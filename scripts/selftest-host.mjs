/**
 * dsh-memo · host 自测（假宿主，不启动 DSH）
 * ============================================================================
 * 用 mock 的 cordis root / tools / webServer 真跑一遍 apply()：
 *   · 工具注册数量与名字
 *   · 每个工具 execute 的结果形状（output.schema 要求 text/chars/tokens）
 *   · 面板端点的 JSON 结构（status / section / search）
 * 不写入任何文件（memo_append 不在这里调用）。
 *
 * 用法： node scripts/selftest-host.mjs
 * ============================================================================
 */

import path from 'node:path'
import os from 'node:os'
import { apply } from '../lib/index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  PASS  ' + name + (detail ? '  — ' + detail : '')) }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')) }
}

const tools = []
const routes = []
const logs = []

const webServer = {
  register(route) {
    routes.push(route)
    return () => {}
  },
}

const toolsCtx = {
  tools: { register(tool) { tools.push(tool) } },
  inject(services, cb) {
    if (services.includes('webServer')) cb({ webServer, effect: (fn) => fn() })
  },
  on() {},
  effect(fn) { fn(); return () => {} },
}

const root = {
  logger: {
    info: (m) => logs.push(m),
    warn: (m) => logs.push('WARN ' + m),
    error: (m) => logs.push('ERROR ' + m),
  },
  inject(services, cb) {
    if (services.includes('tools')) cb(toolsCtx)
  },
}

console.log('plugin = ' + path.resolve(import.meta.dirname, '..'))
apply(root, {})

/* ------------------------------------------------------------------ 工具 ---- */
console.log('[tools]')
const names = tools.map((t) => t.name)
console.log('    ' + names.join(', '))
check('8 tools registered', tools.length === 8, String(tools.length))
for (const name of ['memo_outline', 'memo_section', 'memo_search', 'memo_project', 'memo_quick', 'memo_status', 'memo_playbook', 'memo_append']) {
  check('has ' + name, names.includes(name))
}

function shapeOk(value) {
  return value && typeof value.text === 'string' && Number.isInteger(value.chars) && Number.isInteger(value.tokens)
}

async function runTool(name, args) {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error('missing tool ' + name)
  const value = await tool.execute(args)
  const rendered = tool.output.render(args, value)
  return { value, rendered }
}

const results = await (async () => {
  const out = {}
  out.outline = await runTool('memo_outline', { depth: 2 })
  out.ports = await runTool('memo_quick', { topic: 'ports' })
  out.search = await runTool('memo_search', { query: '8199' })
  out.project = await runTool('memo_project', { name: 'qq' })
  out.section = await runTool('memo_section', { section: '0.2' })
  out.status = await runTool('memo_status', {})
  out.playbook = await runTool('memo_playbook', { name: 'download' })
  return out
})()

check('memo_outline shape', shapeOk(results.outline.value))
check('memo_outline cheap (< 4k chars)', results.outline.value.chars < 4000, String(results.outline.value.chars))
check('memo_quick ports has 8200', results.ports.value.text.includes('8200'))
check('memo_search 8199 hits', results.search.value.hits > 0, String(results.search.value.hits))
check('memo_project qq → 3.6', results.project.value.section === '3.6')
check('memo_section 0.2', results.section.value.text.includes('8200'))
check('memo_status has table', results.status.value.text.includes('Workbench') || results.status.value.text.includes('Projects'))
check('memo_playbook download', results.playbook.value.text.includes('Download + verify'))
check('render returns text block', results.ports.rendered[0] && results.ports.rendered[0].type === 'text')

/* --------------------------------------------------------------- 端点 ---- */
console.log('[http endpoints]')
check('6 routes registered', routes.length === 6, routes.map((r) => r.path).join(', '))

function fakeReq(url) {
  return { url, headers: { host: '127.0.0.1:19387' }, socket: { remoteAddress: '127.0.0.1' } }
}
function fakeRes() {
  return {
    code: 200,
    headers: null,
    body: '',
    writeHead(code, headers) { this.code = code; this.headers = headers },
    end(text) { this.body = String(text) },
  }
}

async function callRoute(routePath, url) {
  const route = routes.find((r) => r.path === routePath)
  if (!route) throw new Error('missing route ' + routePath)
  const req = fakeReq(url || routePath)
  const res = fakeRes()
  await route.handler(req, res)
  return { code: res.code, json: JSON.parse(res.body) }
}

const st = await callRoute('/api/memo/status.json')
check('status 200', st.code === 200)
check('status ok/info', st.json.ok === true && st.json.info && st.json.info.lines > 100)
check('status sections array', Array.isArray(st.json.sections) && st.json.sections.length > 20)
check('status stats exists', st.json.stats && Number.isInteger(st.json.stats.calls))
check('status log is array', Array.isArray(st.json.log))
check('status records the calls above', st.json.stats.calls >= 7, 'calls=' + st.json.stats.calls)

const sec = await callRoute('/api/memo/section.json', '/api/memo/section.json?id=3.6')
check('section endpoint', sec.json.ok === true && sec.json.text.includes('43.226.58.253'))

const srch = await callRoute('/api/memo/search.json', '/api/memo/search.json?q=8199')
check('search endpoint', srch.json.ok === true && srch.json.hits >= 1)

/* 非本机请求应被拒 */
const route = routes.find((r) => r.path === '/api/memo/status.json')
const badReq = { url: '/api/memo/status.json', headers: { host: 'evil.example.com' }, socket: { remoteAddress: '10.0.0.5' } }
const badRes = fakeRes()
await route.handler(badReq, badRes)
check('non-local request refused', badRes.code === 403, 'code=' + badRes.code)

console.log('')
console.log('==============================================')
console.log('PASS ' + pass + ' / FAIL ' + fail)
console.log('==============================================')
if (fail > 0) process.exit(1)
