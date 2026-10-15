export const MAX_GRAPH_VIEW_SVG_BYTES = 8388608

const MAX_INPUT_BYTES = 8388608
const MAX_VISITED_NODES = 50000
const MAX_LABEL_BYTES = 65536
const MAX_ATTRIBUTES = 16
const MAX_STYLES = 8
const MAX_VALUE_BYTES = 512
const MAX_NUMBER_CHARACTERS = 32
const MAX_SOURCE_DEPTH = 4
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const INVALID = Symbol('invalid graph view')
const TOO_LARGE = Symbol('graph view limit exceeded')
const invalid = () => { throw INVALID }
const tooLarge = () => { throw TOO_LARGE }
const NUMBER = '-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:e[+-]?[0-9]+)?'
// JavaScript's $ also matches before a final line terminator. Require the true
// end so no unescaped newline or trailing syntax can enter an output attribute.
const END = '(?![\\s\\S])'
const NUMBER_PATTERN = new RegExp(`^${NUMBER}${END}`)
const VIEWBOX_PATTERN = new RegExp(`^0 0 (${NUMBER}) (${NUMBER})${END}`)
const TRANSFORM_PATTERN = new RegExp(`^translate\\((${NUMBER}),(${NUMBER})\\) scale\\((${NUMBER})\\)${END}`)
const PATH_PATTERNS = [
  new RegExp(`^M(${NUMBER}),(${NUMBER}) L(${NUMBER}),(${NUMBER})${END}`),
  new RegExp(`^M(${NUMBER}),(${NUMBER}) Q(${NUMBER}),(${NUMBER}) (${NUMBER}),(${NUMBER})${END}`),
  new RegExp(`^M(${NUMBER}),(${NUMBER}) A30,30 0 1,1 (${NUMBER}),(${NUMBER})${END}`),
]
const PALETTE = new Set(['#FF6B35', '#004E89', '#7B2D8E', '#1A936F', '#C5283D', '#E9724C', '#3498db', '#9b59b6', '#27ae60', '#f39c12', '#999'])
const ATTRIBUTE_NAMES = {
  svg: new Set(['class', 'width', 'height', 'viewBox', 'preserveAspectRatio']),
  root: new Set(['transform']),
  links: new Set(['class']),
  nodes: new Set(['class']),
  path: new Set(['d', 'stroke', 'stroke-width', 'fill']),
  rect: new Set(['x', 'y', 'width', 'height', 'rx', 'ry', 'fill', 'transform']),
  circle: new Set(['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width']),
  edgeText: new Set(['x', 'y', 'transform', 'font-size', 'fill', 'text-anchor', 'dominant-baseline']),
  nodeText: new Set(['x', 'y', 'font-size', 'fill', 'font-weight', 'dx', 'dy']),
}
const CSS_WHITESPACE = /^[\t\n\r ]+|[\t\n\r ]+$/g
const trimCss = value => value.replace(CSS_WHITESPACE, '')
const transparentTap = /^rgba\([\t\n\r ]*0[\t\n\r ]*,[\t\n\r ]*0[\t\n\r ]*,[\t\n\r ]*0[\t\n\r ]*,[\t\n\r ]*0[\t\n\r ]*\)(?![\s\S])/
const whiteBackground = /^rgba\([\t\n\r ]*255[\t\n\r ]*,[\t\n\r ]*255[\t\n\r ]*,[\t\n\r ]*255[\t\n\r ]*,[\t\n\r ]*0?\.95[\t\n\r ]*\)(?![\s\S])/
const blueBackground = /^rgba\([\t\n\r ]*52[\t\n\r ]*,[\t\n\r ]*152[\t\n\r ]*,[\t\n\r ]*219[\t\n\r ]*,[\t\n\r ]*0?\.1[\t\n\r ]*\)(?![\s\S])/

