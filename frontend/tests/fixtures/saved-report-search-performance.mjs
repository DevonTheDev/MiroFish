// Isolate a formerly blocking admitted query so a regression cannot hang the
// test runner. These are local Node measurements, not native-browser timings.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { findReportPassages } from '../../src/utils/savedReportSearch.js'

const body = '\r\n'.repeat(4 * 1024 * 1024)
const query = '\n'.repeat(199) + 'X'
assert.equal(Buffer.byteLength(body), 8 * 1024 * 1024)
assert.equal([...query].length, 200)
const start = performance.now()
assert.deepEqual(findReportPassages(body, query), { matches: [], more: false })
console.log(JSON.stringify({ bodyBytes: Buffer.byteLength(body), queryCodePoints: [...query].length, milliseconds: performance.now() - start }))
