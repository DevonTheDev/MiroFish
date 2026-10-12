import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import test from 'node:test'
import { mountRuntime } from './helpers/runtime-view-fixture.js'

const hasClass = (node, name) => String(node.props.class ?? '').split(/\s+/).includes(name)

async function home(t) {
  const view = await mountRuntime({ initialPath: '/' })
  t.after(() => {
    try {
      assert.deepEqual(view.warnings, [])
      assert.equal(view.requests.calls.getRuntimeStatus.length, 0)
      assert.equal(view.router.currentRoute.value.name, 'Home')
    } finally { view.unmount() }
  })
  const input = view.find(node => node.type === 'input' && node.props.type === 'file')
  assert.ok(input)
  const state = input.__vueParentComponent.setupState

  // Model a live, indexed FileList: resetting value clears this same object.
  // Calling onChange below delivers an event explicitly; this fixture does not
  // prove whether a native chooser dispatches change for the same path.
  const liveFiles = {
    length: 0,
    item(index) { return this[index] ?? null },
    *[Symbol.iterator]() { for (let index = 0; index < this.length; index++) yield this[index] },
  }
  const clearFiles = () => {
    for (let index = 0; index < liveFiles.length; index++) delete liveFiles[index]
    liveFiles.length = 0
  }
  let value = '', resets = 0, chooserClicks = 0
  Object.defineProperties(input, {
    files: { get: () => liveFiles },
    value: {
      get: () => value,
      set(next) {
        assert.equal(next, '', 'file selection may only reset the input')
        value = next; resets++; clearFiles()
      },
    },
  })
  input.click = () => { chooserClicks++ }
  return {
    ...view, input, state, liveFiles,
    get resets() { return resets },
    get chooserClicks() { return chooserClicks },
    zone: () => view.find(node => hasClass(node, 'upload-zone')),
    names: () => view.all(node => hasClass(node, 'file-name')).map(node => node.text),
    async select(selected) {
      clearFiles()
      for (const [index, file] of selected.entries()) liveFiles[index] = file
      liveFiles.length = selected.length
      value = selected.length ? 'C:\\fakepath\\' + selected[0].name : ''
      input.props.onChange({ target: input })
      await view.flush()
    },
    async remove(index) {
      const button = view.all(node => hasClass(node, 'remove-btn'))[index]
      assert.ok(button)
      button.props.onClick({ stopPropagation() {} })
      await view.flush()
    },
  }
}

test('copies selected File objects before resetting a live FileList', async t => {
  const h = await home(t)
  const file = new File(['seed contents'], 'seed.pdf', { type: 'application/pdf' })
  await h.select([file])
  assert.equal(h.input.value, '')
  assert.equal(h.resets, 1)
  assert.equal(h.input.files, h.liveFiles)
  assert.equal(h.liveFiles.length, 0)
  assert.equal(h.state.files[0], file)
  assert.equal(await h.state.files[0].text(), 'seed contents')
  assert.deepEqual(h.names(), ['seed.pdf'])
})

test('removing then delivering the same File again repopulates the persistent picker view', async t => {
  const h = await home(t)
  const file = new File(['same seed'], 'seed.md')
  await h.select([file])
  await h.remove(0)
  assert.deepEqual(h.names(), [])
  assert.equal(h.state.files.length, 0)
  assert.ok(h.find(node => hasClass(node, 'upload-placeholder')))
  await h.select([file])
  assert.equal(h.find(node => node.type === 'input' && node.props.type === 'file'), h.input)
  assert.equal(h.input.value, '')
  assert.equal(h.resets, 2)
  assert.equal(h.state.files[0], file)
  assert.deepEqual(h.names(), ['seed.md'])
})

test('retains accepted extensions and selection order when a mixed list is cleared', async t => {
  const h = await home(t)
  const files = ['first.PDF', 'rejected.png', 'second.Md', 'third.TXT', 'no-extension']
    .map(name => new File([name], name))
  await h.select(files)
  assert.equal(h.input.value, '')
  assert.equal(h.liveFiles.length, 0)
  assert.deepEqual(Array.from(h.state.files), [files[0], files[2], files[3]])
  assert.deepEqual(h.names(), ['first.PDF', 'second.Md', 'third.TXT'])
})

test('resets a rejected-only selection without replacing accepted files', async t => {
  const h = await home(t)
  const accepted = new File(['keep'], 'keep.txt')
  await h.select([accepted])
  await h.select([new File(['reject'], 'reject.csv')])
  assert.equal(h.input.value, '')
  assert.equal(h.resets, 2)
  assert.deepEqual(Array.from(h.state.files), [accepted])
  assert.deepEqual(h.names(), ['keep.txt'])
})

test('an empty delivered selection resets without removing accepted files', async t => {
  const h = await home(t)
  const file = new File(['keep'], 'keep.txt')
  await h.select([file])
  await h.select([])
  assert.equal(h.input.value, '')
  assert.equal(h.resets, 2)
  assert.deepEqual(Array.from(h.state.files), [file])
  assert.deepEqual(h.names(), ['keep.txt'])
})

test('repeated delivered selections preserve the existing duplicate policy', async t => {
  const h = await home(t)
  const file = new File(['repeat'], 'repeat.txt')
  await h.select([file])
  await h.select([file])
  assert.equal(h.input.value, '')
  assert.equal(h.resets, 2)
  assert.deepEqual(Array.from(h.state.files), [file, file])
  assert.deepEqual(h.names(), ['repeat.txt', 'repeat.txt'])
})

test('loading keeps the picker disabled and prevents the upload-zone trigger', async t => {
  const h = await home(t)
  assert.equal(h.input.props.accept, '.pdf,.md,.txt')
  assert.equal(h.input.props.multiple, '')
  h.zone().props.onClick()
  assert.equal(h.chooserClicks, 1)
  h.state.loading = true
  await h.flush()
  assert.equal(h.input.props.disabled, true)
  h.zone().props.onClick()
  assert.equal(h.chooserClicks, 1)
  assert.equal(h.find(node => hasClass(node, 'start-engine-btn')).props.disabled, true)
  h.state.loading = false
  await h.flush()
  assert.equal(h.input.props.disabled, false)
  h.zone().props.onClick()
  assert.equal(h.chooserClicks, 2)
})

test('an explicitly delivered change while loading retains existing handler acceptance and resets', async t => {
  const h = await home(t)
  const file = new File(['delivered'], 'delivered.txt')
  h.state.loading = true
  await h.flush()
  await h.select([file])
  assert.equal(h.input.props.disabled, true)
  assert.equal(h.input.value, '')
  assert.equal(h.resets, 1)
  assert.deepEqual(Array.from(h.state.files), [file])
  assert.deepEqual(h.names(), ['delivered.txt'])
})
