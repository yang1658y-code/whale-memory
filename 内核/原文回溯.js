/**
 * 原文回溯.js — L1 原文回溯内核（项目「会记得你的鲸鱼」· 唯一抄不走的那一层）
 *
 * 一句话职责：
 *   喂进一轮对话 → 存下逐字原文 → 按「会话#轮次.句序」翻回来，
 *   连原话、轮次、第几句、前后上下文一并吐出。
 *
 * 【原文不可丢】四条红线（本文件存在的全部理由）
 *   ① 原文表只追加、绝不改写：原文表-<会话>.jsonl，一行一条，写完即定稿
 *   ② 索引可整表删掉重建，原文表永不动：索引-<会话>.json 只是加速器，
 *      所有读操作默认只读原文表 → 索引坏了也照样能翻出一句原话
 *   ③ 一行坏掉其余照读：坏行跳过 + 计数 + 留证据片段，绝不静默丢、绝不整表读不出
 *   ④ 句子带字符偏移（起/止）：原句能从原消息里逐字切回来，不靠重新分词
 *
 * 【与 原文库.js 的分工】互不依赖
 *   原文库.js ＝ 压缩场景，存「被替换的整段消息」，只留最近 5 段（防上下文丢失）
 *   本内核   ＝ 记忆场景，存「句级永久原文」，按句定位（防记忆丢失）
 *
 * 会记得你的鲸鱼 · 纯中文代码 · 2026-10-27
 */

'use strict'

const fs = require('fs')
const path = require('path')
const 参数 = require('./参数.js')

const 版本 = 1
const 内置根目录 = path.join(__dirname, '..', '数据', '原文回溯')
// 验收/演练可用环境变量把根目录指到临时目录，绝不碰真实原文表
const 默认根目录 = process.env.原文回溯根目录 ? String(process.env.原文回溯根目录) : 内置根目录
const 默认句数 = 2
const 坏行证据上限 = 20
// 话块：同一人连发的几句话算一段（间隔秒 + 句数上限，都可能必须拧）
const 默认话块间隔秒 = 300
const 默认话块最大句 = 12
// 出厂常量→真值优先取 配置/内核参数.json（热读）；缺文件时行为与改造前一致
const 取前后句数 = () => 参数.取整('原文回溯.前后句数', 默认句数)
const 取坏行上限 = () => 参数.取整('原文回溯.坏行证据上限', 坏行证据上限)
const 取话块间隔秒 = () => 参数.取整('原文回溯.话块间隔秒', 默认话块间隔秒)
const 取话块最大句 = () => 参数.取整('原文回溯.话块最大句', 默认话块最大句)
// 近期上下文：模型每次回话前先读多少轮（定于 2026-11-02：5–10 之间取 8）
const 默认近期轮数 = 8
// 近期上下文的总字数护栏。8 轮 QQ 短句约 800 字，这个数平时撞不到；
// 撞到就从最老的轮开始整轮丢，绝不从最新的轮里切半句。
const 默认近期最大字 = 4000
const 取近期轮数 = () => 参数.取整('近期上下文.轮数', 默认近期轮数)
const 取近期最大字 = () => 参数.取整('近期上下文.最大字符', 默认近期最大字)

// ═══════════════════════ 基础工具 ═══════════════════════

/** 会话名归一：非法字符换下划线，防路径穿越 */
function 归一会话名(会话) {
  const 原 = String(会话 == null ? '' : 会话).trim()
  const 净 = 原.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 120)
  return 净 || '默认'
}

/** 选项合并：调用方只传差异项，其余走默认 */
function 合并选项(选项) {
  const 选 = Object.assign({ 根目录: 默认根目录, 前后句数: 取前后句数() }, 选项 || {})
  选.根目录 = String(选.根目录 || 默认根目录)
  const 前 = Number.isFinite(Number(选.前)) ? Number(选.前) : null
  const 后 = Number.isFinite(Number(选.后)) ? Number(选.后) : null
  if (前 !== null || 后 !== null) {
    选.前句数 = 前 === null ? Number(选.前后句数) || 0 : 前
    选.后句数 = 后 === null ? Number(选.前后句数) || 0 : 后
  } else {
    const n = Math.max(0, Number(选.前后句数) || 0)
    选.前句数 = n
    选.后句数 = n
  }
  return 选
}

function 表路径(会话名, 选) {
  return path.join(选.根目录, '原文表-' + 会话名 + '.jsonl')
}

function 索引路径(会话名, 选) {
  return path.join(选.根目录, '索引-' + 会话名 + '.json')
}

function 拼接句ID(会话名, 轮次, 句序) {
  return 会话名 + '#' + 轮次 + '.' + 句序
}

/** 解析句ID：会话名可能含 #，故从最后一个 # 切 */
function 解析句ID(句ID) {
  const 串 = String(句ID == null ? '' : 句ID).trim()
  if (!串) return null
  const 井 = 串.lastIndexOf('#')
  if (井 <= 0 || 井 === 串.length - 1) return null
  const 会话名 = 串.slice(0, 井)
  const 后半 = 串.slice(井 + 1)
  const m = 后半.match(/^(\d+)\.(\d+)$/)
  if (!m) return null
  const 轮次 = Number(m[1])
  const 句序 = Number(m[2])
  if (!Number.isFinite(轮次) || !Number.isFinite(句序)) return null
  if (轮次 < 0 || 句序 < 1) return null
  return { 会话: 归一会话名(会话名), 原会话名: 会话名, 轮次, 句序 }
}

// ═══════════════════════ 切句（无损是唯一要求） ═══════════════════════

const 终止字 = new Set(['。', '！', '？', '；', '!', '?', ';', '\n'])
// 收尾符：遇到终止符后一并吸收，避免把「」""…）切成孤零零一句
const 收尾字 = new Set(['”', '’', '"', "'", '」', '』', '）', ')', '】', '》', '…', ' '])

/**
 * 切句：返回 [{文本, 起, 止, 空白}]，起/止 为原消息内的字符下标（[起, 止)）
 * 无损保证：所有段.文本 依次拼接 === 原文（含空白段）
 */
