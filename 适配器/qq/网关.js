'use strict'
/**
 * 网关.js · QQ 官方 WebSocket 长连接
 *
 * 这一层最难，也最能证明工程质量。要做对的六件事：
 *   ① Hello(op10) → 起心跳；心跳带最新 seq，收 ACK(op11) 才算活着
 *   ② Identify(op2) 只在首次/会话失效时发；平时断线用 Resume(op6) 带 session_id+seq 补漏
 *   ③ op7 = 平台让重连 → 走 Resume，别重新 Identify（否则丢事件）
 *   ④ op9 = 会话无效 → 清 session/seq，作废令牌，重新 Identify
 *   ⑤ 断线指数退避 + 抖动，不许狂重连把平台打到限流
 *   ⑥ 超过「平台给的心跳间隔 + 15 秒」收不到心跳 ACK 就当掉线，主动断开重连（假活比掉线更坑）
 *      ⛔ 余量必须从 heartbeat_interval 算，不许写死秒数——写死 30 秒而平台发 41.25 秒，
 *         就会陷入「连上 30 秒 → 误判假活 → 重连」的死循环（2026-11-02 真机踩到）
 *
 * WebSocket 来源：Node 22+ 自带全局 WebSocket（零依赖）；
 * 老版本 Node 自动退回可选的 ws 包——注意 ws 不进 dependencies，装了才用，没装给清晰提示。
 * 零依赖（对 Node ≥22 而言）。
 */
const 令牌模块 = require('./令牌.js')
const 凭据模块 = require('./凭据.js')

const 网关接口 = 'https://api.sgroup.qq.com/gateway'
const INTENT_群与单聊 = 1 << 25   // 33554432：群@ + 单聊（我们的全部所需）
// 【2026-11-02 真机血的教训】这里原来写死 30 秒，而平台在 op10 里给的 heartbeat_interval
// 是 41250ms —— 于是「第一次心跳还没到点」就被判假活：每 30 秒必断一次、连上 30 秒再断，
// 日志看着在跑，实际每 30 秒有一段瞎窗（靠 RESUMED 补发才没丢消息，纯属侥幸）。
// 铁律：超时必须由平台给的间隔推出来，绝不写死。
const 心跳兜底间隔毫秒 = 41250
const 心跳超时余量毫秒 = 15000
let 心跳间隔毫秒 = 心跳兜底间隔毫秒
let 心跳超时毫秒 = 心跳间隔毫秒 + 心跳超时余量毫秒
const 最大退避毫秒 = 60 * 1000

const 已知事件 = [
  'READY', 'RESUMED',
  'GROUP_AT_MESSAGE_CREATE', 'C2C_MESSAGE_CREATE',
  'AT_MESSAGE_CREATE', 'DIRECT_MESSAGE_CREATE',
  'GROUP_ADD_ROBOT', 'GROUP_DEL_ROBOT'
]

function 取WS实现() {
  if (typeof globalThis.WebSocket === 'function') return { 实现: globalThis.WebSocket, 原生: true, 名字: 'Node 内置 WebSocket' }
  try {
    const W = require('ws')
    return { 实现: W.WebSocket || W, 原生: false, 名字: 'ws 包' }
  } catch {
    return null
  }
}

