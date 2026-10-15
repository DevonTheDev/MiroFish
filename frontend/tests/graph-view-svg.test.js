import assert from 'node:assert/strict'
import test from 'node:test'
import { createGraphViewSvg, MAX_GRAPH_VIEW_SVG_BYTES } from '../src/utils/graphViewSvg.js'

// This small fixture supplies only the DOM surfaces consumed by the fixed
// drawing adapter. It does not establish native browser rendering.
const SVG = 'http://www.w3.org/2000/svg'
const bytes = value => Buffer.byteLength(value, 'utf8')
const textNode = data => ({ nodeType: 3, data, parentNode: null, nextSibling: null, firstChild: null })
function children(parent, values) {
  parent.firstChild = values[0] ?? null
  values.forEach((child, index) => {
    child.parentNode = parent
    child.nextSibling = values[index + 1] ?? null
  })
  return parent
}
function element(localName, values = {}, declarations = {}, childNodes = []) {
  const attributes = Object.entries(values).map(([name, value]) => ({ name, value: String(value), namespaceURI: null }))
  const styles = Object.entries(declarations)
  const node = {
    nodeType: 1, namespaceURI: SVG, localName, attributes,
    firstChild: null, nextSibling: null, parentNode: null,
    style: {
      get length() { return styles.length },
      item: index => styles[index]?.[0] ?? '',
      getPropertyValue: name => styles.find(item => item[0] === name)?.[1] ?? '',
      getPropertyPriority: () => '',
    },
    setAttribute(name, value) {
      const existing = attributes.find(attribute => attribute.name === name)
      if (existing) existing.value = String(value)
      else attributes.push({ name, value: String(value), namespaceURI: null })
    },
    setStyle(name, value) {
      const existing = styles.find(item => item[0] === name)
      if (existing) existing[1] = value
      else styles.push([name, value])
      this.setAttribute('style', styles.map(([key, item]) => `${key}: ${item};`).join(' '))
    },
    removeAttribute(name) {
      const index = attributes.findIndex(attribute => attribute.name === name)
      if (index !== -1) attributes.splice(index, 1)
    },
  }
  if (styles.length) node.setAttribute('style', styles.map(([key, value]) => `${key}: ${value};`).join(' '))
  return children(node, childNodes)
}
function drawing({ edgeCount = 3, nodeCount = 2, label = 'literal label' } = {}) {
  const paths = Array.from({ length: edgeCount }, (_, index) => element('path', {
    d: ['M1,2 L3,4', 'M1,2 Q3,4 5,6', 'M8,-4 A30,30 0 1,1 8,4'][index % 3],
    fill: 'none', stroke: '#C0C0C0', 'stroke-width': '1.5',
  }, { cursor: 'pointer' }))
  const backgrounds = paths.map(() => element('rect', {
    fill: 'rgba(255,255,255,0.95)', rx: '3', ry: '3', x: '-4', y: '5', width: '60', height: '13', transform: '',
  }, { cursor: 'pointer', 'pointer-events': 'all', display: 'block' }))
  const edgeLabels = paths.map(() => element('text', {
    'font-size': '9px', fill: '#666', 'text-anchor': 'middle', 'dominant-baseline': 'middle', x: '20', y: '10', transform: '',
  }, { cursor: 'pointer', 'pointer-events': 'all', 'font-family': 'system-ui, sans-serif', display: 'block' }, [textNode(label)]))
  const circles = Array.from({ length: nodeCount }, () => element('circle', {
    r: '10', fill: '#FF6B35', stroke: '#fff', 'stroke-width': '2.5', cx: '1', cy: '2',
  }, { cursor: 'pointer' }))
  const nodeLabels = circles.map(() => element('text', {
    'font-size': '11px', fill: '#333', 'font-weight': '500', dx: '14', dy: '4', x: '1', y: '2',
  }, { 'pointer-events': 'none', 'font-family': 'system-ui, sans-serif' }, [textNode(label)]))
  const links = element('g', { class: 'links' }, {}, [...paths, ...backgrounds, ...edgeLabels])
  const nodes = element('g', { class: 'nodes' }, {}, [...circles, ...nodeLabels])
  const root = element('g', { transform: 'translate(-12.5,23) scale(1.25)' }, {}, [links, nodes])
  const svg = element('svg', { class: 'graph-svg', width: '800', height: '600', viewBox: '0 0 800 600' }, {}, [root])
  let measurements = 0
  svg.getBoundingClientRect = () => { measurements++; return { width: 900.5, height: 450.25 } }
  return { svg, root, links, nodes, paths, backgrounds, edgeLabels, circles, nodeLabels,
    measurements: () => measurements, capture: () => createGraphViewSvg(svg, root) }
}
const rejects = (fixture, code = 'invalid') => assert.throws(fixture.capture, error => error.code === code)
function allElements(node, result = []) {
  if (node.nodeType === 1) result.push(node)
  for (let child = node.firstChild; child; child = child.nextSibling) allElements(child, result)
  return result
}
// Matches the contract's scanned strings: each attribute name/value, each
// CSSOM property name/value/priority, and each visible direct text-node value.
function scannedBytes(node) {
  let total = 0
  for (const current of allElements(node)) {
    for (const attribute of current.attributes) total += bytes(attribute.name) + bytes(attribute.value)
    for (let index = 0; index < current.style.length; index++) {
      const name = current.style.item(index)
      total += bytes(name) + bytes(current.style.getPropertyValue(name)) + bytes(current.style.getPropertyPriority(name))
    }
    if (current.localName === 'text' && current.style.getPropertyValue('display') !== 'none' && current.firstChild) total += bytes(current.firstChild.data)
  }
  return total
}
function setPayload(fixture, length, character = 'a') {
  const labels = fixture.nodeLabels
  for (const label of labels) label.firstChild.data = ''
  for (const label of labels) {
    const count = Math.min(length, 65536)
    label.firstChild.data = character.repeat(count)
    length -= count
  }
  assert.equal(length, 0, 'the bounded fixture has enough label capacity')
}

