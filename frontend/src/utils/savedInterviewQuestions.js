// Project a validated, bounded observation without changing its records or
// interpreting prompts, timestamps, agent identities or historical run identity.
export function buildSavedInterviewQuestions(observation) {
  const byPrompt = new Map(), groups = [], ungroupedRecords = []
  for (const row of observation.records) {
    // A timestamp preview can be truncated while its prompt remains complete.
    // Payload previews, including anomalous structured claims, cannot establish
    // an exact stored question.
    if (row.payload_kind !== 'structured' || typeof row.prompt !== 'string' || row.warnings.includes('payload_truncated')) {
      ungroupedRecords.push(row)
      continue
    }
    let group = byPrompt.get(row.prompt)
    if (!group) {
      group = { key: `question-${groups.length}`, prompt: row.prompt, records: [], counts: { twitter: 0, reddit: 0 } }
      byPrompt.set(row.prompt, group)
      groups.push(group)
    }
    group.records.push(row)
    group.counts[row.platform]++
  }
  return { groups, ungroupedRecords }
}
