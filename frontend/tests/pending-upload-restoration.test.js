import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import test from 'node:test'
import { setPendingUpload, getPendingUpload, clearPendingUpload, consumePendingUpload } from '../src/store/pendingUpload.js'

test('each accepted submission has a fresh identity even for identical files and scenario', () => {
  const files = [new File(['same'], 'same.txt')]
  setPendingUpload(files, 'same scenario')
  const first = getPendingUpload()
  setPendingUpload(files, 'same scenario')
  const second = getPendingUpload()
  assert.ok(first.submissionId)
  assert.notEqual(first.submissionId, second.submissionId)
  assert.equal(first.files[0], second.files[0])
  assert.equal(consumePendingUpload(first.submissionId), null)
  assert.equal(getPendingUpload().submissionId, second.submissionId)
  clearPendingUpload()
})

test('guarded consume is one-shot, preserves exact inputs and isolates array membership', async () => {
  const first = new File(['  中文 🌱\r\n'], 'source.txt', { type: 'text/plain', lastModified: 42 })
  const second = new File(['second'], 'source.md', { lastModified: 99 })
  const input = [first, second, first], requirement = '  exact scenario\r\n  '
  setPendingUpload(input, requirement)
  const pending = getPendingUpload()
  input.pop()
  assert.equal(pending.files.length, 3)
  const snapshot = consumePendingUpload(pending.submissionId)
  assert.notEqual(snapshot.files, pending.files)
  assert.deepEqual(snapshot.files, [first, second, first])
  assert.equal(snapshot.simulationRequirement, requirement)
  assert.equal(snapshot.files[0].lastModified, 42)
  assert.equal(snapshot.files[0].type, 'text/plain')
  assert.equal(await snapshot.files[0].text(), '  中文 🌱\r\n')
  snapshot.files.pop()
  assert.equal(pending.files.length, 3)
  assert.equal(getPendingUpload().isPending, false)
  assert.equal(getPendingUpload().submissionId, null)
  assert.equal(consumePendingUpload(pending.submissionId), null)
})

test('missing and incorrect expected identities do not clear a current submission', () => {
  setPendingUpload([new File(['keep'], 'keep.txt')], 'keep')
  const pending = getPendingUpload()
  for (const identity of [undefined, null, Symbol('wrong')]) {
    assert.equal(consumePendingUpload(identity), null)
    assert.equal(getPendingUpload().submissionId, pending.submissionId)
    assert.equal(getPendingUpload().files, pending.files)
  }
  clearPendingUpload()
})

test('legacy no-argument clear resets the existing public fields and remains repeatable', () => {
  setPendingUpload([new File(['legacy'], 'legacy.txt')], 'legacy')
  clearPendingUpload()
  clearPendingUpload()
  const value = getPendingUpload()
  assert.deepEqual(Array.from(value.files), [])
  assert.equal(value.simulationRequirement, '')
  assert.equal(value.isPending, false)
  assert.equal(value.submissionId, null)
})
