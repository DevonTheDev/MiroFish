import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The Flask counterpart is backend/tests/test_saved_report_files_frontend.py.
// This installed-dependency smoke exercises the same real reader/client/views
// with a stdlib HTTP transport, without claiming Flask or browser rendering.
for (const mode of ['file', 'metadata', 'legacy', 'empty', 'unavailable']) {
  test(`production ${mode} report bytes round-trip through local HTTP, Axios and compiled Vue`, () => {
    const output = execFileSync('python3', [fileURLToPath(new URL('./fixtures/saved-report-files-reader-server.py', import.meta.url)), mode],
      { encoding: 'utf8', timeout: 50000, maxBuffer: 2 * 1024 * 1024 })
    assert.match(output, /actual Axios\/Vue report file round trip passed/)
    const result = JSON.parse(output.trim().split('\n').at(-1))
    assert.equal(result.source_files_unchanged, true)
    assert.equal(result.application_model_runtime_imports, false)
    assert.ok(result.requests.length >= 3)
    assert.equal(result.transport, 'stdlib loopback HTTP; not Flask')
  })
}