function 切句(原文) {
  const 文 = typeof 原文 === 'string' ? 原文 : (原文 == null ? '' : String(原文))
  if (文 === '') return []
  const 段们 = []
  let 起 = 0
  let i = 0
  const 收 = (止) => {
    const 片 = 文.slice(起, 止)
    段们.push({ 文本: 片, 起, 止, 空白: 片.trim() === '' })
  }
  while (i < 文.length) {
    if (终止字.has(文[i])) {
      i++
      // 吸收连续的终止符与收尾符（"真的？！"「好…」都不拆）
      while (i < 文.length && (终止字.has(文[i]) || 收尾字.has(文[i]))) i++
      收(i)
      起 = i
    } else {
      i++
    }
  }
  if (起 < 文.length) 收(文.length)
  return 段们
}

// ═══════════════════════ 读原文表（坏行容错） ═══════════════════════

/**
 * 读原文表：一行一解析，坏行跳过并留证据
 * @returns {{会话,记录,总行数,坏行数,坏行,存在,路径,错误?}}
 */
function 读原文表(会话, 选项 = {}) {
  const 选 = 合并选项(选项)
  const 名 = 归一会话名(会话)
  const 路径 = 表路径(名, 选)
  const 结果 = { 会话: 名, 记录: [], 总行数: 0, 坏行数: 0, 坏行: [], 存在: false, 路径 }
  let 文
  try {
    文 = fs.readFileSync(路径, 'utf8')
    结果.存在 = true
  } catch (e) {
    if (e.code !== 'ENOENT') { 结果.错误 = e.message }
    return 结果
  }
  const 行们 = 文.split('\n')
  for (let i = 0; i < 行们.length; i++) {
    const 行 = 行们[i]
    if (行.trim() === '') continue
    结果.总行数++
    try {
      const o = JSON.parse(行)
      if (!o || typeof o.句ID !== 'string' || typeof o.文本 !== 'string') throw new Error('缺关键字段（句ID/文本）')
      if (!Number.isFinite(Number(o.轮次)) || !Number.isFinite(Number(o.句序))) throw new Error('轮次或句序不是数字')
      o.轮次 = Number(o.轮次); o.句序 = Number(o.句序)
      结果.记录.push(o)
    } catch (e) {
      结果.坏行数++
      if (结果.坏行.length < 取坏行上限()) 结果.坏行.push({ 行号: i + 1, 片段: 行.slice(0, 120), 原因: e.message })
    }
  }
  return 结果
}

// ═══════════════════════ 索引（纯加速器，可整表重建） ═══════════════════════

function 读索引(会话, 选项 = {}) {
  const 选 = 合并选项(选项)
  const 名 = 归一会话名(会话)
  const 空 = { 版本, 会话: 名, 最后轮次: 0, 句数: 0, 轮次汇总: {}, 更新时间: null, 来源: '空表' }
  try {
    const o = JSON.parse(fs.readFileSync(索引路径(名, 选), 'utf8'))
    if (!o || typeof o !== 'object') return 空
    const 合 = Object.assign(空, o)
    合.轮次汇总 = (o.轮次汇总 && typeof o.轮次汇总 === 'object') ? o.轮次汇总 : {}
    合.来源 = '索引文件'
    return 合
  } catch (e) {
    if (e.code !== 'ENOENT') 空.来源 = '索引损坏，按空表用（不影响回溯）'
    return 空
  }
}

function 写索引(会话, 索引, 选项 = {}) {
  const 选 = 合并选项(选项)
  const 名 = 归一会话名(会话)
  const 路径 = 索引路径(名, 选)
  try {
    fs.mkdirSync(path.dirname(路径), { recursive: true })
    const 临时 = 路径 + '.tmp-' + process.pid
    索引.版本 = 版本
    索引.会话 = 名
    索引.更新时间 = new Date().toISOString()
    fs.writeFileSync(临时, JSON.stringify(索引, null, 1), 'utf8')
    fs.renameSync(临时, 路径)
    return true
  } catch (e) {
    console.warn('[原文回溯] 写索引失败（不影响回溯，原文表为准）：' + e.message)
    return false
  }
}

/** 下一轮次：查索引；索引不在就从原文表现算，绝不重号 */
function 下一轮次(会话, 选项 = {}) {
  const 选 = 合并选项(选项)
  const 索引 = 读索引(会话, 选)
  if (索引.来源 === '索引文件' && Number.isFinite(Number(索引.最后轮次))) return Number(索引.最后轮次) + 1
  const 表 = 读原文表(会话, 选)
  let 最大 = 0
  for (const r of 表.记录) if (r.轮次 > 最大) 最大 = r.轮次
  return 最大 + 1
}

// ═══════════════════════ 写入（只追加） ═══════════════════════

function 取消息正文(m) {
  if (typeof m === 'string') return m
  if (!m || typeof m !== 'object') return ''
  if (typeof m.文本 === 'string') return m.文本
  if (typeof m.content === 'string') return m.content
  if (typeof m.内容 === 'string') return m.内容
  return ''
}

function 取消息角色(m) {
  if (!m || typeof m !== 'object') return '用户'
  const 原 = m.角色 || m.role || '用户'
  const 串 = String(原).trim()
  const 低 = 串.toLowerCase()
  if (低 === 'user') return '用户'
  if (低 === 'assistant') return '助理'
  if (低 === 'system') return '系统'
  return 串 || '用户'
}

/**
 * 喂一轮：一次调用 = 一轮对话，轮内句序跨角色连续编号
 * @param {string} 会话
 * @param {Array|string} 消息列表 [{角色,文本,时间}] 或 单条文本
 * @param {object} 选项 {轮次?, 时间?, 根目录?}
 * @returns {{会话,轮次,写入,句ID们,说明?|错误?}}
 */
