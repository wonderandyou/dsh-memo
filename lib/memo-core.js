/**
 * dsh-memo · core
 * ============================================================================
 * 纯逻辑层：解析 MEMO.md，提供「按需取用」的查询接口。
 * 不 import 任何 DSH 模块、不碰网络、不依赖 React —— 这样可以在普通 node 里
 * 直接跑自测（scripts/selftest-core.mjs），也能被 host 半边复用。
 *
 * 设计目标只有一个：**用几百 token 回答一个具体问题**，而不是把整份备忘录
 * （~99 KB / ~30k token）塞进上下文。
 *
 * 所有查询统一返回 { text, chars, tokens, ... }：
 *   text   —— 给模型看的紧凑文本（唯一进入上下文的部分）
 *   chars  —— 本次返回的字符数（面板统计用）
 *   tokens —— 按 chars/tokenChars 估的 token（展示用，不追求精确）
 * ============================================================================
 */

import fs from 'node:fs'
import path from 'node:path'

/** 中英混排的经验值：3.2 个字符 ≈ 1 token。只在展示时用，不影响正确性。 */
const DEFAULT_TOKEN_CHARS = 3.2

export function estimateTokens(chars, tokenChars = DEFAULT_TOKEN_CHARS) {
  if (!Number.isFinite(chars) || chars <= 0) return 0
  return Math.max(1, Math.ceil(chars / tokenChars))
}

