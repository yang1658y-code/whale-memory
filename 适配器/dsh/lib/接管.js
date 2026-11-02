/**
 * 会记得你的鲸鱼 · 压缩接管核心
 *
 * 这个文件**不 import 任何 DSH 包**，所以能脱离 DSH 单独验收。
 * index.js 只是它的一层宿主壳（继承官方引擎 + 应急阀）。
 *
 * 输入：官方即将遮蔽的那一段 messages
 * 输出：一条「历史归档索引」——不是摘要，是目录卡
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { 归档原话, 造索引, 抽关键词, 取原话, 总字符数, 原文表根 } from './归档.js'

const 索引上限默认 = 1200
const 索引相对上限 = 0.25 // 索引长度 ≤ 被压缩原文的 25%，离官方「必须更小」那道断言远远的

function 指纹路径(会话) {
  const 名 = String(会话 ?? '未命名')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
  return path.join(原文表根(), '归档指纹-' + 名 + '.json')
}

function 读指纹(会话) {
  try {
    const 原 = JSON.parse(fs.readFileSync(指纹路径(会话), 'utf8'))
    return new Set(Array.isArray(原) ? 原 : [])
  } catch {
    return new Set()
  }
}

function 写指纹(会话, 集) {
  try {
    const p = 指纹路径(会话)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify([...集].slice(-2000)), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 整段原话的内容指纹（角色 + 文本 + 分隔符），用于防重复归档 */
export function 原始指纹(原话) {
  const h = crypto.createHash('sha1')
  for (const s of 原话) h.update(s.角色 + '\u0000' + s.文本 + '\u0001')
  return h.digest('hex')
}

/**
 * 造出接管结果。
 * **永不抛错**——这条路一抛，压缩就失败，DSH 就有可能回落到它自己的摘要。
 *
 * @param {object} 参数
 * @param {Array} 参数.消息们 DSH 的 messages（即将被遮蔽那一段）
 * @param {string} 参数.会话 会话标识（一般取 session.id）
 * @returns {{summary:Array, rawOutput:Array, llmStreamCall:boolean, provider:string, model:string, 报告:object}}
 */
export function 造接管结果({ 消息们, 会话 } = {}) {
  const 名 = 会话 || 'dsh'
  const 列表 = Array.isArray(消息们) ? 消息们 : []
  let 原话 = []
  let 字数 = 0
  try {
    原话 = 取原话(列表)
    字数 = 总字符数(列表)
  } catch {
    原话 = []
    字数 = 0
  }

  // ── 归档
  let 归档 = { ok: false, 句数: 0, 字数: 0, 首句ID: null, 末句ID: null, 内核: 'none', 错误: '未执行' }
  let 重复 = false
  try {
    const 印 = 原始指纹(原话)
    const 已存 = 读指纹(名)
    if (原话.length > 0 && 已存.has(印)) {
      重复 = true
    } else {
      归档 = 归档原话({ 消息们: 列表, 会话: 名 })
      if (归档.ok) {
        已存.add(印)
        写指纹(名, 已存)
      }
    }
  } catch (e) {
    归档 = { ...归档, 错误: String(e && e.message ? e.message : e) }
  }

  // ── 索引长度自适应
  let 关键词 = []
  try {
    关键词 = 抽关键词(
      原话.map((s) => s.文本),
      12
    )
  } catch {
    关键词 = []
  }
  const 相对上限 = Math.floor(字数 * 索引相对上限)
  const 硬上限 = Number(process.env['鲸鱼索引上限'] || 索引上限默认) || 索引上限默认
  let 上限字符 = Math.min(硬上限, Math.max(200, 相对上限))
  // 官方有一道断言：替换消息必须比被遮蔽内容小。索引绝不能撞上去。
  if (字数 > 0) 上限字符 = Math.min(上限字符, Math.max(24, 字数 - 1))

  let 索引文 = ''
  // ── 状态尾注先定下来，并把它的长度算进预算（否则"索引+尾注"会超原文，撞官方断言）
  let 尾注 = ''
  if (重复) {
    尾注 = '\n· 已归档过（同一份原文，未重写）'
  } else if (归档.ok) {
    尾注 = '\n· 已归档 ' + 归档.句数 + ' 句（' + (归档.内核 === 'none' ? '兜底写入' : '内核写入') + '）'
  } else {
    尾注 = '\n· 归档失败：' + (归档.错误 || '未知原因')
  }

  const 正文预算 = Math.max(16, Math.min(上限字符 - 尾注.length - 1, 上限字符))
  try {
    索引文 = 造索引({
      会话: 名,
      句数: 原话.length,
      字数,
      首句ID: 归档.首句ID,
      末句ID: 归档.末句ID,
      关键词,
      上限字符: 正文预算,
    })
  } catch (e) {
    索引文 =
      '〔历史归档·原话未丢〕本段已移出上下文。' +
      '索引生成异常（' +
      String(e && e.message ? e.message : e) +
      '），原话已按原文表保存。'
  }

  索引文 += 尾注
  // ── 最后一道闸：无论如何不许等于或超过原文字符数
  if (字数 > 0 && 索引文.length >= 字数) {
    const 截 = Math.max(2, 字数 - 1)
    索引文 = 索引文.slice(0, 截 - 1) + '…'
  }

  return {
    summary: [{ type: 'text', text: 索引文 }],
    rawOutput: [],
    llmStreamCall: false, // 明确声明：这不是模型写的摘要
    provider: 'whale-archive',
    model: 'local-index',
    报告: { 会话: 名, 句数: 原话.length, 字数, 索引字符: 索引文.length, 归档, 重复, 关键词 },
  }
}