function 喂一轮(会话, 消息列表, 选项 = {}) {
  const 选 = 合并选项(选项)
  const 名 = 归一会话名(会话)
  let 消息 = []
  if (Array.isArray(消息列表)) 消息 = 消息列表
  else if (typeof 消息列表 === 'string') 消息 = [{ 角色: '用户', 文本: 消息列表 }]
  else if (消息列表 && typeof 消息列表 === 'object') 消息 = [消息列表]

  const 有效消息 = 消息.filter(m => 取消息正文(m).trim() !== '')
  if (有效消息.length === 0) {
    return { 会话: 名, 轮次: null, 写入: 0, 句ID们: [], 说明: '消息为空或全是空白，未写入' }
  }

  const 索引 = 读索引(名, 选)
  const 指定轮次 = Number(选.轮次)
  const 轮次 = Number.isFinite(指定轮次) ? 指定轮次 : 下一轮次(名, 选)
  const 现在 = Number.isFinite(Number(选.时间)) ? Number(选.时间) : Date.now()

  // 同轮已有句 → 句序接着往下编（追加不重号）
  const 旧表 = 读原文表(名, 选)
  let 句序 = 0
  for (const r of 旧表.记录) if (r.轮次 === 轮次 && r.句序 > 句序) 句序 = r.句序

  const 行们 = []
  const 句ID们 = []
  有效消息.forEach((m, i) => {
    const 角色 = 取消息角色(m)
    const 正文 = 取消息正文(m)
    const 消息时间 = Number(m && m.时间)
    const 段们 = 切句(正文)
    段们.forEach(段 => {
      if (段.空白) return
      句序++
      const 记录 = {
        v: 版本,
        句ID: 拼接句ID(名, 轮次, 句序),
        会话: 名,
        轮次,
        句序,
        角色,
        时间: Number.isFinite(消息时间) ? 消息时间 : 现在,
        文本: 段.文本,
        起: 段.起,
        止: 段.止,
        消息序: i + 1,
        消息长: 正文.length
      }
      句ID们.push(记录.句ID)
      行们.push(JSON.stringify(记录))
    })
  })

  if (行们.length === 0) {
    return { 会话: 名, 轮次, 写入: 0, 句ID们: [], 说明: '全是空白句，未写入' }
  }

  const 路径 = 表路径(名, 选)
  try {
    fs.mkdirSync(path.dirname(路径), { recursive: true })
    // 只追加：一次写完整行，绝不重写已有内容
    fs.appendFileSync(路径, 行们.join('\n') + '\n', 'utf8')
  } catch (e) {
    return { 会话: 名, 轮次, 写入: 0, 句ID们: [], 错误: '写原文表失败：' + e.message }
  }

  // 索引是加速器，写失败不报错、不影响数据
  const 键 = String(轮次)
  const 旧汇总 = 索引.轮次汇总[键] || { 句数: 0, 角色们: [], 消息数: 0, 时间: 现在 }
  旧汇总.句数 = (Number(旧汇总.句数) || 0) + 行们.length
  旧汇总.消息数 = (Number(旧汇总.消息数) || 0) + 有效消息.length
  if (!Array.isArray(旧汇总.角色们)) 旧汇总.角色们 = []
  for (const m of 有效消息) {
    const r = 取消息角色(m)
    if (!旧汇总.角色们.includes(r)) 旧汇总.角色们.push(r)
  }
  if (!Number.isFinite(Number(旧汇总.时间))) 旧汇总.时间 = 现在
  索引.轮次汇总[键] = 旧汇总
  索引.最后轮次 = Math.max(Number(索引.最后轮次) || 0, 轮次)
  索引.句数 = (Number(索引.句数) || 0) + 行们.length
  写索引(名, 索引, 选)

  return { 会话: 名, 轮次, 写入: 行们.length, 句ID们, 句序范围: [1, 句序], 路径 }
}

/**
 * 喂多轮：[{轮次?, 消息列表}]，逐轮调 喂一轮
 */
function 喂多轮(会话, 轮列表, 选项 = {}) {
  const 结果 = []
  if (!Array.isArray(轮列表)) return 结果
  for (const 轮 of 轮列表) {
    if (!轮) continue
    const 单轮选项 = Object.assign({}, 选项)
    if (轮.轮次 !== undefined && 轮.轮次 !== null) 单轮选项.轮次 = 轮.轮次
    if (轮.时间 !== undefined && 轮.时间 !== null) 单轮选项.时间 = 轮.时间
    结果.push(喂一轮(会话, 轮.消息列表 || 轮.消息 || [], 单轮选项))
  }
  return 结果
}

// ═══════════════════════ 回溯（本内核的主接口） ═══════════════════════

// ═══════════════════════ 话块（L1·连发合并） ═══════════════════════
/**
 * 划话块：把同一会话的句子按「谁在连着说」切成段。
 *
 * 【为何需要这一层】聊天平台的原子单位不是「消息」——
 *   · QQ 用户常把一句话拆成好几条发（「在吗」「我跟你说」「昨晩那个」）；
 *   · 机器人自己一次回复也会被平台按 msg_seq 拆成几条发出去（本仓 适配器/qq/发送.js 就靠 msg_seq 递增防重复）。
 * 所以按「一条消息 = 一句独立记忆」存，翻出来必然是半句，而且连发会变成好几段毫不相干的碎片。
 * 行业里已经踩过同一个坑：mem0 的 add 收的是 **messages 数组**（一段对话一次提交），
 * Zep 是 thread.add_messages 以 **thread 为归档单位**、episode 只做溯源——都不是「一条消息一次入库」。
 *
 * 【为何不落盘】原文表是唯一事实源，一行写完即定稿（本文件红线①②）。
 * 段的划分随新消息会延长——若写进原文表就成了会变的落盘字段，迟早与原文对不上。
 * 所以段永远在**读取时现算**，不增字段、不改存量、旧库直接受益。
 *
 * 规则（按优先级，任一成立即开新段）：
 *   ① 角色变了 → 换人说话了，上一段到头（用户连说完、对方接话）
 *   ② 与上一句间隔 > 话块间隔秒 → 隔了大半天，不屏同一件事
 *   ③ 本段已满 话块最大句 → 刷屏不能喂成一堵墙
 *   ④ 时间戳缺失 → 只看角色（宁合不拆：宁可多带一句，不可断头断尾）
 *
 * @param {Array} 记录们 读原文表 的 records
 * @param {object} 选项 根目录 / 话块间隔秒 / 话块最大句
 * @returns {{段们:Array, 索引:Map, 条数:number, 间隔毫秒:number, 最大句:number}}
 */