/** 数字加千分位（1,234）。 */
function nf(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function stripHash(title) {
  return title.replace(/^#+\s*/, '').trim()
}

/**
 * 建一个备忘录索引。
 * @param {string} filePath - MEMO.md 的绝对路径
 * @param {{tokenChars?: number}} [opts]
 */
export function createMemo(filePath, opts = {}) {
  const tokenChars = Number.isFinite(opts.tokenChars) && opts.tokenChars > 0
    ? opts.tokenChars
    : DEFAULT_TOKEN_CHARS
  let state = null

  /* ------------------------------------------------------------ 解析 ---- */

  function build() {
    const stat = fs.statSync(filePath)
    const text = fs.readFileSync(filePath, 'utf8')
    const lines = text.split(/\r?\n/)

    // 1) 标题（## / ###）
    const heads = []
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^(#{2,3})\s+(.+?)\s*$/.exec(lines[i])
      if (m !== null) {
        heads.push({ level: m[1].length, title: m[2].trim(), start: i })
      }
    }

    // 2) 每节的区间：到下一个「同级或更高级」标题之前
    const sections = []
    for (let k = 0; k < heads.length; k += 1) {
      const h = heads[k]
      let end = lines.length - 1
      for (let j = k + 1; j < heads.length; j += 1) {
        if (heads[j].level <= h.level) {
          end = heads[j].start - 1
          break
        }
      }
      while (end > h.start && lines[end].trim() === '') end -= 1
      const body = lines.slice(h.start, end + 1).join('\n')
      const idm = /^(\d+(?:\.\d+)?)[.)]?\s+/.exec(h.title)
      sections.push({
        id: idm !== null ? idm[1] : 'h' + String(h.start + 1),
        level: h.level,
        title: stripHash(h.title),
        start: h.start,
        end,
        chars: body.length,
        tokens: estimateTokens(body.length, tokenChars),
      })
    }

    // 3) 项目卡 = §3 下的三级子节
    const projects = sections.filter((s) => /^3\.\d+$/.test(s.id))

    // 4) playbook = §5 里 "**P<n> 名字**" 的段落
    //    两种写法都要支持：
    //      **P1 Download + verify (every download)**      ← 标题独占一行，正文在下面
    //      **P2 Package audit** — pip freeze → …           ← 标题 + 破折号正文，全在一行
    const five = sections.find((s) => s.id === '5')
    const playbooks = []
    if (five !== undefined) {
      for (let i = five.start; i <= five.end; i += 1) {
        const m = /^\*\*(P\d+)\s+(.+?)\*\*(.*)$/.exec(lines[i])
        if (m === null) continue
        playbooks.push({
          name: m[2].trim(),
          code: m[1],
          start: i,
          end: i,
          inline: m[3].trim() !== '',
        })
      }
      for (let k = 0; k < playbooks.length; k += 1) {
        const p = playbooks[k]
        if (!p.inline) {
          const next = playbooks[k + 1]
          let end = next !== undefined ? next.start - 1 : five.end
          while (end > p.start && lines[end].trim() === '') end -= 1
          p.end = end
        }
        p.chars = lines.slice(p.start, p.end + 1).join('\n').length
      }
    }

    state = {
      path: filePath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      text,
      lines,
      sections,
      projects,
      playbooks,
      builtAt: Date.now(),
    }
    return state
  }

  function idx() {
    let stat
    try {
      stat = fs.statSync(filePath)
    } catch (error) {
      throw new Error('备忘录文件读不到：' + filePath + '（' + String(error && error.message ? error.message : error) + '）')
    }
    if (state !== null && state.mtimeMs === stat.mtimeMs && state.size === stat.size) return state
    return build()
  }

  /* -------------------------------------------------------- 基础查询 ---- */

  function info() {
    const s = idx()
    const chars = s.text.length
    return {
      path: s.path,
      name: path.basename(s.path),
      chars,
      lines: s.lines.length,
      sections: s.sections.length,
      projects: s.projects.length,
      playbooks: s.playbooks.length,
      tokens: estimateTokens(chars, tokenChars),
      mtimeMs: s.mtimeMs,
      builtAt: s.builtAt,
      size: s.size,
    }
  }

  /** 结构化目录（面板用）：只回 id/标题/行号/字符数，不带正文。 */
  function listSections() {
    const s = idx()
    return s.sections.map((x) => ({
      id: x.id,
      title: x.title,
      level: x.level,
      start: x.start + 1,
      end: x.end + 1,
      chars: x.chars,
      tokens: x.tokens,
    }))
  }

  function findSection(id) {
    const s = idx()
    const want = String(id ?? '').trim().replace(/^§/, '')
    if (want === '') return null
    const exact = s.sections.find((x) => x.id === want)
    if (exact !== undefined) return exact
    // "3.6" / "3.6 " / "3" 都能命中；再加个按标题包含的兜底
    const alt = s.sections.find((x) => x.id.toLowerCase() === want.toLowerCase())
    if (alt !== undefined) return alt
    return null
  }

  function sectionText(sec) {
    const s = idx()
    return s.lines.slice(sec.start, sec.end + 1).join('\n')
  }

  function outline({ depth = 2 } = {}) {
    const s = idx()
    const title = 'MEMO ' + nf(s.text.length) + ' chars · ' + nf(s.lines.length) + ' lines'
      + ' · ' + s.sections.length + ' sections · ' + s.projects.length + ' project cards'
      + ' · ' + s.playbooks.length + ' playbooks'
    const rows = [title]
    for (const sec of s.sections) {
      if (depth === 1 && sec.level === 3) continue
      const pad = sec.level === 3 ? '  ' : ''
      rows.push(pad + '§' + sec.id + ' ' + sec.title
        + ' — L' + (sec.start + 1) + '-' + (sec.end + 1)
        + ', ' + nf(sec.chars) + ' chars (~' + nf(sec.tokens) + ' tok)')
    }
    rows.push('')
    rows.push('hint: memo_section <id> 取一节；memo_project <名> 取项目卡；memo_search <词> 搜全文')
    const text = rows.join('\n')
    return { text, chars: text.length, tokens: estimateTokens(text.length, tokenChars) }
  }

  function section(id, { maxChars = 24000 } = {}) {
    const sec = findSection(id)
    if (sec === null) {
      return {
        ok: false,
        text: '没有这一节：' + String(id) + '。先用 memo_outline 看目录。',
        chars: 0,
        tokens: 0,
      }
    }
    let body = sectionText(sec)
    let truncated = false
    if (body.length > maxChars) {
      body = body.slice(0, maxChars)
      truncated = true
    }
    const footer = '[§' + sec.id + ' ' + sec.title + ' · L' + (sec.start + 1) + '-' + (sec.end + 1)
      + ' · ' + nf(sec.chars) + ' chars ≈ ' + nf(sec.tokens) + ' tok'
      + (truncated ? ' · TRUNCATED at ' + nf(maxChars) : '') + ']'
    const text = body + '\n\n' + footer
    return {
      ok: true,
      text,
      chars: text.length,
      tokens: estimateTokens(text.length, tokenChars),
      section: sec.id,
      title: sec.title,
      truncated,
      totalChars: sec.chars,
    }
  }

  /** 把「行号」映射到所属章节标题（最近的 start <= line）。 */
  function sectionOfLine(lineNo) {
    const s = idx()
    let best = null
    for (const sec of s.sections) {
      if (sec.start <= lineNo) {
        if (best === null || sec.start > best.start) best = sec
      }
    }
    return best
  }

  function toRegex(query) {
    const raw = String(query ?? '')
    if (raw.trim() === '') return null
    try {
      return new RegExp(raw, 'iu')
    } catch {
      // 不是合法正则 → 当字面量（转义所有元字符）
      return new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
    }
  }

  function search(query, { context = 1, maxHits = 8, maxChars = 4200, section: only = null } = {}) {
    const s = idx()
    const re = toRegex(query)
    if (re === null) {
      return { ok: false, text: 'query 不能为空', chars: 0, tokens: 0, hits: 0, total: 0 }
    }
    const onlySec = only !== null ? findSection(only) : null
    const from = onlySec !== null ? onlySec.start : 0
    const to = onlySec !== null ? onlySec.end : s.lines.length - 1
    const hits = []
    for (let i = from; i <= to; i += 1) {
      if (re.test(s.lines[i])) hits.push(i)
    }
    const total = hits.length
    if (total === 0) {
      const text = '没有命中「' + String(query) + '」（共 ' + nf(s.lines.length) + ' 行）。'
        + '换关键词试试，或用 memo_outline 看目录。'
      return { ok: true, text, chars: text.length, tokens: estimateTokens(text.length, tokenChars), hits: 0, total: 0 }
    }
    // 合并相邻命中（避免同一段重复输出）
    const blocks = []
    for (const line of hits) {
      const last = blocks[blocks.length - 1]
      if (last !== undefined && line - last.end <= context * 2 + 1) {
        last.end = line
      } else {
        blocks.push({ start: line, end: line })
      }
    }
    const rows = []
    let used = 0
    let shown = 0
    for (const block of blocks) {
      if (shown >= maxHits) break
      const a = Math.max(from, block.start - context)
      const b = Math.min(to, block.end + context)
      const sec = sectionOfLine(block.start)
      const head = 'L' + (block.start + 1)
        + (sec !== null ? ' §' + sec.id + ' ' + sec.title.slice(0, 40) : '')
      const chunk = [head]
      for (let i = a; i <= b; i += 1) {
        chunk.push('  ' + s.lines[i])
      }
      const piece = chunk.join('\n')
      if (used + piece.length > maxChars) break
      rows.push(piece)
      used += piece.length + 1
      shown += 1
    }
    const more = total - shown
    const footer = '[' + nf(total) + ' hit(s), showing ' + shown
      + (more > 0 ? ', ' + nf(more) + ' more' : '')
      + ' · ' + nf(used) + ' chars ≈ ' + nf(estimateTokens(used, tokenChars)) + ' tok]'
    const text = rows.join('\n\n') + '\n\n' + footer
    return {
      ok: true,
      text,
      chars: text.length,
      tokens: estimateTokens(text.length, tokenChars),
      hits: total,
      total,
      shown,
      section: onlySec !== null ? onlySec.id : null,
    }
  }

  /* ------------------------------------------------------- 语义入口 ---- */

  const QUICK = {
    machine: '0.1',
    ports: '0.2',
    interpreters: '0.3',
    dirs: '0.4',
    commands: '0.5',
    one: '0.5',
  }

  function quick(topic) {
    const key = String(topic ?? '').trim().toLowerCase()
    const id = QUICK[key] !== undefined ? QUICK[key] : null
    if (id === null) {
      return {
        ok: false,
        text: 'topic 只能是：machine / ports / interpreters / dirs / commands（或 0.1-0.5 的节号）。',
        chars: 0,
        tokens: 0,
      }
    }
    return section(id, { maxChars: 12000 })
  }

  const PROJECT_ALIASES = [
    { id: '3.1', keys: ['dsh', 'plugin', '插件', 'harness', 'reasoning', 'people'] },
    { id: '3.2', keys: ['workstation', '工作站', '8200'] },
    { id: '3.3', keys: ['image', '生图', 'qwen', 'comfy', '千问', '绘图', '8199'] },
    { id: '3.4', keys: ['workbench', '超级ai', '工作台', 'pywebview'] },
    { id: '3.5', keys: ['site', 'website', '网站', 'wonderandyou', 'console', '控制台', 'guest'] },
    { id: '3.6', keys: ['qq', 'bot', 'wechat', '微信', 'vps', 'napcat', 'forward', '转发', '机器人'] },
    { id: '3.7', keys: ['mc', 'minecraft', 'mod', 'whalefall', 'hells', '地狱', '我的世界'] },
    { id: '3.8', keys: ['cyberpunk', '2077', 'redscript', '赛博', '黑墙'] },
    { id: '3.9', keys: ['audio', '音频', 'tts', 'seed-vc', 'f5', 'music', '音乐', '翻唱', '合成音'] },
    { id: '3.10', keys: ['live2d', 'seeThrough', 'moc3', '立绘'] },
    { id: '3.11', keys: ['uiagent', 'automation', '自动化', '鼠标', '画图'] },
    { id: '3.12', keys: ['blender', 'render', 'multipass', '穿模', '公交站', 'rain'] },
    { id: '3.13', keys: ['score', '乐谱', 'omr', 'audiveris', 'midi'] },
    { id: '3.14', keys: ['remotion', 'video', '视频'] },
    { id: '3.15', keys: ['android', '安卓', 'apk', '点名', 'emulator'] },
    { id: '3.16', keys: ['screen', '屏幕', 'red', '红屏', 'screenguard', 'monitor'] },
    { id: '3.17', keys: ['tool', '小工具', 'wps', 'ncm', 'docx', 'ffmpeg'] },
    { id: '3.18', keys: ['security', 'audit', '安全', '审计', 'credential', '凭据', 'sandbox', '沙箱', 'pe'] },
  ]

  function project(name) {
    const q = String(name ?? '').trim()
    if (q === '') {
      const list = idx().projects.map((p) => '§' + p.id + ' ' + p.title).join('\n')
      return { ok: false, text: '给个名字。可选：\n' + list, chars: 0, tokens: 0 }
    }
    const low = q.toLowerCase()
    // 1) 直接按节号（3.6、§3.6）
    const direct = findSection(low.replace(/^§/, ''))
    if (direct !== null && /^3\.\d+$/.test(direct.id)) {
      return section(direct.id)
    }
    // 2) 别名表
    for (const alias of PROJECT_ALIASES) {
      if (alias.keys.some((k) => low.includes(k.toLowerCase()))) {
        return section(alias.id)
      }
    }
    // 3) 标题包含
    const hit = idx().projects.find((p) => p.title.toLowerCase().includes(low))
    if (hit !== undefined) return section(hit.id)
    const list = idx().projects.map((p) => '§' + p.id + ' ' + p.title).join('\n')
    return {
      ok: false,
      text: '没匹配到项目「' + q + '」。可选：\n' + list,
      chars: 0,
      tokens: 0,
    }
  }

  function status() {
    const sec = findSection('6')
    if (sec === null) return { ok: false, text: '备忘录里没有 §6 状态表', chars: 0, tokens: 0 }
    return section('6')
  }

  function playbook(name) {
    const s = idx()
    const q = String(name ?? '').trim()
    if (q === '') {
      const list = s.playbooks.map((p) => 'P' + p.code.slice(1) + ' ' + p.name).join('\n')
      return { ok: false, text: '给个套路名。可选：\n' + list, chars: 0, tokens: 0 }
    }
    const low = q.toLowerCase()
    const hit = s.playbooks.find((p) => p.name.toLowerCase().includes(low))
      || s.playbooks.find((p) => low.includes(p.name.toLowerCase().split(' ')[0]))
    if (hit === undefined) {
      return {
        ok: false,
        text: '没有这个套路「' + q + '」。可选：\n' + s.playbooks.map((p) => 'P' + p.code.slice(1) + ' ' + p.name).join('\n'),
        chars: 0,
        tokens: 0,
      }
    }
    const body = s.lines.slice(hit.start, hit.end + 1).join('\n')
    const footer = '[§5 ' + hit.name + ' · ' + nf(hit.chars) + ' chars ≈ ' + nf(estimateTokens(hit.chars, tokenChars)) + ' tok]'
    const text = body + '\n\n' + footer
    return { ok: true, text, chars: text.length, tokens: estimateTokens(text.length, tokenChars), section: '5', title: hit.name }
  }

  /* ----------------------------------------------------------- 写入 ---- */

  function append(sectionId, content, { backupDir } = {}) {
    const s = idx()
    const body = String(content ?? '')
    if (body.trim() === '') {
      return { ok: false, text: 'content 不能为空', chars: 0, tokens: 0 }
    }
    const target = String(sectionId ?? '').trim().replace(/^§/, '')
    let insertAt = s.lines.length // 默认追加到文件末尾
    let targetSec = null
    if (target !== '' && target !== 'end') {
      targetSec = findSection(target)
      if (targetSec === null) {
        return {
          ok: false,
          text: '没有这一节：' + target + '（不想追加到末尾就用 section=end）',
          chars: 0,
          tokens: 0,
        }
      }
      insertAt = targetSec.end + 1
    }
    // 备份（失败就不写）
    const dir = backupDir !== undefined && backupDir !== null
      ? backupDir
      : path.join(path.dirname(s.path), 'memo-backups')
    let backup = null
    try {
      fs.mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      backup = path.join(dir, 'MEMO-' + stamp + '.md')
      fs.copyFileSync(s.path, backup)
    } catch (error) {
      return {
        ok: false,
        text: '备份失败，未写入：' + String(error && error.message ? error.message : error),
        chars: 0,
        tokens: 0,
      }
    }
    // 拼新内容：去掉原行尾空行，插一个空行再放正文
    const head = s.lines.slice(0, insertAt)
    while (head.length > 0 && head[head.length - 1].trim() === '') head.pop()
    const tail = s.lines.slice(insertAt)
    const merged = head.concat(['', body.trim(), '']).concat(tail)
    const nextText = merged.join('\n')
    try {
      fs.writeFileSync(s.path, nextText, 'utf8')
    } catch (error) {
      return {
        ok: false,
        text: '写入失败（备份在 ' + backup + '）：' + String(error && error.message ? error.message : error),
        chars: 0,
        tokens: 0,
      }
    }
    // 读回校验：字符数变多、目标节仍存在、新内容只出现一次
    const check = build()
    const newChars = check.text.length
    const grew = newChars > s.text.length
    const count = check.text.split(body.trim()).length - 1
    const okSection = targetSec === null || check.sections.some((x) => x.id === targetSec.id)
    if (!grew || count !== 1 || !okSection) {
      try { fs.copyFileSync(backup, s.path) } catch { /* 回滚失败只能报错 */ }
      return {
        ok: false,
        text: '读回校验没过，已回滚（' + (grew ? '' : '没变长；') + 'count=' + count + '）。备份：' + backup,
        chars: 0,
        tokens: 0,
      }
    }
    const text = '已追加到 ' + (targetSec !== null ? '§' + targetSec.id : '文件末尾')
      + '：+' + nf(newChars - s.text.length) + ' chars，现 '
      + nf(check.text.length) + ' chars / ' + nf(check.lines.length) + ' lines。备份：' + backup
    return { ok: true, text, chars: text.length, tokens: estimateTokens(text.length, tokenChars) }
  }

  /* ----------------------------------------------------------- 分类 ---- */

  /**
   * 按「用途」给所有节归类 —— 面板目录用它折叠分组。
   * 规则只看节号前缀，不认标题文字：换一份备忘录（节号约定相同）也能自动归好。
   */
  const CATEGORY_RULES = [
    { key: 'quick', label: '速查', hint: '机器 / 端口 / 解释器 / 目录', match: (id) => /^0(\.\d+)?$/.test(id) },
    { key: 'env', label: '环境与坑', hint: '踩过的坑 / 网络与下载 / 工作方式', match: (id) => /^(1|2|4|7)(\.\d+)?$/.test(id) },
    { key: 'projects', label: '项目', hint: '每个项目一张卡', match: (id) => /^3(\.\d+)?$/.test(id) },
    { key: 'playbook', label: '套路', hint: '可复用的标准步骤', match: (id) => /^5(\.\d+)?$/.test(id) },
    { key: 'status', label: '状态', hint: '每个项目做到哪一步', match: (id) => /^6(\.\d+)?$/.test(id) },
  ]

  /** 哪些节的区间里还套着别的节（父节）—— 父节的正文等于所有子节之和，不能重复处理。 */
  function parentStarts(s) {
    const parents = new Set()
    for (const sec of s.sections) {
      for (const other of s.sections) {
        if (other !== sec && other.start > sec.start && other.start <= sec.end) {
          parents.add(sec.start)
          break
        }
      }
    }
    return parents
  }

  function classify() {
    const s = idx()
    const parents = parentStarts(s)
    const groups = []
    const byKey = Object.create(null)
    for (const rule of CATEGORY_RULES) {
      const g = { key: rule.key, label: rule.label, hint: rule.hint, chars: 0, tokens: 0, sections: [] }
      byKey[rule.key] = g
      groups.push(g)
    }
    const other = { key: 'topic', label: '专题', hint: '独立专题笔记', chars: 0, tokens: 0, sections: [] }
    groups.push(other)
    for (const sec of s.sections) {
      let rule = null
      for (const r of CATEGORY_RULES) {
        if (r.match(sec.id)) { rule = r; break }
      }
      const g = rule !== null ? byKey[rule.key] : other
      const isParent = parents.has(sec.start)
      g.sections.push({
        id: sec.id,
        title: sec.title,
        level: sec.level,
        chars: sec.chars,
        tokens: sec.tokens,
        start: sec.start + 1,
        end: sec.end + 1,
        parent: isParent,
      })
      // 父节的 chars 含全部子节，累加会重复计数 —— 只统计叶子节
      if (!isParent) {
        g.chars += sec.chars
        g.tokens += sec.tokens
      }
    }
    return groups.filter((g) => g.sections.length > 0)
  }

  /* ------------------------------------------------------ 精简备忘录 ---- */

  const LITE_NAME = 'MEMO.lite.md'

  function litePath() {
    return path.join(path.dirname(filePath), LITE_NAME)
  }

  /**
   * 给一行打「信息密度」分。分数越高越该留在精简版里。
   * 判据都是中文技术笔记里真能拉开差距的：表格、路径、端口、命令、坑。
   */
  function scoreLine(line, inCode) {
    const t = line.trim()
    if (t === '') return 0
    if (/^#{2,3}\s/u.test(t)) return 100
    if (inCode) return 30
    let score = 0
    if (/^\|/u.test(t)) score = Math.max(score, 45)
    if (/[A-Za-z]:\\|~[\\/]|\/api\/|\.(exe|bat|cmd|py|md|json|ya?ml|safetensors|gguf)\b/u.test(t)) score = Math.max(score, 42)
    if (/:\d{4,5}\b|127\.0\.0\.1|localhost/u.test(t)) score = Math.max(score, 36)
    if (/\b(pip|npm|pnpm|node|git|curl|wget|python|powershell|pwsh|nvidia-smi|ffmpeg|docker)\b/iu.test(t)) score = Math.max(score, 30)
    if (/坑|踩过|注意|不要|禁止|必须|铁律|教训|回滚|备份/u.test(t)) score = Math.max(score, 30)
    if (/^[-*]\s/u.test(t)) score = Math.max(score, 22)
    if (/^\d+\.\s/u.test(t)) score = Math.max(score, 18)
    // 又长又没信号 = 散文，直接丢
    if (t.length > 160 && score < 25) return 0
    return score
  }

  /**
   * 生成精简版：同目录 MEMO.lite.md，**绝不改原文件**。
   * 目标比例 ratio（默认 0.16）按节分别计算预算，节短于 minKeep 的全留。
   */
  function compact(opts = {}) {
    const ratio = Number.isFinite(opts.ratio) && opts.ratio > 0 && opts.ratio < 1 ? opts.ratio : 0.16
    const s = idx()
    const parents = parentStarts(s)
    const out = []
    let droppedLines = 0
    let keptLines = 0
    const perSection = []

    for (const sec of s.sections) {
      const body = s.lines.slice(sec.start, sec.end + 1)
      // 父节（§0 / §3 / §27 …）正文就是所有子节之和：只留标题，
      // 正文交给下面的子节各自输出，否则同一段内容会被压两遍。
      if (parents.has(sec.start)) {
        const titleOnly = body[0]
        out.push(titleOnly)
        keptLines += 1
        perSection.push({ id: sec.id, title: sec.title, before: sec.chars, after: titleOnly.length })
        continue
      }
      // 短节不值得压，整段留着
      const short = sec.chars <= 700
      const budget = short ? sec.chars : Math.max(280, Math.ceil(sec.chars * ratio))
      const kept = []
      let inCode = false
      let codeLines = 0
      for (const line of body) {
        const t = line.trim()
        if (/^```/u.test(t)) {
          inCode = !inCode
          codeLines = 0
          kept.push({ line, score: 70 })
          continue
        }
        if (inCode) {
          codeLines += 1
          if (codeLines <= 3) {
            kept.push({ line, score: 40 })
            keptLines += 1
          } else {
            droppedLines += 1
          }
          continue
        }
        const score = scoreLine(line, false)
        if (score > 0) {
          kept.push({ line, score })
          keptLines += 1
        } else if (t !== '') {
          droppedLines += 1
        }
      }
      if (inCode) kept.push({ line: '```', score: 70 }) // 代码块没闭合就补上

      let chars = kept.reduce((acc, k) => acc + k.line.length + 1, 0)
      const dropped = new Set()
      if (!short && chars > budget) {
        const order = []
        for (let i = 0; i < kept.length; i += 1) {
          if (kept[i].score < 100) order.push({ i, score: kept[i].score })
        }
        order.sort((a, b) => a.score - b.score)
        for (const o of order) {
          if (chars <= budget) break
          dropped.add(o.i)
          chars -= kept[o.i].line.length + 1
          droppedLines += 1
          keptLines -= 1
        }
      }

      const text = []
      for (let i = 0; i < kept.length; i += 1) {
        if (!dropped.has(i)) text.push(kept[i].line)
      }
      // 同一节内压掉的行用一行省略号表示，保持可读
      const merged = text.join('\n').replace(/\n{3,}/g, '\n\n').trim()
      const finalText = dropped.size > 0 ? merged + '\n\n> …（本节省略 ' + dropped.size + ' 行低密度内容）' : merged
      out.push(finalText)
      perSection.push({ id: sec.id, title: sec.title, before: sec.chars, after: finalText.length })
    }

    const fullChars = s.text.length
    const body = out.join('\n\n')
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
    const head = [
      '# MEMO 精简版 · 给 AI 速览用',
      '',
      '> 由 dsh-memo 从 `' + path.basename(s.path) + '` 自动精简生成，**原文件未改动**。',
      '> 规模：' + nf(fullChars) + ' chars → ' + nf(body.length) + ' chars'
        + '（省 ' + Math.max(0, Math.round((1 - body.length / Math.max(1, fullChars)) * 100)) + '%）'
        + ' · 生成于 ' + stamp,
      '> 需要细节时按节号取原文：`memo_section <节号>`。',
      '',
    ].join('\n')
    const text = head + body + '\n'
    const target = litePath()
    try {
      fs.writeFileSync(target, text, 'utf8')
    } catch (error) {
      return {
        ok: false,
        text: '写精简版失败：' + String(error && error.message ? error.message : error),
        chars: 0,
        tokens: 0,
      }
    }
    const savedPct = Math.max(0, Math.round((1 - text.length / Math.max(1, fullChars)) * 100))
    const summary = '已生成精简版 ' + path.basename(target)
      + '：' + nf(fullChars) + ' → ' + nf(text.length) + ' chars（省 ' + savedPct + '%）'
      + ' · 保留 ' + s.sections.length + ' 个标题 / ' + nf(keptLines) + ' 行，压掉 ' + nf(droppedLines) + ' 行'
      + ' · 原文件一字未动'
    return {
      ok: true,
      text: summary,
      chars: summary.length,
      tokens: estimateTokens(summary.length, tokenChars),
      lite: { path: target, chars: text.length, before: fullChars, savedPct, keptLines, droppedLines, sections: s.sections.length, perSection },
    }
  }

  /** 读精简版（没有就让调用方去生成）。 */
  function lite(opts = {}) {
    const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 40000
    const target = litePath()
    let raw
    try {
      raw = fs.readFileSync(target, 'utf8')
    } catch {
      return {
        ok: false,
        text: '还没有精简版（' + path.basename(target) + ' 不存在）。让主人在面板里点「精简备忘录」，或调用 memo_compact。',
        chars: 0,
        tokens: 0,
      }
    }
    let body = raw
    let truncated = false
    if (body.length > maxChars) {
      body = body.slice(0, maxChars)
      truncated = true
    }
    const footer = '[MEMO 精简版 · ' + nf(raw.length) + ' chars ≈ ' + nf(estimateTokens(raw.length, tokenChars)) + ' tok'
      + (truncated ? ' · TRUNCATED at ' + nf(maxChars) : '') + ']'
    const text = body + '\n\n' + footer
    return {
      ok: true,
      text,
      chars: text.length,
      tokens: estimateTokens(text.length, tokenChars),
      truncated,
    }
  }

  /* --------------------------------------------------------- 导出面 ---- */

  return {
    path: filePath,
    info,
    listSections,
    outline,
    section,
    search,
    quick,
    project,
    status,
    playbook,
    append,
    classify,
    compact,
    lite,
    litePath,
    estimate: (chars) => estimateTokens(chars, tokenChars),
    tokenChars,
  }
}
