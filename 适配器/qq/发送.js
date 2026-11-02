'use strict'
/**
 * 发送.js · 把话送回 QQ
 *
 * 官方两条硬约束（写在这里，省得后来人踩）：
 *   ① 被动回复（带 msg_id）只有 5 分钟窗口。超窗就发不出去，只能丢弃并记日志——不重试，重试也是白搭。
 *   ② 同一条用户消息连发多条时，msg_seq 必须递增，否则平台判定重复。这里按 msg_id 记序号。
 *
 * 接口：
 *   群聊   POST https://api.sgroup.qq.com/v2/groups/{group_openid}/messages
 *   单聊   POST https://api.sgroup.qq.com/v2/users/{openid}/messages
 *   频道   POST https://api.sgroup.qq.com/channels/{channel_id}/messages
 *
 * 零依赖。
 */
const 令牌模块 = require('./令牌.js')
const 归一模块 = require('./归一.js')

const 基址 = 'https://api.sgroup.qq.com'
const 被动窗口毫秒 = 5 * 60 * 1000

const 序号表 = new Map()   // msgId → 已用序号，防平台判重复

function 取序号(msgId) {
  if (!msgId) return undefined
  const n = (序号表.get(msgId) || 0) + 1
  序号表.set(msgId, n)
  if (序号表.size > 500) { // 防内存长胖，清最旧的一批
    for (const k of 序号表.keys()) { 序号表.delete(k); if (序号表.size <= 400) break }
  }
  return n
}

/**
 * @param {object} 消息 { 会话, 文本, msgId?, 时间? }
 * @param {object} 选项 { 环境?, 日志? }
 * @returns {{ok, 状态码?, 原因?, 超窗?, 已丢弃?, 返回?}}
 */
async function 发消息(消息, 选项 = {}) {
  const 日志 = 选项.日志 || (() => {})
  const 会话 = 消息 && 消息.会话
  const 文本 = String((消息 && 消息.文本) || '')
  const 解 = 归一模块.解析会话(会话)
  if (!解) return { ok: false, 原因: '会话名不合规矩：' + 会话 }
  if (!文本.trim()) return { ok: false, 原因: '空回复，不发（省得在群里刷空白）' }

  // 被动窗口：超过 5 分钟就别费劲了，平台必拒
  if (消息.msgId && 消息.时间 && Date.now() - Number(消息.时间) > 被动窗口毫秒) {
    日志('warn', '被动回复已超 5 分钟窗口，丢弃不重试（会话 ' + 会话 + '）')
    return { ok: false, 超窗: true, 已丢弃: true, 原因: '被动回复窗口已过（>5 分钟）' }
  }

  let 路 = null
  let 体 = null
  if (解.类别 === '群') {
    路 = '/v2/groups/' + 解.键 + '/messages'
    体 = { content: 文本, msg_type: 0, msg_id: 消息.msgId || undefined, msg_seq: 取序号(消息.msgId) }
  } else if (解.类别 === '单聊') {
    路 = '/v2/users/' + 解.键 + '/messages'
    体 = { content: 文本, msg_type: 0, msg_id: 消息.msgId || undefined, msg_seq: 取序号(消息.msgId) }
  } else if (解.类别 === '频道') {
    路 = '/channels/' + 解.键 + '/messages'
    体 = { content: 文本, msg_id: 消息.msgId || undefined }
  } else {
    return { ok: false, 原因: '暂不支持主动推送该会话类型：' + 解.类别 }
  }
  if (!体.msg_id) delete 体.msg_id
  if (体.msg_seq === undefined) delete 体.msg_seq

  const 发一次 = async (token) => {
    const r = await fetch(基址 + 路, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'QQBot ' + token },
      body: JSON.stringify(体)
    })
    const 文 = await r.text()
    let j = null
    try { j = JSON.parse(文) } catch {}
    return { 状态码: r.status, j, 文 }
  }

  let t = await 令牌模块.取令牌(选项)
  if (!t.ok) return { ok: false, 原因: '取令牌失败：' + t.原因 }
  let r = await 发一次(t.access_token)

  // 401/403 多半是令牌被提前作废（别处换了令牌），作废重取再试一次
  if (r.状态码 === 401 || r.状态码 === 403) {
    日志('warn', '发送返回 ' + r.状态码 + '，作废令牌后重试一次')
    令牌模块.作废()
    t = await 令牌模块.取令牌(Object.assign({}, 选项, { 强制刷新: true }))
    if (t.ok) r = await 发一次(t.access_token)
  }

  if (r.状态码 >= 200 && r.状态码 < 300) {
    return { ok: true, 状态码: r.状态码, 返回: r.j }
  }
  const 原因 = '发送失败 HTTP ' + r.状态码 + ' ' + String(r.文).slice(0, 200)
  日志('error', 原因 + '（会话 ' + 会话 + '）')
  return { ok: false, 状态码: r.状态码, 原因, 返回: r.j }
}

module.exports = { 发消息, 基址, 被动窗口毫秒, 清序号: () => 序号表.clear() }