/** 把两种 WebSocket 风格抹平成同一种：给 on(事件, fn) */
function 造连接(地址, WS信息) {
  const ws = WS信息.原生 ? new WS信息.实现(地址) : new WS信息.实现(地址)
  const 表 = { open: [], message: [], close: [], error: [] }
  const 触发 = (名, 载荷) => { for (const fn of 表[名]) { try { fn(载荷) } catch (e) { console.error('[网关] 回调异常', e && e.message) } } }

  if (WS信息.原生) {
    ws.addEventListener('open', () => 触发('open'))
    ws.addEventListener('message', (e) => 触发('message', typeof e.data === 'string' ? e.data : String(e.data)))
    ws.addEventListener('close', (e) => 触发('close', { 码: e && e.code, 因: e && e.reason }))
    ws.addEventListener('error', (e) => 触发('error', (e && e.message) || 'WebSocket 错误'))
  } else {
    ws.on('open', () => 触发('open'))
    ws.on('message', (d) => 触发('message', String(d)))
    ws.on('close', (码, 因) => 触发('close', { 码, 因 }))
    ws.on('error', (e) => 触发('error', (e && e.message) || 'WebSocket 错误'))
  }

  return {
    ws, 事件表: 表, 触发,
    on: (名, fn) => { if (表[名]) 表[名].push(fn) },
    发送: (对象) => {
      const 开 = (ws.readyState === undefined) ? true : (ws.readyState === 1 || ws.readyState === ws.OPEN)
      if (!开) return { ok: false, 原因: '连接未打开' }
      try { ws.send(JSON.stringify(对象)); return { ok: true } } catch (e) { return { ok: false, 原因: String(e && e.message) } }
    },
    关闭: () => { try { ws.close() } catch {} },
    状态: () => ws.readyState
  }
}

/**
 * 串台自检：READY 报回来的机器人，是不是 配置/qq.json 里那只。
 *
 * 2026-11-02 真机踩到：一键装换了新机器人（1906239808），起网关后日志明明写
 * 「凭据就绪 AppID 1906239808」，READY 回来的却是 1906238509 —— 令牌缓存串台
 * （磁盘里那份旧令牌还有 7000 秒寿命，被当成新凭据的令牌用了）。
 * 从外面看全绿，实际连的是上一只——最坑的一种绿。
 * 根治在 令牌.js 的 可用()（缓存按 appId 隔离）；这里只留一道「说人话」的报警。
 * 认不出名字里的数字就跳过，宁可不报也不误报。
 */
function 检串台(机器人, 选项 = {}) {
  const 名 = String((机器人 && (机器人.username || 机器人.id)) || '')
  const 数 = 名.match(/(\d{6,})/)
  if (!数) return null
  const 凭 = 凭据模块.取凭据(选项)
  if (!凭.ok || !凭.appId) return null
  if (String(数[1]) === String(凭.appId)) return null
  return '串台：配置里 AppID 是 ' + 凭.appId + '，READY 回来的却是「' + 名 + '」—— 手里那份令牌属于别的机器人。'
    + '停网关 → 删 数据/qq令牌.json → 再起（新版已按 appId 隔离缓存，删一次即可）'
}

