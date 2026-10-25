/**
 * dsh-memo — 宿主半边（Host half）
 * ============================================================================
 * 让「查备忘录」变成一次几百 token 的精确调用，而不是把 99 KB 的
 * MEMO.md 整份读进上下文。
 *
 * 注册 8 个工具：
 *   memo_outline   目录（先看结构，几百 token）
 *   memo_section   取一节（按节号）
 *   memo_search    全文搜索（关键词/正则，带上下文与行号）
 *   memo_project   按项目取卡（中文名/别名都能命中）
 *   memo_quick     速查表（机器/端口/解释器/目录/命令）
 *   memo_status    当前状态表（§6）
 *   memo_playbook  取一个可复用套路（§5）
 *   memo_append    追加内容（写之前先备份，写完读回校验）
 *
 * 另外注册 3 个只读 HTTP 端点，供客户端面板显示「我查了什么」：
 *   /api/memo/status.json   索引元数据 + 本次运行统计 + 最近查询
 *   /api/memo/section.json  某一节（面板内预览）
 *   /api/memo/search.json   面板里的搜索框
 *
 * 设计约束（照 MEMO 的教训）：
 *   · 只用局部 root.inject(['tools', ...])，不用对象级 inject；
 *   · webServer 是可选服务，缺了照常提供工具，只是没有面板数据；
 *   · 任何异常都不许把 DSH 启动拖垮 —— 工具内部 try/catch，路由回 200 + 可读原因；
 *   · 只放行本机请求（面板与本人用，不给外部）。
 * ============================================================================
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMemo } from './memo-core.js'

/** 插件自己的目录（lib/ 的上一层），用来定位 assets 里的动画视频。 */
const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SHELF_VIDEO = path.join(PLUGIN_ROOT, 'assets', 'memo-shelf.webm')

const DEFAULTS = {
  // 留空 → 自动取 ~/.dsh/MEMO.md（别人装了也能直接跑）
  file: null,
  // 中英混排的 token 估算系数（只用于展示）
  tokenChars: 3.2,
}

/** 统一的工具结果 schema（DSH 会强校验 output.schema）。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', description: '给模型看的紧凑文本' },
    chars: { type: 'integer', description: '本次返回字符数' },
    tokens: { type: 'integer', description: '估算 token' },
    hits: { type: 'integer', description: '命中条数（没有则为 0）' },
    section: { type: 'string', description: '涉及的节号（没有则为空串）' },
  },
  required: ['text', 'chars', 'tokens'],
}

function makeLog(root) {
  return (level, message) => {
    try {
      const logger = root?.logger
      if (logger && typeof logger[level] === 'function') logger[level]('[memo] ' + message)
      else if (level === 'warn' || level === 'error') console.error('[memo] ' + message)
    } catch {
      /* 日志失败不影响插件 */
    }
  }
}

function isLocalRequest(req) {
  const host = String(req?.headers?.host ?? '').toLowerCase()
  const remote = String(req?.socket?.remoteAddress ?? '')
  const hostOk = host === '' || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/u.test(host)
  const remoteOk = remote === '' || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  return hostOk && remoteOk
}

function respondJson(res, body, code = 200) {
  try {
    const text = JSON.stringify(body)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(text)
  } catch (error) {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, reason: String(error?.message ?? error) }))
    } catch {
      /* 连接已经没了 */
    }
  }
}

/** 把工具结果规整成 schema 要求的形状（永不 undefined）。 */
function shape(result) {
  return {
    text: String(result?.text ?? ''),
    chars: Number.isFinite(result?.chars) ? result.chars : String(result?.text ?? '').length,
    tokens: Number.isFinite(result?.tokens) ? result.tokens : 0,
    hits: Number.isFinite(result?.hits) ? result.hits : 0,
    section: typeof result?.section === 'string' ? result.section : '',
  }
}

/**
 * 插件入口。
 * @param root - cordis root
 * @param rawConfig - cordis.patch.yml 里的 config
 */
