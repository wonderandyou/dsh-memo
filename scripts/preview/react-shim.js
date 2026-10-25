/**
 * 预览页专用的极简 React 替身
 * ============================================================================
 * 只实现插件真正用到的那点 API：createElement / useRef / useEffect / useState。
 * 目的是在**不开真机**的情况下，把 lib/client.js 里那个 React 座位组件
 * （ReasoningGlowSeat）真跑一遍 —— 验证它取 ref、挂载、卸载清理都对。
 *
 * ★ 这不是 React 的替代品，只是自测夹具；真机上用的是 DSH 平台自带的 React。
 * ========================================================================== */
(function () {
  var CURRENT = null
  var cleanups = []

  function h(type, props) {
    var children = []
    for (var i = 2; i < arguments.length; i++) children.push(arguments[i])
    var out = { type: type, props: {} }
    for (var key in (props || {})) out.props[key] = props[key]
    out.props.children = children.flat(Infinity).filter(function (c) { return c !== null && c !== undefined && c !== false })
    return out
  }

  function useRef(init) {
    if (!CURRENT) throw new Error('useRef 必须在组件渲染中调用')
    var slot = CURRENT.hooks[CURRENT.i]
    if (!slot) slot = CURRENT.hooks[CURRENT.i] = { current: init }
    CURRENT.i += 1
    return slot
  }

  function useState(init) {
    if (!CURRENT) throw new Error('useState 必须在组件渲染中调用')
    var slot = CURRENT.hooks[CURRENT.i]
    if (!slot) {
      slot = CURRENT.hooks[CURRENT.i] = { value: typeof init === 'function' ? init() : init }
      var host = CURRENT
      slot.set = function (next) {
        slot.value = typeof next === 'function' ? next(slot.value) : next
        currentRender.rerender(host)
      }
    }
    CURRENT.i += 1
    return [slot.value, slot.set]
  }

  function useEffect(fn, deps) {
    if (!CURRENT) throw new Error('useEffect 必须在组件渲染中调用')
    var slot = CURRENT.hooks[CURRENT.i]
    CURRENT.i += 1
    var changed = true
    if (slot && slot.deps && deps) {
      changed = deps.length !== slot.deps.length || deps.some(function (d, i) { return d !== slot.deps[i] })
    }
    if (!changed) return
    if (slot && typeof slot.cleanup === 'function') cleanups.push(slot.cleanup)
    var record = { deps: deps, cleanup: null }
    CURRENT.hooks[CURRENT.i - 1] = record
    pending.push(function () { record.cleanup = fn() })
  }

  var pending = []

  function mount(vnode) {
    if (vnode === null || vnode === undefined || vnode === false) {
      return document.createTextNode('')
    }
    if (typeof vnode === 'string' || typeof vnode === 'number') {
      return document.createTextNode(String(vnode))
    }
    if (typeof vnode.type === 'function') {
      var parent = CURRENT
      CURRENT = { hooks: [], i: 0 }
      var out = vnode.type(vnode.props || {})
      CURRENT = parent
      return mount(out)
    }
    var el = document.createElement(vnode.type)
    var props = vnode.props || {}
    for (var key in props) {
      var value = props[key]
      if (key === 'children') continue
      if (key === 'ref') {
        if (value && typeof value === 'object') value.current = el
        continue
      }
      if (key === 'className') { el.className = value; continue }
      if (key === 'style' && value && typeof value === 'object') {
        for (var s in value) el.style.setProperty(s, value[s])
        continue
      }
      if (key.slice(0, 2) === 'on' && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value)
        continue
      }
      if (value === true) { el.setAttribute(key, ''); continue }
      if (value === false || value === null || value === undefined) continue
      el.setAttribute(key, String(value))
    }
    var kids = props.children || []
    if (!Array.isArray(kids)) kids = [kids]
    kids.forEach(function (child) { el.appendChild(mount(child)) })
    return el
  }

  function render(vnode, container) {
    CURRENT = null
    pending = []
    container.textContent = ''
    container.appendChild(mount(vnode))
    // 挂载后再跑 effect（与 React 的 commit 顺序一致：先 DOM，后 effect）
    var queue = pending
    pending = []
    queue.forEach(function (run) { run() })
    return function unmount() {
      cleanups.forEach(function (fn) { try { if (typeof fn === 'function') fn() } catch (e) {} })
      cleanups = []
      container.textContent = ''
    }
  }

  var currentRender = { rerender: function () { /* 预览页只渲染一次，不需要真正的重渲染 */ } }

  window.ReactShim = {
    createElement: h,
    useRef: useRef,
    useState: useState,
    useEffect: useEffect,
    render: render,
    /**
     * 真机里 `require("react")` 返回的是"平台种子模块"（默认导出在 .default 上）。
     * 这个函数给的是**模块对象**，不是 require 本身 —— 调用方要包成 require 函数。
     */
    asModule() { return { default: window.ReactShim, createElement: h, useRef: useRef, useState: useState, useEffect: useEffect } },
  }
})()
