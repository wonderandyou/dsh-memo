/**
 * 无头截图：用本机 Edge 打开 preview/index.html 并截图。
 * 只看渲染结果，不连 DSH。
 *
 * 用法： node scripts/preview/screenshot.mjs [输出路径]
 */

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const here = import.meta.dirname
const page = path.join(here, 'index.html')
const out = path.resolve(process.argv[2] || path.join(here, 'panel.png'))
const hash = String(process.argv[3] || '')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmemo-shot-'))
const url = 'file:///' + page.replace(/\\/g, '/') + hash

const args = [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--window-size=1280,900',
  '--virtual-time-budget=5000',
  '--user-data-dir=' + profile,
  '--screenshot=' + out,
  url,
]

try {
  execFileSync(EDGE, args, { stdio: 'inherit' })
  const st = fs.statSync(out)
  console.log('screenshot: ' + out + ' (' + st.size + ' bytes)')
} catch (error) {
  console.error('edge failed: ' + String(error && error.message ? error.message : error))
  process.exitCode = 1
} finally {
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ }
}
