export const REPORT_HEADING_LIMITS = Object.freeze({ headings: 200, label: 160 })
const blank = code => code === 32 || code === 9
const lineBreak = code => code === 10 || code === 13

// Literal, fence-aware ATX lines, not a Markdown block parser. The admitted
// source is the only complete body: scanner state is offsets/counters, and the
// retained labels and entries are bounded. Never split or copy a whole line.
export function indexReportHeadings(text) {
  const headings = []
  let lineStart = 0, line = 1, fence = 0, fenceLength = 0
  while (lineStart < text.length) {
    let markerStart = lineStart
    while (markerStart < lineStart + 4 && text.charCodeAt(markerStart) === 32) markerStart++
    const marker = text.charCodeAt(markerStart)
    const prefix = markerStart - lineStart < 4 && (marker === 35 || marker === 96 || marker === 126)
    let runEnd = markerStart
    if (prefix) while (text.charCodeAt(runEnd) === marker) runEnd++
    const run = runEnd - markerStart
    const heading = !fence && prefix && marker === 35 && run <= 6
      && (runEnd === text.length || lineBreak(text.charCodeAt(runEnd)) || blank(text.charCodeAt(runEnd)))
    let cursor = prefix ? runEnd : markerStart
    let titleStart = -1, titleEnd = runEnd, closingEnd = -1, suffixBlank = true, suffixBacktick = false
    while (cursor < text.length && !lineBreak(text.charCodeAt(cursor))) {
      const code = text.charCodeAt(cursor)
      if (!blank(code)) {
        suffixBlank = false
        if (code === 96) suffixBacktick = true
        if (heading) {
          if (titleStart === -1) titleStart = cursor
          if (code === 35) {
            if (text.charCodeAt(cursor - 1) !== 35) closingEnd = blank(text.charCodeAt(cursor - 1)) ? titleEnd : -1
          } else closingEnd = -1
          titleEnd = cursor + 1
        }
      }
      cursor++
    }
    if (prefix && (marker === 96 || marker === 126) && run >= 3) {
      if (fence) {
        if (marker === fence && run >= fenceLength && suffixBlank) { fence = 0; fenceLength = 0 }
      } else if (marker !== 96 || !suffixBacktick) { fence = marker; fenceLength = run }
    } else if (heading) {
      if (closingEnd !== -1) titleEnd = closingEnd
      if (titleStart !== -1 && titleStart < titleEnd) {
        if (headings.length === REPORT_HEADING_LIMITS.headings) return { headings, more: true }
        let previewEnd = titleStart, count = 0
        while (previewEnd < titleEnd && count < REPORT_HEADING_LIMITS.label) {
          previewEnd += text.codePointAt(previewEnd) > 0xffff ? 2 : 1; count++
        }
        headings.push({ lineStart, markerStart, lineEnd: cursor, level: run, line,
          label: text.slice(titleStart, previewEnd) + (previewEnd < titleEnd ? '…' : '') })
      }
    }
    lineStart = cursor + (text.charCodeAt(cursor) === 13 && text.charCodeAt(cursor + 1) === 10 ? 2 : 1)
    line++
  }
  return { headings, more: false }
}

// Preserve one outer interval per Find match. Heading spans partition those
// intervals at the first raw # only; no duplicated text or empty anchors.
export function segmentReportText(text, matches, headings) {
  const parts = []
  let start = 0, headingIndex = 0
  function append(end, match) {
    if (end <= start) return
    const children = [], key = start
    while (headingIndex < headings.length && headings[headingIndex].markerStart < end) {
      const heading = headings[headingIndex++], p = heading.markerStart, q = Math.min(heading.lineEnd, end)
      if (start < p) children.push({ key: start, text: text.slice(start, p) })
      children.push({ key: p, text: text.slice(p, q), heading }); start = q
    }
    if (start < end) children.push({ key: start, text: text.slice(start, end) })
    parts.push({ key: match === undefined ? `text-${key}` : `match-${match}`, match, children })
    start = end
  }
  matches.forEach((match, index) => { append(match.start); append(match.end, index) })
  append(text.length)
  return parts
}
