export const REPORT_SEARCH_LIMITS = Object.freeze({ query: 200, matches: 1000 })

// Stop at the first excess code point: even a large paste never becomes retained
// search state. Do not trim or normalize the user's literal spaces/newlines.
export function boundReportQuery(value) {
  let query = '', length = 0
  for (const character of value) {
    if (length === REPORT_SEARCH_LIMITS.query) return { query, tooLong: true }
    query += character; length++
  }
  return { query, tooLong: false }
}

export function createReportSearchIndex(text) {
  const firstCR = text.indexOf('\r')
  if (firstCR === -1) return { text, removedCRLF: null }
  // Only CRLF removes a code unit. Store its normalized position compactly;
  // a worst-case admitted 8 MiB CRLF body needs a 16 MiB Uint32Array. Count
  // first so sparse sources never allocate an entry for every character.
  let count = 0
  for (let offset = firstCR; offset !== -1; offset = text.indexOf('\r', offset + 1)) {
    if (text.charCodeAt(offset + 1) === 10) count++
  }
  const removedCRLF = count ? new Uint32Array(count) : null
  if (removedCRLF) {
    let removed = 0
    for (let offset = firstCR; offset !== -1; offset = text.indexOf('\r', offset + 1)) {
      if (text.charCodeAt(offset + 1) === 10) {
        removedCRLF[removed] = offset - removed
        removed++
      }
    }
  }
  return { text: text.replace(/\r\n?/g, '\n'), removedCRLF }
}

function originalOffset(index, boundary) {
  const removed = index.removedCRLF
  if (!removed) return boundary
  // Count removed CRs strictly before this normalized boundary. A match on
  // the normalized LF therefore starts at raw CR and ends after raw LF.
  let low = 0, high = removed.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (removed[middle] < boundary) low = middle + 1
    else high = middle
  }
  return boundary + low
}

export function findReportPassages(source, query, matchCase = false) {
  const matches = []
  if (!query || boundReportQuery(query).tooLong) return { matches, more: false }
  const index = typeof source === 'string' ? createReportSearchIndex(source) : source
  // Every user metacharacter is escaped, so there are no user-controlled regex
  // operators. Unicode mode avoids splitting surrogate
  // pairs; case-insensitive mode uses Unicode simple case folding without
  // changing the source string or its offsets (including İ and astral letters).
  // Normalize only the small query here. A prepared body index is reusable;
  // the search pattern stays a single escaped literal, even for dense breaks.
  const literal = query.replace(/\r\n?/g, '\n').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(literal, matchCase ? 'gu' : 'giu')
  let match
  while ((match = pattern.exec(index.text)) !== null) {
    if (matches.length === REPORT_SEARCH_LIMITS.matches) return { matches, more: true }
    matches.push({ start: originalOffset(index, match.index), end: originalOffset(index, pattern.lastIndex) })
  }
  return { matches, more: false }
}
