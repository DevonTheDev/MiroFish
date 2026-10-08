import { buildSavedInterviewQuestions } from './savedInterviewQuestions.js'

const emptySide = () => ({ records: [], counts: { twitter: 0, reddit: 0 } })

// Two independently admitted observations. Exact complete prompts align;
// records and identities remain scoped to their original observation.
export function buildSavedInterviewComparison(left, right) {
  const groups = [], byPrompt = new Map(), ungroupedRecords = { left: [], right: [] }
  for (const [side, observation] of [['left', left], ['right', right]]) {
    if (!observation) continue
    const index = buildSavedInterviewQuestions(observation)
    ungroupedRecords[side] = index.ungroupedRecords
    for (const question of index.groups) {
      let group = byPrompt.get(question.prompt)
      if (!group) {
        group = { key: `question-${groups.length}`, prompt: question.prompt, left: emptySide(), right: emptySide() }
        byPrompt.set(question.prompt, group); groups.push(group)
      }
      group[side] = { records: question.records, counts: question.counts }
    }
  }
  return { groups, ungroupedRecords }
}
