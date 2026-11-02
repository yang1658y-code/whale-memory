/**
 * 会记得你的鲸鱼 · DSH 压缩接管 · 归档层
 *
 * 职责只有一件：**在 DSH 即将把这段历史换成一条消息之前，把它的原话逐字存下来。**
 *
 * 三条纪律：
 *   ① 绝不调用模型、绝不做语义摘要——这里只做搬运和机械统计；
 *   ② 归档失败不许抛错（抛了压缩就失败，DSH 会回落到它自己的路子）；
 *   ③ 内核在就用内核的原文表（格式天然一致），内核不在就自己按同格式落盘。
 *
 * 原文表格式（与 内核/原文回溯.js 一致）：
 *   {"句ID":"会话#轮次.句序","会话":"x","轮次":1,"句序":1,"角色":"user","时间":"…","文本":"…"}
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { 原文表根 as 算原文表根, 解析原文表根, 对齐内核根, 用户数据根 } from './路径.js'

const 需 = createRequire(import.meta.url)
const 本目录 = path.dirname(fileURLToPath(import.meta.url))

/* ─────────────────────────── 一、从 DSH 消息里取原话 ─────────────────────────── */

/** 一个 content block 转成逐字文本。非 text 块保留原文 JSON，绝不改写。 */
export function 块转文本(块) {
  if (块 === null || 块 === undefined) return ''
  if (typeof 块 === 'string') return 块
  if (typeof 块 !== 'object') return String(块)
  if (块.type === 'text') return String(块.text ?? '')
  // 工具调用 / 工具结果 / 图片 等：除 type 外原样序列化，一个字段都不丢
  const 副本 = {}
  for (const k of Object.keys(块)) if (k !== 'type') 副本[k] = 块[k]
  let 尾 = ''
  try {
    尾 = JSON.stringify(副本)
  } catch {
    尾 = '[不可序列化]'
  }
  return '〔' + String(块.type) + '〕' + 尾
}

/** 一条消息的正文（所有 content block 顺序拼接） */
export function 消息文本(消息) {
  if (!消息 || typeof 消息 !== 'object') return ''
  const 内 = 消息.content
  if (typeof 内 === 'string') return 内
  if (!Array.isArray(内)) return ''
  return 内.map(块转文本).join('')
}

/** 一条消息的角色：DSH 的 role，或由 content block 推断 */
export function 消息角色(消息) {
  if (!消息 || typeof 消息 !== 'object') return 'unknown'
  if (typeof 消息.role === 'string' && 消息.role.length > 0) return 消息.role
  const 内 = Array.isArray(消息.content) ? 消息.content : []
  if (内.some((b) => b && b.type === 'tool-result')) return 'tool'
  return 'unknown'
}

/**
 * 把 DSH 的 messages 数组摊成「一条一条原话」。
 * 空消息丢弃（但不丢内容：只要有一段非空白就保留）。
 */
export function 取原话(消息们) {
  const 句们 = []
  for (const m of Array.isArray(消息们) ? 消息们 : []) {
    const 文本 = 消息文本(m)
    if (文本.trim().length === 0) continue
    句们.push({ 角色: 消息角色(m), 文本 })
  }
  return 句们
}

/* ─────────────────────────── 二、找内核 / 定目录 ─────────────────────────── */

/** 找内核的 原文回溯.js：环境变量优先，其次按项目结构上溯 */
export function 找内核() {
  // 断内核演练开关：强制只用自带兜底（验收用，生产别开）
  if (process.env['鲸鱼禁用内核'] === '1') return null
  // 【必须先做】内核的 默认根目录 是 require 那一刻读 env 定死的常量。
  // 这里先把 env 对齐，内核加载后自己算的根才跟归档/检索是同一个目录。
  对齐内核根()
  const 候选 = []
  if (process.env['鲸鱼内核']) 候选.push(process.env['鲸鱼内核'])
  // 开发期：适配器/dsh/lib → 项目根/内核
  候选.push(path.join(本目录, '..', '..', '..', '内核', '原文回溯.js'))
  // 装成独立包时：插件根/内核（用户把内核放在旁边）
  候选.push(path.join(本目录, '..', '内核', '原文回溯.js'))
  for (const p of 候选) {
    try {
      const m = 需(p)
      if (m && typeof m.喂一轮 === 'function') return { 模块: m, 路径: p }
    } catch {
      /* 继续试下一个 */
    }
  }
  return null
}

