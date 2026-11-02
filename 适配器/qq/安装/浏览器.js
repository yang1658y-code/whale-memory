'use strict'
/**
 * 会记得你的鲸鱼 · 安装线 · 浏览器层（CDP）
 *
 * 唯一职责：把「本机已有的 Chromium 内核浏览器」变成一个能听指令的调试端点，用完干净关掉。
 *
 * 三条设计约束（每条都是踩出来的）：
 *   ① **不内置 Chromium。** 一个浏览器 ~150MB，为了抄两个字符串让用户先等下载，
 *      等于亲手废掉「最容易上手」。所以只找本机已有的：Chrome / Edge / Chromium / Brave。
 *      注意 Windows 10/11 每台机器都自带 Edge（Chromium 内核，CDP 与 Chrome 同构），
 *      所以「找 Chrome」应写成「找 Chromium 内核的浏览器」——这不降低覆盖率，反而拉满。
 *   ② **独立 profile。** 绝不碰用户日常浏览器的 cookie 与标签页：一碰就得先请他关浏览器，
 *      那是整条安装线上最容易失败的一步。代价是首次必须扫码一次——这正是产品许诺的
 *      「人只做两步」里的第一步，不是缺陷；扫完 cookie 留在独立 profile 里，第二次起免扫。
 *   ③ **端口让系统分配**（--remote-debugging-port=0），从 stderr 的
 *      "DevTools listening on ws://…" 读回来。写死 9222 会在用户已经开着调试端口时无声撞车。
 *
 * 零依赖：只用 Node 标准库 + Node ≥22 自带的全局 WebSocket。
 */

const fs = require('fs')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

const 根目录 = path.join(__dirname, '..', '..', '..')
const 默认数据目录 = path.join(根目录, '配置', '浏览器配置')