// Iterate scalars without TextEncoder's replacement of malformed surrogates.
// The returned width is also the exact raw UTF-8 charge for the input budget.
function scalarAt(value, index) {
  const first = value.charCodeAt(index)
  if (first >= 0xd800 && first <= 0xdbff) {
    const second = value.charCodeAt(index + 1)
    if (!(second >= 0xdc00 && second <= 0xdfff)) invalid()
    return { units: 2, bytes: 4 }
  }
  if (first >= 0xdc00 && first <= 0xdfff || first === 0xfffe || first === 0xffff
    || first < 0x20 && first !== 9 && first !== 10 && first !== 13) invalid()
  return { units: 1, bytes: first < 0x80 ? 1 : first < 0x800 ? 2 : 3 }
}

function budget() {
  let inputBytes = 0, visited = 0
  return {
    input(count) {
      if (inputBytes + count > MAX_INPUT_BYTES) tooLarge()
      inputBytes += count
    },
    scan(value, maximum = MAX_VALUE_BYTES) {
      if (typeof value !== 'string') invalid()
      // UTF-8 cannot use fewer bytes than the UTF-16 length. Check this before
      // scanning or making bounded copies of a potentially enormous DOM value.
      if (value.length > maximum) tooLarge()
      let size = 0
      for (let index = 0; index < value.length;) {
        const scalar = scalarAt(value, index)
        size += scalar.bytes
        if (size > maximum) tooLarge()
        this.input(scalar.bytes)
        index += scalar.units
      }
      return value
    },
    visit(node, depth, parent, type = 1) {
      if (++visited > MAX_VISITED_NODES || depth > MAX_SOURCE_DEPTH) tooLarge()
      if (!node || node.nodeType !== type || node.parentNode !== parent) invalid()
      if (type === 1 && node.namespaceURI !== SVG_NAMESPACE) invalid()
    },
  }
}

function number(value, constraint = 'finite') {
  if (typeof value !== 'string' || !NUMBER_PATTERN.test(value)) invalid()
  if (value.length > MAX_NUMBER_CHARACTERS) tooLarge()
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || constraint === 'positive' && parsed <= 0
    || constraint === 'nonnegative' && parsed < 0) invalid()
  return value
}

function exact(value, accepted) {
  if (!accepted.includes(value)) invalid()
  return value
}

function normalizeStyle(role, name, value) {
  if (name === 'cursor' && ['path', 'rect', 'circle', 'edgeText'].includes(role)) return exact(value, ['pointer'])
  if (name === 'pointer-events') {
    if (role === 'rect' || role === 'edgeText') return exact(value, ['all'])
    if (role === 'nodeText') return exact(value, ['none'])
  }
  if (name === 'font-family' && (role === 'edgeText' || role === 'nodeText')) return exact(value, ['system-ui, sans-serif'])
  if (name === 'display') {
    if (role === 'rect' || role === 'edgeText') return exact(value, ['block', 'none'])
    if (role === 'nodeText') return exact(value, ['none'])
  }
  if (name === '-webkit-tap-highlight-color' && (role === 'svg' || role === 'circle') && transparentTap.test(value)) return 'transparent-tap'
  if (name === 'touch-action' && role === 'circle') return exact(value, ['none'])
  invalid()
}

function readStyles(node, role, raw, limits) {
  // Raw style is bounded before splitting. Validate it too: CSSOM alone would
  // silently discard unknown/invalid declarations and could alter the image.
  const declared = new Map()
  let declarations = 0
  for (const part of (raw ?? '').split(';')) {
    const declaration = trimCss(part)
    if (!declaration) continue
    if (++declarations > MAX_STYLES) tooLarge()
    const colon = declaration.indexOf(':')
    if (colon < 1) invalid()
    const name = trimCss(declaration.slice(0, colon))
    const value = normalizeStyle(role, name, trimCss(declaration.slice(colon + 1)))
    if (declared.has(name) && declared.get(name) !== value) invalid()
    declared.set(name, value)
  }
  const style = node.style
  if (!style || !Number.isSafeInteger(style.length) || style.length < 0) invalid()
  if (style.length > MAX_STYLES) tooLarge()
  const values = new Map()
  for (let index = 0; index < style.length; index++) {
    const name = limits.scan(style.item(index))
    const value = limits.scan(style.getPropertyValue(name))
    if (limits.scan(style.getPropertyPriority(name)) !== '' || values.has(name)) invalid()
    const normalized = normalizeStyle(role, name, value)
    if (declared.get(name) !== normalized) invalid()
    values.set(name, normalized)
  }
  if (values.size !== declared.size) invalid()
  if ((role === 'edgeText' || role === 'nodeText') && values.get('font-family') !== 'system-ui, sans-serif') invalid()
  if ((role === 'rect' || role === 'edgeText') && !values.has('display')) invalid()
  return values
}