test('SVG capture preserves viewport, source viewBox, root transform and fixed primitive order', () => {
  const h = drawing()
  const output = h.capture()
  assert.equal(h.measurements(), 1)
  assert.match(output, /<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="900.5" height="450.25" viewBox="0 0 900.5 450.25"/)
  assert.match(output, /<rect x="0" y="0" width="900.5" height="450.25" fill="#FAFAFA"\/>/)
  assert.match(output, /<svg x="0" y="0" width="900.5" height="450.25" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid meet" overflow="hidden">/)
  assert.match(output, /<g transform="translate\(-12.5,23\) scale\(1.25\)">/)
  assert.ok(output.indexOf('M1,2 L3,4') < output.indexOf('M1,2 Q3,4 5,6'))
  assert.ok(output.indexOf('M8,-4 A30,30 0 1,1 8,4') < output.indexOf('fill-opacity="0.95"'))
  assert.ok(output.indexOf('font-size="9px"') < output.indexOf('<circle'))
  assert.ok(output.indexOf('<circle') < output.indexOf('font-size="11px"'))
  assert.match(output, /font-family="system-ui, sans-serif"/)
  assert.match(output, /font-weight="normal"/)
  assert.match(output, /font-weight="500"/)
  assert.doesNotMatch(output, /class=|style=|data-v-|cursor|pointer-events/)
})

test('SVG capture normalizes known background rgba and preserves actual selected paints', () => {
  const h = drawing()
  h.paths[0].setAttribute('stroke', '#E91E63')
  h.paths[0].setAttribute('stroke-width', '2.5')
  h.circles[0].setAttribute('stroke', '#E91E63')
  h.circles[0].setAttribute('stroke-width', '4')
  h.backgrounds[0].setAttribute('fill', 'rgba(52, 152, 219, 0.1)')
  h.edgeLabels[0].setAttribute('fill', '#3498db')
  const output = h.capture()
  assert.match(output, /stroke="#E91E63" stroke-width="2.5"/)
  assert.match(output, /stroke="#E91E63" stroke-width="4"/)
  assert.match(output, /fill="#3498db" fill-opacity="0.1"/)
  for (const color of ['#FF6B35', '#004E89', '#7B2D8E', '#1A936F', '#C5283D', '#E9724C', '#3498db', '#9b59b6', '#27ae60', '#f39c12', '#999']) {
    h.circles[0].setAttribute('fill', color)
    assert.ok(h.capture().includes(`fill="${color}"`))
  }
})

test('SVG capture admits only the exact D3 touch style exceptions and strips them', () => {
  const h = drawing()
  h.svg.setStyle('-webkit-tap-highlight-color', 'rgba(0, 0, 0, 0)')
  h.circles[0].setStyle('-webkit-tap-highlight-color', 'rgba(0,0,0,0)')
  h.circles[0].setStyle('touch-action', 'none')
  assert.doesNotMatch(h.capture(), /tap-highlight|touch-action/)
  h.svg.setStyle('touch-action', 'none')
  rejects(h)
  const bad = drawing()
  bad.circles[0].setStyle('-webkit-tap-highlight-color', 'rgba(1, 0, 0, 0)')
  rejects(bad)
})

test('SVG capture escapes literal XML, preserves CR, multibyte and supplementary characters', () => {
  const h = drawing({ label: '<&>"\'\r\n\t中文😀' })
  const output = h.capture()
  assert.ok(output.includes('&lt;&amp;&gt;&quot;&apos;&#13;\n\t中文😀'))
  assert.doesNotMatch(output, /xml:space|<!DOCTYPE|<!\[CDATA/)
})

test('SVG capture rejects the fixed XML 1.0 invalid-character table', () => {
  for (const value of ['\u0000', '\u0001', '\u0008', '\u000b', '\u000c', '\u001f', '\ufffe', '\uffff', '\ud800', '\udfff', 'a\ud83d…']) rejects(drawing({ label: value }))
  assert.doesNotThrow(drawing({ label: '\u0020\ud7ff\ue000\ufffd\u{10000}\u{10ffff}' }).capture)
})

test('SVG capture omits hidden label values before reading them but validates their structure', () => {
  const h = drawing()
  for (const label of [...h.edgeLabels, ...h.nodeLabels]) {
    label.setStyle('display', 'none')
    Object.defineProperty(label.firstChild, 'data', { get() { throw new Error('hidden text was read') } })
  }
  for (const background of h.backgrounds) background.setStyle('display', 'none')
  const output = h.capture()
  assert.doesNotMatch(output, /<text|fill-opacity/)
  children(h.nodeLabels[0], [textNode('first'), textNode('second')])
  rejects(h)
})

test('SVG capture rejects mismatched hidden edge-label pairs', () => {
  const h = drawing()
  h.edgeLabels[0].setStyle('display', 'none')
  rejects(h)
})

test('SVG capture requires the exact root, one SVG child and positive node count', () => {
  const h = drawing()
  assert.throws(() => createGraphViewSvg(h.svg, element('g')), error => error.code === 'invalid')
  children(h.svg, [h.root, element('g')])
  rejects(h)
  rejects(drawing({ nodeCount: 0 }))
})

test('SVG capture rejects unsupported topology, child order, counts and namespaces', () => {
  for (const change of [
    h => children(h.root, [h.nodes, h.links]),
    h => children(h.links, [...h.paths, ...h.edgeLabels, ...h.backgrounds]),
    h => children(h.nodes, [...h.circles, ...h.nodeLabels.slice(1)]),
    h => children(h.paths[0], [textNode('stray')]),
    h => children(h.root, [h.links, h.nodes, { nodeType: 8, nextSibling: null }]),
    h => { h.circles[0].localName = 'foreignObject' },
    h => { h.circles[0].namespaceURI = 'http://www.w3.org/1999/xhtml' },
  ]) {
    const h = drawing(); change(h); rejects(h)
  }
})

test('SVG capture rejects unknown attributes, classes, styles and CSS priorities', () => {
  for (const change of [
    h => h.paths[0].setAttribute('onclick', 'run()'),
    h => h.paths[0].setAttribute('href', 'https://example.test'),
    h => h.root.setAttribute('data-record', 'private'),
    h => h.links.setAttribute('class', 'links extra'),
    h => h.paths[0].setStyle('filter', 'url(#secret)'),
    h => h.nodeLabels[0].setStyle('font-family', 'serif'),
    h => h.svg.setAttribute('style', 'unrecognized: ignored;'),
    h => { h.paths[0].style.getPropertyPriority = () => 'important' },
  ]) {
    const h = drawing(); change(h); rejects(h)
  }
})

test('SVG capture rejects malformed paths and finite-number grammar without trailing syntax', () => {
  for (const path of ['M0,0 L1,1 Z', 'M0,0 C1,2 3,4 5,6', 'M0,0 A31,30 0 1,1 1,1', 'M0,0 LNaN,1', 'M0,0 LInfinity,1', 'M0,0 L0x10,1', 'M0,0 L01,1', 'M0,0 L+1,1', 'M0,0 L1.,1', 'M0,0 L1E2,1', 'M0,0 L1,1\n']) {
    const h = drawing(); h.paths[0].setAttribute('d', path); rejects(h)
  }
  for (const value of ['NaN', 'Infinity', '1e999', '0x10', '01', '1px', '1\n', '1\r', '1\u2028']) {
    const h = drawing(); h.circles[0].setAttribute('cx', value); rejects(h)
  }
  const h = drawing(); h.paths[0].setAttribute('d', 'M-1.5e+2,2e-3 Q0,4 -5,6'); assert.doesNotThrow(h.capture)
})

test('SVG capture rejects unsupported transforms, dimensions and missing completed geometry', () => {
  for (const change of [
    h => h.root.setAttribute('transform', 'matrix(1 0 0 1 0 0)'),
    h => h.root.setAttribute('transform', 'translate(0,0) scale(0)'),
    h => h.root.setAttribute('transform', 'translate(0,0) scale(1)\n'),
    h => h.svg.setAttribute('viewBox', '1 0 800 600'),
    h => h.svg.setAttribute('viewBox', '0 0 800 0'),
    h => h.svg.setAttribute('viewBox', '0 0 800 600\n'),
    h => h.svg.setAttribute('preserveAspectRatio', 'none'),
    h => h.backgrounds[0].setAttribute('width', '-1'),
    h => h.backgrounds[0].setAttribute('rx', '4'),
    h => h.circles[0].setAttribute('r', '11'),
    h => h.circles[0].removeAttribute('cx'),
    h => h.paths[0].removeAttribute('d'),
    h => { h.svg.getBoundingClientRect = () => ({ width: NaN, height: 1 }) },
    h => { h.svg.getBoundingClientRect = () => ({ width: 1, height: 0 }) },
  ]) {
    const h = drawing(); change(h); rejects(h)
  }
})

test('SVG capture reads current geometry without mutating the live drawing or measuring labels', () => {
  const h = drawing()
  h.paths[0].setAttribute('d', 'M99,8 L7,6')
  const before = JSON.stringify(allElements(h.svg).map(node => node.attributes))
  for (const node of allElements(h.svg)) {
    node.setAttribute = node.setStyle = node.removeAttribute = () => { throw new Error('mutation') }
    node.getBBox = () => { throw new Error('label geometry was recomputed') }
    Object.defineProperty(node, 'textContent', { get() { throw new Error('unbounded textContent read') } })
    Object.defineProperty(node, 'outerHTML', { get() { throw new Error('generic serialization') } })
  }
  assert.ok(h.capture().includes('M99,8 L7,6'))
  assert.equal(h.measurements(), 1)
  assert.equal(JSON.stringify(allElements(h.svg).map(node => node.attributes)), before)
})

test('SVG capture admits 64 KiB visible UTF-8 labels and rejects the first extra byte', () => {
  const h = drawing({ edgeCount: 0, nodeCount: 1, label: 'é'.repeat(32768) })
  assert.doesNotThrow(h.capture)
  h.nodeLabels[0].firstChild.data += 'a'
  rejects(h, 'too_large')
})

test('SVG capture admits 16 attributes and rejects attribute 17 before reading its value', () => {
  const h = drawing({ edgeCount: 0, nodeCount: 1 })
  for (let index = 0; index < 15; index++) h.links.setAttribute(`data-v-${index.toString(16).padStart(8, '0')}`, '')
  assert.equal(h.links.attributes.length, 16)
  assert.doesNotThrow(h.capture)
  h.links.attributes.push({ name: 'data-v-ffffffff', get value() { throw new Error('over-cap value read') } })
  rejects(h, 'too_large')
})

test('SVG capture bounds raw style declarations at eight including repeated inert declarations', () => {
  const h = drawing()
  h.paths[0].setAttribute('style', 'cursor: pointer;'.repeat(8))
  assert.doesNotThrow(h.capture)
  h.paths[0].setAttribute('style', 'cursor: pointer;'.repeat(9))
  rejects(h, 'too_large')
})

test('SVG capture admits a 512-byte attribute value and rejects byte 513 before parsing', () => {
  const h = drawing()
  h.paths[0].setAttribute('style', 'cursor: pointer;'.padEnd(512, ' '))
  assert.doesNotThrow(h.capture)
  h.paths[0].setAttribute('style', 'cursor: pointer;'.padEnd(513, ' '))
  rejects(h, 'too_large')
  const path = drawing()
  path.paths[0].setAttribute('d', 'M0,0 L1,1'.padEnd(512, ' '))
  rejects(path)
  path.paths[0].setAttribute('d', 'M0,0 L1,1'.padEnd(513, ' '))
  rejects(path, 'too_large')
})

test('SVG capture admits 32-character numeric tokens and rejects character 33', () => {
  const h = drawing()
  h.circles[0].setAttribute('cx', '0.' + '1'.repeat(30))
  assert.doesNotThrow(h.capture)
  h.circles[0].setAttribute('cx', '0.' + '1'.repeat(31))
  rejects(h, 'too_large')
})

test('SVG capture admits source depth four and rejects deeper or nested label content', () => {
  const h = drawing()
  assert.doesNotThrow(h.capture)
  children(h.nodeLabels[0], [element('text', {}, {}, [textNode('depth five')])])
  rejects(h)
})

test('SVG capture counts hidden text nodes at the 50000-node traversal boundary', () => {
  const h = drawing({ edgeCount: 0, nodeCount: 16666, label: '' })
  children(h.nodeLabels[0], [])
  children(h.nodeLabels[1], [])
  for (const label of h.nodeLabels) label.setStyle('display', 'none')
  assert.doesNotThrow(h.capture, 'four structural nodes, 16666 circles, 16666 texts, 16664 text children')
  children(h.nodeLabels[0], [textNode('')])
  rejects(h, 'too_large')
})

test('SVG capture admits exactly 8 MiB scanned input and rejects the first extra byte', () => {
  const h = drawing({ edgeCount: 0, nodeCount: 2000, label: '' })
  for (const label of h.nodeLabels) {
    const style = label.attributes.find(attribute => attribute.name === 'style')
    style.value = style.value.padEnd(512, ' ')
  }
  setPayload(h, 8388608 - scannedBytes(h.svg))
  assert.equal(scannedBytes(h.svg), 8388608)
  assert.ok(bytes(h.capture()) < MAX_GRAPH_VIEW_SVG_BYTES)
  h.nodeLabels.at(-1).firstChild.data += 'a'
  rejects(h, 'too_large')
})

test('SVG capture bounds escaped UTF-8 output at 8 MiB including all wrappers', () => {
  assert.equal(MAX_GRAPH_VIEW_SVG_BYTES, 8388608)
  const h = drawing({ edgeCount: 0, nodeCount: 32, label: '' })
  const overhead = bytes(h.capture())
  const payload = MAX_GRAPH_VIEW_SVG_BYTES - overhead
  setPayload(h, Math.floor(payload / 5), '&')
  h.nodeLabels.at(-1).firstChild.data += 'a'.repeat(payload % 5)
  assert.ok(scannedBytes(h.svg) < 8388608)
  assert.equal(bytes(h.capture()), MAX_GRAPH_VIEW_SVG_BYTES)
  h.nodeLabels.at(-1).firstChild.data += 'a'
  rejects(h, 'too_large')
})