/**
 * 原文表根目录。
 *
 * 【一致性铁律】归档写这里、检索读这里，**算法只允许有一份**——就是 lib/路径.js。
 * 本函数只是它的一个转发，保留这个名字是因为 记忆核心.js / 装.cjs 都按它取根。
 *
 * 旧实现在这里问内核要 `默认根目录`，而内核的默认根落在**包目录内**：
 * npm update 一次，用户的记忆连目录一起被替换掉。已废。
 */
export function 原文表根() {
  return 算原文表根()
}

/** 根目录 + 来处（日志/体检用，不含任何用户内容） */
export { 解析原文表根, 用户数据根 }

/* ─────────────────────────── 三、落盘 ─────────────────────────── */

function 归一会话名(会话) {
  const 原 = String(会话 ?? '').trim()
  const 净 = 原.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_')
  return 净.length > 0 ? 净 : '未命名'
}

/** 内核不在时的兜底写入：与内核同格式，一行一句，只追加 */
function 兜底落盘(名, 句们, 路径) {
  fs.mkdirSync(path.dirname(路径), { recursive: true })
  const 时间 = new Date().toISOString()
  const 行们 = 句们.map((句, i) =>
    JSON.stringify({
      句ID: 名 + '#0.' + (i + 1),
      会话: 名,
      轮次: 0,
      句序: i + 1,
      角色: 句.角色,
      时间,
      文本: 句.文本,
      来源: 'dsh-compaction-fallback',
    })
  )
  fs.appendFileSync(路径, 行们.join('\n') + '\n', 'utf8')
  return { 路径, 句ID们: 句们.map((_, i) => 名 + '#0.' + (i + 1)) }
}

/**
 * 归档一段即将被压缩的历史。
 * **任何情况都不抛错**，失败也要返回 ok:false 并说原因。
 *
 * @param {object} 参数 {消息们, 会话, 轮次?}
 * @returns {{ok:boolean, 句数:number, 字数:number, 首句ID:string|null, 末句ID:string|null, 路径:string|null, 内核:string, 错误?:string}}
 */
export function 归档原话({ 消息们, 会话, 轮次 } = {}) {
  const 名 = 归一会话名(会话)
  const 句们 = 取原话(消息们)
  const 字数 = 句们.reduce((n, s) => n + s.文本.length, 0)
  const 空 = { ok: false, 句数: 0, 字数: 0, 首句ID: null, 末句ID: null, 路径: null, 内核: 'none' }
  if (句们.length === 0) return { ...空, 错误: '没有可归档的原话' }

  const 内核 = 找内核()
  try {
    if (内核) {
      const 根目录 = 原文表根()
      const 选项 = { 根目录 }
      if (Number.isFinite(Number(轮次))) 选项.轮次 = Number(轮次)
      const 结果 = 内核.模块.喂一轮(名, 句们.map((s) => ({ 角色: s.角色, 文本: s.文本 })), 选项)
      if (结果 && 结果.错误) return { ...空, 内核: 内核.路径, 错误: 结果.错误 }
      const ids = Array.isArray(结果?.句ID们) ? 结果.句ID们 : []
      return {
        ok: true,
        句数: 句们.length,
        字数,
        首句ID: ids[0] ?? null,
        末句ID: ids[ids.length - 1] ?? null,
        路径: 结果?.路径 ?? path.join(根目录, '原文表-' + 名 + '.jsonl'),
        内核: 内核.路径,
        轮次: 结果?.轮次 ?? null,
      }
    }
    const 路径 = path.join(原文表根(), '原文表-' + 名 + '.jsonl')
    const 写 = 兜底落盘(名, 句们, 路径)
    return {
      ok: true,
      句数: 句们.length,
      字数,
      首句ID: 写.句ID们[0] ?? null,
      末句ID: 写.句ID们[写.句ID们.length - 1] ?? null,
      路径: 写.路径,
      内核: 'none',
      轮次: null,
    }
  } catch (e) {
    return { ...空, 内核: 内核?.路径 ?? 'none', 错误: String(e && e.message ? e.message : e) }
  }
}

/* ─────────────────────────── 四、机械索引（不是摘要） ─────────────────────────── */

const 停用 = new Set([
  '这个', '那个', '我们', '你们', '他们', '就是', '不是', '可以', '什么', '怎么',
  '因为', '所以', '但是', '如果', '然后', '现在', '已经', '还是', '这样', '那样',
  '一个', '一下', '一点', '没有', '自己', '时候', '知道', '觉得', '应该', '需要',
  'the', 'and', 'for', 'that', 'this', 'with', 'you', 'are', 'was', 'have', 'not',
])