function 造网关(选项 = {}) {
  const 日志 = 选项.日志 || (() => {})
  const 事件回调 = 选项.事件 || (() => {})
  const 状态回调 = 选项.状态 || (() => {})
  const WS信息 = 选项.WS || 取WS实现()   // 选项.WS 是验收注入缝：给个假 WS 就能离线验鉴权格式与心跳

  const 状态 = {
    已启动: false, 已就绪: false, 阶段: '待启动',
    session: null, seq: null, 重连次数: 0, 事件数: 0, 最近事件: null, 最近错误: null
  }
  let 连接 = null
  let 心跳定时 = null
  let 心跳看门狗 = null
  let 重连定时 = null
  let 收尾 = false
  let 当前token = null   // Resume 要用明文，令牌模块对外只给脱敏值，故本地存一份
  let 就绪等待 = []   // {resolve, reject, 超时器}

  const 报状态 = () => { try { 状态回调(Object.assign({}, 状态)) } catch {} }
  const 改阶段 = (s) => { 状态.阶段 = s; 报状态() }

  function 清心跳() {
    if (心跳定时) { clearInterval(心跳定时); 心跳定时 = null }
    if (心跳看门狗) { clearTimeout(心跳看门狗); 心跳看门狗 = null }
  }

  function 兑现(结果) {
    const 待 = 就绪等待; 就绪等待 = []
    for (const w of 待) { clearTimeout(w.超时器); 结果.ok ? w.resolve(结果) : w.reject(new Error(结果.原因)) }
  }

  function 发心跳() {
    if (!连接) return
    连接.发送({ op: 1, d: 状态.seq })
    if (心跳看门狗) clearTimeout(心跳看门狗)
    心跳看门狗 = setTimeout(() => {
      日志('warn', '心跳 ' + Math.round(心跳超时毫秒 / 1000) + ' 秒无 ACK，判定假活，主动断开重连')
      状态.最近错误 = '心跳超时'
      try { 连接.关闭() } catch {}
    }, 心跳超时毫秒)
  }

  function 处理帧(帧) {
    if (!帧 || typeof 帧 !== 'object') return
    const { op, d, s, t } = 帧
    if (typeof s === 'number') 状态.seq = s

    if (op === 10) {                       // Hello
      日志('info', '网关握手成功（op10 Hello），心跳间隔 ' + (d && d.heartbeat_interval) + 'ms')
      清心跳()
      心跳间隔毫秒 = Math.max(5000, Number((d && d.heartbeat_interval) || 心跳兜底间隔毫秒))
      心跳超时毫秒 = 心跳间隔毫秒 + 心跳超时余量毫秒
      心跳定时 = setInterval(发心跳, 心跳间隔毫秒)
      发心跳()
      // 有会话就补漏，没会话才重新鉴权
      if (状态.session && 当前token) {
        改阶段('补漏中(Resume)')
        连接.发送({ op: 6, d: { token: 'QQBot ' + 当前token, session_id: 状态.session, seq: 状态.seq } })
      }
      return
    }

    if (op === 11) {                       // 心跳 ACK
      if (心跳看门狗) { clearTimeout(心跳看门狗); 心跳看门狗 = null }
      return
    }

    if (op === 7) {                        // 平台要求重连
      日志('warn', '平台下发 op7，主动重连（保留会话做 Resume）')
      状态.最近错误 = 'op7 重连'
      try { 连接.关闭() } catch {}
      return
    }

    if (op === 9) {                        // 会话无效，必须重新鉴权
      日志('warn', '会话失效（op9），清 session/seq 并重换令牌')
      状态.session = null
      状态.seq = null
      状态.最近错误 = 'op9 会话失效'
      令牌模块.作废()
      try { 连接.关闭() } catch {}
      return
    }

    if (op === 0) {                        // 事件分发
      状态.事件数++
      状态.最近事件 = { 类型: t, 时间: new Date().toISOString() }
      if (t === 'READY') {
        状态.session = (d && d.session_id) || null
        状态.已就绪 = true
        状态.机器人 = (d && d.user) || null
        改阶段('已就绪')
        const 串 = 检串台(状态.机器人, 选项)
        状态.串台 = 串
        if (串) { 状态.最近错误 = 串; 日志('error', 串) }
        日志('info', 'READY 收到：机器人 ' + ((d && d.user && (d.user.username || d.user.id)) || '未知') + '，会话 ' + String(状态.session).slice(0, 8) + '…')
        兑现({ ok: true, 就绪: Object.assign({}, 状态), 机器人: (d && d.user) || null })
      } else if (t === 'RESUMED') {
        状态.已就绪 = true
        改阶段('已就绪(已补漏)')
        日志('info', 'RESUMED：断线期间的事件已由平台补发')
        兑现({ ok: true, 就绪: Object.assign({}, 状态) })
      }
      try { 事件回调(t, d, 帧) } catch (e) { 日志('warn', '事件回调异常：' + (e && e.message)) }
      return
    }
  }

  async function 取网关地址(token) {
    const r = await fetch(网关接口, { headers: { Authorization: 'QQBot ' + token } })
    const 文本 = await r.text()
    let j = null
    try { j = JSON.parse(文本) } catch {}
    if (!r.ok || !j || !j.url) return { ok: false, 原因: '取网关地址失败 HTTP ' + r.status + ' ' + String(文本).slice(0, 160) }
    return { ok: true, url: j.url }
  }

  async function 连接一次() {
    if (收尾) return
    改阶段('取令牌')
    const t = await 令牌模块.取令牌(选项)
    if (!t.ok) { 状态.最近错误 = t.原因; 改阶段('令牌失败'); 日志('error', t.原因); return 排重连() }

    当前token = t.access_token
    改阶段('取网关地址')
    const g = await 取网关地址(t.access_token)
    if (!g.ok) { 状态.最近错误 = g.原因; 改阶段('网关地址失败'); 日志('error', g.原因); return 排重连() }

    改阶段('连接中')
    const 本连接 = 造连接(g.url, WS信息)
    连接 = 本连接

    本连接.on('open', () => {
      日志('info', 'WebSocket 已连上 ' + WS信息.名字)
      // Identify：鉴权格式必须是 QQBot {access_token}（旧文档写的 Bot {appid}.{token} 已废弃，照抄必 4004）
      本连接.发送({
        op: 2,
        d: {
          token: 'QQBot ' + t.access_token,
          intents: Number(选项.权限集 || INTENT_群与单聊),
          shard: [0, 1],
          properties: { $os: 'linux', $browser: 'whale-memory', $device: 'whale-memory' }
        }
      })
    })

    本连接.on('message', (文本) => {
      let 帧 = null
      try { 帧 = JSON.parse(文本) } catch { return }
      处理帧(帧)
    })

    本连接.on('error', (msg) => {
      状态.最近错误 = String(msg)
      日志('warn', 'WebSocket 错误：' + msg)
    })

    本连接.on('close', (信息) => {
      连接 = null
      清心跳()
      状态.已就绪 = false
      日志('warn', '连接关闭（码 ' + (信息 && 信息.码) + ' ' + ((信息 && 信息.因) || '') + '）')
      if (!收尾) 排重连()
    })
  }

  function 排重连() {
    if (收尾 || 重连定时) return
    状态.重连次数++
    const 指数 = Math.min(最大退避毫秒, 1000 * Math.pow(2, Math.min(6, 状态.重连次数 - 1)))
    const 等待 = Math.round(指数 * (0.75 + Math.random() * 0.5))   // 抖动，防多实例同时重连
    改阶段('退避 ' + Math.round(等待 / 1000) + 's 后重连')
    日志('info', '第 ' + 状态.重连次数 + ' 次重连，等待 ' + 等待 + 'ms')
    重连定时 = setTimeout(() => { 重连定时 = null; 连接一次().catch(e => { 状态.最近错误 = String(e && e.message); 排重连() }) }, 等待)
  }

  return {
    状态: () => Object.assign({}, 状态),
    WS实现: WS信息 ? WS信息.名字 : '无（Node 版本过低且未装 ws）',

    async 启动(启动选项 = {}) {
      if (!WS信息) {
        const 原因 = '没有可用的 WebSocket 实现：当前 Node ' + process.version + '，请升级到 Node 22+（自带 WebSocket），或 npm i ws'
        日志('error', 原因)
        return { ok: false, 原因 }
      }
      收尾 = false
      状态.已启动 = true
      const 就绪Promise = new Promise((resolve, reject) => {
        const 超时 = Number(启动选项.等就绪毫秒 || 20000)
        const 超时器 = setTimeout(() => reject(new Error('等待 READY 超时（' + 超时 + 'ms），最近错误：' + (状态.最近错误 || '无'))), 超时)
        就绪等待.push({ resolve, reject, 超时器 })
      })
      连接一次().catch(e => { 状态.最近错误 = String(e && e.message); 日志('error', '连接异常：' + 状态.最近错误); 排重连() })
      try { return await 就绪Promise } catch (e) { return { ok: false, 原因: String(e && e.message) } }
    },

    关闭() {
      收尾 = true
      清心跳()
      if (重连定时) { clearTimeout(重连定时); 重连定时 = null }
      if (连接) { try { 连接.关闭() } catch {} }
      状态.已就绪 = false
      状态.已启动 = false
      改阶段('已关闭')
      兑现({ ok: false, 原因: '网关被主动关闭' })
    }
  }
}

module.exports = { 造网关, INTENT_群与单聊, 取WS实现, 已知事件 }