function 划话块(记录们, 选项 = {}) {
  const 选 = 合并选项(选项)
  const 间隔毫秒 = Math.max(1, 取话块间隔秒()) * 1000
  const 最大句 = Math.max(1, 取话块最大句())
  const 表 = Array.isArray(记录们) ? 记录们.slice() : []
  表.sort((a, b) => (a.轮次 - b.轮次) || (a.句序 - b.句序))
  const 段们 = []
  let 当前 = null
  for (const r of 表) {
    const 上 = 当前 ? 当前.句们[当前.句们.length - 1] : null
    let 开新 = !当前
    if (!开新) {
      if (String(r.角色) !== String(上.角色)) 开新 = true
      else if (当前.句们.length >= 最大句) 开新 = true
      else {
        const t1 = Number(上.时间)
        const t2 = Number(r.时间)
        if (Number.isFinite(t1) && Number.isFinite(t2) && Math.abs(t2 - t1) > 间隔毫秒) 开新 = true
      }
    }
    if (开新) {
      当前 = { 段ID: String(r.句ID), 会话: r.会话, 角色: String(r.角色), 起时间: r.时间, 止时间: r.时间, 句们: [] }
      段们.push(当前)
    }
    当前.句们.push(r)
    当前.止时间 = r.时间
  }
  const 索引 = new Map()
  段们.forEach((d, i) => {
    d.序号 = i + 1
    d.句数 = d.句们.length
    for (const x of d.句们) 索引.set(String(x.句ID), d)
  })
  return { 段们, 索引, 条数: 段们.length, 间隔毫秒, 最大句 }
}

/** 取某个句ID 所在的话块（现算，不落盘）；找不到 / 句ID 不合法 → null */
function 取话块(句ID, 选项 = {}) {
  const 解析 = 解析句ID(句ID)
  if (!解析) return null
  const 表 = 读原文表(解析.会话, 合并选项(选项))
  if (表.错误) return null
  const 划 = 划话块(表.记录, 选项)
  return 划.索引.get(String(句ID)) || null
}

/** 话块 → 可序列化的形状（给上层排版用，不带内部引用） */
function 段摘要(d, 命中句ID) {
  if (!d) return null
  return {
    段ID: String(d.段ID || ''),
    序号: Number(d.序号) || 0,
    句数: d.句们.length,
    角色: String(d.角色 || ''),
    会话: String(d.会话 || ''),
    句们: d.句们.map(r => ({
      句ID: String(r.句ID || ''),
      轮次: Number(r.轮次) || 0,
      句序: Number(r.句序) || 0,
      角色: String(r.角色 || ''),
      文本: String(r.文本 == null ? '' : r.文本),
      时间: r.时间,
      主: String(r.句ID || '') === String(命中句ID || '')
    }))
  }
}

// ═══════════════════════ 划轮 / 取最近轮（给模型摆「刚才聊了什么」） ═══════════════════════

/**
 * 划轮：句 → 整条消息 → 轮。
 *
 * 【为什么要拼回消息】切句会把一条消息切成几段（「在吗」「我跟你说」），
 * 照着句子往上下文里摆，模型看到的是被剁碎的残句。同一次入库的同一句
 * （轮次 + 消息序相同）按句序拼回去，才是人真正发出去的那一条。
 *
 * 【为什么要按角色切轮】原文表的「轮次」= 一次入库调用，一条 user 一个轮次、
 * 一条 assistant 又一个轮次。但人心里的一轮是「一来一回」。而且 QQ 里一句话
 * 常被拆成好几条发，按条数数轮会把一轮数成三轮（用户原话：说好几段才合为一轮）。
 * 所以切法是：换人说话才开新轮，同一个人连着发多条算同一轮。
 *
 * @param {Array} 记录们 原文表记录（每项含 轮次/句序/角色/文本/消息序）
 * @returns {{轮们:Array, 轮数:number, 消息数:number}}
 */
function 划轮(记录们, 选项 = {}) {
  const 表 = Array.isArray(记录们) ? 记录们.slice() : []
  表.sort((a, b) => (a.轮次 - b.轮次) || (a.句序 - b.句序))

  const 消息们 = []
  let 当前 = null
  for (const r of 表) {
    const 消息序 = Number.isFinite(Number(r.消息序)) ? Number(r.消息序) : 1
    const 键 = r.轮次 + ':' + 消息序
    if (!当前 || 当前.键 !== 键) {
      当前 = {
        键, 轮次: Number(r.轮次) || 0, 消息序,
        角色: String(r.角色 || ''), 文本: '', 句ID们: [], 时间: null
      }
      消息们.push(当前)
    }
    当前.文本 += String(r.文本 == null ? '' : r.文本)
    当前.句ID们.push(String(r.句ID || ''))
    const t = Number(r.时间)
    // 注意：Number(null) === 0 且是有限数，所以不能拿「是不是有限数」判空，必须显式比 null
    if (Number.isFinite(t) && 当前.时间 === null) 当前.时间 = t
  }

  const 轮们 = []
  let 轮 = null
  for (const m of 消息们) {
    // 开新轮的两种情形：①还没有轮；②当前轮已经出现过这个角色，却又换回来了
    // （user 说、assistant 回、user 又说 → 第二轮）。
    // 同角色连着发（user,user）不开新轮——那就是人一次说的一堆话。
    const 开新 = !轮 || (m.角色 !== 轮.末角色 && 轮.角色们.indexOf(m.角色) >= 0)
    if (开新) {
      轮 = { 轮号: 轮们.length + 1, 角色们: [], 末角色: '', 消息们: [], 起时间: null, 止时间: null }
      轮们.push(轮)
    }
    轮.消息们.push(m)
    if (轮.角色们.indexOf(m.角色) < 0) 轮.角色们.push(m.角色)
    轮.末角色 = m.角色
    const t = Number(m.时间)
    if (Number.isFinite(t)) {
      if (轮.起时间 === null) 轮.起时间 = t
      轮.止时间 = t
    }
  }

  const 轮们出 = 轮们.map(d => ({
    轮号: d.轮号,
    角色们: d.角色们.slice(),
    轮次们: Array.from(new Set(d.消息们.map(m => m.轮次))),
    消息数: d.消息们.length,
    字数: d.消息们.reduce((s, m) => s + m.文本.length, 0),
    起时间: d.起时间,
    止时间: d.止时间,
    消息们: d.消息们.map(m => ({
      角色: m.角色, 文本: m.文本, 句ID们: m.句ID们.slice(), 时间: m.时间, 轮次: m.轮次
    }))
  }))
  return { 轮们: 轮们出, 轮数: 轮们出.length, 消息数: 消息们.length }
}

