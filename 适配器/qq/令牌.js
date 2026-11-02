'use strict'
/**
 * QQ 令牌层 · access_token 的取与缓存。
 *
 * 三个必须做对的地方（做错会被平台限流或鉴权失败）：
 *   ① 提前 60 秒刷新——别卡在过期那一秒撞 4004
 *   ② 并发合并——同时十个请求要令牌，只能发一次换令牌请求
 *   ③ 换令牌失败不缓存失败结果——下次还能重试，不把一次网络抖动变成长期不可用
 *
 * 缓存：内存 + 磁盘（默认 数据/qq令牌.json，属临时产物，可随时删；验收可指定隔离路径）
 * 零依赖：只用 Node 标准库。
 */
const fs = require('fs')
const path = require('path')
const 凭据模块 = require('./凭据.js')

const 缓存路径 = path.join(凭据模块.根目录, '数据', 'qq令牌.json')
const 令牌接口们 = [
  'https://bots.qq.com/app/getAppAccessToken',
  'https://api.bot.qq.com/app/getAppAccessToken' // 备用域名，主域名抽风时顶上
]
const 提前刷新毫秒 = 60 * 1000

let 内存缓存 = null      // {access_token, 到期时间戳, appId}
let 进行中 = null        // 并发合并用的 Promise

/** 验收要隔离：允许调用方指定缓存文件位置 */
function 定路径(选项 = {}) {
  return 选项.令牌缓存路径 || 缓存路径
}

function 读磁盘缓存(路径) {
  try {
    if (!fs.existsSync(路径)) return null
    const j = JSON.parse(fs.readFileSync(路径, 'utf8'))
    if (!j || !j.access_token || !j.到期时间) return null
    return { access_token: j.access_token, 到期时间: Number(j.到期时间), appId: j.appId == null ? null : String(j.appId) }
  } catch { return null }
}

function 写磁盘缓存(c, 路径) {
  try {
    fs.mkdirSync(path.dirname(路径), { recursive: true })
    fs.writeFileSync(路径, JSON.stringify({ appId: c.appId == null ? null : String(c.appId), access_token: c.access_token, 到期时间: c.到期时间 }, null, 2), 'utf8')
  } catch { /* 落盘失败不影响主流程，内存缓存照样能用 */ }
}

/**
 * 缓存能不能用。必须同时满足两条——第二条是 2026-11-02 真机血案：
 *
 * 换机器人后 appId 变了，而磁盘里那份旧令牌还有 7000 多秒寿命。新网关一启动就「命中缓存」，
 * 拿着 A 机器人的令牌去连 WS，日志却印着「凭据就绪 AppID B」——READY 回来的是 A。
 * 从外面看全绿，实际连的是上一只机器人。所以令牌缓存必须和 appId 绑死。
 *
 * 老格式缓存（没有 appId 字段）一律不认：宁可多换一次令牌（一次 HTTP），不许串台。
 */
function 可用(c, appId) {
  if (!(c && c.access_token && Number(c.到期时间) - 提前刷新毫秒 > Date.now())) return false
  if (appId == null) return true                                            // 调用方没给 appId → 退回老行为
  return String(c.appId == null ? '' : c.appId) === String(appId)
}

async function 换令牌(选项 = {}) {
  const 凭 = 凭据模块.取凭据(选项)
  if (!凭.ok) return { ok: false, 原因: '凭据不可用：' + 凭.问题.join('；') }

  let 最后错误 = null
  for (const 接口 of 令牌接口们) {
    try {
      const r = await fetch(接口, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: String(凭.appId), clientSecret: String(凭.appSecret) })
      })
      const 文本 = await r.text()
      let j = null
      try { j = JSON.parse(文本) } catch { j = null }
      if (!r.ok || !j || !j.access_token) {
        最后错误 = 'HTTP ' + r.status + ' ' + String(文本).slice(0, 200)
        continue
      }
      const 寿命 = Number(j.expires_in || 7200)
      return {
        ok: true,
        appId: String(凭.appId),
        access_token: j.access_token,
        到期时间: Date.now() + 寿命 * 1000,
        寿命秒: 寿命,
        接口
      }
    } catch (e) {
      最后错误 = String((e && e.message) || e)
    }
  }
  return { ok: false, 原因: '换令牌失败（两个域名都试过）：' + 最后错误 }
}

/**
 * 取令牌。
 * @param {object} 选项 { 强制刷新?, 环境?, 配置路径?, 不读磁盘?, 令牌缓存路径? }
 * @returns {{ok, access_token?, 到期时间?, 缓存命中?, 原因?}}
 */
async function 取令牌(选项 = {}) {
  const 存货路径 = 定路径(选项)
  const 凭 = 凭据模块.取凭据(选项)          // 只为拿当前 appId：缓存要和它对齐，不许串台
  const 当前appId = 凭.ok ? String(凭.appId) : null
  if (!选项.强制刷新) {
    if (可用(内存缓存, 当前appId)) return { ok: true, appId: 内存缓存.appId, access_token: 内存缓存.access_token, 到期时间: 内存缓存.到期时间, 缓存命中: '内存' }
    if (!选项.不读磁盘) {
      const 盘 = 读磁盘缓存(存货路径)
      if (可用(盘, 当前appId)) { 内存缓存 = 盘; return { ok: true, appId: 盘.appId, access_token: 盘.access_token, 到期时间: 盘.到期时间, 缓存命中: '磁盘' } }
    }
  }
  if (进行中) {   // 并发合并：后到的直接搭车，不另发请求
    const r = await 进行中
    return Object.assign({}, r, { 缓存命中: r && r.ok ? '合并' : (r && r.缓存命中) })
  }
  进行中 = (async () => {
    try {
      const r = await 换令牌(选项)
      if (r.ok) {
        内存缓存 = { access_token: r.access_token, 到期时间: r.到期时间, appId: r.appId }
        写磁盘缓存(内存缓存, 存货路径)
      }
      return r
    } finally {
      进行中 = null
    }
  })()
  return 进行中
}

/** 作废缓存（收到 op9 鉴权失败时立刻调） */
function 作废(选项 = {}) {
  内存缓存 = null
  if (!选项.保留磁盘) {
    try { const p = 定路径(选项); if (fs.existsSync(p)) fs.unlinkSync(p) } catch {}
  }
  return { ok: true }
}

function 状态(选项 = {}) {
  const c = 内存缓存 || 读磁盘缓存(定路径(选项))
  if (!c) return { 有令牌: false }
  const 剩 = Math.round((Number(c.到期时间) - Date.now()) / 1000)
  return { 有令牌: true, 剩余秒: 剩, appId: c.appId == null ? null : c.appId, 可用: 可用(c, 凭据模块.取凭据(选项).appId || null), 令牌: 凭据模块.脱敏(c.access_token) }
}

module.exports = { 取令牌, 换令牌, 作废, 状态, 缓存路径, 定路径 }
