/**
 * dsh-memo — 客户端半边（Client half）
 * ============================================================================
 * 目的：让主人**看得见我查备忘录的过程**，同时提供一个他自己也能用的查法。
 *
 * 做三件事：
 *   ① 右上角一个小按钮（带角标 = 本次运行被调用了几次）。
 *   ② 点开是浮层面板：
 *        · 本机备忘录的规模（字符 / 行 / 节）
 *        · 本次运行的统计：调用次数、返回字符、估算 token、比整份读省了多少
 *        · 「最近查询」实时列表：时间 / 工具 / 参数 / 命中 / 返回大小 / 省了多少
 *        · 「目录」：所有章节（点击就地预览，不离开面板）
 *        · 自己的搜索框：输入关键词 → 直接看到命中行
 *   ③ 所有数据都来自 host 的只读端点（/api/memo/*），只放行本机。
 *
 * 安全约定（照 MEMO 的教训）：
 *   · 非 ESM，走 window.__ModuleLoader__.load；React 拿不到就安静退出；
 *   · 只往 document.body 挂**自己的**节点（按钮 + 面板），绝不改 DSH 原生 DOM；
 *   · 不覆写任何全局对象，不用 MutationObserver / rAF 常驻循环；
 *   · 面板关闭时停止轮询；卸载时移除全部节点与定时器；
 *   · 所有 DOM 写入用 textContent（数据可能含任意备忘录文本）；
 *   · 全部包 try/catch，失败最多 console.warn。
 * ============================================================================
 */