/**
 * 取最近轮：给模型回话前摆的那份「刚才聊了什么」。
 *
 * 三条纪律：
 *   ① 逐字：只从原文表读，一个字不改写、不概括；
 *   ② 不重复：本轮用户刚说的那句（已入库、句ID已知）要剔掉——它会作为
 *      「他现在说」单独递进去，同一句摆两遍模型会当成说过两次；
 *   ③ 半句比没有更坏：撞字数护栏时整轮丢（从最老的丢），绝不切半句。
 *
 * @param {string} 会话
 * @param {object} 选项 {轮数?, 最大字?, 剔除句ID们?, 根目录?}
 * @returns {{会话,轮们,消息们,轮数,消息数,字数,截断,已剔句数,坏行数,存在,错误?}}
 */
function 取最近轮(会话, 选项 = {}) {
  const 选 = 合并选项(选项)
  const 名 = 归一会话名(会话)
  const 表 = 读原文表(名, 选)
  const 出 = {
    会话: 名, 轮们: [], 消息们: [], 轮数: 0, 消息数: 0, 字数: 0,
    请求轮数: 0, 截断: false, 已剔句数: 0, 坏行数: 0, 存在: !!表.存在
  }
  if (表.错误) { 出.错误 = 表.错误; return 出 }
  出.坏行数 = Number(表.坏行数) || 0

  const 要轮 = Math.max(0, Math.floor(Number.isFinite(Number(选.轮数)) ? Number(选.轮数) : 取近期轮数()))
  const 要字 = Math.max(200, Math.floor(Number.isFinite(Number(选.最大字)) && Number(选.最大字) > 0 ? Number(选.最大字) : 取近期最大字()))
  出.请求轮数 = 要轮
  if (要轮 === 0) return 出

  const 剔 = new Set((Array.isArray(选.剔除句ID们) ? 选.剔除句ID们 : []).map(x => String(x)))
  let 记录们 = 表.记录
  if (剔.size > 0) {
    const 留 = []
    for (const r of 记录们) if (!剔.has(String(r.句ID))) 留.push(r)
    出.已剔句数 = 记录们.length - 留.length
    记录们 = 留
  }

  const 划 = 划轮(记录们, 选)
  let 轮们 = 划.轮们.slice(-要轮)
  let 字 = 轮们.reduce((s, d) => s + d.字数, 0)
  while (轮们.length > 1 && 字 > 要字) {
    字 -= 轮们[0].字数
    轮们 = 轮们.slice(1)
    出.截断 = true
  }

  出.轮们 = 轮们
  出.轮数 = 轮们.length
  出.消息们 = 轮们.reduce((a, d) => a.concat(d.消息们), [])
  出.消息数 = 出.消息们.length
  出.字数 = 字
  return 出
}

/**
 * 回溯：给一个句ID，翻出原句 + 轮次 + 第几句 + 前后上下文
 * @param {string} 句ID 形如「会话A#42.3」
 * @param {object} 选项 {前后句数=2, 前?, 后?, 根目录?}
 */
function 回溯(句ID, 选项 = {}) {
  const 选 = 合并选项(选项)
  const 原ID = String(句ID == null ? '' : 句ID).trim()
  const 解析 = 解析句ID(原ID)
  if (!解析) {
    return {
      找到: false, 句ID: 原ID, 原因: '句ID格式不对',
      格式: '「会话#轮次.句序」，例如 会话A#42.3',
      提示: '轮次从 1 起，句序是轮内第几句（从 1 起，跨角色连续）'
    }
  }
  const 表 = 读原文表(解析.会话, 选)
  if (表.错误) return { 找到: false, 句ID: 原ID, 原因: '原文表读取失败：' + 表.错误 }
  const 同轮 = 表.记录.filter(r => r.轮次 === 解析.轮次).sort((a, b) => a.句序 - b.句序)
  if (同轮.length === 0) {
    return { 找到: false, 句ID: 原ID, 原因: '该会话没有第 ' + 解析.轮次 + ' 轮', 会话: 解析.会话, 已有轮数: 表.记录.length ? Math.max(...表.记录.map(r => r.轮次)) : 0 }
  }
  const 位 = 同轮.findIndex(r => r.句序 === 解析.句序)
  if (位 < 0) {
    return { 找到: false, 句ID: 原ID, 原因: '第 ' + 解析.轮次 + ' 轮只有 ' + 同轮.length + ' 句，没有第 ' + 解析.句序 + ' 句', 会话: 解析.会话, 轮次: 解析.轮次, 同轮句数: 同轮.length }
  }
   const 目标 = 同轮[位]
  const 跨轮 = 选.跨轮 === true || 选.跨轮 === 'true'
  let 前段, 后段
  if (跨轮) {
    // 全局顺序 = 对话顺序：同轮内不够的，向上一轮末尾 / 下一轮开头补
    const 全表 = 表.记录.slice().sort((a, b) => (a.轮次 - b.轮次) || (a.句序 - b.句序))
    const 全局位 = 全表.findIndex(r => r.轮次 === 目标.轮次 && r.句序 === 目标.句序)
    前段 = 全表.slice(Math.max(0, 全局位 - 选.前句数), 全局位)
    后段 = 全表.slice(全局位 + 1, 全局位 + 1 + 选.后句数)
  } else {
    前段 = 同轮.slice(Math.max(0, 位 - 选.前句数), 位)
    后段 = 同轮.slice(位 + 1, 位 + 1 + 选.后句数)
  }
  const 打 = (r) => ({ 句ID: r.句ID, 轮次: r.轮次, 句序: r.句序, 角色: r.角色, 文本: r.文本, 同轮: r.轮次 === 目标.轮次 })
  return {
    找到: true,
    句ID: 目标.句ID,
    会话: 解析.会话,
    轮次: 目标.轮次,
    句序: 目标.句序,
    角色: 目标.角色,
    时间: 目标.时间,
    时间可读: 可读时间(目标.时间),
    原句: 目标.文本,
    跨轮模式: 跨轮,
    前: 前段.map(打),
    后: 后段.map(打),
    同轮句数: 同轮.length,
    同轮: 同轮.map(r => ({ 句ID: r.句ID, 句序: r.句序, 角色: r.角色, 文本: r.文本 })),
    位置: '第 ' + 目标.轮次 + ' 轮 · 第 ' + 目标.句序 + ' 句（全轮共 ' + 同轮.length + ' 句）',
    原文坐标: { 起: 目标.起, 止: 目标.止, 消息序: 目标.消息序, 消息长: 目标.消息长 },
    // 话块：这句是「谁连着说的一段」里的第几句。段是现算的，不落盘。
    // 选项.段 === false 可关掉（验收老口径/只看单句的场景）。
    段: 选.段 === false ? null : (() => {
      try {
        const 划 = 划话块(表.记录, 选)
        return 段摘要(划.索引.get(String(目标.句ID)), 目标.句ID)
      } catch {
        return null
      }
    })(),
    坏行数: 表.坏行数
  }
}

