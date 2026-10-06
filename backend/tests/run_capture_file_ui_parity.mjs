// Invoked by pytest with actual Flask export data from disposable logs/SQLite.
// The production view is compiled and mounted in the deterministic Vue host;
// this does not claim native browser picker, rendering, or filesystem coverage.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mountCaptureFiles } from '../../frontend/tests/helpers/run-capture-files-view-fixture.js'

const data = JSON.parse(readFileSync(process.argv[2], 'utf8'))
async function selectFile(view, value, name) {
  const blob = new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' })
  const file = { name, type: blob.type, size: blob.size, arrayBuffer: () => blob.arrayBuffer() }
  const target = { files: [file], value: name }
  await view.byId('capture-file').props.onChange({ target })
  await view.flush()
  assert.equal(target.value, '')
  assert.ok(view.byId('file-preview'), view.text())
  assert.equal(view.byId('file-error'), undefined)
  assert.ok(view.text(view.byId('preview-filename')).includes(name))
}

for (const locale of ['en', 'zh']) {
  const view = await mountCaptureFiles({ locale })
  try {
    assert.equal(view.router.currentRoute.value.path, '/capture-files')
    assert.equal(view.byId('download-left'), undefined)
    await selectFile(view, data.left, '<script>left</script>.json')
    assert.equal(view.byId('download-left'), undefined, 'Preview must require explicit acceptance')
    assert.ok(view.text().includes(data.left.observation.summary.scenario))
    await view.click('use-left')
    await view.click('download-left')
    assert.deepEqual(JSON.parse(await view.downloads.at(-1).blob.text()), data.left)
    assert.equal(view.downloads.at(-1).filename, 'mirofish-run-capture.json')

    await selectFile(view, data.right, 'complete-zero.json')
    assert.equal(view.byId('download-right'), undefined)
    await view.click('use-right')
    assert.equal(view.byId('file-comparison'), undefined)
    await view.click('compare-files')
    assert.ok(view.byId('file-comparison'))
    await view.click('download-file-comparison')
    const individualPair = JSON.parse(await view.downloads.at(-1).blob.text())
    assert.deepEqual(individualPair, { ...data.comparison, generated_at: individualPair.generated_at })
    assert.notEqual(individualPair.generated_at, data.comparison.generated_at)
    assert.ok(Number.isFinite(Date.parse(individualPair.generated_at)))
    assert.equal(view.downloads.at(-1).filename, 'mirofish-run-capture-comparison.json')

    // A previously downloaded comparison is also a first-class file: preview
    // its historical generation time, use both, then compute a fresh result.
    await view.click('clear-files')
    await selectFile(view, data.comparison, 'historical-comparison.json')
    assert.ok(view.text(view.byId('historical-comparison-time')).includes(data.comparison.generated_at))
    assert.equal(view.byId('download-left'), undefined)
    assert.equal(view.byId('download-file-comparison').props.disabled, true)
    await view.click('use-both')
    assert.equal(view.byId('file-comparison'), undefined)
    assert.equal(view.byId('download-file-comparison').props.disabled, true)
    await view.click('compare-files')
    await view.click('download-file-comparison')
    const reopenedPair = JSON.parse(await view.downloads.at(-1).blob.text())
    assert.deepEqual(reopenedPair, { ...data.comparison, generated_at: reopenedPair.generated_at })
    assert.notEqual(reopenedPair.generated_at, data.comparison.generated_at)
    assert.equal(reopenedPair.left.observation.observed_at, data.left.observation.observed_at)
    assert.equal(reopenedPair.right.captured_at, data.right.captured_at)
    assert.equal(reopenedPair.differences.platforms.reddit.recorded_actions, null)
    assert.match(view.text(view.byId('file-metric-recorded_actions')),
      data.comparison.differences.recorded_actions === null ? /4.*0.*—/ : /4.*0.*-4/)
    assert.equal(view.all(node => ['script', 'img', 'iframe'].includes(node.type)).length, 0)
    assert.deepEqual(view.networkCalls, [])
    assert.deepEqual(view.storageWrites, [])
    assert.ok(Object.values(view.requests.calls).every(calls => calls.length === 0))
    assert.deepEqual(view.warnings, [])
  } finally {
    view.unmount()
  }
  assert.ok(view.downloads.every(download => view.revokedUrls.includes(download.url)))
  assert.equal(view.blobs.size, 0)
}
console.log('actual Flask exports -> compiled Vue file selection/use/compare/download passed in en and zh')
