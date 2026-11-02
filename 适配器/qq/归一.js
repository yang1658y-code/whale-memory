'use strict'
/**
 * 归一.js · QQ 事件 → 内核认得的形状
 *
 * 内核只认 {角色, 文本, 时间}，别的什么都不用知道。
 * 所以这一层存在的唯一理由：把 QQ 五花八门的事件，翻译成那三个字段，
 * 顺便把「这句话属于哪个会话」定死——会话名是原文表的文件名，定错了原话就翻不出来。
 *
 * 会话命名规则（改之前先看 文档/QQ接入.md）：
 *   qq-群-{group_openid}     群聊，一个群一个账本
 *   qq-单聊-{user_openid}     私聊，一个人一个账本
 *   qq-频道-{channel_id}      频道子频道
 *
 * 零依赖。
 */

// 群里 @机器人 会以 <@!数字> 形式混在正文里，必须剥掉，否则原话里全是尖括号
const AT标记 = /<@!?[^>]{1,64}>/g
// 表情/图片占位符，QQ 给的格式形如 <emoji:1> <faceType:1,...>
const 占位标记 = /<(?:emoji|faceType|img|voice|video|file):[^>]*>/gi

function 剥标记(文本) {
  return String(文本 == null ? '' : 文本)
    .replace(AT标记, ' ')
    .replace(占位标记, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** 按点路径取值：'author.user_openid' → 事件.author.user_openid（真平台的单聊 openid 就在 author 里） */
function 取路径(对象, 点路径) {
  if (!对象 || !点路径) return undefined
  let 值 = 对象
  for (const 段 of String(点路径).split('.')) {
    if (值 == null) return undefined
    值 = 值[段]
  }
  return 值
}

function 取时间(事件) {
  const ts = 事件 && 事件.timestamp
  if (!ts) return Date.now()
  const s = String(ts)
  // QQ 给的是 ISO 字符串（2026-10-27T05:05:00+08:00），也兼容毫秒数
  if (/^\d{10,}$/.test(s)) return Number(s)
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : Date.now()
}

/** 事件类型 → 人话 + 会话键头 */
const 类型表 = {
  GROUP_AT_MESSAGE_CREATE: { 人话: '群@', 前缀: 'qq-群-', 键字段: 'group_openid' },
  GROUP_ADD_ROBOT: { 人话: '入群', 系统: true },
  GROUP_DEL_ROBOT: { 人话: '退群', 系统: true },
  C2C_MESSAGE_CREATE: { 人话: '单聊', 前缀: 'qq-单聊-', 键字段: 'author.user_openid' },
  AT_MESSAGE_CREATE: { 人话: '频道@', 前缀: 'qq-频道-', 键字段: 'channel_id' },
  DIRECT_MESSAGE_CREATE: { 人话: '频道私信', 前缀: 'qq-频道私信-', 键字段: 'guild_id' }
}

/**
 * @param {string} 事件名 如 GROUP_AT_MESSAGE_CREATE
 * @param {object} d      事件的 d 字段
 * @returns {null|{渠道,类型,会话,角色,文本,时间,msgId,发送者,原始类型,原始}}
 */
function 归一(事件名, d) {
  const 规 = 类型表[事件名]
  if (!规 || 规.系统) return null
  d = d || {}
  const 作者 = d.author || {}
  // 键字段既可能是顶层（group_openid），也可能是嵌套（单聊的 author.user_openid）
  // 取不到就返回 null —— 宁可跳过这一条，也不许用 'unknown' 造一个假账本（假账本会让原话永久翻不出来）
  const 会话键 = 取路径(d, 规.键字段) || d[规.键字段] || d.channel_id || d.group_openid || d.user_openid || 作者.user_openid || null
  const 会话 = 会话键 ? 规.前缀 + 会话键 : null
  const 文本 = 剥标记(d.content)
  const 附件 = Array.isArray(d.attachments) ? d.attachments : []
  // 没有文字但有图/语音：留个占位，别让这一轮彻底消失（原话里至少知道「他发了张图」）
  const 有效文本 = 文本 || (附件.length ? '[' + 附件.map(a => (a.content_type || '附件')).join(',') + ']' : '')

  return {
    渠道: 'qq',
    类型: 规.人话,
    会话,
    角色: '用户',
    文本: 有效文本,
    时间: 取时间(d),
    msgId: d.id || null,
    发送者: 作者.id || 作者.user_openid || d.user_openid || null,
    发送者名: 作者.username || 作者.nick || null,
    原始类型: 事件名,
    原始: d
  }
}

/** 归一结果 → 内核 入库一轮 用的消息条（只留内核认的三个字段，外加会话） */
function 转内核消息(归一结果) {
  if (!归一结果) return null
  return { 角色: 归一结果.角色, 文本: 归一结果.文本, 时间: 归一结果.时间 }
}

/** 会话名反解：qq-群-xxx → {类别:'群', 键:'xxx'} */
function 解析会话(会话) {
  const m = /^qq-(群|单聊|频道|频道私信)-(.+)$/.exec(String(会话 || ''))
  return m ? { 类别: m[1], 键: m[2] } : null
}

module.exports = { 归一, 转内核消息, 剥标记, 解析会话, 类型表, 取时间, 取路径 }