function 可读时间(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n)) return ''
  const d = new Date(n)
  const p = (x) => String(x).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

// ═══════════════════════ 找原句（字面兜底路，不是语义路） ═══════════════════════

/** 双字组：去标点空白后取相邻两字，汉字/字母通用 */
function 双字组(文本) {
  const 净 = String(文本 == null ? '' : 文本).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  const 组 = new Set()
  if (净.length === 0) return 组
  if (净.length === 1) { 组.add(净); return 组 }
  for (let i = 0; i < 净.length - 1; i++) 组.add(净.slice(i, i + 2))
  return 组
}

/** 字面覆盖度打分：查询的双字组有多少被这句命中；整串命中额外加权 */
function 字面分(查询组, 查询净串, 句文本) {
  const 句组 = 双字组(句文本)
  if (查询组.size === 0 || 句组.size === 0) return 0
  let 交 = 0
  for (const g of 查询组) if (句组.has(g)) 交++
  let 分 = 交 / 查询组.size
  if (查询净串 && String(句文本).includes(查询净串)) 分 += 0.5
  return 分
}

/**
 * 找原句：字面兜底检索（L4 语义路未接前的默认路，定位准、不懂改写）
 * @returns {{查询,结果:[{句ID,轮次,句序,角色,时间,文本,分数,位置}],候选数,坏行数,提示?}}
 */
function 找原句(查询, 选项 = {}) {
  const 选 = 合并选项(选项)
  const topK = Math.max(1, Number(选.topK) || 参数.取整('原文回溯.topK', 5))
  const 会话 = 选.会话 ? [归一会话名(选.会话)] : 列会话(选)
  const 查询净 = String(查询 == null ? '' : 查询).replace(/[\s\p{P}\p{S}]+/gu, '')
  const 查询组 = 双字组(查询)
  const 结果 = { 查询: String(查询 == null ? '' : 查询), 路: '字面（双字组覆盖度）', 结果: [], 候选数: 0, 坏行数: 0 }
  if (查询组.size === 0) {
    结果.提示 = '查询为空或只有标点，没有可检索的内容'
    return 结果
  }
  const 池 = []
  for (const 名 of 会话) {
    const 表 = 读原文表(名, 选)
    结果.坏行数 += 表.坏行数
    for (const r of 表.记录) {
      const 分 = 字面分(查询组, 查询净, r.文本)
      if (分 > 0) 池.push({ 记录: r, 分 })
    }
  }
  结果.候选数 = 池.length
  池.sort((a, b) => (b.分 - a.分) || (Number(b.记录.时间) - Number(a.记录.时间)))
  结果.结果 = 池.slice(0, topK).map(x => ({
    句ID: x.记录.句ID,
    会话: x.记录.会话,
    轮次: x.记录.轮次,
    句序: x.记录.句序,
    角色: x.记录.角色,
    时间: x.记录.时间,
    时间可读: 可读时间(x.记录.时间),
    文本: x.记录.文本,
    分数: Number(x.分.toFixed(3)),
    位置: '第 ' + x.记录.轮次 + ' 轮 · 第 ' + x.记录.句序 + ' 句'
  }))
  if (查询净.length < 2) 结果.提示 = '查询太短（去标点后不足 2 字），命中会很泛，建议多给几个字'
  return 结果
}

// ═══════════════════════ 清点与自检 ═══════════════════════

/** 列会话：根目录下所有 原文表-*.jsonl 对应的会话名 */
function 列会话(选项 = {}) {
  const 选 = 合并选项(选项)
  try {
    return fs.readdirSync(选.根目录)
      .filter(f => f.startsWith('原文表-') && f.endsWith('.jsonl'))
      .map(f => f.slice('原文表-'.length, -'.jsonl'.length))
  } catch (e) { return [] }
}

/** 列轮次：从原文表现算，不依赖索引 */
function 列轮次(会话, 选项 = {}) {
  const 选 = 合并选项(选项)
  const 表 = 读原文表(会话, 选)
  const 桶 = new Map()
  for (const r of 表.记录) {
    if (!桶.has(r.轮次)) 桶.set(r.轮次, [])
    桶.get(r.轮次).push(r)
  }
  const 轮们 = [...桶.keys()].sort((a, b) => a - b).map(轮次 => {
    const 组 = 桶.get(轮次).sort((a, b) => a.句序 - b.句序)
    return {
      轮次,
      句数: 组.length,
      角色们: [...new Set(组.map(r => r.角色))],
      时间: Math.min(...组.map(r => Number(r.时间) || 0)) || null,
      时间可读: 可读时间(Math.min(...组.map(r => Number(r.时间) || 0))),
      首句: 组[0] ? 组[0].文本.slice(0, 40) : '',
      末句: 组[组.length - 1] ? 组[组.length - 1].文本.slice(0, 40) : ''
    }
  })
  return { 会话: 归一会话名(会话), 轮数: 轮们.length, 句数: 表.记录.length, 坏行数: 表.坏行数, 轮们 }
}

