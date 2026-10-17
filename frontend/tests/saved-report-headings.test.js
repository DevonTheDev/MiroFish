import assert from 'node:assert/strict'
import test from 'node:test'
import { indexReportHeadings, segmentReportText } from '../src/utils/savedReportHeadings.js'

// Dropping grammar/offset/fence guards, truncating source, or splitting Find
// wrappers would break these externally visible results. No timing benchmark.
test('ATX grammar keeps literal titles, closing-marker emptiness and explicit continuation lines', () => {
  const lines = ['# Title', ' ## Two ###  ', '  ### Three', '   #### Four', '##### Five', '###### Six',
    '####### Seven', '#hashtag', '\\# Escaped', '    ## Indented', '\t## Tab', '> ## Quote', '- ## List',
    '<div>', '  ## HTML continuation', '</div>', '- item', '  ## List continuation', 'Setext', '===',
    '## ###', '## ###   ', '# #', '##', '##   ', '## ###x', '## x###', '## x ###', '#\tTabbed', '# <img src="x"> &amp; **literal**']
  const headings = indexReportHeadings(lines.join('\n')).headings
  assert.deepEqual(headings.map(h => h.label), ['Title', 'Two', 'Three', 'Four', 'Five', 'Six',
    'HTML continuation', 'List continuation', '###x', 'x###', 'x', 'Tabbed', '<img src="x"> &amp; **literal**'])
  assert.deepEqual(headings.slice(0, 6).map(h => h.level), [1, 2, 3, 4, 5, 6])
  assert.deepEqual(headings.slice(0, 4).map(h => h.markerStart - h.lineStart), [0, 1, 2, 3])
  assert.deepEqual(headings.map(h => h.line), [1, 2, 3, 4, 5, 6, 15, 18, 26, 27, 28, 29, 30])
})

test('plain fences require matching character, length and whitespace-only closers', () => {
  const body = ['# Before', ' ````js', '## hidden', '```', '## hidden', '~~~~', '## hidden', '```` x',
    '## hidden', ' `````\t', '## After', '~~~ info`allowed', '## hidden', '~~', '## hidden', '~~~~ ',
    '## After tilde', '```bad`info', '## Invalid opener stays literal', '    ```', '## Indented fence stays literal',
    '~~~', '## Unterminated'].join('\r\n')
  assert.deepEqual(indexReportHeadings(body).headings.map(h => h.label),
    ['Before', 'After', 'After tilde', 'Invalid opener stays literal', 'Indented fence stays literal'])
})

test('raw UTF-16 offsets distinguish duplicate titles across LF CRLF and CR', () => {
  const body = '🐟\r\n  ## Same\r# Same\n### 雪 🐟\r\n'
  assert.deepEqual(indexReportHeadings(body), { more: false, headings: [
    { lineStart: 4, markerStart: 6, lineEnd: 13, level: 2, line: 2, label: 'Same' },
    { lineStart: 14, markerStart: 14, lineEnd: 20, level: 1, line: 3, label: 'Same' },
    { lineStart: 21, markerStart: 21, lineEnd: 29, level: 3, line: 4, label: '雪 🐟' },
  ] })
})

test('only a 201st eligible heading reports excess after the first 200', () => {
  const body = Array.from({ length: 200 }, (_, i) => `## ${i}`).join('\n')
  const exact = indexReportHeadings(body + '\n# ###\n```\n# hidden')
  assert.equal(exact.headings.length, 200); assert.equal(exact.more, false)
  const extra = indexReportHeadings(body + '\n# ###\n# Excess\n# Later')
  assert.equal(extra.headings.length, 200); assert.equal(extra.more, true)
  assert.equal(extra.headings.at(-1).label, '199')
})

test('labels cap at 160 code points with ellipsis while source offsets retain the complete line', () => {
  const title = '🐟'.repeat(160), body = '# ' + title + 'x'.repeat(100000) + ' ###\t'
  const [h] = indexReportHeadings(body).headings
  assert.equal(h.label, title + '…'); assert.equal(h.lineEnd, body.length)
  assert.equal(indexReportHeadings('# ' + title).headings[0].label, title)
})

test('admitted 8 MiB boundaries retain late headings and tolerate long fence lines and dense logical breaks', () => {
  const size = 8 * 1024 * 1024
  for (const prefix of ['x'.repeat(size - 8), '\r\n'.repeat((size - 8) / 2)]) {
    const body = prefix + '\n# Late!'
    assert.equal(Buffer.byteLength(body), size)
    const [h] = indexReportHeadings(body).headings
    assert.equal(h.lineStart, prefix.length + 1); assert.equal(h.label, 'Late!')
  }
  assert.deepEqual(indexReportHeadings('x'.repeat(size)), { headings: [], more: false })
  assert.deepEqual(indexReportHeadings('```' + 'x'.repeat(size - 3)), { headings: [], more: false })
  const heading = indexReportHeadings('# ' + 'x'.repeat(size - 2)).headings[0]
  assert.equal(heading.label, 'x'.repeat(160) + '…'); assert.equal(heading.lineEnd, size)
})

test('half-open match boundaries place one nonempty target at the exact marker', () => {
  const text = 'lead\r\n  ## Alpha\r\nend', headings = indexReportHeadings(text).headings
  const p = headings[0].markerStart, e = headings[0].lineEnd
  for (const [start, end, marked, stop] of [
    [0, p, false, e], [p, e, true, e], [0, p + 1, true, p + 1],
    [p + 1, e, false, p + 1], [6, 8, false, e], [0, text.length, true, e],
  ]) {
    const parts = segmentReportText(text, [{ start, end }], headings)
    assert.equal(parts.flatMap(part => part.children).map(piece => piece.text).join(''), text)
    assert.equal(parts.filter(part => part.match !== undefined).length, 1)
    const containers = parts.filter(part => part.children.some(piece => piece.heading))
    assert.equal(containers.length, 1); assert.equal(containers[0].match !== undefined, marked)
    const target = containers[0].children.find(piece => piece.heading)
    assert.equal(target.text, text.slice(p, stop)); assert.ok(target.text.length)
  }
})

test('a multiline Find match keeps one wrapper while containing several heading targets', () => {
  const text = 'lead\r\n## A\r\n## B\r\ntail', headings = indexReportHeadings(text).headings
  const parts = segmentReportText(text, [{ start: 0, end: text.length }], headings)
  assert.equal(parts.length, 1); assert.equal(parts[0].match, 0)
  assert.deepEqual(parts[0].children.filter(p => p.heading).map(p => p.text), ['## A', '## B'])
  assert.equal(parts[0].children.map(p => p.text).join(''), text)
  assert.deepEqual(segmentReportText('', [], []), [])
})