/** 候选浏览器：先本机常见位置，再看环境变量与配置文件覆盖 */
function 候选清单(环境 = process.env) {
  const L = 环境.LOCALAPPDATA || ''
  const PF = 环境.ProgramFiles || 'C:\\Program Files'
  const PF86 = 环境['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  return [
    { 名字: 'Chrome', 路径: path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { 名字: 'Chrome', 路径: path.join(PF86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { 名字: 'Chrome', 路径: path.join(L, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { 名字: 'Edge', 路径: path.join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { 名字: 'Edge', 路径: path.join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { 名字: 'Chromium', 路径: path.join(L, 'Chromium', 'Application', 'chrome.exe') },
    { 名字: 'Brave', 路径: path.join(PF, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
    { 名字: 'Brave', 路径: path.join(L, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') }
  ]
}

/**
 * 找浏览器。优先级：选项.路径 > 配置/浏览器.json 的 路径 > 环境变量 鲸鱼浏览器 > 候选清单第一个存在的。
 * 找不到 → 返回 { ok:false, 说明, 试过 } —— 由调用方决定怎么提示，本函数永不抛错。
 */
function 找浏览器(选项 = {}) {
  const 环境 = 选项.环境 || process.env
  const 试过 = []

  const 显式 = []
  if (选项.路径) 显式.push({ 名字: '显式指定', 路径: 选项.路径 })
  try {
    const p = 选项.配置路径 || path.join(根目录, '配置', '浏览器.json')
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (j && j.路径) 显式.push({ 名字: j.名字 || '配置指定', 路径: j.路径 })
    }
  } catch { /* 配置坏了不该挡住安装，忽略 */ }
  if (环境.鲸鱼浏览器) 显式.push({ 名字: '环境变量', 路径: 环境.鲸鱼浏览器 })

  for (const c of 显式) {
    试过.push(c.路径)
    if (fs.existsSync(c.路径)) return { ok: true, 路径: c.路径, 名字: c.名字, 来源: '指定' }
  }
  for (const c of 候选清单(环境)) {
    试过.push(c.路径)
    if (fs.existsSync(c.路径)) return { ok: true, 路径: c.路径, 名字: c.名字, 来源: '本机已装' }
  }
  return {
    ok: false,
    说明: '没找到 Chromium 内核的浏览器。装一个 Chrome 或 Edge 即可（Windows 10/11 自带 Edge），'
      + '也可以设环境变量 鲸鱼浏览器=浏览器exe完整路径，或在 配置/浏览器.json 里写 {"路径":"…"}',
    试过
  }
}

/** 最小的 GET/PUT JSON 工具（CDP 的 HTTP 面只有这几个端点用得上） */
function 请求JSON(端口, 请求路径, 方法 = 'GET', 超时毫秒 = 3000) {
  return new Promise((resolve) => {
    // ⚠️ path 必须写成 `path: 请求路径`：本文件顶部 `const path = require('path')`，
    // 简写成 { path } 会把 Node 的 path 模块对象当请求路径发出去（会抛 ERR_UNESCAPED_CHARACTERS）。
    const req = http.request({ host: '127.0.0.1', port: 端口, path: 请求路径, method: 方法, timeout: 超时毫秒 }, (res) => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { buf += d })
      res.on('end', () => {
        try { resolve({ ok: true, 数据: JSON.parse(buf) }) }
        catch (e) { resolve({ ok: false, 原因: '返回不是 JSON：' + buf.slice(0, 200) }) }
      })
    })
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, 原因: '请求超时' }) })
    req.on('error', (e) => resolve({ ok: false, 原因: String((e && e.message) || e) }))
    req.end()
  })
}

const 睡 = (ms) => new Promise((r) => setTimeout(r, Math.max(1, ms | 0)))

/**
 * 启动浏览器并等 CDP 就绪。
 *
 * @param {object} 选项
 * @param {string} 选项.路径        浏览器 exe（不传则调 找浏览器）
 * @param {string} 选项.数据目录    独立 profile 目录（默认 配置/浏览器配置）
 * @param {boolean} 选项.无头       true 则 --headless=new（验收/CI 用；真人装的时候要看得见窗口，因为要扫码）
 * @param {number} 选项.超时毫秒    等 CDP 就绪的上限
 * @returns {Promise<{ok, 端口?, ws地址?, 进程?, 关闭?, 说明?}>}
 */
async function 启动(选项 = {}) {
  if (typeof globalThis.WebSocket !== 'function') {
    return { ok: false, 说明: '这个 Node 没有内置 WebSocket（需 Node ≥22，当前 ' + process.version + '）——升级 Node 即可，不用装包' }
  }
  let 路径 = 选项.路径
  let 名字 = '浏览器'
  if (!路径) {
    const 找 = 找浏览器(选项)
    if (!找.ok) return { ok: false, 说明: 找.说明, 试过: 找.试过 }
    路径 = 找.路径; 名字 = 找.名字
  }
  if (!fs.existsSync(路径)) return { ok: false, 说明: '浏览器不存在：' + 路径 }

  const 数据目录 = 选项.数据目录 || 默认数据目录
  try { fs.mkdirSync(数据目录, { recursive: true }) } catch (e) {
    return { ok: false, 说明: '建不了独立配置目录（' + 数据目录 + '）：' + String((e && e.message) || e) }
  }

  const 固定端口 = Number(选项.端口) || 0

  // ① 指定端口时：先看是不是已经有同配置的浏览器活着 —— 活着就直接复用，不再开第二个。
  //    【为什么必须这一步】同一个 --user-data-dir 开第二个实例，Edge 会把请求交给已有实例、
  //    自己立刻退出，stderr 上永远等不到 "DevTools listening" —— 上一轮「窗口明明开着却连不上」就是这原因。
  if (固定端口) {
    const 探 = await 请求JSON(固定端口, '/json/version', 'GET', 1500)
    if (探.ok) {
      return {
        ok: true, 复用: true, 名字, 路径, 数据目录, 端口: 固定端口,
        ws地址: (探.数据 && 探.数据.webSocketDebuggerUrl) || '',
        进程: null,
        关闭: async () => {
          try {
            const v = await 请求JSON(固定端口, '/json/version', 'GET', 1500)
            if (v.ok && v.数据 && v.数据.webSocketDebuggerUrl) {
              const c = await 连接(v.数据.webSocketDebuggerUrl, { 超时毫秒: 3000 })
              if (c.ok) { try { await c.发('Browser.close', {}, 2000) } catch { /* 无所谓 */ } ; c.关() }
            }
          } catch { /* 无所谓 */ }
        }
      }
    }
  }

  const 参数 = [
    '--remote-debugging-port=' + (固定端口 || 0),
    '--user-data-dir=' + 数据目录,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
    '--disable-popup-blocking',
    '--window-size=1280,900',
    '--window-position=80,60'
  ]
  if (选项.无头) 参数.unshift('--headless=new')
  if (Array.isArray(选项.额外参数)) 参数.push(...选项.额外参数)
  if (选项.起始页) 参数.push(选项.起始页)

  let 进程
  try {
    // detached：让浏览器自成进程组 —— 父 node 被超时掐掉/退出时，窗口不会被连带杀掉。
    // （上一轮用户扫完码窗口却消失，就是进程树被一起收了。）
    // ⚠️ windowsHide 必须是 false（2026-11-02 真机踩坑）：
    //   Node 的 windowsHide:true 会给子进程塞 STARTF_USESHOWWINDOW/SW_HIDE，
    //   对 GUI 程序意味着**主窗口一出生就是隐藏的** —— 进程活着、CDP 连得上、
    //   页面也对，但人屏幕上什么都看不见（用户「没看见」就是这么来的）。
    //   浏览器是 GUI 程序，本来就不会弹黑框，所以这里没有理由隐藏。
    进程 = spawn(路径, 参数, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false, detached: true })
  } catch (e) {
    return { ok: false, 说明: '启动浏览器失败：' + String((e && e.message) || e) }
  }

  const 超时毫秒 = 选项.超时毫秒 || 20000
  const 结果 = await new Promise((resolve) => {
    let 落定 = false
    let 尾巴 = ''
    let 轮询钟 = null
    const 完 = (r) => { if (落定) return; 落定 = true; clearTimeout(定时); if (轮询钟) clearInterval(轮询钟); resolve(r) }
    const 定时 = setTimeout(() => 完({ ok: false, 说明: '浏览器起来了但 ' + 超时毫秒 + 'ms 内没开调试端口' + (尾巴 ? '；stderr 尾巴：' + 尾巴.slice(-400) : '') }), 超时毫秒)
    // 固定端口时同时走 HTTP 探测：即使浏览器把请求交给了已有实例（stderr 无输出），也能确认端口活着
    if (固定端口) {
      轮询钟 = setInterval(async () => {
        const p = await 请求JSON(固定端口, '/json/version', 'GET', 1200)
        if (p.ok) 完({ ok: true, 端口: 固定端口, ws地址: (p.数据 && p.数据.webSocketDebuggerUrl) || '' })
      }, 400)
    }

    const 收 = (块) => {
      尾巴 += 块.toString()
      const m = 尾巴.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) {
        const ws地址 = m[1]
        const 端口 = Number((ws地址.match(/:(\d+)\//) || [])[1]) || 0
        完({ ok: true, ws地址, 端口 })
      }
    }
    进程.stdout.on('data', 收)
    进程.stderr.on('data', 收)
    进程.on('exit', (码) => 完({ ok: false, 说明: '浏览器自己退了（退出码 ' + 码 + '）' + (尾巴 ? '；stderr：' + 尾巴.slice(-400) : '') }))
    进程.on('error', (e) => 完({ ok: false, 说明: '启动出错：' + String((e && e.message) || e) }))
  })

  if (!结果.ok) {
    try { 进程.kill() } catch { /* 已经死了 */ }
    return 结果
  }

  return {
    ok: true,
    名字,
    路径,
    数据目录,
    端口: 结果.端口,
    ws地址: 结果.ws地址,
    进程,
    /** 关掉：先请求 CDP Browser.close（让它自己存 cookie），再兜底 kill */
    关闭: async () => {
      try {
        const v = await 请求JSON(结果.端口, '/json/version', 'GET', 1500)
        if (v.ok && v.数据 && v.数据.webSocketDebuggerUrl) {
          const c = await 连接(v.数据.webSocketDebuggerUrl, { 超时毫秒: 3000 })
          if (c.ok) { try { await c.发('Browser.close', {}, 2000) } catch { /* 关不掉也无所谓 */ } ; c.关() }
        }
      } catch { /* 走兜底 */ }
      await 睡(300)
      try { if (!进程.killed) 进程.kill() } catch { /* 已经死了 */ }
    }
  }
}

/**
 * 连一个 CDP WebSocket 端点。
 * 发(方法, 参数, 超时) → Promise<结果>：CDP 用 id 配对，这里把「事件」单独回调出去，不塞进返回值。
 */
function 连接(ws地址, 选项 = {}) {
  return new Promise((resolve) => {
    const 表 = { 事件: [], 关闭: [] }
    let 序 = 0
    const 待 = new Map()
    let ws
    try { ws = new globalThis.WebSocket(ws地址) }
    catch (e) { return resolve({ ok: false, 说明: 'WebSocket 建不起来：' + String((e && e.message) || e) }) }

    const 落定 = (r) => { clearTimeout(定时); resolve(r) }
    const 定时 = setTimeout(() => {
      try { ws.close() } catch { /* 没连上 */ }
      落定({ ok: false, 说明: '连 CDP 端点超时（' + (选项.超时毫秒 || 8000) + 'ms）：' + ws地址 })
    }, 选项.超时毫秒 || 8000)

    ws.addEventListener('open', () => {
      落定({
        ok: true,
        ws,
        发(方法, 参数 = {}, 超时毫秒 = 10000) {
          return new Promise((res, rej) => {
            const id = ++序
            const 钟 = setTimeout(() => { 待.delete(id); rej(new Error('CDP 指令超时：' + 方法)) }, 超时毫秒)
            待.set(id, { res, rej, 钟, 方法 })
            try { ws.send(JSON.stringify({ id, method: 方法, params: 参数 })) }
            catch (e) { clearTimeout(钟); 待.delete(id); rej(e) }
          })
        },
        在(事件名, fn) { 表.事件.push({ 事件名, fn }) },
        关() { try { ws.close() } catch { /* 已关 */ } },
        原始: ws
      })
    })

    ws.addEventListener('message', (e) => {
      let 报
      try { 报 = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data)) } catch { return }
      if (报.id && 待.has(报.id)) {
        const w = 待.get(报.id); 待.delete(报.id); clearTimeout(w.钟)
        if (报.error) w.rej(new Error('CDP「' + w.方法 + '」报错：' + (报.error.message || JSON.stringify(报.error))))
        else w.res(报.result)
        return
      }
      if (报.method) for (const it of 表.事件) { if (it.事件名 === 报.method || it.事件名 === '*') { try { it.fn(报.params, 报.method) } catch { /* 观察者自己的错不该断链路 */ } } }
    })

    ws.addEventListener('error', () => { 落定({ ok: false, 说明: 'CDP 连接出错（端点可能已关闭）：' + ws地址 }) })
    ws.addEventListener('close', () => {
      for (const w of 待.values()) { clearTimeout(w.钟); w.rej(new Error('CDP 连接已断：' + w.方法)) }
      待.clear()
      for (const f of 表.关闭) { try { f() } catch { /* 收尾失败不影响主流程 */ } }
    })
  })
}

/** 开一个新标签页，返回它的 CDP 端点（HTTP 面：PUT /json/new） */
async function 开页(端口, url, 选项 = {}) {
  const 编码 = encodeURIComponent(url)
  let r = await 请求JSON(端口, '/json/new?' + 编码, 'PUT', 选项.超时毫秒 || 8000)
  if (!r.ok) r = await 请求JSON(端口, '/json/new?' + 编码, 'GET', 选项.超时毫秒 || 8000) // 老版本浏览器只认 GET
  if (!r.ok) return { ok: false, 说明: '开标签页失败：' + r.原因 }
  const 页 = Array.isArray(r.数据) ? r.数据[0] : r.数据
  if (!页 || !页.webSocketDebuggerUrl) return { ok: false, 说明: '开页返回里没有调试端点：' + JSON.stringify(r.数据).slice(0, 200) }
  return { ok: true, 页ID: 页.id, ws地址: 页.webSocketDebuggerUrl, 页 }
}

/** 列出所有可调试目标 */
async function 列页(端口) {
  const r = await 请求JSON(端口, '/json/list')
  return r.ok && Array.isArray(r.数据) ? r.数据 : []
}

module.exports = {
  找浏览器, 候选清单, 启动, 连接, 开页, 列页, 请求JSON, 睡,
  默认数据目录
}