/** 重建索引：从原文表整表重算（索引丢了/落灰了都用它） */
function 重建索引(会话, 选项 = {}) {
  const 选 = 合并选项(选项)
  const 名 = 归一会话名(会话)
  const 表 = 读原文表(名, 选)
  const 汇总 = {}
  let 最后轮次 = 0
  for (const r of 表.记录) {
    const 键 = String(r.轮次)
    if (!汇总[键]) 汇总[键] = { 句数: 0, 角色们: [], 消息数: 0, 时间: Number(r.时间) || null }
    汇总[键].句数++
    if (!汇总[键].角色们.includes(r.角色)) 汇总[键].角色们.push(r.角色)
    const 消息键 = 'm' + (r.消息序 || 0)
    if (!汇总[键]._已数) 汇总[键]._已数 = {}
    if (!汇总[键]._已数[消息键]) { 汇总[键]._已数[消息键] = 1; 汇总[键].消息数++ }
    if (r.轮次 > 最后轮次) 最后轮次 = r.轮次
  }
  for (const k of Object.keys(汇总)) delete 汇总[k]._已数
  const 索引 = { 版本, 会话: 名, 最后轮次, 句数: 表.记录.length, 轮次汇总: 汇总, 更新时间: null, 来源: '重建' }
  const 写成 = 写索引(名, 索引, 选)
  return { 会话: 名, 句数: 表.记录.length, 轮数: Object.keys(汇总).length, 坏行数: 表.坏行数, 索引已写: 写成 }
}

/**
 * 自检：一条命令看清这个会话的原文表健不健康
 * 会话留空则检查全部会话
 */
function 自检(会话, 选项 = {}) {
  const 选 = 合并选项(选项)
  const 会话们 = 会话 ? [归一会话名(会话)] : 列会话(选)
  const 项 = []
  const 报告 = { 版本, 根目录: 选.根目录, 会话数: 会话们.length, 项, 通过: true }
  if (会话们.length === 0) {
    项.push({ 检查: '有会话可查', 结果: false, 说明: '根目录下没有任何原文表' })
    报告.通过 = false
    return 报告
  }
  let 总句 = 0, 总坏 = 0, 全部通过 = true
  for (const 名 of 会话们) {
    const 表 = 读原文表(名, 选)
    总句 += 表.记录.length
    总坏 += 表.坏行数
    // ① 坏行
    项.push({ 检查: 名 + ' · 坏行', 结果: 表.坏行数 === 0, 说明: 表.坏行数 === 0 ? '无坏行（' + 表.记录.length + ' 条）' : 表.坏行数 + ' 行无法解析，已跳过并存证据', 证据: 表.坏行 })
    if (表.坏行数 !== 0) 全部通过 = false
    // ② 句ID重复
    const 见 = new Set()
    const 重 = []
    for (const r of 表.记录) { if (见.has(r.句ID)) 重.push(r.句ID); else 见.add(r.句ID) }
    项.push({ 检查: 名 + ' · 句ID唯一', 结果: 重.length === 0, 说明: 重.length === 0 ? '无重号' : '重号 ' + 重.length + ' 个：' + 重.slice(0, 5).join('、') })
    if (重.length !== 0) 全部通过 = false
    // ③ 索引与原文表对账（索引只是加速器，不一致不算故障，但要报出来）
    const 索引 = 读索引(名, 选)
    const 差 = Number(索引.句数) - 表.记录.length
    项.push({ 检查: 名 + ' · 索引对账', 结果: true, 说明: 索引.来源 === '索引文件' ? (差 === 0 ? '索引与原文表一致（' + 表.记录.length + ' 条）' : '索引记 ' + 索引.句数 + ' 条 / 原文表 ' + 表.记录.length + ' 条，差 ' + 差 + '（不影响回溯，可跑重建索引）') : '索引不在或损坏（' + 索引.来源 + '），回溯只走原文表，照常可用' })
    // ④ 抽样回溯
    if (表.记录.length > 0) {
      const 样 = [表.记录[0], 表.记录[Math.floor(表.记录.length / 2)], 表.记录[表.记录.length - 1]]
      const 坏样 = 样.filter(r => {
        const 回 = 回溯(r.句ID, 选)
        return !回.找到 || 回.原句 !== r.文本
      })
      项.push({ 检查: 名 + ' · 抽样回溯', 结果: 坏样.length === 0, 说明: 坏样.length === 0 ? '首/中/末 三句原样翻回，逐字相等' : '翻不回的句ID：' + 坏样.map(r => r.句ID).join('、') })
      if (坏样.length !== 0) 全部通过 = false
    }
  }
  报告.总句数 = 总句
  报告.总坏行 = 总坏
  报告.通过 = 全部通过
  报告.摘要 = 全部通过
    ? '原文表健康：' + 会话们.length + ' 会话 / ' + 总句 + ' 句 / 0 坏行，抽样回溯逐字相等'
    : '原文表有问题，见项内说明（' + 总坏 + ' 坏行）'
  return 报告
}

/** 自述：本模块能干什么（供工具注册表/文档引用） */
function 自述() {
  return {
    名称: '原文回溯内核',
    层: 'L1',
    版本,
    一句话: '喂进一轮对话，按「会话#轮次.句序」翻出逐字原句 + 前后上下文（可选跨轮）',
    红线: ['原文表只追加不改写', '索引可整表重建、原文表永不动', '坏行跳过并留证据', '句子带字符偏移可逐字切回'],
    接口: ['喂一轮', '喂多轮', '回溯', '找原句', '划轮', '取最近轮', '列轮次', '列会话', '重建索引', '自检'],
    存储: { 原文表: '原文表-<会话>.jsonl（只追加）', 索引: '索引-<会话>.json（可删可重建）' },
    默认根目录
  }
}

// ═══════════════════════ CLI ═══════════════════════

function 打印(标题, 内容) {
  console.log('\n── ' + 标题 + ' ' + '─'.repeat(Math.max(0, 46 - 标题.length)))
  console.log(typeof 内容 === 'string' ? 内容 : JSON.stringify(内容, null, 1))
}

