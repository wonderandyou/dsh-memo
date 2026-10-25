/**
 * dsh-memo · core 自测（不需要 DSH，直接 node 跑）
 * ============================================================================
 * 覆盖：索引解析、目录、按节取、搜索、项目别名、速查、状态、套路、追加（含回滚路径）。
 * 追加测试**只用临时副本**，绝不碰真实 MEMO.md。
 *
 * 用法： node scripts/selftest-core.mjs
 * ============================================================================
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemo } from '../lib/memo-core.js'

const MEMO = path.join(os.homedir(), '.dsh', 'MEMO.md')
const memo = createMemo(MEMO)

let pass = 0
let fail = 0

function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log('  PASS  ' + name + (detail ? '  — ' + detail : ''))
  } else {
    fail += 1
    console.log('  FAIL  ' + name + (detail ? '  — ' + detail : ''))
  }
}

function has(text, needle) {
  return typeof text === 'string' && text.includes(needle)
}

console.log('MEMO = ' + MEMO)
console.log('')

/* ------------------------------------------------------------------ 1. 索引 ---- */
console.log('[1] index')
const info = memo.info()
console.log('    chars=' + info.chars + ' lines=' + info.lines + ' sections=' + info.sections
  + ' projects=' + info.projects + ' playbooks=' + info.playbooks)
check('file exists / parsed', info.chars > 50000, info.chars + ' chars')
check('sections >= 25', info.sections >= 25, String(info.sections))
check('projects >= 18', info.projects >= 18, String(info.projects))
check('playbooks >= 12', info.playbooks >= 12, String(info.playbooks))

/* ---------------------------------------------------------------- 2. outline ---- */
console.log('[2] outline')
const outline = memo.outline({ depth: 2 })
check('contains §0.2', has(outline.text, '§0.2'), outline.chars + ' chars')
check('contains §3.6', has(outline.text, '§3.6'))
check('contains §5', has(outline.text, '§5'))
check('outline cheap (< 8k chars)', outline.chars < 8000, String(outline.chars))

/* ---------------------------------------------------------------- 3. section ---- */
console.log('[3] section')
const ports = memo.section('0.2')
check('0.2 ok', ports.ok === true)
check('0.2 has 8200', has(ports.text, '8200'))
check('0.2 has 8199', has(ports.text, '8199'))
const qq = memo.section('3.6')
check('3.6 ok', qq.ok === true, qq.chars + ' chars')
check('3.6 has VPS IP', has(qq.text, '43.226.58.253'))
const missing = memo.section('nope')
check('missing section → ok:false', missing.ok === false)

/* ----------------------------------------------------------------- 4. search ---- */
console.log('[4] search')
const s1 = memo.search('8199')
check('search 8199 hits', s1.hits > 0, s1.hits + ' hits, ' + s1.chars + ' chars')
const s2 = memo.search('NARB_DISABLE_NATIVE_CACHE')
check('search long token', s2.hits >= 1, s2.hits + ' hits')
const s3 = memo.search('port|端口')
check('regex search', s3.hits >= 1, s3.hits + ' hits')
const s4 = memo.search('zzz_no_such_thing_987')
check('no match → 0 hits', s4.hits === 0)
const s5 = memo.search('8199', { section: '0.2' })
check('scoped search', s5.hits >= 1 && s5.section === '0.2')

/* ---------------------------------------------------------------- 5. project ---- */
console.log('[5] project')
const p1 = memo.project('qq')
check('project qq → 3.6', p1.section === '3.6', p1.section)
const p2 = memo.project('乐谱')
check('project 乐谱 → 3.13', p2.section === '3.13', p2.section)
const p3 = memo.project('blender')
check('project blender → 3.12', p3.section === '3.12', p3.section)
const p4 = memo.project('zzz_not_a_project')
check('unknown project → ok:false', p4.ok === false, (p4.text || '').split('\n')[0])

/* ------------------------------------------------------------------ 6. quick ---- */
console.log('[6] quick')
for (const topic of ['machine', 'ports', 'interpreters', 'dirs', 'commands']) {
  const q = memo.quick(topic)
  check('quick ' + topic, q.ok === true, q.chars + ' chars')
}
check('quick unknown topic → ok:false', memo.quick('nope').ok === false)

/* ----------------------------------------------------------------- 7. status ---- */
console.log('[7] status')
const st = memo.status()
check('status ok', st.ok === true, st.chars + ' chars')
check('status has a project row', has(st.text, 'Workbench') || has(st.text, 'Projects'))

/* --------------------------------------------------------------- 8. playbook ---- */
console.log('[8] playbook')
const pb = memo.playbook('download')
check('playbook download', pb.ok === true, pb.chars + ' chars')
check('playbook content', has(pb.text, 'Download + verify'))
check('playbook unknown → ok:false', memo.playbook('zzz').ok === false)

/* ----------------------------------------------------------------- 9. append ---- */
console.log('[9] append (temp copy only)')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmemo-test-'))
const tmpFile = path.join(tmpDir, 'MEMO-test.md')
fs.copyFileSync(MEMO, tmpFile)
const draft = createMemo(tmpFile)
const before = draft.info()

const a1 = draft.append('end', '## 99. Selftest tail\n\nhello from selftest')
check('append end ok', a1.ok === true, a1.text)
const after1 = draft.info()
check('append grew file', after1.chars > before.chars, before.chars + ' → ' + after1.chars)
check('append content present', has(fs.readFileSync(tmpFile, 'utf8'), 'hello from selftest'))

const a2 = draft.append('6', 'selftest-note-in-section-6')
check('append to §6 ok', a2.ok === true, a2.text)
const text2 = fs.readFileSync(tmpFile, 'utf8')
check('section-6 note inserted before §7', text2.indexOf('selftest-note-in-section-6') < text2.indexOf('## 7.'))
check('only one copy inserted', (text2.split('selftest-note-in-section-6').length - 1) === 1)

const a3 = draft.append('nope-section', 'should not be written')
check('append bad section → ok:false', a3.ok === false, (a3.text || '').slice(0, 60))

// 清理（含 memo-backups）
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }

/* ------------------------------------------------------------------ summary ---- */
console.log('')
console.log('==============================================')
console.log('PASS ' + pass + ' / FAIL ' + fail)
console.log('==============================================')
if (fail > 0) process.exit(1)