/** 机械抽词：中文双字组 + 英文单词，按出现次数排序。纯统计，不含任何语义判断。 */
export function 抽关键词(文本们, 上限 = 12) {
  const 全 = Array.isArray(文本们) ? 文本们.join('\n') : String(文本们 ?? '')
  const 虚 = new Set('的了在和与都也就要被把从到对为以是有这那个我你他们上下里中之而其且或再还只更很')
  const 计数 = new Map()
  const 加 = (词) => {
    if (!词 || 词.length < 2 || 停用.has(词)) return
    计数.set(词, (计数.get(词) || 0) + 1)
  }
  for (const m of 全.matchAll(/[A-Za-z][A-Za-z0-9_.-]{1,}/g)) 加(m[0].toLowerCase())
  const 汉 = 全.replace(/[^\u4e00-\u9fa5]+/g, ' ')
  for (const 段 of 汉.split(/\s+/)) {
    for (let i = 0; i + 2 <= 段.length; i += 1) {
      const 双 = 段.slice(i, i + 2)
      // 双字组跨词时首尾常是虚词，滤掉减噪（纯机械规则，不看语义）
      if (虚.has(双[0]) || 虚.has(双[1])) continue
      加(双)
    }
  }
  return [...计数.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 上限)
    .map(([词]) => 词)
}

/**
 * 造索引文本。
 *
 * ⚠️ 这里刻意**不写任何内容概要**。DSH 官方摘要的做法是让模型把这段历史用话重说一遍，
 * 那一刻原话就被替换掉了。我们只给：坐标、规模、机械关键词、取回方式。
 * 模型看到的是「目录卡」，不是「别人转述的你」。
 */
export function 造索引({
  会话,
  起 = null,
  止 = null,
  轮数 = null,
  句数 = 0,
  字数 = 0,
  首句ID = null,
  末句ID = null,
  关键词 = [],
  上限字符 = 1200,
} = {}) {
  const 头 = '〔历史归档·原话未丢〕'
  const 行们 = []
  行们.push(
    头 +
      '本段更早的对话已移出上下文，原话逐字存于本地原文表，' +
      '**未做任何摘要改写**（不是压缩摘要，是索引）。'
  )
  const 范围 = []
  if (轮数 !== null) 范围.push(String(轮数) + ' 轮')
  范围.push(String(句数) + ' 句')
  范围.push(String(字数) + ' 字')
  行们.push('· 规模：' + 范围.join(' / '))
  if (起 || 止) 行们.push('· 时间：' + [起, 止].filter(Boolean).join(' → '))
  if (首句ID || 末句ID) 行们.push('· 句ID 区间：' + [首句ID, 末句ID].filter(Boolean).join(' ~ '))
  if (会话) 行们.push('· 会话：' + 会话)
  if (关键词.length > 0) 行们.push('· 高频词（机械统计，非摘要）：' + 关键词.join('、'))
  行们.push('· 取回：按句ID 或关键词查本地原文表即可逐字翻出，不依赖本段上下文。')

  let 文 = 行们.join('\n')
  if (文.length <= 上限字符) return 文

  // 预算不够就降精度：短版 → 极简版 → 硬截断。绝不允许索引 ≥ 原文
  const 区间 = 首句ID && 末句ID ? '（' + 首句ID + ' ~ ' + 末句ID + '）' : ''
  const 短版 =
    '〔历史归档·原话未丢〕' + 句数 + ' 句 / ' + 字数 + ' 字已移出上下文，原话逐字存于原文表' + 区间 + '，未做任何摘要。'
  if (短版.length <= 上限字符) return 短版

  const 极简 = '〔归档·原话未丢〕' + 句数 + ' 句已移出上下文，原话存入原文表' + 区间 + '，未摘要。'
  if (极简.length <= 上限字符) return 极简

  const 一行 = '〔已归档·未摘要〕' + 句数 + ' 句'
  if (一行.length <= 上限字符) return 一行

  return 一行.slice(0, Math.max(1, 上限字符 - 1)) + '…'
}

/** 给个粗略的 token 估算，用于「索引必须比被压缩内容短」的自检 */
export function 粗估token(文本) {
  const s = String(文本 ?? '')
  let 汉 = 0
  let 其他 = 0
  for (const ch of s) {
    if (/[\u4e00-\u9fa5]/.test(ch)) 汉 += 1
    else 其他 += 1
  }
  return Math.ceil(汉 * 0.75 + 其他 / 3.5)
}

/** 一段 messages 的总字符数（用于给索引定上限） */
export function 总字符数(消息们) {
  return 取原话(消息们).reduce((n, s) => n + s.文本.length, 0)
}
