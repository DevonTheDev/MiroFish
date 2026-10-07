// Search only stored text in already validated, bounded observation records.
// Keep source records and their warnings intact for display and full downloads.
export function filterSavedInterviewRecords(records, query) {
  if (typeof query !== 'string') throw new TypeError('Saved interview search query must be a string')
  const needle = query.toLowerCase()
  return records.filter(row => needle === '' || [row.prompt, row.response, row.raw_preview]
    .some(value => typeof value === 'string' && value.toLowerCase().includes(needle)))
}
