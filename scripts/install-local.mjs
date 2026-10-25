/**
 * dsh-memo · 本机安装脚本（幂等）
 * ============================================================================
 * 做三处（照 MEMO / AGENTS 的规矩，不动 app.asar、不碰 profile 的 cordis.patch.yml）：
 *   ① profile package.json: dependencies 加 link + dsh.profile.bundles 加名
 *   ② pnpm-lock.yaml: 补 importer 的 link 条目（否则下次 pnpm install 会还原）
 *   ③ node_modules\<name>: Junction 指向插件源码目录
 *
 * 每步都先备份；任何一步失败都不继续。改完读回校验。
 *
 * 用法： node scripts/install-local.mjs [profile目录]
 * ============================================================================
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const NAME = 'dsh-memo'
const pluginDir = path.resolve(import.meta.dirname, '..')
const profile = path.resolve(process.argv[2] || path.join(os.homedir(), '.dsh', 'profiles', 'desktop'))
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = path.join(profile, '_backup-memo-' + stamp)

function fail(msg) {
  console.error('FAIL: ' + msg)
  process.exit(1)
}

function log(msg) {
  console.log('  ' + msg)
}

function backup(file) {
  const dst = path.join(backupDir, path.basename(file))
  fs.mkdirSync(backupDir, { recursive: true })
  fs.copyFileSync(file, dst)
  log('backup ' + path.basename(file) + ' → ' + path.relative(profile, dst))
}

console.log('plugin  = ' + pluginDir)
console.log('profile = ' + profile)

if (!fs.existsSync(path.join(profile, 'package.json'))) fail('profile 里没有 package.json：' + profile)
if (!fs.existsSync(path.join(pluginDir, 'package.json'))) fail('插件目录不完整：' + pluginDir)

/* ------------------------------------------------------------ 1. package.json ---- */

const pkgPath = path.join(profile, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.dependencies = pkg.dependencies || {}
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []

const linkSpec = 'link:' + pluginDir.replace(/\\/g, '/')
let pkgChanged = false
if (pkg.dependencies[NAME] === linkSpec && pkg.dsh.profile.bundles.includes(NAME)) {
  log('package.json 已经装过（幂等跳过）')
} else {
  backup(pkgPath)
  pkg.dependencies[NAME] = linkSpec
  if (!pkg.dsh.profile.bundles.includes(NAME)) pkg.dsh.profile.bundles.push(NAME)
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  pkgChanged = true
  log('package.json: dependencies[' + NAME + '] = ' + linkSpec)
  log('package.json: bundles += ' + NAME)
}

// 读回校验（必须是合法 JSON，且两处都在）
const checkPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
if (checkPkg.dependencies[NAME] !== linkSpec) fail('package.json 读回校验失败：dependencies 没写上')
if (!checkPkg.dsh.profile.bundles.includes(NAME)) fail('package.json 读回校验失败：bundles 没写上')
log('package.json 读回校验 OK')

/* ----------------------------------------------------------- 2. pnpm-lock.yaml ---- */

const lockPath = path.join(profile, 'pnpm-lock.yaml')
if (fs.existsSync(lockPath)) {
  const lock = fs.readFileSync(lockPath, 'utf8')
  if (lock.includes('\n      ' + NAME + ':')) {
    log('pnpm-lock.yaml 已有条目（幂等跳过）')
  } else {
    backup(lockPath)
    const entry = '      ' + NAME + ':\n'
      + '        specifier: ' + linkSpec + '\n'
      + '        version: link:' + path.relative(path.join(profile, 'node_modules'), pluginDir).replace(/\\/g, '/') + '\n'
    const marker = '      dsh-qwen-paint:\n'
    if (!lock.includes(marker)) fail('pnpm-lock.yaml 结构不认识（找不到 dsh-qwen-paint 条目）')
    const next = lock.replace(marker, entry + marker)
    fs.writeFileSync(lockPath, next, 'utf8')
    log('pnpm-lock.yaml: + ' + NAME + ' (link)')
  }
  const checkLock = fs.readFileSync(lockPath, 'utf8')
  if (!checkLock.includes('\n      ' + NAME + ':')) fail('pnpm-lock.yaml 读回校验失败')
  log('pnpm-lock.yaml 读回校验 OK')
} else {
  log('没有 pnpm-lock.yaml，跳过（不影响启动）')
}

/* ------------------------------------------------------------- 3. junction ---- */

const linkPath = path.join(profile, 'node_modules', NAME)
if (fs.existsSync(linkPath)) {
  const st = fs.lstatSync(linkPath)
  if (st.isSymbolicLink() || st.isDirectory()) {
    const real = fs.realpathSync(linkPath)
    if (real.toLowerCase() === pluginDir.toLowerCase()) {
      log('node_modules 链接已存在且指向正确（幂等跳过）')
    } else {
      // 指向别处的旧链接：删掉重建（用 rmdir 语义，不递归删目标）
      fs.rmSync(linkPath, { recursive: false, force: true })
      fs.symlinkSync(pluginDir, linkPath, 'junction')
      log('node_modules 链接已重建 → ' + pluginDir)
    }
  } else {
    fail('node_modules 里 ' + NAME + ' 是普通文件，先手工处理：' + linkPath)
  }
} else {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  fs.symlinkSync(pluginDir, linkPath, 'junction')
  log('node_modules 链接已建 → ' + pluginDir)
}

// 通过链接读到 package.json 才算通
const viaLink = path.join(linkPath, 'package.json')
if (!fs.existsSync(viaLink)) fail('链接读不到 package.json：' + viaLink)
const viaPkg = JSON.parse(fs.readFileSync(viaLink, 'utf8'))
if (viaPkg.name !== NAME) fail('链接指向的包名不对：' + viaPkg.name)
log('node_modules 链接读回 OK（' + viaPkg.name + ' v' + viaPkg.version + '）')

/* ---------------------------------------------------------------- 摘要 ---- */

console.log('')
console.log('安装完成' + (pkgChanged ? '' : '（本来就有，未改动）') + '：')
console.log('  profile: ' + profile)
console.log('  backup : ' + backupDir)
console.log('  next   : 关掉 DSH 窗口重新打开（不是刷新），新插件在启动时加载')