export function apply(root, rawConfig) {
  const cfg = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const log = makeLog(root)

  const memoFile = typeof cfg.file === 'string' && cfg.file.trim() !== ''
    ? cfg.file
    : path.join(os.homedir(), '.dsh', 'MEMO.md')

  let memo = null
  try {
    memo = createMemo(memoFile, { tokenChars: cfg.tokenChars })
    const info = memo.info()
    log('info', '已加载备忘录 ' + info.path + '（' + info.lines + ' 行 / ' + info.chars + ' 字符）')
  } catch (error) {
    // 文件不存在也照常启动：工具会在被调用时返回可读错误。
    log('warn', '备忘录加载失败（工具仍会注册，调用时会报原因）：' + String(error?.message ?? error))
    memo = createMemo(memoFile, { tokenChars: cfg.tokenChars })
  }

  /* -------------------------------------------------- 统计与查询日志 ---- */

  const stats = {
    calls: 0,
    chars: 0,
    tokens: 0,
    errors: 0,
    startedAt: Date.now(),
    byTool: Object.create(null),
  }
  const rows = []
  const logFile = path.join(path.dirname(memoFile), 'memo-plugin', 'query-log.jsonl')

  function record(tool, arg, result, isError) {
    try {
      stats.calls += 1
      if (isError) stats.errors += 1
      stats.chars += Number.isFinite(result?.chars) ? result.chars : 0
      stats.tokens += Number.isFinite(result?.tokens) ? result.tokens : 0
      const byTool = stats.byTool[tool] ?? { calls: 0, chars: 0 }
      byTool.calls += 1
      byTool.chars += Number.isFinite(result?.chars) ? result.chars : 0
      stats.byTool[tool] = byTool

      let fullChars = 0
      try { fullChars = memo.info().chars } catch { fullChars = 0 }
      const row = {
        t: Date.now(),
        tool,
        arg: String(arg ?? '').slice(0, 80),
        chars: Number.isFinite(result?.chars) ? result.chars : 0,
        tokens: Number.isFinite(result?.tokens) ? result.tokens : 0,
        hits: Number.isFinite(result?.hits) ? result.hits : 0,
        section: typeof result?.section === 'string' ? result.section : '',
        savedPct: fullChars > 0
          ? Math.min(99, Math.max(0, Math.round((1 - (Number.isFinite(result?.chars) ? result.chars : 0) / fullChars) * 100)))
          : 0,
        ok: !isError,
      }
      rows.push(row)
      if (rows.length > 240) rows.shift()
      try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true })
        fs.appendFileSync(logFile, JSON.stringify(row) + '\n', 'utf8')
      } catch {
        /* 落盘失败不影响工具本身 */
      }
    } catch {
      /* 统计失败绝不影响结果 */
    }
  }

  function safeCall(tool, arg, fn) {
    try {
      const result = fn()
      record(tool, arg, result, result?.ok === false)
      return shape(result)
    } catch (error) {
      const text = '备忘录查询失败：' + String(error?.message ?? error)
      const result = { ok: false, text, chars: text.length, tokens: 0, hits: 0 }
      record(tool, arg, result, true)
      return shape(result)
    }
  }

  /* ------------------------------------------------------------ 工具 ---- */

  /** 建一个工具定义（不依赖 defineTool：register 直接吃这个对象）。 */
  function makeTool(spec) {
    return {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      timeoutMs: 20000,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      // 只读查询彼此无副作用；append 自己串行由调用方保证。
      isConcurrencySafe: () => spec.name !== 'memo_append',
      async execute(args) {
        return spec.run(args ?? {})
      },
    }
  }

  const TOOLS = [
    makeTool({
      name: 'memo_outline',
      description:
        '看本机备忘录（MEMO.md）的目录：每节的编号、标题、行号、字符数与估算 token。'
        + '开局或不知道去哪查时**先调这个**（几百 token），再按编号取节。'
        + '避免整份读：整份约 99 KB / 30k token，这里只要几百。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          depth: {
            type: 'integer',
            description: '1 = 只要顶级章节；2 = 含子节（默认 2）',
          },
        },
      },
      run(args) {
        return safeCall('memo_outline', 'depth=' + (args.depth ?? 2), () =>
          memo.outline({ depth: Number.isFinite(args.depth) ? args.depth : 2 }))
      },
    }),

    makeTool({
      name: 'memo_section',
      description:
        '按节号取备忘录的一节原文（如 0.2 端口、3.6 QQ 机器人、5 套路、6 状态）。'
        + '比读整份省 95% 以上。不知道节号就先 memo_outline。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          section: { type: 'string', description: '节号，如 "0.2"、"3.6"、"5"' },
          maxChars: { type: 'integer', description: '最多返回多少字符（默认 24000，超出截断）' },
        },
        required: ['section'],
      },
      run(args) {
        const id = String(args.section ?? '')
        return safeCall('memo_section', id, () =>
          memo.section(id, { maxChars: Number.isFinite(args.maxChars) ? args.maxChars : 24000 }))
      },
    }),

    makeTool({
      name: 'memo_search',
      description:
        '在备忘录里搜关键词或正则，返回命中行 + 上下文 + 所属节（带行号）。'
        + '适合查「某个报错 / 某个路径 / 某个坑」。比整份读省 98%。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '关键词；也接受正则（如 "port|端口"）' },
          context: { type: 'integer', description: '每条命中前后各带几行，默认 1' },
          maxHits: { type: 'integer', description: '最多显示几处命中，默认 8' },
          section: { type: 'string', description: '只在这一节里搜（可选）' },
        },
        required: ['query'],
      },
      run(args) {
        const q = String(args.query ?? '')
        return safeCall('memo_search', q, () => memo.search(q, {
          context: Number.isFinite(args.context) ? args.context : 1,
          maxHits: Number.isFinite(args.maxHits) ? args.maxHits : 8,
          section: typeof args.section === 'string' && args.section !== '' ? args.section : null,
        }))
      },
    }),

    makeTool({
      name: 'memo_project',
      description:
        '按项目名取整张项目卡（§3.x）：支持中文名与别名，如 "qq"、"mc"、"乐谱"、"网站"、"插件"、"blender"。'
        + '一张卡约 1~4k token，比读整份省 90% 以上。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: '项目名或别名，如 "qq"、"乐谱"、"blender"' },
        },
        required: ['name'],
      },
      run(args) {
        const name = String(args.name ?? '')
        return safeCall('memo_project', name, () => memo.project(name))
      },
    }),

    makeTool({
      name: 'memo_quick',
      description:
        '速查表：machine（机器配置）/ ports（端口）/ interpreters（解释器）/ dirs（目录）/ commands（常用命令）。'
        + '只回那一节，几十到几百 token，回答「端口是多少 / 模型在哪」这类问题最快。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          topic: {
            type: 'string',
            description: 'machine / ports / interpreters / dirs / commands',
          },
        },
        required: ['topic'],
      },
      run(args) {
        const topic = String(args.topic ?? '')
        return safeCall('memo_quick', topic, () => memo.quick(topic))
      },
    }),

    makeTool({
      name: 'memo_status',
      description:
        '取备忘录 §6 的当前状态表（每个项目做到哪一步）。接手、汇报进度前先看一眼，约 500 token。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      run() {
        return safeCall('memo_status', '', () => memo.status())
      },
    }),

    makeTool({
      name: 'memo_playbook',
      description:
        '取 §5 里的一个可复用套路（如 download、plugin、video、release、deploy、office）。'
        + '做完某类事情要按标准步骤走时调它。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: '套路名关键词，如 "download" / "plugin" / "release"' },
        },
        required: ['name'],
      },
      run(args) {
        const name = String(args.name ?? '')
        return safeCall('memo_playbook', name, () => memo.playbook(name))
      },
    }),

    makeTool({
      name: 'memo_append',
      description:
        '往备忘录追加内容（记新坑 / 新事实 / 新项目）。写入前自动备份，写完读回校验，失败自动回滚。'
        + 'section 填节号（追加到该节末尾）或 "end"（追加到文件末尾）。'
        + '用于维护 MEMO，不需要把整份读出来再写回去。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          section: { type: 'string', description: '节号，如 "3.6"；或 "end" 追加到文件末尾' },
          content: { type: 'string', description: '要追加的 Markdown 正文（不必带标题）' },
        },
        required: ['section', 'content'],
      },
      run(args) {
        const sec = String(args.section ?? 'end')
        return safeCall('memo_append', '§' + sec, () =>
          memo.append(sec, String(args.content ?? ''), { backupDir: path.join(path.dirname(memoFile), 'memo-backups') }))
      },
    }),

    makeTool({
      name: 'memo_lite',
      description:
        '取备忘录的**精简版**（MEMO.lite.md，约原体积的 1/5）：所有章节标题都保留，'
        + '只留高密度行（表格 / 路径 / 端口 / 命令 / 坑），压掉散文。'
        + '想看全局就用它，需要细节再 memo_section。需先生成（面板「精简备忘录」或 memo_compact）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          maxChars: { type: 'integer', description: '最多返回多少字符（默认 40000）' },
        },
      },
      run(args) {
        return safeCall('memo_lite', '', () =>
          memo.lite({ maxChars: Number.isFinite(args.maxChars) ? args.maxChars : 40000 }))
      },
    }),

    makeTool({
      name: 'memo_compact',
      description:
        '把备忘录压成精简版 MEMO.lite.md（**原文件一字不动**，只新建 lite 文件）。'
        + '保留全部标题 + 高密度行，供 AI 全局速览，比整份读省 80% 以上。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ratio: { type: 'number', description: '目标比例 0~1，默认 0.16（越小越狠）' },
        },
      },
      run(args) {
        return safeCall('memo_compact', '', () =>
          memo.compact({ ratio: Number.isFinite(args.ratio) ? args.ratio : 0.16 }))
      },
    }),
  ]

  /* --------------------------------------------------------- 注册工具 ---- */

  root.inject(['tools'], (ctx) => {
    for (const tool of TOOLS) {
      try {
        ctx.tools.register(tool)
      } catch (error) {
        log('warn', '注册工具 ' + tool.name + ' 失败：' + String(error?.message ?? error))
      }
    }
    log('info', '已注册 ' + TOOLS.length + ' 个备忘录工具')

    /* ------------------------------------------------- 面板数据端点 ---- */

    if (typeof ctx.inject !== 'function') {
      log('warn', '宿主没有 ctx.inject，跳过面板端点（工具不受影响）')
      return
    }

    ctx.inject(['webServer'], (webCtx) => {
      const statusPayload = () => {
        let info
        let sections
        let categories = []
        try {
          info = memo.info()
          sections = memo.listSections()
          categories = memo.classify()
        } catch (error) {
          return { ok: false, reason: String(error?.message ?? error) }
        }
        let lite = { exists: false }
        try {
          const liteFile = memo.litePath()
          const st = fs.statSync(liteFile)
          const chars = fs.readFileSync(liteFile, 'utf8').length
          lite = { exists: true, chars, mtimeMs: st.mtimeMs, savedPct: Math.max(0, Math.round((1 - chars / Math.max(1, info.chars)) * 100)) }
        } catch {
          lite = { exists: false }
        }
        return {
          ok: true,
          info,
          stats: {
            calls: stats.calls,
            chars: stats.chars,
            tokens: stats.tokens,
            errors: stats.errors,
            startedAt: stats.startedAt,
            uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
            byTool: stats.byTool,
          },
          log: rows.slice(-40).reverse(),
          sections,
          categories,
          lite,
        }
      }

      /** 轻量心跳：客户端靠 calls 变化触发「书架」动画，不拉整份 status。 */
      const pingPayload = () => {
        const last = rows.length > 0 ? rows[rows.length - 1] : null
        return {
          ok: true,
          calls: stats.calls,
          errors: stats.errors,
          startedAt: stats.startedAt,
          last: last === null ? null : { t: last.t, tool: last.tool, arg: last.arg, chars: last.chars, ok: last.ok },
        }
      }

      const handler = async (req, res) => {
        if (!isLocalRequest(req)) {
          respondJson(res, { ok: false, reason: 'local requests only' }, 403)
          return
        }
        const u = new URL(String(req?.url ?? '/'), 'http://127.0.0.1')
        try {
          if (u.pathname.endsWith('/status.json')) {
            respondJson(res, statusPayload())
            return
          }
          if (u.pathname.endsWith('/section.json')) {
            const id = String(u.searchParams.get('id') ?? '')
            const sec = memo.section(id, { maxChars: 16000 })
            respondJson(res, { ok: sec.ok !== false, id, text: sec.text, chars: sec.chars, tokens: sec.tokens })
            return
          }
          if (u.pathname.endsWith('/search.json')) {
            const q = String(u.searchParams.get('q') ?? '')
            const n = Number(u.searchParams.get('n') ?? 12)
            const found = memo.search(q, { context: 1, maxHits: Number.isFinite(n) ? n : 12, maxChars: 6000 })
            respondJson(res, { ok: found.ok !== false, text: found.text, hits: found.hits, chars: found.chars })
            return
          }
          if (u.pathname.endsWith('/shelf.webm')) {
            // 3D 书架动画（Remotion 预渲染，透明背景）；没有就 404，客户端会退回自绘版
            let buf
            try {
              buf = fs.readFileSync(SHELF_VIDEO)
            } catch {
              respondJson(res, { ok: false, reason: 'shelf video not bundled' }, 404)
              return
            }
            res.writeHead(200, {
              'Content-Type': 'video/webm',
              'Content-Length': buf.length,
              'Cache-Control': 'public, max-age=86400',
            })
            res.end(buf)
            return
          }
          if (u.pathname.endsWith('/ping.json')) {
            respondJson(res, pingPayload())
            return
          }
          if (u.pathname.endsWith('/compact.json')) {
            // 只新建 MEMO.lite.md，原文件不动 —— 面板上的「精简备忘录」走这里
            const rawRatio = Number(u.searchParams.get('ratio') ?? '0.16')
            const r = memo.compact({ ratio: Number.isFinite(rawRatio) ? rawRatio : 0.16 })
            respondJson(res, {
              ok: r.ok !== false,
              text: r.text,
              before: r.lite !== undefined ? r.lite.before : 0,
              after: r.lite !== undefined ? r.lite.chars : 0,
              savedPct: r.lite !== undefined ? r.lite.savedPct : 0,
              kept: r.lite !== undefined ? r.lite.keptLines : 0,
              dropped: r.lite !== undefined ? r.lite.droppedLines : 0,
            })
            return
          }
          respondJson(res, { ok: false, reason: 'unknown route' }, 404)
        } catch (error) {
          respondJson(res, { ok: false, reason: String(error?.message ?? error) })
        }
      }

      try {
        webCtx.effect(() => {
          const routes = [
            '/api/memo/status.json',
            '/memo/status.json',
            '/api/memo/section.json',
            '/memo/section.json',
            '/api/memo/search.json',
            '/memo/search.json',
            '/api/memo/ping.json',
            '/memo/ping.json',
            '/api/memo/compact.json',
            '/memo/compact.json',
            '/api/memo/shelf.webm',
            '/memo/shelf.webm',
          ].map((routePath) => webCtx.webServer.register({ kind: 'exact', path: routePath, handler }))
          log('info', '已注册面板端点 /api/memo/status.json')
          return () => {
            for (const dispose of routes) {
              try { dispose() } catch { /* 卸载时路由可能已经没了 */ }
            }
          }
        }, 'memo:routes')
      } catch (error) {
        log('warn', '注册面板端点失败（工具不受影响）：' + String(error?.message ?? error))
      }
    })
  })
}