if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-memo',
    factory: (require) => {
      var module = { exports: {} }
      var exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

      /* React 从平台模块表拿；拿不到就不注册（注册了组件一渲染就 TypeError）。 */
      var React = null
      try {
        var seed = require('react')
        React = seed && seed.default ? seed.default : seed
      } catch (e) {
        React = null
      }

      var PLUGIN_ID = 'dsh-memo'
      var SLOT = 'conversation.composer.dock'
      var SLOT_ID = 'memo-dock'
      var BTN_ID = 'dshmemo-btn'
      var PANEL_ID = 'dshmemo-panel'
      var STYLE_ID = 'dshmemo-style'
      var POLL_MS = 2500
      var PING_MS = 1400
      var API_BASES = ['api/memo/', 'memo/']
      var FONT = '"Microsoft YaHei", "PingFang SC", system-ui, -apple-system, sans-serif'
      var MONO = 'ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace'

      function warn(msg) {
        try { console.warn('[dsh-memo] ' + msg) } catch (e) { /* 没有 console 也无所谓 */ }
      }

      /* --------------------------------------------------------------- 样式 ---- */

      function buildCss() {
        return [
          '#dshmemo-btn{position:fixed;top:104px;right:14px;z-index:2147483000;width:34px;height:34px;',
          'display:flex;align-items:center;justify-content:center;padding:0;border-radius:10px;',
          'background:#16181d;color:#cfd4dc;border:1px solid #2a2e38;cursor:pointer;',
          'box-shadow:0 6px 18px rgba(0,0,0,.35);',
          'transition:background .15s,color .15s,transform .15s,opacity .3s,width .26s ease,height .26s ease,border-radius .26s ease}',
          /* 翻备忘录期间：按钮展开成动画窗口，图标淡出 */
          '#dshmemo-btn.dshmemo-playing{width:200px;height:200px;border-radius:22px;top:62px;background:#070b11;border-color:#2b4557}',
          '#dshmemo-btn.dshmemo-playing:hover{transform:none;background:#070b11}',
          '#dshmemo-btn.dshmemo-playing > svg,#dshmemo-btn.dshmemo-playing > .dshmemo-badge{opacity:0}',
          '#dshmemo-btn > svg,#dshmemo-btn > .dshmemo-badge{transition:opacity .2s}',
          '.dshmemo-media{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;',
          'opacity:0;transition:opacity .32s ease;pointer-events:none;',
          'background:radial-gradient(circle at 50% 48%, rgba(14,26,41,.94) 0%, rgba(7,13,22,.96) 58%, rgba(3,6,11,.97) 100%)}',
          '#dshmemo-btn.dshmemo-hide{opacity:0;pointer-events:none}',
          '#dshmemo-btn:hover{background:#1f232b;color:#eaf0f8;transform:translateY(-1px)}',
          '#dshmemo-btn[aria-expanded="true"]{background:#223041;color:#7fd0ff;border-color:#355064}',
          '#dshmemo-btn .dshmemo-badge{position:absolute;top:-6px;right:-6px;min-width:15px;height:15px;',
          'padding:0 4px;border-radius:8px;background:#3f7d5c;color:#e6fff1;font:10px/15px ' + FONT + ';',
          'text-align:center;border:1px solid #14161b;box-sizing:border-box}',
          '#dshmemo-btn .dshmemo-badge[hidden]{display:none}',

          '#dshmemo-panel{position:fixed;top:144px;right:14px;z-index:2147483000;width:390px;',
          'max-width:calc(100vw - 24px);max-height:calc(100vh - 172px);display:flex;flex-direction:column;',
          'background:#14161b;color:#d7dae0;border:1px solid #2a2e38;border-radius:14px;overflow:hidden;',
          'box-shadow:0 18px 44px rgba(0,0,0,.5);font:12.5px/1.5 ' + FONT + ';',
          'transform-origin:top right;animation:dshmemo-in .16s ease-out}',
          '@keyframes dshmemo-in{from{opacity:0;transform:translateY(-6px) scale(.985)}to{opacity:1;transform:none}}',
          '#dshmemo-panel[hidden]{display:none!important}',
          '.dshmemo-head,.dshmemo-meta,.dshmemo-stats,.dshmemo-tabs,.dshmemo-search,.dshmemo-foot{flex:0 0 auto}',

          '.dshmemo-head{display:flex;align-items:center;gap:8px;padding:10px 12px 8px;border-bottom:1px solid #23262e}',
          '.dshmemo-title{font-size:13px;font-weight:600;color:#eef2f7;letter-spacing:.2px}',
          '.dshmemo-title small{font-weight:400;color:#7d838f;font-size:11px;margin-left:6px}',
          '.dshmemo-spacer{flex:1}',
          '.dshmemo-iconbtn{width:26px;height:26px;display:flex;align-items:center;justify-content:center;',
          'border:0;border-radius:7px;background:transparent;color:#9aa0ab;cursor:pointer;font-size:14px;line-height:1;padding:0}',
          '.dshmemo-iconbtn:hover{background:#22262e;color:#e8edf4}',

          '.dshmemo-meta{padding:6px 12px 0;color:#848b97;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
          '.dshmemo-meta code{font-family:' + MONO + ';color:#a8b0bd;font-size:10.5px}',
          '.dshmemo-stats{display:flex;gap:6px;padding:8px 12px 10px;flex-wrap:wrap}',
          '.dshmemo-stat{flex:1 1 0;min-width:70px;background:#1a1d24;border:1px solid #242833;border-radius:9px;padding:5px 7px}',
          '.dshmemo-stat b{display:block;font:600 14px/1.2 ' + MONO + ';color:#8fd6ff}',
          '.dshmemo-stat span{display:block;color:#7d838f;font-size:10.5px;margin-top:2px}',
          '.dshmemo-stat.good b{color:#7ee0b0}',

          '.dshmemo-tabs{display:flex;gap:4px;padding:0 10px 8px}',
          '.dshmemo-tab{border:1px solid transparent;background:transparent;color:#9aa0ab;border-radius:8px;',
          'padding:4px 10px;font:12px ' + FONT + ';cursor:pointer}',
          '.dshmemo-tab:hover{background:#1d2028;color:#d7dae0}',
          '.dshmemo-tab[aria-selected="true"]{background:#22262e;color:#e8edf4;border-color:#31363f}',

          '.dshmemo-list{flex:1;min-height:90px;overflow:auto;padding:2px 8px 8px}',
          '.dshmemo-list::-webkit-scrollbar{width:8px}',
          '.dshmemo-list::-webkit-scrollbar-thumb{background:#2b303a;border-radius:4px}',
          '.dshmemo-row{display:flex;gap:8px;align-items:baseline;padding:5px 6px;border-radius:7px;cursor:default}',
          '.dshmemo-row.click{cursor:pointer}',
          '.dshmemo-row:hover{background:#1b1f26}',
          '.dshmemo-row .t{font-family:' + MONO + ';font-size:10.5px;color:#6f7682;flex:0 0 58px}',
          '.dshmemo-row .tool{color:#8fd6ff;font-family:' + MONO + ';font-size:11px;flex:0 0 auto;max-width:104px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '.dshmemo-row .arg{color:#c9d0da;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '.dshmemo-row .num{font-family:' + MONO + ';font-size:10.5px;color:#8a919c;flex:0 0 auto}',
          '.dshmemo-row.fail .arg{color:#ff9d9d}',
          '.dshmemo-row.fail .num{color:#d98a8a}',
          '.dshmemo-row .saved{color:#7ee0b0;font-family:' + MONO + ';font-size:10.5px;flex:0 0 46px;text-align:right}',

          '.dshmemo-outline-row{display:flex;align-items:baseline;gap:8px;padding:4px 6px;border-radius:7px;cursor:pointer}',
          '.dshmemo-outline-row:hover{background:#1b1f26}',
          '.dshmemo-outline-row .id{font-family:' + MONO + ';font-size:11px;color:#8fd6ff;flex:0 0 40px}',
          '.dshmemo-outline-row .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c9d0da}',
          '.dshmemo-outline-row.sub .name{color:#9ba3af;font-size:11.5px}',
          '.dshmemo-outline-row.sub{padding-left:16px}',
          '.dshmemo-outline-row .k{font-family:' + MONO + ';font-size:10px;color:#6f7682;flex:0 0 auto}',

          '.dshmemo-search{display:flex;gap:6px;padding:0 12px 8px}',
          '.dshmemo-search input{flex:1;min-width:0;background:#101216;border:1px solid #2a2e38;border-radius:8px;',
          'color:#e8edf4;padding:5px 9px;font:12px ' + MONO + ';outline:none}',
          '.dshmemo-search input:focus{border-color:#3d5a72}',
          '.dshmemo-search button{background:#223041;border:1px solid #355064;color:#a8d8ff;border-radius:8px;',
          'padding:5px 10px;font:12px ' + FONT + ';cursor:pointer;flex:0 0 auto}',
          '.dshmemo-search button:hover{background:#2a3d50;color:#d6ecff}',

          '.dshmemo-preview{flex:1;min-height:120px;display:flex;flex-direction:column;overflow:hidden}',
          '.dshmemo-preview[hidden]{display:none!important}',
          '.dshmemo-previewbar{display:flex;align-items:center;gap:8px;padding:0 12px 6px;color:#9aa0ab;font-size:11px}',
          '.dshmemo-previewbar b{color:#c9d0da;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '.dshmemo-preview pre{flex:1;overflow:auto;margin:0 12px 10px;padding:10px;background:#0f1115;',
          'border:1px solid #22262e;border-radius:9px;color:#c4cbd5;font:11.5px/1.55 ' + MONO + ';white-space:pre-wrap;word-break:break-word}',
          '.dshmemo-preview pre::-webkit-scrollbar{width:8px;height:8px}',
          '.dshmemo-preview pre::-webkit-scrollbar-thumb{background:#2b303a;border-radius:4px}',

          '.dshmemo-foot{padding:6px 12px 9px;border-top:1px solid #23262e;color:#6f7682;font-size:10.5px;',
          'display:flex;gap:8px;align-items:center}',
          '.dshmemo-foot code{font-family:' + MONO + ';color:#8a919c;font-size:10px}',
          '.dshmemo-empty{padding:14px 10px;color:#7d838f;font-size:11.5px;text-align:center}',

          '.dshmemo-act{display:flex;align-items:center;gap:4px;height:24px;padding:0 9px;border-radius:7px;',
          'border:1px solid #355064;background:#1d2733;color:#a8d8ff;font:11.5px ' + FONT + ';cursor:pointer;flex:0 0 auto}',
          '.dshmemo-act:hover{background:#243344;color:#d6ecff}',
          '.dshmemo-act[disabled]{opacity:.5;cursor:default}',

          /* ── 分类目录 ── */
          '.dshmemo-group{border-bottom:1px solid #1e222a}',
          '.dshmemo-group:last-child{border-bottom:0}',
          '.dshmemo-grouphead{display:flex;align-items:center;gap:7px;padding:6px;cursor:pointer;border-radius:7px}',
          '.dshmemo-grouphead:hover{background:#1b1f26}',
          '.dshmemo-caret{display:inline-block;width:10px;color:#6f7682;font-size:10px;flex:0 0 auto;',
          'transform:rotate(90deg);transition:transform .16s ease}',
          '.dshmemo-group[data-open="false"] .dshmemo-caret{transform:rotate(0)}',
          '.dshmemo-group[data-open="false"] .dshmemo-groupbody{display:none}',
          '.dshmemo-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 6px currentColor}',
          '.dshmemo-gname{font-weight:600;color:#dfe5ee;font-size:12px;flex:0 0 auto}',
          '.dshmemo-ghint{color:#5d646f;font-size:10.5px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '.dshmemo-gmeta{color:#6f7682;font-family:' + MONO + ';font-size:10px;flex:0 0 auto;text-align:right}',
          '.dshmemo-groupbody{padding:0 0 4px 2px}',

          /* ── 确认层 ── */
          '.dshmemo-confirm{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
          'background:rgba(8,10,14,.74);z-index:5;padding:18px}',
          '.dshmemo-confirm[hidden]{display:none!important}',
          '.dshmemo-confirm-card{width:100%;max-width:320px;background:#171a21;border:1px solid #2f3541;',
          'border-radius:12px;padding:14px 15px 13px;box-shadow:0 16px 40px rgba(0,0,0,.55);animation:dshmemo-in .14s ease-out}',
          '.dshmemo-confirm-card h4{margin:0 0 8px;font-size:13px;color:#eef2f7;font-weight:600}',
          '.dshmemo-confirm-card p{margin:0 0 12px;color:#9aa1ad;font-size:11.5px;line-height:1.65}',
          '.dshmemo-confirm-card b{color:#8fd6ff;font-family:' + MONO + ';font-weight:600}',
          '.dshmemo-confirm-btns{display:flex;gap:8px;justify-content:flex-end}',
          '.dshmemo-btn-ghost,.dshmemo-btn-primary{border-radius:8px;padding:6px 12px;font:12px ' + FONT + ';cursor:pointer}',
          '.dshmemo-btn-ghost{background:transparent;border:1px solid #333a46;color:#9aa1ad}',
          '.dshmemo-btn-ghost:hover{background:#1e232c;color:#dfe5ee}',
          '.dshmemo-btn-primary{background:#1f4a63;border:1px solid #3f7d9e;color:#ccecff}',
          '.dshmemo-btn-primary:hover{background:#265b79}',

          /* ── 提示条 ── */
          '.dshmemo-toast{position:absolute;left:12px;right:12px;bottom:42px;padding:8px 11px;border-radius:9px;',
          'background:#16212c;border:1px solid #2c4557;color:#a8d8ff;font-size:11.5px;line-height:1.55;',
          'box-shadow:0 8px 22px rgba(0,0,0,.45);opacity:0;transform:translateY(4px);',
          'transition:opacity .2s,transform .2s;pointer-events:none;z-index:4}',
          '.dshmemo-toast[data-show="1"]{opacity:1;transform:none}',

          /* ── 书架动画层（独立 canvas，不碰任何原生 DOM） ── */
          '#dshmemo-shelf{position:fixed;inset:0;width:100vw;height:100vh;z-index:2147482999;pointer-events:none;display:block}',
          '#dshmemo-shelf[hidden]{display:none!important}',

          '@media (max-width:720px){#dshmemo-panel{right:12px;left:12px;width:auto}}',
        ].join('')
      }

      function injectStyle() {
        if (document.getElementById(STYLE_ID) !== null) return null
        var el = document.createElement('style')
        el.id = STYLE_ID
        el.textContent = buildCss()
        document.head.appendChild(el)
        return el
      }

      /* --------------------------------------------------------------- 数据 ---- */

      function apiGet(pathName, params) {
        function attempt(i) {
          if (i >= API_BASES.length) return Promise.reject(new Error('endpoint unavailable'))
          var url = API_BASES[i] + pathName
          if (params) url += '?' + params
          return fetch(url, { cache: 'no-store' }).then(function (res) {
            if (!res.ok) throw new Error('http ' + res.status)
            return res.json()
          }).catch(function (error) {
            if (i + 1 < API_BASES.length) return attempt(i + 1)
            throw error
          })
        }
        return attempt(0)
      }

      function fmtK(n) {
        var v = Number(n) || 0
        if (v >= 100000) return (v / 1000).toFixed(0) + 'k'
        if (v >= 1000) return (v / 1000).toFixed(1) + 'k'
        return String(v)
      }

      function clock(t) {
        var d = new Date(Number(t) || Date.now())
        function p(x) { return x < 10 ? '0' + x : String(x) }
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
      }

      /* ------------------------------------------------------- 书架动画 ---- */

      /**
       * 一个自绘的 3D 点线书架场景：AI 每次查备忘录时浮起，
       * 相机绕 Y 轴慢转，每转 90° 从书架抽出一本书、悬停、再放回，
       * 查询结束（一段时间没有新查询）后淡出，备忘录按钮再浮现。
       *
       * 只用一个 <canvas>，零依赖、零外部资源；不碰 DSH 任何原生 DOM。
       */
      var ANIM_BOX = 200 // 展开后的动画窗口边长

      function createShelfScene(host) {
        var canvas = null
        var ctx = null
        var raf = null
        var W = 0
        var H = 0
        var dpr = 1
        var state = 'idle' // idle | in | live | out
        var alpha = 0
        var angle = 0
        var nextBookAngle = 0
        var pending = 0
        var activeUntil = 0
        var lastTs = 0
        var books = []
        var spawnIndex = 0
        var onIdle = null

        var SHELF_W = 1.5
        var SHELF_H = 2.15
        var SHELF_D = 0.34
        var LEVELS = 4
        var SHELVES = [
          { x: -2.3, w: SHELF_W, h: SHELF_H, d: SHELF_D },
          { x: 0, w: SHELF_W, h: SHELF_H, d: SHELF_D },
          { x: 2.3, w: SHELF_W, h: SHELF_H, d: SHELF_D },
        ]
        var CAM_Z = 6.4
        var IDLE_HOLD_MS = 8000
        var SPIN = 0.62 // rad/s
        var BOOK_DUR = 2100 // 一本书飞出→回位的毫秒数

        function clamp(v, a, b) {
          return v < a ? a : (v > b ? b : v)
        }
        function easeOutCubic(t) {
          return 1 - Math.pow(1 - t, 3)
        }
        function easeInOutSine(t) {
          return -(Math.cos(Math.PI * t) - 1) / 2
        }

        /* --- 3D：旋转 + 透视投影（相机在 z=-CAM_Z 看向原点） --- */
        function project(p) {
          var ca = Math.cos(angle)
          var sa = Math.sin(angle)
          var x = p[0] * ca - p[2] * sa
          var zz = p[0] * sa + p[2] * ca
          var dist = zz + CAM_Z
          if (dist < 0.7) return null
          var f = (H * 0.92) / dist
          return {
            x: W / 2 + x * f,
            y: H * 0.52 - p[1] * f * 0.92,
            d: dist,
            f: f,
          }
        }

        function fadeOf(d) {
          return clamp(1.5 - d / 7.5, 0.06, 1)
        }

        function stroke3(a, b, alphaMul, width, tint) {
          var pa = project(a)
          var pb = project(b)
          if (pa === null || pb === null) return
          var d = (pa.d + pb.d) * 0.5
          var fd = fadeOf(d)
          var al = 0.92 * fd * alphaMul
          if (al < 0.008) return
          ctx.strokeStyle = 'rgba(' + tint + ',' + al.toFixed(3) + ')'
          ctx.lineWidth = Math.max(0.85, width * fd * 1.45)
          ctx.beginPath()
          ctx.moveTo(pa.x, pa.y)
          ctx.lineTo(pb.x, pb.y)
          ctx.stroke()
        }

        function dot3(p, r, alphaMul) {
          var pp = project(p)
          if (pp === null) return
          var fd = fadeOf(pp.d)
          var al = 1.0 * fd * alphaMul
          if (al < 0.012) return
          var rad = Math.max(0.9, r * fd * (pp.f / (H || 1)) * 2.5)
          ctx.fillStyle = 'rgba(168,228,255,' + al.toFixed(3) + ')'
          ctx.beginPath()
          ctx.arc(pp.x, pp.y, rad, 0, Math.PI * 2)
          ctx.fill()
        }

        /* --- 线框盒子（书本与书架框共用） --- */
        function boxEdges(center, sx, sy, sz, rotY, alphaMul) {
          var hx = sx / 2
          var hy = sy / 2
          var hz = sz / 2
          var ca = Math.cos(rotY || 0)
          var sa = Math.sin(rotY || 0)
          var pts = []
          for (var i = 0; i < 8; i += 1) {
            var lx = (i & 1 ? hx : -hx)
            var ly = (i & 2 ? hy : -hy)
            var lz = (i & 4 ? hz : -hz)
            var rx = lx * ca - lz * sa
            var rz = lx * sa + lz * ca
            pts.push([center[0] + rx, center[1] + ly, center[2] + rz])
          }
          var edges = [
            [0, 1], [1, 3], [3, 2], [2, 0],
            [4, 5], [5, 7], [7, 6], [6, 4],
            [0, 4], [1, 5], [2, 6], [3, 7],
          ]
          for (var e = 0; e < edges.length; e += 1) {
            stroke3(pts[edges[e][0]], pts[edges[e][1]], alphaMul * 0.95, 1.1, '150,216,255')
          }
          for (var k = 0; k < 8; k += 1) dot3(pts[k], 1.1, alphaMul)
        }

        /* --- 画三个书架：外框 + 层板 + 书脊点 --- */
        function drawShelves(t) {
          for (var s = 0; s < SHELVES.length; s += 1) {
            var sh = SHELVES[s]
            var y0 = -sh.h / 2
            var y1 = sh.h / 2
            var z0 = -sh.d / 2
            var z1 = sh.d / 2
            var x0 = sh.x - sh.w / 2
            var x1 = sh.x + sh.w / 2
            // 四根立柱
            var corners = [
              [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
              [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
            ]
            var vert = [[0, 4], [1, 5], [2, 6], [3, 7]]
            for (var v = 0; v < vert.length; v += 1) {
              stroke3(corners[vert[v][0]], corners[vert[v][1]], 1.0, 1.7, '138,216,255')
            }
            // 层板：每条边 + 板上的书脊点
            for (var lv = 0; lv <= LEVELS; lv += 1) {
              var y = y0 + (sh.h / LEVELS) * lv
              var ring = [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]]
              for (var r = 0; r < 4; r += 1) {
                stroke3(ring[r], ring[(r + 1) % 4], 0.55, 0.9, '110,190,240')
              }
              if (lv < LEVELS) {
                var shelfY = y + (sh.h / LEVELS) * 0.5
                for (var b = 0; b < 6; b += 1) {
                  var bx = x0 + (sh.w / 6) * (b + 0.5)
                  dot3([bx, shelfY + Math.sin(t * 0.0016 + b + s) * 0.012, z0 + 0.02], 0.85, 0.5)
                }
              }
            }
            // 书架侧面的网格点（"网络"感）
            for (var gp = 0; gp < 5; gp += 1) {
              var gy = y0 + (sh.h / 4) * gp
              dot3([x0, gy, z1], 0.7, 0.35)
              dot3([x1, gy, z1], 0.7, 0.35)
            }
          }
        }

        /* --- 被抽出来的书 --- */
        function spawnBook() {
          var sh = SHELVES[spawnIndex % SHELVES.length]
          spawnIndex += 1
          var level = spawnIndex % LEVELS
          var inner = (Math.sin(spawnIndex * 2.399) * 0.5) * (sh.w - 0.5)
          books.push({
            from: [sh.x + inner, -sh.h / 2 + (sh.h / LEVELS) * (level + 0.5), 0.02],
            to: [0, 0.22, -1.25],
            born: performance.now(),
            dur: BOOK_DUR,
            seed: spawnIndex,
          })
        }

        function drawBooks(now) {
          for (var i = books.length - 1; i >= 0; i -= 1) {
            var bk = books[i]
            var u = (now - bk.born) / bk.dur
            if (u >= 1) {
              books.splice(i, 1)
              continue
            }
            // 0 → 1 → 0 的弧线：抽出、悬停、放回
            var arc = Math.sin(Math.PI * easeInOutSine(clamp(u, 0, 1)))
            var lift = Math.sin(Math.PI * u) * 0.42
            var cx = bk.from[0] + (bk.to[0] - bk.from[0]) * arc
            var cy = bk.from[1] + (bk.to[1] - bk.from[1]) * arc + lift
            var cz = bk.from[2] + (bk.to[2] - bk.from[2]) * arc
            // 飞行中自转，悬停时慢摆
            var rot = u * Math.PI * 2.4 + Math.sin(u * Math.PI) * 0.6
            boxEdges([cx, cy, cz], 0.15, 0.3, 0.22, rot, 1)
            // 书本尾迹：一小段淡光
            var pp = project([cx, cy, cz])
            if (pp !== null) {
              var g = ctx.createRadialGradient(pp.x, pp.y, 0, pp.x, pp.y, 26 * (pp.f / (H || 1)) * 2.2)
              g.addColorStop(0, 'rgba(150,220,255,0.16)')
              g.addColorStop(1, 'rgba(150,220,255,0)')
              ctx.fillStyle = g
              ctx.beginPath()
              ctx.arc(pp.x, pp.y, 26 * (pp.f / (H || 1)) * 2.2, 0, Math.PI * 2)
              ctx.fill()
            }
          }
        }

        /* --- 背景：中心微亮的深色，让点线有对比 --- */
        function drawBackdrop() {
          ctx.clearRect(0, 0, W, H)
          var g = ctx.createRadialGradient(W * 0.5, H * 0.48, 40, W * 0.5, H * 0.52, Math.max(W, H) * 0.72)
          g.addColorStop(0, 'rgba(8,13,22,0.94)')
          g.addColorStop(0.55, 'rgba(5,9,15,0.96)')
          g.addColorStop(1, 'rgba(3,6,10,0.98)')
          ctx.fillStyle = g
          ctx.fillRect(0, 0, W, H)
        }

        function resize() {
          if (canvas === null) return
          dpr = Math.min(window.devicePixelRatio || 1, 2)
          W = ANIM_BOX
          H = ANIM_BOX
          canvas.width = Math.floor(W * dpr)
          canvas.height = Math.floor(H * dpr)
          canvas.style.width = W + 'px'
          canvas.style.height = H + 'px'
          ctx = canvas.getContext('2d')
          if (ctx !== null) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        }

        function frame(ts) {
          if (state === 'idle') { raf = null; return }
          var dt = lastTs === 0 ? 16 : Math.min(48, ts - lastTs)
          lastTs = ts
          var now = performance.now()

          if (state === 'in') {
            alpha = Math.min(1, alpha + dt / 320)
            if (alpha >= 1) state = 'live'
          } else if (state === 'out') {
            alpha = Math.max(0, alpha - dt / 380)
            if (alpha <= 0) {
              state = 'idle'
              alpha = 0
              raf = null
              if (canvas !== null) canvas.hidden = true
              books.length = 0
              pending = 0
              if (typeof onIdle === 'function') {
                try { onIdle() } catch (e) { /* ignore */ }
              }
              return
            }
          } else if (state === 'live') {
            if (now > activeUntil && pending === 0) state = 'out'
          }

          // 相机旋转：查询期间一直慢慢转
          if (state === 'live' || state === 'in') angle += (SPIN * dt) / 1000

          // 每转 90° 抽一本书（前提：还有排队的查询没展示）
          if (pending > 0 && angle >= nextBookAngle) {
            spawnBook()
            pending -= 1
            nextBookAngle = angle + Math.PI / 2
          }

          if (ctx !== null) {
            drawBackdrop()
            ctx.globalAlpha = alpha
            drawShelves(ts)
            drawBooks(now)
            ctx.globalAlpha = 1
          }
          raf = requestAnimationFrame(frame)
        }

        function ensureCanvas() {
          if (canvas !== null && canvas.isConnected) return
          canvas = document.createElement('canvas')
          canvas.id = 'dshmemo-shelf'
          canvas.className = 'dshmemo-media'
          canvas.hidden = true
          host.appendChild(canvas)
          resize()
        }

        function start() {
          ensureCanvas()
          if (raf !== null) return
          lastTs = 0
          raf = requestAnimationFrame(frame)
        }

        return {
          /** AI 每查一次：排队一本书，并把「还在查」的截止时间往后推。 */
          pulse: function (count) {
            var n = Number(count) > 0 ? Math.min(6, Number(count)) : 1
            pending = Math.min(6, pending + n)
            activeUntil = performance.now() + IDLE_HOLD_MS
            if (state === 'idle') {
              alpha = 0
              angle = 0
              nextBookAngle = 0
              books.length = 0
              state = 'in'
              ensureCanvas()
              if (canvas !== null) canvas.hidden = false
              start()
            } else if (state === 'out') {
              state = 'in'
              if (canvas !== null) canvas.hidden = false
              start()
            }
          },
          onIdle: function (fn) { onIdle = fn },
          resize: function () { if (state !== 'idle') resize() },
          destroy: function () {
            state = 'idle'
            if (raf !== null) { cancelAnimationFrame(raf); raf = null }
            if (canvas !== null) { try { canvas.remove() } catch (e) { /* ignore */ } canvas = null }
            ctx = null
          },
          isBusy: function () { return state !== 'idle' },
        }
      }

      /* --------------------------------------------------- 书架动画（视频版） ---- */

      /**
       * 优先方案：播放 Remotion 预渲染的透明 webm（60fps，比运行时自绘更顺更细）。
       * 拿不到视频 / 解码失败时安静返回 false，由 Canvas 自绘版兜底。
       */
      function createShelfVideo(host) {
        var video = null
        var failed = false
        var hideTimer = null
        var onIdle = null
        var onFail = null
        // 版本号：换了动画视频就 +1，否则浏览器会用缓存里的旧片
        var URL_PATH = '/api/memo/shelf.webm?v=7'
        // 播满一个完整循环（8 秒 = 4 本书），太短会「一闪就过」看不到
        var HOLD_MS = 8000

        function ensure() {
          if (failed) return null
          if (video !== null) return video
          var v = document.createElement('video')
          v.id = 'dshmemo-shelf-video'
          v.className = 'dshmemo-media'
          v.muted = true
          v.loop = true
          v.playsInline = true
          v.setAttribute('playsinline', '')
          v.setAttribute('muted', '')
          v.src = URL_PATH
          // 视频拿不到 / 解不了码：撤掉自己，把场面交还给 Canvas 自绘版
          v.addEventListener('error', function () {
            failed = true
            try { v.remove() } catch (e) { /* ignore */ }
            if (video === v) video = null
            if (typeof onFail === 'function') {
              try { onFail() } catch (e) { /* ignore */ }
            }
          })
          host.appendChild(v)
          video = v
          return v
        }

        function show() {
          var v = ensure()
          if (v === null) return false
          var p = null
          try {
            p = v.play()
          } catch (e) {
            failed = true
            return false
          }
          if (p && typeof p.then === 'function') {
            p.catch(function () {
              failed = true
              if (typeof onFail === 'function') {
                try { onFail() } catch (e) { /* ignore */ }
              }
            })
          }
          host.classList.add('dshmemo-playing')
          v.style.opacity = '1'
          return true
        }

        function hide() {
          host.classList.remove('dshmemo-playing')
          if (video === null) return
          var v = video
          v.style.opacity = '0'
          setTimeout(function () {
            try { v.pause() } catch (e) { /* ignore */ }
          }, 420)
        }

        return {
          /** AI 查了一次 → 播（并续期 2.6s）；返回 false 表示这条路线不可用。 */
          pulse: function () {
            if (failed) return false
            if (hideTimer !== null) clearTimeout(hideTimer)
            if (!show()) return false
            hideTimer = setTimeout(function () {
              hideTimer = null
              hide()
              if (typeof onIdle === 'function') {
                try { onIdle() } catch (e) { /* ignore */ }
              }
            }, HOLD_MS)
            return true
          },
          onIdle: function (fn) { onIdle = fn },
          onFail: function (fn) { onFail = fn },
          destroy: function () {
            if (hideTimer !== null) clearTimeout(hideTimer)
            hideTimer = null
            if (video !== null) {
              try { video.remove() } catch (e) { /* ignore */ }
              video = null
            }
          },
          isAvailable: function () { return !failed }
        }
      }

      /* ------------------------------------------------------------- 面板 ---- */

      function mountPanel() {
        if (document.getElementById(PANEL_ID) !== null) return function () { /* 已经挂过 */ }
        injectStyle()

        var btn = document.createElement('button')
        btn.id = BTN_ID
        btn.type = 'button'
        btn.title = 'MEMO · 备忘录查询面板'
        btn.setAttribute('aria-label', '打开备忘录查询面板')
        btn.setAttribute('aria-expanded', 'false')
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" '
          + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
          + '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v18l-7.5-4.2L4 21V4.5Z"/></svg>'
        var badge = document.createElement('span')
        badge.className = 'dshmemo-badge'
        badge.hidden = true
        btn.appendChild(badge)

        var panel = document.createElement('div')
        panel.id = PANEL_ID
        panel.hidden = true
        panel.setAttribute('role', 'dialog')
        panel.setAttribute('aria-label', '备忘录查询面板')
        panel.innerHTML = [
          '<div class="dshmemo-head">',
          '  <div class="dshmemo-title">MEMO<small>本机备忘录</small></div>',
          '  <div class="dshmemo-spacer"></div>',
          '  <button class="dshmemo-act" data-act="compact" type="button" title="把备忘录压成精简版（原文件一字不动）">精简</button>',
          '  <button class="dshmemo-iconbtn" data-act="refresh" type="button" title="刷新">↻</button>',
          '  <button class="dshmemo-iconbtn" data-act="close" type="button" title="关闭">×</button>',
          '</div>',
          '<div class="dshmemo-meta" data-el="meta">读取中…</div>',
          '<div class="dshmemo-stats">',
          '  <div class="dshmemo-stat"><b data-el="calls">0</b><span>本次查询</span></div>',
          '  <div class="dshmemo-stat"><b data-el="returned">0</b><span>返回字符</span></div>',
          '  <div class="dshmemo-stat good"><b data-el="saved">—</b><span>比整读省</span></div>',
          '  <div class="dshmemo-stat"><b data-el="lite">—</b><span>精简版</span></div>',
          '</div>',
          '<div class="dshmemo-tabs">',
          '  <button class="dshmemo-tab" data-tab="log" type="button" aria-selected="true">最近查询</button>',
          '  <button class="dshmemo-tab" data-tab="cats" type="button" aria-selected="false">分类</button>',
          '</div>',
          '<div class="dshmemo-search">',
          '  <input data-el="q" type="text" placeholder="搜备忘录（回车）" spellcheck="false" />',
          '  <button data-act="search" type="button">搜</button>',
          '</div>',
          '<div class="dshmemo-list" data-el="list"></div>',
          '<div class="dshmemo-preview" data-el="preview" hidden>',
          '  <div class="dshmemo-previewbar">',
          '    <button class="dshmemo-iconbtn" data-act="back" type="button" title="返回">←</button>',
          '    <b data-el="ptitle"></b>',
          '  </div>',
          '  <pre data-el="ptext"></pre>',
          '</div>',
          '<div class="dshmemo-foot"><span>日志</span><code data-el="logpath">~/.dsh/memo-plugin/query-log.jsonl</code></div>',
          '<div class="dshmemo-confirm" data-el="confirm" hidden>',
          '  <div class="dshmemo-confirm-card">',
          '    <h4>精简备忘录？</h4>',
          '    <p data-el="cfnote">会生成一份精简版：保留全部章节标题 + 高密度内容（表格 / 路径 / 端口 / 命令 / 坑），压掉散文。<b>原文件一字不动</b>，精简版另存为 MEMO.lite.md，随时可以重新生成。</p>',
          '    <div class="dshmemo-confirm-btns">',
          '      <button class="dshmemo-btn-ghost" data-act="cf-cancel" type="button">取消</button>',
          '      <button class="dshmemo-btn-primary" data-act="cf-go" type="button">确认精简</button>',
          '    </div>',
          '  </div>',
          '</div>',
          '<div class="dshmemo-toast" data-el="toast" hidden></div>',
        ].join('')

        document.body.appendChild(btn)
        document.body.appendChild(panel)

        var el = {}
        panel.querySelectorAll('[data-el]').forEach(function (node) { el[node.getAttribute('data-el')] = node })
        var tabs = panel.querySelectorAll('[data-tab]')
        var timer = null
        var pingTimer = null
        var open = false
        var tab = 'log'
        var lastSections = []
        var lastCategories = []
        var lastLite = null
        var lastCalls = null
        var lastDelta = 1
        var toastTimer = null
        var lastInfo = null
        var lastLog = []
        var scene = createShelfScene(btn)
        var shelfVideo = createShelfVideo(btn)

        var CAT_COLORS = {
          quick: '#7fd0ff',
          env: '#ffb86b',
          projects: '#7ee0b0',
          playbook: '#c8a6ff',
          status: '#ff9d9d',
          topic: '#8fb7d9',
        }

        // 动画放完 → 按钮收回书签尺寸（playing 类在 hide() 里摘掉，这里兜个底）
        scene.onIdle(function () { btn.classList.remove('dshmemo-playing') })
        shelfVideo.onIdle(function () { btn.classList.remove('dshmemo-playing') })
        // 视频不可用（没打包 / 解码失败）→ 立刻改播自绘版，别让这一下白等
        shelfVideo.onFail(function () {
          try { scene.pulse(lastDelta) } catch (e) { /* ignore */ }
        })
        function onResize() { scene.resize() }
        window.addEventListener('resize', onResize)

        /* 轻量心跳：AI 每查一次备忘录，这里就播一次书架动画 */
        function pingOnce() {
          apiGet('ping.json').then(function (data) {
            if (!data || data.ok === false) return
            var calls = Number(data.calls) || 0
            if (lastCalls === null) {
              lastCalls = calls
              return
            }
            if (calls > lastCalls) {
              var delta = calls - lastCalls
              lastCalls = calls
              lastDelta = delta
              // 优先播 Remotion 预渲染的透明视频；拿不到就退回自绘 Canvas
              if (!shelfVideo.pulse(delta)) scene.pulse(delta)
            }
          }).catch(function () {
            /* 端点没挂上也安静，不打扰使用 */
          })
        }

        function setup() {
          var box = panel.querySelector('.dshmemo-meta')
          if (box) box.setAttribute('title', '')
        }
        setup()

        /* ------------------------------------------------ 渲染：统计与日志 ---- */

        function renderMeta(info) {
          if (!info) return
          el.meta.textContent = ''
          var f = document.createElement('code')
          f.textContent = String(info.name || 'MEMO.md')
          el.meta.appendChild(f)
          el.meta.appendChild(document.createTextNode(
            ' · ' + fmtK(info.chars) + ' chars · ' + Number(info.lines || 0) + ' lines · '
            + Number(info.sections || 0) + ' 节 · ' + Number(info.projects || 0) + ' 项目卡'
          ))
        }

        function renderStats(stats, info, lite) {
          var calls = Number(stats && stats.calls) || 0
          var chars = Number(stats && stats.chars) || 0
          el.calls.textContent = String(calls)
          el.returned.textContent = fmtK(chars)
          var full = info ? Number(info.chars) || 0 : 0
          var pct = full > 0 ? Math.max(0, Math.round((1 - chars / full) * 100)) : 0
          el.saved.textContent = calls > 0 ? pct + '%' : '—'
          if (el.lite) {
            el.lite.textContent = lite && lite.exists
              ? '−' + Math.max(0, Number(lite.savedPct) || 0) + '%'
              : '未生成'
            el.lite.style.color = lite && lite.exists ? '#7ee0b0' : '#6f7682'
          }
          badge.hidden = calls <= 0
          badge.textContent = calls > 99 ? '99+' : String(calls)
        }

        function logRow(row) {
          var line = document.createElement('div')
          line.className = 'dshmemo-row' + (row.ok === false ? ' fail' : '') + (row.section ? ' click' : '')
          line.title = (row.arg || '') + (row.hits ? ' · ' + row.hits + ' hit' : '')
          var t = document.createElement('span'); t.className = 't'; t.textContent = clock(row.t)
          var tool = document.createElement('span'); tool.className = 'tool'
          tool.textContent = String(row.tool || '').replace(/^memo_/, '')
          var arg = document.createElement('span'); arg.className = 'arg'
          arg.textContent = (row.arg ? row.arg : (row.section ? '§' + row.section : ''))
            + (row.hits > 0 ? ' · ' + row.hits + 'h' : '')
          var num = document.createElement('span'); num.className = 'num'
          num.textContent = row.ok === false ? '失败' : fmtK(row.chars) + ' · ≈' + fmtK(row.tokens) + 't'
          var saved = document.createElement('span'); saved.className = 'saved'
          saved.textContent = row.ok === false ? '' : (row.savedPct ? '−' + row.savedPct + '%' : '')
          line.appendChild(t); line.appendChild(tool); line.appendChild(arg)
          line.appendChild(num); line.appendChild(saved)
          if (row.section) {
            line.addEventListener('click', function () { openSection(row.section) })
          }
          return line
        }

        function renderLog(rows) {
          var list = el.list
          if (!Array.isArray(rows) || rows.length === 0) {
            list.innerHTML = '<div class="dshmemo-empty">还没有查询记录。让我查一次备忘录，这里就会实时出现。</div>'
            return
          }
          var top = list.scrollTop
          list.textContent = ''
          for (var i = 0; i < Math.min(rows.length, 15); i += 1) list.appendChild(logRow(rows[i]))
          list.scrollTop = top
        }

        /* ------------------------------------------------ 渲染：分类 / 目录 ---- */

        function outlineRow(s) {
          var row = document.createElement('div')
          var isSub = Number(s.level) === 3 && !s.parent
          row.className = 'dshmemo-outline-row' + (isSub ? ' sub' : '')
          row.setAttribute('data-section', String(s.id))
          var id = document.createElement('span'); id.className = 'id'; id.textContent = '§' + s.id
          var name = document.createElement('span'); name.className = 'name'; name.textContent = String(s.title || '')
          var k = document.createElement('span'); k.className = 'k'; k.textContent = fmtK(s.chars) + 'c'
          row.appendChild(id); row.appendChild(name); row.appendChild(k)
          row.addEventListener('click', function () { openSection(this.getAttribute('data-section')) })
          return row
        }

        function renderOutline(sections) {
          var list = el.list
          if (!Array.isArray(sections) || sections.length === 0) {
            list.innerHTML = '<div class="dshmemo-empty">目录读取失败（端点可能没挂上）</div>'
            return
          }
          var top = list.scrollTop
          list.textContent = ''
          for (var i = 0; i < sections.length; i += 1) list.appendChild(outlineRow(sections[i]))
          list.scrollTop = top
        }

        /** 按用途分组的目录：速查 / 环境与坑 / 项目 / 套路 / 状态 / 专题。 */
        function renderCategories(categories) {
          var list = el.list
          if (!Array.isArray(categories) || categories.length === 0) {
            renderOutline(lastSections)
            return
          }
          var top = list.scrollTop
          list.textContent = ''
          for (var i = 0; i < categories.length; i += 1) {
            var cat = categories[i]
            var group = document.createElement('div')
            group.className = 'dshmemo-group'
            group.setAttribute('data-open', 'true')
            group.setAttribute('data-cat', String(cat.key || ''))

            var head = document.createElement('div')
            head.className = 'dshmemo-grouphead'
            var caret = document.createElement('span')
            caret.className = 'dshmemo-caret'
            caret.textContent = '▸'
            var dot = document.createElement('span')
            dot.className = 'dshmemo-dot'
            dot.style.color = CAT_COLORS[cat.key] || '#8fb7d9'
            dot.style.background = CAT_COLORS[cat.key] || '#8fb7d9'
            var name = document.createElement('span')
            name.className = 'dshmemo-gname'
            name.textContent = String(cat.label || '')
            var hint = document.createElement('span')
            hint.className = 'dshmemo-ghint'
            hint.textContent = String(cat.hint || '')
            var meta = document.createElement('span')
            meta.className = 'dshmemo-gmeta'
            meta.textContent = (cat.sections ? cat.sections.length : 0) + ' 节 · ' + fmtK(cat.chars) + 'c'
            head.appendChild(caret); head.appendChild(dot); head.appendChild(name)
            head.appendChild(hint); head.appendChild(meta)
            head.addEventListener('click', function () {
              var g = this.parentNode
              g.setAttribute('data-open', g.getAttribute('data-open') === 'true' ? 'false' : 'true')
            })
            group.appendChild(head)

            var body = document.createElement('div')
            body.className = 'dshmemo-groupbody'
            var secs = Array.isArray(cat.sections) ? cat.sections : []
            for (var k = 0; k < secs.length; k += 1) body.appendChild(outlineRow(secs[k]))
            group.appendChild(body)
            list.appendChild(group)
          }
          list.scrollTop = top
        }

        /* -------------------------------------------------- 预览 / 搜索结果 ---- */

        function showPreview(title, text) {
          el.ptitle.textContent = title
          el.ptext.textContent = text
          el.list.hidden = true
          el.preview.hidden = false
          el.ptext.scrollTop = 0
        }

        function hidePreview() {
          el.preview.hidden = true
          el.list.hidden = false
          renderCurrentTab()
        }

        function openSection(id) {
          var want = String(id || '').trim()
          if (want === '') return
          showPreview('§' + want, '读取中…')
          apiGet('section.json', 'id=' + encodeURIComponent(want)).then(function (data) {
            if (data && data.ok === false) {
              showPreview('§' + want, String(data.reason || data.text || '读取失败'))
              return
            }
            showPreview('§' + want, String(data && data.text ? data.text : ''))
          }).catch(function (error) {
            showPreview('§' + want, '读取失败：' + String(error && error.message ? error.message : error))
          })
        }

        function doSearch() {
          var q = String(el.q.value || '').trim()
          if (q === '') return
          var saved = el.q.value
          showPreview('搜索「' + q + '」', '搜索中…')
          apiGet('search.json', 'q=' + encodeURIComponent(q) + '&n=12').then(function (data) {
            var text = String(data && data.text ? data.text : '没有结果')
            showPreview('搜索「' + saved + '」' + (data && data.hits ? ' · ' + data.hits + ' 处命中' : ''), text)
          }).catch(function (error) {
            showPreview('搜索「' + saved + '」', '搜索失败：' + String(error && error.message ? error.message : error))
          })
        }

        /* ------------------------------------------------------------ 刷新 ---- */

        function renderCurrentTab() {
          if (tab === 'cats') renderCategories(lastCategories)
          else renderLog(lastLog)
        }

        function refresh() {
          return apiGet('status.json').then(function (data) {
            if (data && data.ok === false) {
              el.meta.textContent = '读取失败：' + String(data.reason || '')
              return
            }
            lastInfo = data.info || null
            lastSections = Array.isArray(data.sections) ? data.sections : []
            lastCategories = Array.isArray(data.categories) ? data.categories : []
            lastLite = data.lite || null
            lastLog = Array.isArray(data.log) ? data.log : []
            renderMeta(data.info)
            renderStats(data.stats, data.info, lastLite)
            if (el.list.hidden === false) renderCurrentTab()
          }).catch(function (error) {
            el.meta.textContent = '面板端点不可用（工具仍可用）：' + String(error && error.message ? error.message : error)
          })
        }

        function setTab(next) {
          tab = next === 'cats' ? 'cats' : 'log'
          for (var i = 0; i < tabs.length; i += 1) {
            tabs[i].setAttribute('aria-selected', String(tabs[i].getAttribute('data-tab') === tab))
          }
          hidePreview()
        }

        /* ------------------------------------------------------------ 精简 ---- */

        function showToast(text, isError) {
          if (!el.toast) return
          el.toast.textContent = text
          el.toast.hidden = false
          el.toast.style.borderColor = isError === true ? '#5a3138' : '#2c4557'
          el.toast.style.color = isError === true ? '#ff9d9d' : '#a8d8ff'
          el.toast.setAttribute('data-show', '1')
          if (toastTimer !== null) clearTimeout(toastTimer)
          toastTimer = setTimeout(function () {
            if (el.toast) el.toast.setAttribute('data-show', '0')
            toastTimer = setTimeout(function () {
              if (el.toast) el.toast.hidden = true
              toastTimer = null
            }, 240)
          }, 4200)
        }

        function openConfirm() {
          if (!el.confirm) return
          var full = lastInfo ? Number(lastInfo.chars) || 0 : 0
          var est = full > 0 ? Math.round(full * 0.19) : 0
          if (el.cfnote) {
            el.cfnote.textContent = '会生成一份精简版：保留全部章节标题 + 高密度内容'
              + '（表格 / 路径 / 端口 / 命令 / 坑），压掉散文。原文件一字不动，'
              + '精简版另存为 MEMO.lite.md，随时可以重新生成。'
              + (full > 0 ? ' 预计 ' + fmtK(full) + ' → 约 ' + fmtK(est) + ' 字符。' : '')
          }
          el.confirm.hidden = false
        }

        function runCompact() {
          if (el.confirm) el.confirm.hidden = true
          var goBtn = panel.querySelector('[data-act="cf-go"]')
          if (goBtn !== null) goBtn.setAttribute('disabled', '1')
          showToast('正在精简备忘录…')
          apiGet('compact.json', 'ratio=0.16').then(function (data) {
            if (!data || data.ok === false) {
              showToast('精简失败：' + String((data && data.text) || '端点没响应'), true)
              return null
            }
            showToast('已生成精简版：' + fmtK(data.before) + ' → ' + fmtK(data.after)
              + ' 字符（省 ' + (Number(data.savedPct) || 0) + '%）')
            return refresh()
          }).catch(function (error) {
            showToast('精简失败：' + String(error && error.message ? error.message : error), true)
          }).then(function () {
            if (goBtn !== null) goBtn.removeAttribute('disabled')
          })
        }

        /* ------------------------------------------------------------ 事件 ---- */

        function toggle(next) {
          open = typeof next === 'boolean' ? next : !open
          panel.hidden = !open
          btn.setAttribute('aria-expanded', String(open))
          if (open) {
            refresh()
            if (timer === null) timer = setInterval(refresh, POLL_MS)
          } else if (timer !== null) {
            clearInterval(timer)
            timer = null
          }
        }

        btn.addEventListener('click', function () { toggle() })
        panel.addEventListener('click', function (event) {
          var act = event.target && event.target.getAttribute ? event.target.getAttribute('data-act') : null
          if (act === 'close') toggle(false)
          else if (act === 'refresh') refresh()
          else if (act === 'back') hidePreview()
          else if (act === 'search') doSearch()
          else if (act === 'compact') openConfirm()
          else if (act === 'cf-cancel') { if (el.confirm) el.confirm.hidden = true }
          else if (act === 'cf-go') runCompact()
        })
        el.q.addEventListener('keydown', function (event) {
          if (event.key === 'Enter') {
            event.preventDefault()
            doSearch()
          } else if (event.key === 'Escape') {
            hidePreview()
          }
        })
        for (var i = 0; i < tabs.length; i += 1) {
          (function (node) {
            node.addEventListener('click', function () { setTab(node.getAttribute('data-tab')) })
          })(tabs[i])
        }

        // 心跳：面板关着也要能感知「AI 查了备忘录」，动画才播得出来
        pingOnce()
        pingTimer = setInterval(pingOnce, PING_MS)

        /* ------------------------------------------------------------ 卸载 ---- */

        return function dispose() {
          try { if (timer !== null) clearInterval(timer) } catch (e) { /* ignore */ }
          try { if (pingTimer !== null) clearInterval(pingTimer) } catch (e) { /* ignore */ }
          try { if (toastTimer !== null) clearTimeout(toastTimer) } catch (e) { /* ignore */ }
          timer = null
          pingTimer = null
          toastTimer = null
          try { window.removeEventListener('resize', onResize) } catch (e) { /* ignore */ }
          try { scene.destroy() } catch (e) { /* ignore */ }
          try { shelfVideo.destroy() } catch (e) { /* ignore */ }
          try { btn.remove() } catch (e) { /* ignore */ }
          try { panel.remove() } catch (e) { /* ignore */ }
          try { var st = document.getElementById(STYLE_ID); if (st !== null) st.remove() } catch (e) { /* ignore */ }
        }
      }

      /* ------------------------------------------------------ React 座位 ---- */

      function MemoSeat() {
        var ref = React.useRef(null)
        React.useEffect(function () {
          var dispose = null
          try {
            dispose = mountPanel()
          } catch (error) {
            warn('挂载面板失败：' + String(error && error.message ? error.message : error))
          }
          return function () {
            try { if (typeof dispose === 'function') dispose() } catch (error) { /* ignore */ }
          }
        }, [])
        return React.createElement('span', {
          ref: ref,
          style: { display: 'none' },
          'aria-hidden': 'true',
        })
      }

      /* ------------------------------------------------------------ 入口 ---- */

      function apply(ctx) {
        if (!React || typeof React.createElement !== 'function') {
          warn('拿不到 React，跳过面板（模型仍可用工具查备忘录）')
          return
        }
        if (ctx === undefined || ctx.slots === undefined) {
          warn('没有 slots 服务，跳过面板')
          return
        }
        if (typeof React.useRef !== 'function' || typeof React.useEffect !== 'function') {
          warn('React 种子缺 useRef/useEffect，跳过面板')
          return
        }
        try {
          ctx.slots.inject(SLOT, function () {
            return ctx.slots.register({ name: SLOT, id: SLOT_ID, order: 60 }, MemoSeat)
          })
        } catch (error) {
          warn('注册面板座位失败（不影响工具）：' + String(error && error.message ? error.message : error))
        }
      }

      exports.inject = ['slots']
      exports.name = PLUGIN_ID
      exports.apply = apply
      return module.exports
    },
  })
}
