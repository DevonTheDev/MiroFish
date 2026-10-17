export const REPORT_CONVERSATION_TEXT_MAX_BYTES = 1024 * 1024
const tooLarge = Symbol('conversation text too large')
const prefix = "MiroFish Report Agent conversation\n"
  + "format_version: 1\n"
  + "Scope: All displayed stored turns in the current Report Agent conversation from this browser page session. Displayed error notices may appear as assistant messages.\n"
  + "This is not a complete run history, historical graph snapshot, verified model trace or resumable conversation.\n"
  + "Content is stored message text, including Markdown syntax, not rendered HTML. Hidden prompts and tool metadata are excluded.\n"
  + "Encoding: UTF-8 with fixed English labels. String values use two-space indentation and preserve ordinary Unicode, spaces and every LF. Backslashes, CR, tab, other controls and lone surrogates use visible escapes.\n"
  + "Escapes describe individual values; TXT is not an import format. Indentation and the final LF are presentation syntax.\n"
  + "\n"

// Match the existing saved-interview TXT convention: retain ordinary Unicode
// and LF while making controls and otherwise unencodable UTF-16 units visible.
function visible(value) {
  return value.replace(/\\|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, character => {
    if (character === '\n') return '\n'
    if (character === '\\') return '\\\\'
    if (character === '\r') return '\\r'
    if (character === '\t') return '\\t'
    return character.split('').map(unit => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')).join('')
  })
}

export function formatReportConversationText(capture) {
  try {
    if (!capture || typeof capture !== 'object' || Array.isArray(capture)) return { ok: false, code: 'invalid' }
    const { reportId, simulationId, capturedAt, messages } = capture
    if (![reportId, simulationId, capturedAt].every(value => typeof value === 'string' && value.length > 0)
      || !Array.isArray(messages) || !messages.length) return { ok: false, code: 'invalid' }
    const chunks = [], encoder = new TextEncoder()
    let bytes = 0
    const append = text => {
      if (text.length > REPORT_CONVERSATION_TEXT_MAX_BYTES - bytes) throw tooLarge
      bytes += encoder.encode(text).byteLength
      if (bytes > REPORT_CONVERSATION_TEXT_MAX_BYTES) throw tooLarge
      chunks.push(text)
    }
    const field = (label, value) => {
      append(label + ':\n')
      // Every source UTF-16 unit needs at least one output byte. Reject known
      // oversized values before allocating an escaped/indented copy.
      if (value.length > REPORT_CONVERSATION_TEXT_MAX_BYTES - bytes) throw tooLarge
      append(value === '' ? '[empty string]\n' : '  ' + visible(value).replace(/\n/g, '\n  ') + '\n')
    }
    append(prefix)
    field('report_id', reportId); field('simulation_id', simulationId); field('captured_at', capturedAt)
    append(`message_count: ${messages.length}\n`)
    for (let index = 0; index < messages.length; index++) {
      const row = messages[index]
      if (!row || typeof row !== 'object' || Array.isArray(row)) return { ok: false, code: 'invalid' }
      const { role, timestamp, content } = row
      if (!['user', 'assistant'].includes(role) || typeof timestamp !== 'string' || typeof content !== 'string') return { ok: false, code: 'invalid' }
      append(`\nMessage ${index + 1}\nrole: ${role}\n`)
      field('timestamp', timestamp); field('content', content)
    }
    return { ok: true, text: chunks.join('') }
  } catch (error) {
    return { ok: false, code: error === tooLarge ? 'too_large' : 'invalid' }
  }
}
