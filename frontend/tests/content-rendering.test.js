import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { parse, compileScript } from '@vue/compiler-sfc'
import { h, reactive, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'

// Load the actual component binding without mounting polling/network lifecycles.
async function componentBinding(filename, name, globals = {}) {
  const url = new URL(`../src/components/${filename}`, import.meta.url)
  const { descriptor } = parse(await readFile(url, 'utf8'))
  const script = compileScript(descriptor, { id: filename })
  for (const statement of script.scriptSetupAst) {
    if (statement.type === 'ImportDeclaration') {
      const binding = statement.specifiers.find(item => item.local.name === name)
      if (binding) return (await import(new URL(statement.source.value, url)))[binding.imported.name]
    }
    for (const declaration of statement.declarations || []) {
      if (declaration.id.name === name) {
        const code = descriptor.scriptSetup.content.slice(declaration.init.start, declaration.init.end)
        return vm.runInNewContext(`(${code})`, globals)
      }
    }
  }
  throw new Error(`Missing component binding: ${filename}:${name}`)
}

const payloads = [
  '<img src="https://example.invalid/pixel" onerror="window.injected = true">',
  '<svg onload="window.injected = true"></svg>',
  '<iframe src="https://example.invalid/"></iframe>',
  '<style>body { background: url(https://example.invalid/pixel) }</style>',
  '<a href="javascript:alert(1)">click</a>',
  '<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>',
  '<script>window.injected = true</script>',
]

for (const filename of ['Step4Report.vue', 'Step5Interaction.vue']) {
  const render = await componentBinding(filename, 'renderMarkdown')
  for (const [index, payload] of payloads.entries()) {
    test(`${filename} treats untrusted HTML ${index + 1} as text`, () => {
      const html = render(payload)
      assert.doesNotMatch(html, /<(?:img|svg|iframe|style|a|math|script)\b/i)
      assert.ok(html.includes('&lt;'), 'literal angle brackets must be escaped')
    })
  }
  test(`${filename} escapes raw HTML in code, quotes, headings and lists`, () => {
    for (const input of [
      '`<img src=x>`', '```html\n<img src=x>\n```',
      '> <img src=x>', '# <img src=x>', '- <img src=x>', '**<img src=x>**',
    ]) assert.doesNotMatch(render(input), /<img\b/i)
  })
  test(`${filename} preserves literal HTML entities without decoding markup`, () => {
    assert.ok(render('&lt;img src=x&gt; & &#60;svg&#62;').includes('&amp;lt;img'))
  })
  test(`${filename} preserves the supported Markdown layout`, () => {
    const html = render('## Repeated title\n\n### Section\n\n> Quote\n\n- **Bold**\n- *Italic*\n\n1. First\n\nDetail\n\n2. Second\n\n`code`\n\n---')
    assert.ok(!html.includes('Repeated title'))
    for (const fragment of ['<h4 class="md-h4">Section</h4>', '<blockquote class="md-quote">Quote</blockquote>', '<strong>Bold</strong>', '<em>Italic</em>', '<ul class="md-ul">', '<ol class="md-ol" start="2">', '<code class="inline-code">code</code>', '<hr class="md-hr">']) {
      assert.ok(html.includes(fragment), `missing ${fragment}`)
    }
    assert.equal(render(''), '')
  })
}

const renderMarkdown = await componentBinding('Step4Report.vue', 'renderMarkdown')
const renderInlineText = await componentBinding('Step4Report.vue', 'renderInlineText')
const InterviewDisplay = await componentBinding('Step4Report.vue', 'InterviewDisplay', {
  h, ref, reactive, renderMarkdown, renderInlineText, t: key => key,
})

test('actual interview answer, quotation and summary sinks escape HTML', async () => {
  const payload = '<img src="https://example.invalid/pixel" onerror="alert(1)">'
  const html = await renderToString(h(InterviewDisplay, { result: {
    interviews: [{ name: 'Agent', question: 'Question', twitterAnswer: payload, quotes: [payload] }],
    summary: payload,
  } }))
  assert.doesNotMatch(html, /<img\b/i)
  assert.equal((html.match(/&lt;img/g) || []).length, 3)
})

function findNode(node, className) {
  if (!node || typeof node !== 'object') return undefined
  const classes = [node.props?.class].flat().filter(item => typeof item === 'string').join(' ')
  if (classes.split(' ').includes(className)) return node
  for (const child of Array.isArray(node.children) ? node.children.flat() : []) {
    const found = findNode(child, className)
    if (found) return found
  }
}

test('interview expansion and platform switching keep both answers inert', async () => {
  const payload = '<svg onload="alert(1)"></svg>'
  const render = InterviewDisplay.setup({ result: {
    interviews: [{ name: 'Agent', question: 'Question', twitterAnswer: 'x'.repeat(405) + payload,
      redditAnswer: '**Reply**\n' + payload }],
  } })
  const assertSafe = async () => {
    const html = await renderToString(render())
    assert.doesNotMatch(html, /<svg onload/i)
    return html
  }
  assert.ok(!(await assertSafe()).includes('&lt;svg')) // collapsed text ends before the payload
  findNode(render(), 'expand-answer-btn').props.onClick()
  assert.ok((await assertSafe()).includes('&lt;svg'))
  const switcher = findNode(render(), 'platform-switch')
  switcher.children[1].props.onClick({ stopPropagation() {} })
  const switched = await assertSafe()
  assert.ok(switched.includes('<strong>Reply</strong><br>&lt;svg'))
  switcher.children[0].props.onClick({ stopPropagation() {} })
  assert.ok((await assertSafe()).includes('&lt;svg'))
  findNode(render(), 'expand-answer-btn').props.onClick()
  assert.ok(!(await assertSafe()).includes('&lt;svg'))
})

test('interview no-reply placeholder remains readable', async () => {
  const html = await renderToString(h(InterviewDisplay, { result: {
    interviews: [{ name: 'Agent', question: 'Question', twitterAnswer: '[无回复]' }],
  } }))
  assert.ok(html.includes('[无回复]'))
  assert.ok(!html.includes('expand-answer-btn'))
})