function readElement(node, role, limits) {
  const attributes = node.attributes
  if (!attributes || !Number.isSafeInteger(attributes.length) || attributes.length < 0) invalid()
  if (attributes.length > MAX_ATTRIBUTES) tooLarge()
  const values = Object.create(null)
  for (let index = 0; index < attributes.length; index++) {
    const attribute = attributes[index]
    if (!attribute || attribute.namespaceURI != null) invalid()
    const name = limits.scan(attribute.name)
    const value = limits.scan(attribute.value)
    if (Object.hasOwn(values, name)) invalid()
    // Only Vue's empty, hexadecimal scope attributes are inert input. Other
    // data attributes, classes and event attributes are not a copying surface.
    if (/^data-v-[0-9a-f]{8}(?![\s\S])/.test(name)) {
      if (value !== '') invalid()
    } else if (name !== 'style' && !ATTRIBUTE_NAMES[role].has(name)) invalid()
    values[name] = value
  }
  if (role === 'svg' && values.class !== undefined) exact(values.class, ['graph-svg'])
  if (role === 'links' || role === 'nodes') exact(values.class, [role])
  return { attributes: values, styles: readStyles(node, role, values.style, limits) }
}

function noChildren(node) {
  if (node.firstChild !== null) invalid()
}

function writer(limits) {
  const chunks = []
  let outputBytes = 0
  const charge = count => {
    if (outputBytes + count > MAX_GRAPH_VIEW_SVG_BYTES) tooLarge()
    outputBytes += count
  }
  return {
    // All non-text output comes from fixed ASCII names/values or the closed
    // numeric/path grammar. Never put unvalidated DOM strings in this method.
    ascii(value) {
      charge(value.length)
      chunks.push(value)
    },
    open(name, attributes = [], selfClosing = false) {
      this.ascii(`<${name}`)
      for (const [key, value] of attributes) this.ascii(` ${key}="${value}"`)
      this.ascii(selfClosing ? '/>' : '>')
    },
    text(value) {
      if (typeof value !== 'string') invalid()
      if (value.length > MAX_LABEL_BYTES) tooLarge()
      let rawBytes = 0, pending = ''
      for (let index = 0; index < value.length;) {
        const scalar = scalarAt(value, index)
        rawBytes += scalar.bytes
        if (rawBytes > MAX_LABEL_BYTES) tooLarge()
        limits.input(scalar.bytes)
        const character = value.slice(index, index + scalar.units)
        const escaped = character === '&' ? '&amp;' : character === '<' ? '&lt;'
          : character === '>' ? '&gt;' : character === '"' ? '&quot;'
            : character === "'" ? '&apos;' : character === '\r' ? '&#13;' : character
        charge(escaped === character ? scalar.bytes : escaped.length)
        pending += escaped
        if (pending.length >= 2048) { chunks.push(pending); pending = '' }
        index += scalar.units
      }
      if (pending) chunks.push(pending)
    },
    finish() {
      const result = chunks.join('')
      // Defense in depth before the caller can create a Blob or object URL.
      if (new TextEncoder().encode(result).byteLength > MAX_GRAPH_VIEW_SVG_BYTES) tooLarge()
      return result
    },
  }
}

function textChild(node, hidden, limits, output) {
  const child = node.firstChild
  if (child === null) return
  limits.visit(child, 4, node, 3)
  if (child.nextSibling !== null || child.firstChild !== null) invalid()
  // Read only after display and direct-text topology are validated. A hidden
  // label may have arbitrarily large or invalid data; it never enters the file.
  if (!hidden) output.text(child.data)
}

