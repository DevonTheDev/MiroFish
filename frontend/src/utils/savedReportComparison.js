// Independent from the 8 MiB saved-reader admission limit. These budgets apply
// before allocating a diff matrix or output; a limited diff has unknown counts.
export const COMPARISON_LIMITS = Object.freeze({ bytes: 64 * 1024, lines: 2000, cells: 1000000, rows: 4000 })

// Stop scanning at the preview budget. Never encode/copy a whole large body just
// to make a preview, and never split a surrogate pair at the visible boundary.
export function previewCapturedText(text) {
  let bytes = 0, end = 0
  for (const character of text) {
    const point = character.codePointAt(0)
    const width = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (bytes + width > COMPARISON_LIMITS.bytes) return { text: text.slice(0, end), truncated: true }
    bytes += width; end += character.length
  }
  return { text, truncated: false }
}

function lines(text) {
  const result = []
  let start = 0
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '\n' && text[index] !== '\r') continue
    if (result.length === COMPARISON_LIMITS.lines) return null
    const end = index
    const ending = text[index] === '\n' ? 'LF' : text[index + 1] === '\n' ? 'CRLF' : 'CR'
    if (ending === 'CRLF') index++
    result.push({ text: text.slice(start, end), ending }); start = index + 1
  }
  if (start < text.length) {
    if (result.length === COMPARISON_LIMITS.lines) return null
    result.push({ text: text.slice(start), ending: 'NONE' })
  }
  return result
}
const result = (status, reason = null) => ({ status, reason, added: null, removed: null, rows: [] })

export function compareCapturedText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return result('unavailable')
  if (left === right) return { ...result('identical'), added: 0, removed: 0 }
  if (previewCapturedText(left).truncated || previewCapturedText(right).truncated) return result('limited', 'bytes')
  const a = lines(left), b = lines(right)
  if (!a || !b) return result('limited', 'lines')
  const width = b.length + 1, cells = (a.length + 1) * width
  if (cells > COMPARISON_LIMITS.cells) return result('limited', 'cells')
  // This conservative bound covers unchanged rows as well as changes. Check it
  // before the matrix, not after constructing an oversized result.
  if (a.length + b.length > COMPARISON_LIMITS.rows) return result('limited', 'rows')
  const grid = new Uint16Array(cells)
  const same = (i, j) => a[i].text === b[j].text && a[i].ending === b[j].ending
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      grid[i * width + j] = same(i, j) ? 1 + grid[(i + 1) * width + j + 1]
        : Math.max(grid[(i + 1) * width + j], grid[i * width + j + 1])
    }
  }
  const rows = []
  let i = 0, j = 0, added = 0, removed = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && same(i, j)) {
      rows.push({ kind: 'same', ...a[i], leftLine: i + 1, rightLine: j + 1 }); i++; j++
    } else if (i < a.length && (j === b.length || grid[(i + 1) * width + j] >= grid[i * width + j + 1])) {
      rows.push({ kind: 'removed', ...a[i], leftLine: i + 1, rightLine: null }); i++; removed++
    } else {
      rows.push({ kind: 'added', ...b[j], leftLine: null, rightLine: j + 1 }); j++; added++
    }
  }
  return { status: 'different', reason: null, added, removed, rows }
}