function 命令行(参数) {
  const 命令 = (参数[0] || '帮助').toLowerCase()
  if (命令 === '喂' || 命令 === '存') {
    const 会话 = 参数[1] || '默认'
    const 角色 = 参数[2] || '用户'
    const 文本 = 参数.slice(3).join(' ')
    const 结果 = 喂一轮(会话, [{ 角色, 文本 }])
    打印('喂一轮', 结果)
    if (结果.写入) 打印('落盘', 表路径(归一会话名(会话), 合并选项({})))
    return
  }
  if (命令 === '喂轮' || 命令 === '喂一轮对话') {
    const 会话 = 参数[1] || '默认'
    const 文本 = 参数.slice(2).join(' ')
    const 结果 = 喂一轮(会话, [{ 角色: '用户', 文本 }])
    打印('喂一轮', 结果)
    return
  }
  if (命令 === '回溯' || 命令 === '翻') {
    const 句ID = 参数[1]
    const 跨轮 = 参数.includes('跨轮')
    const 纯参数 = 参数.filter(x => x !== '跨轮')
    const 前后 = 纯参数[2] !== undefined ? Number(纯参数[2]) : undefined
    if (!句ID) return 打印('回溯', '用法：node 内核/原文回溯.js 回溯 "会话A#42.3" [前后句数] [跨轮]')
    const 回 = 回溯(句ID, Object.assign(前后 === undefined ? {} : { 前后句数: 前后 }, { 跨轮 }))
    if (!回.找到) return 打印('回溯', 回)
    const 行 = []
    行.push('位置：' + 回.位置 + '　角色：' + 回.角色 + '　时间：' + 回.时间可读 + (回.跨轮模式 ? '　（跨轮上下文）' : ''))
    行.push('')
    for (const p of 回.前) 行.push('  〔' + (p.同轮 ? '' : '上轮·') + p.句序 + '〕' + p.角色 + '：' + p.文本)
    行.push('▌〔' + 回.句序 + '〕' + 回.角色 + '：' + 回.原句 + '   ← 就是这一句')
    for (const p of 回.后) 行.push('  〔' + (p.同轮 ? '' : '下轮·') + p.句序 + '〕' + p.角色 + '：' + p.文本)
    if (回.坏行数) 行.push('', '（原文表有 ' + 回.坏行数 + ' 行坏行已跳过）')
    打印('回溯 ' + 回.句ID, 行.join('\n'))
    return
  }
  if (命令 === '找') {
    const 查询 = 参数.slice(1).join(' ')
    if (!查询) return 打印('找原句', '用法：node 内核/原文回溯.js 找 关键词')
    const r = 找原句(查询, { topK: 5 })
    打印('找原句：' + 查询 + '（' + r.路 + '，候选 ' + r.候选数 + ' 条）',
      r.结果.length === 0 ? '没有命中。换几个字试试——字面路只认字面，不认改写。' :
        r.结果.map((x, i) => (i + 1) + '. [' + x.分数 + '] ' + x.位置 + '　' + x.句ID + '\n    ' + x.文本.slice(0, 90)).join('\n'))
    if (r.提示) 打印('提示', r.提示)
    return
  }
  if (命令 === '列') {
    const 会话 = 参数[1]
    if (!会话) return 打印('会话清单', 列会话())
    const r = 列轮次(会话)
    打印('列轮次：' + r.会话 + '（' + r.轮数 + ' 轮 / ' + r.句数 + ' 句）',
      r.轮们.map(x => '第' + x.轮次 + '轮 ' + x.句数 + '句 [' + x.角色们.join('+') + '] ' + (x.时间可读 || '') + '\n    首：' + x.首句 + '\n    末：' + x.末句).join('\n'))
    return
  }
  if (命令 === '最近' || 命令 === '上下文') {
    const 会话 = 参数[1]
    if (!会话) return 打印('最近轮', '用法：node 内核/原文回溯.js 最近 <会话> [轮数]')
    const 轮数 = 参数[2] !== undefined ? Number(参数[2]) : undefined
    const r = 取最近轮(会话, 轮数 === undefined || !Number.isFinite(轮数) ? {} : { 轮数 })
    if (r.错误) return 打印('最近轮', r)
    const 行 = []
    行.push('会话：' + r.会话 + '　取到 ' + r.轮数 + '/' + r.请求轮数 + ' 轮 · ' + r.消息数 + ' 条消息 · ' + r.字数 + ' 字' +
      (r.截断 ? '（撞字数护栏，已从最老的轮开始丢）' : '') + (r.已剔句数 ? '　已剔本批 ' + r.已剔句数 + ' 句' : ''))
    行.push('')
    for (const d of r.轮们) {
      行.push('── 第 ' + d.轮号 + ' 轮（' + d.角色们.join('/') + '，' + d.消息数 + ' 条，' + d.字数 + ' 字）')
      for (const m of d.消息们) 行.push('   ' + m.角色 + '：' + m.文本)
    }
    if (r.坏行数) 行.push('', '（原文表有 ' + r.坏行数 + ' 行坏行已跳过）')
    打印('最近轮 ' + r.会话, 行.join('\n'))
    return
  }
  if (命令 === '重建索引') {
    打印('重建索引', 重建索引(参数[1] || '默认'))
    return
  }
  if (命令 === '自检') {
    const r = 自检(参数[1] || null)
    打印('自检', r.摘要)
    打印('项', r.项.map(x => (x.结果 ? '✅ ' : '❌ ') + x.检查 + '：' + x.说明).join('\n'))
    return
  }
  if (命令 === '自述') return 打印('自述', 自述())
  打印('帮助', [
    '原文回溯内核 CLI（L1）',
    '',
    '  node 内核/原文回溯.js 喂    <会话> <角色> <文本>     存一轮',
    '  node 内核/原文回溯.js 回溯 "<会话#轮次.句序>" [前后] [跨轮]  翻回原句',
    '  node 内核/原文回溯.js 找   <关键词>                 字面兜底检索',
    '  node 内核/原文回溯.js 列   [会话]                   会话/轮次清单',
    '  node 内核/原文回溯.js 最近 <会话> [轮数]            摆给模型的「刚才聊了什么」',
    '  node 内核/原文回溯.js 重建索引 <会话>               从原文表重算索引',
    '  node 内核/原文回溯.js 自检 [会话]                   健不健康一条命令',
    ''
  ].join('\n'))
}

if (require.main === module) {
  命令行(process.argv.slice(2))
}

module.exports = {
  版本,
  默认根目录,
  切句,
  解析句ID,
  拼接句ID,
  归一会话名,
  读原文表,
  喂一轮,
  喂多轮,
  回溯,
  划轮,
  取最近轮,
  划话块,
  取话块,
  段摘要,
  找原句,
  下一轮次,
  列轮次,
  列会话,
  重建索引,
  自检,
  自述,
  取前后句数,
  取话块间隔秒,
  取话块最大句,
  取近期轮数,
  取近期最大字
}