function pathElement(node, limits, output) {
  const { attributes: a } = readElement(node, 'path', limits)
  noChildren(node)
  let match = null
  for (const pattern of PATH_PATTERNS) { match = pattern.exec(a.d); if (match) break }
  if (!match) invalid()
  for (let index = 1; index < match.length; index++) number(match[index])
  exact(a.fill, ['none'])
  exact(a.stroke, ['#C0C0C0', '#3498db', '#E91E63'])
  exact(a['stroke-width'], ['1.5', '3', '2.5'])
  output.open('path', [['d', a.d], ['fill', a.fill], ['stroke', a.stroke], ['stroke-width', a['stroke-width']]], true)
}

function backgroundElement(node, limits, output) {
  const { attributes: a, styles } = readElement(node, 'rect', limits)
  noChildren(node)
  number(a.x); number(a.y); number(a.width, 'nonnegative'); number(a.height, 'nonnegative')
  exact(a.rx, ['3']); exact(a.ry, ['3'])
  if (a.transform !== undefined && a.transform !== '') invalid()
  const paint = whiteBackground.test(a.fill) ? ['#fff', '0.95'] : blueBackground.test(a.fill) ? ['#3498db', '0.1'] : null
  if (!paint) invalid()
  const hidden = styles.get('display') === 'none'
  if (!hidden) output.open('rect', [['x', a.x], ['y', a.y], ['width', a.width], ['height', a.height],
    ['rx', '3'], ['ry', '3'], ['fill', paint[0]], ['fill-opacity', paint[1]]], true)
  return hidden
}

function circleElement(node, limits, output) {
  const { attributes: a } = readElement(node, 'circle', limits)
  noChildren(node)
  number(a.cx); number(a.cy); exact(a.r, ['10'])
  if (!PALETTE.has(a.fill)) invalid()
  exact(a.stroke, ['#fff', '#333', '#E91E63'])
  exact(a['stroke-width'], ['2.5', '3', '4'])
  output.open('circle', [['cx', a.cx], ['cy', a.cy], ['r', '10'], ['fill', a.fill],
    ['stroke', a.stroke], ['stroke-width', a['stroke-width']]], true)
}

function labelElement(node, role, limits, output, backgroundHidden) {
  const { attributes: a, styles } = readElement(node, role, limits)
  number(a.x); number(a.y)
  const hidden = styles.get('display') === 'none'
  const attributes = [['x', a.x], ['y', a.y]]
  if (role === 'edgeText') {
    if (hidden !== backgroundHidden || a.transform !== undefined && a.transform !== '') invalid()
    exact(a['font-size'], ['9px']); exact(a.fill, ['#666', '#3498db'])
    exact(a['text-anchor'], ['middle']); exact(a['dominant-baseline'], ['middle'])
    attributes.push(['font-size', '9px'], ['font-weight', 'normal'], ['fill', a.fill],
      ['text-anchor', 'middle'], ['dominant-baseline', 'middle'])
  } else {
    exact(a['font-size'], ['11px']); exact(a.fill, ['#333']); exact(a['font-weight'], ['500'])
    exact(a.dx, ['14']); exact(a.dy, ['4'])
    attributes.push(['font-size', '11px'], ['font-weight', '500'], ['fill', '#333'], ['dx', '14'], ['dy', '4'],
      ['text-anchor', 'start'], ['dominant-baseline', 'auto'])
  }
  attributes.push(['font-family', 'system-ui, sans-serif'])
  if (!hidden) output.open('text', attributes)
  textChild(node, hidden, limits, output)
  if (!hidden) output.ascii('</text>')
}

function linksGroup(group, limits, output) {
  if (group.localName !== 'g') invalid()
  readElement(group, 'links', limits)
  output.ascii('<g>')
  let child = group.firstChild, paths = 0, rects = 0, labels = 0, phase = 0
  const hiddenBackgrounds = []
  while (child !== null) {
    limits.visit(child, 3, group)
    if (child.localName === 'path' && phase === 0) {
      pathElement(child, limits, output); paths++
    } else if (child.localName === 'rect' && phase <= 1) {
      phase = 1
      if (++rects > paths) invalid()
      hiddenBackgrounds.push(backgroundElement(child, limits, output))
    } else if (child.localName === 'text' && rects === paths) {
      phase = 2
      if (labels >= paths) invalid()
      labelElement(child, 'edgeText', limits, output, hiddenBackgrounds[labels++])
    } else invalid()
    child = child.nextSibling
  }
  if (paths !== rects || paths !== labels) invalid()
  output.ascii('</g>')
}

