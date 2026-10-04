const bytes = value => new TextEncoder().encode(value).length

// JSON.parse silently overwrites duplicate keys. This bounded parser rejects them,
// including escaped aliases, before schema admission. Depth is capped before recursion.
export function parseBoundedJson(source, maximumBytes, maximumDepth, invalid, strictValues = false) {
  try {
    if (typeof source !== 'string' || bytes(source) > maximumBytes) return invalid()
    let cursor = 0
    const whitespace = () => { while (/[\t\n\r ]/.test(source[cursor] ?? '\0')) cursor++ }
    function string() {
      const start = cursor++
      while (cursor < source.length) {
        const character = source[cursor++]
        if (character === '\\') cursor++
        else if (character === '"') {
          const result = JSON.parse(source.slice(start, cursor))
          if (strictValues && /\p{Cs}/u.test(result)) return invalid()
          return result
        }
      }
      return invalid()
    }
    function value(depth) {
      if (depth > maximumDepth) return invalid()
      whitespace()
      if (source[cursor] === '"') return string()
      if (source[cursor] === '{' || source[cursor] === '[') {
        const array = source[cursor++] === '[', end = array ? ']' : '}', result = array ? [] : Object.create(null), keys = new Set()
        whitespace()
        if (source[cursor] === end) { cursor++; return result }
        while (cursor < source.length) {
          whitespace()
          if (array) result.push(value(depth + 1))
          else {
            if (source[cursor] !== '"') return invalid()
            const key = string()
            if (keys.has(key)) return invalid()
            keys.add(key); whitespace()
            if (source[cursor++] !== ':') return invalid()
            result[key] = value(depth + 1)
          }
          whitespace()
          if (source[cursor] === end) { cursor++; return result }
          if (source[cursor++] !== ',') return invalid()
        }
        return invalid()
      }
      const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(cursor))?.[0]
      if (!token) return invalid()
      cursor += token.length
      const result = JSON.parse(token)
      if (strictValues && typeof result === 'number' && !Number.isFinite(result)) return invalid()
      return result
    }
    const result = value(0); whitespace()
    if (cursor !== source.length) return invalid()
    return result
  } catch { return invalid() }
}