function nodesGroup(group, limits, output) {
  if (group.localName !== 'g') invalid()
  readElement(group, 'nodes', limits)
  output.ascii('<g>')
  let child = group.firstChild, circles = 0, labels = 0, labeling = false
  while (child !== null) {
    limits.visit(child, 3, group)
    if (child.localName === 'circle' && !labeling) {
      circleElement(child, limits, output); circles++
    } else if (child.localName === 'text') {
      labeling = true
      if (++labels > circles) invalid()
      labelElement(child, 'nodeText', limits, output)
    } else invalid()
    child = child.nextSibling
  }
  if (circles === 0 || circles !== labels) invalid()
  output.ascii('</g>')
}

// Synchronous, closed adapter for GraphPanel's completed drawing. It reads no
// D3 data, computed style, textContent, layout bounds or live simulation state.
// The caller owns the exact capture descriptor and all download resources.
export function createGraphViewSvg(svgElement, rootElement) {
  try {
    const limits = budget(), output = writer(limits)
    if (!svgElement || svgElement.nodeType !== 1 || svgElement.localName !== 'svg'
      || svgElement.namespaceURI !== SVG_NAMESPACE || !rootElement
      || svgElement.firstChild !== rootElement || rootElement.nextSibling !== null) invalid()
    // The source SVG may have a parent outside the captured tree.
    limits.visit(svgElement, 0, svgElement.parentNode)
    limits.visit(rootElement, 1, svgElement)
    if (rootElement.localName !== 'g') invalid()
    const { attributes: svg } = readElement(svgElement, 'svg', limits)
    const { attributes: root } = readElement(rootElement, 'root', limits)
    number(svg.width, 'positive'); number(svg.height, 'positive')
    const viewBox = VIEWBOX_PATTERN.exec(svg.viewBox)
    if (!viewBox) invalid()
    number(viewBox[1], 'positive'); number(viewBox[2], 'positive')
    if (svg.preserveAspectRatio !== undefined) exact(svg.preserveAspectRatio, ['xMidYMid meet'])
    const transform = TRANSFORM_PATTERN.exec(root.transform)
    if (!transform) invalid()
    number(transform[1]); number(transform[2]); number(transform[3], 'positive')

    // One allowed CSS viewport measurement; it does not change the source's
    // last-render viewBox or ask SVG to recompute any label/graph geometry.
    const viewport = svgElement.getBoundingClientRect()
    if (!viewport || typeof viewport.width !== 'number' || typeof viewport.height !== 'number'
      || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)
      || viewport.width <= 0 || viewport.height <= 0) invalid()
    const width = number(String(viewport.width), 'positive'), height = number(String(viewport.height), 'positive')
    output.open('svg', [['xmlns', SVG_NAMESPACE], ['width', width], ['height', height], ['viewBox', `0 0 ${width} ${height}`],
      ['preserveAspectRatio', 'xMidYMid meet'], ['overflow', 'hidden']])
    output.open('rect', [['x', '0'], ['y', '0'], ['width', width], ['height', height], ['fill', '#FAFAFA']], true)
    output.open('svg', [['x', '0'], ['y', '0'], ['width', width], ['height', height], ['viewBox', svg.viewBox],
      ['preserveAspectRatio', 'xMidYMid meet'], ['overflow', 'hidden']])
    output.open('g', [['transform', root.transform]])
    const links = rootElement.firstChild
    if (!links) invalid()
    limits.visit(links, 2, rootElement)
    linksGroup(links, limits, output)
    const nodes = links.nextSibling
    if (!nodes) invalid()
    limits.visit(nodes, 2, rootElement)
    nodesGroup(nodes, limits, output)
    if (nodes.nextSibling !== null) invalid()
    output.ascii('</g></svg></svg>')
    return output.finish()
  } catch (cause) {
    // A DOM getter or method may throw an arbitrary object. Never inspect it.
    const code = cause === TOO_LARGE ? 'too_large' : 'invalid'
    const error = new Error(code === 'too_large' ? 'Graph view SVG exceeds a capture limit' : 'Invalid graph view SVG')
    error.code = code
    throw error
  }
}
