/**
 * 会记得你的鲸鱼 · DSH 记忆注入 · 核心层
 *
 * 这个文件**不 import 任何 DSH 包**，所以能脱离 DSH 单独验收。
 * 记忆.js 只是它的一层宿主壳（Service + 官方 createUserMessage）。
 *
 * 职责只有一件：**在模型真正看到用户这句话之前，把内核记得的原话递到它眼前。**
 *
 * 三条纪律（与 归档.js 同源）：
 *   ① 绝不调用模型、绝不生成内容——只搬运内核已经存在的事实（原话 + 句ID）；
 *   ② 任何失败都不抛错（抛了这一步就废，整轮对话跟着废）；
 *   ③ 内核不在 / 检索挂 / 门控闭嘴 → 不注入，只是"这次没记起"，不是错误。
 *
 * 与内核的分工：
 *   内核 `候选映射.提话链路()` 负责「该不该开口、提哪一句」（双路交集 + 门控 + 冷却），
 *   本层只负责「把开口的结果摆成模型能读的一段字」。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { 找内核, 原文表根, 解析原文表根 } from './归档.js'
import { 数据根 } from './路径.js'

const 需 = createRequire(import.meta.url)

const 默认最大注入字符 = 900
const 默认上下句数 = 1

/* ─────────────────── 一·零、让面板拧得到这一层 ─────────────────── */

/**
 * 内核参数模块（热读）—— 找到就缓存引用，值每次现取。
 *
 * 为何要这一步：最大字符 / 上下句数 原先只是本文件里的两个常量，
 * 想改只能动 cordis.patch.yml。但「自动想起一句时前后带几句原文」是
 * 用户能直接感受到的东西（只念一句 vs 带一串），应该是面板上的旋钮。
 * 所以它们已经进了 内核/参数.js 的清单，这里按「显式配置 → 内核参数 → 内置常量」
 * 三级优先级去取：老配置文件一行不改仍然生效（显式优先）。
 *
 * 拿不到参数模块（内核被装到别处、或裁剪掉了参数层）→ 退回内置常量，不报错。
 */
let _参数模块
function 取参数模块() {
  if (_参数模块 !== undefined) return _参数模块
  _参数模块 = null
  try {
    const 内 = 找内核()
    if (内 && 内.路径) {
      const m = 需(path.join(path.dirname(内.路径), '参数.js'))
      if (m && typeof m.取 === 'function') _参数模块 = m
    }
  } catch {
    _参数模块 = null
  }
  return _参数模块
}

/* ─────────────────────── 一、找内核的检索层 ─────────────────────── */

/**
 * 找 候选映射.js：靠 找内核() 定位的 原文回溯.js 同目录推导。
 * @returns {{模块:object, 路径:string}|null}
 */
export function 找检索() {
  if (process.env['鲸鱼禁用内核'] === '1') return null
  const 内 = 找内核()
  if (!内) return null
  const 候选 = []
  if (process.env['鲸鱼检索']) 候选.push(process.env['鲸鱼检索'])
  候选.push(path.join(path.dirname(内.路径), '候选映射.js'))
  for (const p of 候选) {
    try {
      const m = 需(p)
      if (m && typeof m.提话链路 === 'function') return { 模块: m, 路径: p }
    } catch {
      /* 继续试下一个 */
    }
  }
  return null
}

/**
 * 找 对话入库.js：检索源（向量库）的写入入口。
 * 不找它，检索就永远是空的——原文表里有人，向量库里没人。
 * @returns {{模块:object, 路径:string}|null}
 */
export function 找入库() {
  if (process.env['鲸鱼禁用内核'] === '1') return null
  const 内 = 找内核()
  if (!内) return null
  const 候选 = []
  if (process.env['鲸鱼入库']) 候选.push(process.env['鲸鱼入库'])
  候选.push(path.join(path.dirname(内.路径), '对话入库.js'))
  for (const p of 候选) {
    try {
      const m = 需(p)
      if (m && typeof m.入库一轮 === 'function') return { 模块: m, 路径: p }
    } catch {
      /* 继续试下一个 */
    }
  }
  return null
}

/* ─────────────────────── 二、把开口结果摆成一段字 ─────────────────────── */

/** 一条 content block 转文本（与 归档.js 同口径，非 text 块原样保留） */
function 块转文本(块) {
  if (块 === null || 块 === undefined) return ''
  if (typeof 块 === 'string') return 块
  if (typeof 块 !== 'object') return String(块)
  if (块.type === 'text') return String(块.text ?? '')
  try {
    const 副本 = {}
    for (const k of Object.keys(块)) if (k !== 'type') 副本[k] = 块[k]
    return '〔' + String(块.type) + '〕' + JSON.stringify(副本)
  } catch {
    return '〔' + String(块.type) + '〕'
  }
}

/** 一条消息的正文（所有 content block 顺序拼接） */
export function 消息文本(消息) {
  if (!消息 || typeof 消息 !== 'object') return ''
  const 内 = 消息.content
  if (typeof 内 === 'string') return 内
  if (!Array.isArray(内)) return ''
  return 内.map(块转文本).join('')
}

/** 一条消息的角色 */
export function 消息角色(消息) {
  if (!消息 || typeof 消息 !== 'object') return 'unknown'
  if (typeof 消息.role === 'string' && 消息.role.length > 0) return 消息.role
  return 'unknown'
}

/**
 * 从候选消息里挑出「这次要拿来检索的查询文本」。
 * 取最后一条 user 消息——不问模型，纯结构判断。
 * @returns {string}
 */
export function 取查询文本(消息们) {
  const 列 = Array.isArray(消息们) ? 消息们 : []
  for (let i = 列.length - 1; i >= 0; i -= 1) {
    const m = 列[i]
    if (消息角色(m) !== 'user') continue
    const 文 = 消息文本(m).trim()
    if (文.length > 0) return 文
  }
  return ''
}

/**
 * 把 提话链路() 的结果摆成注入文本。
 * 只做排版，不添一个字的事实。
 *
 * @param {object} 开口 提话链路 的返回值
 * @param {number} 最大字符
 * @returns {string}
 */
/**
 * 从一次回溯结果里取出「这一段要摆的句子」（按对话顺序）。
 *
 * 为何不直接用 回溯 返回的前/后数组：
 *   · 回溯 返回的是 前[] / 后[]（数组，每项带 角色/文本）；
 *   · 旧实现读的是 原.前句 / 原.后句（字符串）——这两个字段**从未存在**，
 *     于是「上下句数」这个旋钮拧到 10 也一个字都带不出来，模型只看到一句干巴巴的原话。
 *     用户说的「就带这么一句哪够用」，真正的原因就在这里。
 *
 * 两句以上时优先用「话块」（同一人连着说的整段）：QQ 里一句话常被拆成几条发，
 * 按前后 N 句切会把连发的头尾切断，按段取才完整。
 *
 * @param {object} 原 回溯结果
 * @returns {Array<{角色:string, 文本:string, 主:boolean}>}
 */
function 摆句列(原) {
  const 收 = (x, 主) => ({
    角色: String((x && x.角色) || ''),
    文本: String((x && (x.文本 != null ? x.文本 : x.原句)) || '').trim(),
    主: !!主
  })
  const 段 = 原 && 原.段 && Array.isArray(原.段.句们) ? 原.段.句们 : null
  if (段 && 段.length > 1) {
    return 段.map((x) => 收(x, x && x.主)).filter((x) => x.文本.length > 0)
  }
  const 列 = []
  for (const x of (Array.isArray(原.前) ? 原.前 : [])) 列.push(收(x, false))
  const 身 = String((原 && 原.原句) || '').trim()
  if (身.length > 0) 列.push({ 角色: String((原 && 原.角色) || ''), 文本: 身, 主: true })
  for (const x of (Array.isArray(原.后) ? 原.后 : [])) 列.push(收(x, false))
  return 列.filter((x) => x.文本.length > 0)
}

export function 摆注入文本(开口, 最大字符 = 默认最大注入字符) {
  if (!开口 || 开口.开口 !== true) return ''
  const 行们 = []
  const 措辞 = String(开口.措辞句 || '').trim()
  if (措辞.length > 0) 行们.push(措辞)

  const 原 = 开口.原话
  // 句ID / 原句提到外层：截断时要写「全文见原文表句ID …」，不能只在分支里可见
  const 句ID = 原 && 原.找到 === true
    ? String(原.句ID || (开口.命中 && 开口.命中.记忆ID) || '').trim()
    : ''
  const 原句身 = 原 && 原.找到 === true ? String(原.原句 || '').trim() : ''
  if (原 && 原.找到 === true) {
    const 句列 = 摆句列(原)
    if (句列.length > 1) {
      // 一段话：逐句带角色，命中那句标 ※——模型必须看得出哪句是本次命中的原话，
      // 否则会把整段当成「用户刚刚才说的」，反而更容易串台。
      const 段 = 原.段 && typeof 原.段 === 'object' ? 原.段 : null
      const 用段 = !!(段 && Number(段.句数) > 1)
      const 头注 = '原话这一段[' + (句ID || '未编号') + ']（' +
        (用段 ? '共 ' + 段.句数 + ' 句（同一人连着说的整段）' : '前后共 ' + 句列.length + ' 句') +
        '，※ 是这次命中的那句）：'
      行们.push(头注)
      for (const x of 句列) 行们.push('  ' + (x.角色 ? x.角色 + '：' : '') + x.文本 + (x.主 ? '  ※' : ''))
    } else if (原句身.length > 0) {
      行们.push('原话' + (句ID ? '[' + 句ID + ']' : '') + '：「' + 原句身 + '」')
    }
  } else if (开口.命中 && 开口.命中.原句) {
    // 翻不到原话时只报候选原句，绝不假装它是原话
    行们.push('相近记录（未回溯到原话）：「' + String(开口.命中.原句).trim() + '」')
  }

  if (行们.length === 0) return ''

  const 头 = '〔记起一段原话〕这条来自会话历史，不是本轮新输入：'
  const 尾 = '（本段由本地原文表检索得到，原话逐字可回溯，不含模型改写。）'
  let 全文 = 头 + '\n' + 行们.join('\n') + '\n' + 尾

  const 上限 = Number.isInteger(最大字符) && 最大字符 > 0 ? 最大字符 : 默认最大注入字符
  if (全文.length > 上限) {
    全文 = 截注入文本(全文, 上限, { 句ID, 原句: 原句身 })
  }
  return 全文
}

/**
 * 超限截断——但必须让模型看得出「这是被截的」。
 *
 * 为何不满足于 slice + '…'（旧做法）：注入文本是模型眼前唯一的一份凭据，
 * 它无法分辨「原话就到这里」和「原话被裁掉一半」。一旦它以为自己手上的
 * 就是全部，就会照着半句回答——而本项目立身之本正是「原话逐字可回溯」，
 * 让模型以为半句是全文，比直接不注入更坏。
 * 宁可丑，不许骗：宁可末尾挂一长串说明，也不许悄悄断在半句上。
 *
 * 硬约束：返回值长度 **绝不超上限**（验收 ⑦ 断言的就是这条）。
 *
 * @param {string} 全文
 * @param {number} 上限
 * @param {{句ID?: string, 原句?: string}} 位 原话在全文中的坐标信息，用于算「只到第 X 字」
 * @returns {string}
 */
function 截注入文本(全文, 上限, { 句ID = '', 原句 = '' } = {}) {
  const 原长 = 全文.length
  const 原句起 = 原句.length > 0 ? 全文.indexOf(原句) : -1

  // 告警长度依赖「留」的位数，故先按留编一次、据其长度回退重编，两轮即收敛
  const 编告警 = (留) => {
    const 截在原句中 = 原句起 >= 0 && 留 > 原句起 && 留 < 原句起 + 原句.length
    const 主体 = 截在原句中
      ? '〔已截断：原话共' + 原句.length + '字，此处只到第' + (留 - 原句起) + '字'
      : '〔已截断：本段原' + 原长 + '字，此处只留前' + 留 + '字'
    // 句ID 能写就写（可逐字取回全文）；上限太小放不下时退成「仍在原文表」
    const 尾 = 句ID.length > 0 && 上限 >= 200 ? '，全文见原文表句ID ' + 句ID : '，全文仍在原文表'
    return 主体 + 尾 + '〕'
  }

  let 留 = Math.max(1, 上限 - 1)
  for (let 轮 = 0; 轮 < 3; 轮++) {
    const 新留 = Math.max(1, 上限 - 编告警(留).length)
    if (新留 === 留) break
    留 = 新留
  }

  let 告警 = 编告警(留)
  // 严格兜底：位数抖动可能溢出 1-2 字 → 按溢出量退，退到放不下就换最短标记
  if (留 + 告警.length > 上限) {
    留 = Math.max(1, 留 - (留 + 告警.length - 上限))
    告警 = 编告警(留)
  }
  if (留 + 告警.length > 上限) {
    告警 = '〔截断〕'
    留 = Math.max(1, 上限 - 告警.length)
  }
  return 全文.slice(0, 留) + 告警
}

/* ─────────────────────── 三、先入库，再检索 ─────────────────────── */

/** 已入库指纹（进程内，会话 → 最近若干批）：同一批不反复写盘 */
const 已入库指纹 = new Map()
const 每会话记指纹数 = 64

/** 一批消息的内容指纹（角色 + 逐个逐字文本） */
export function 批指纹(消息们) {
  const h = crypto.createHash('sha1')
  const 列 = Array.isArray(消息们) ? 消息们 : []
  for (const m of 列) h.update(消息角色(m) + '\u0000' + 消息文本(m) + '\u0001')
  return h.digest('hex')
}

/**
 * 把这一步新到的一批消息写进内核（原文表 + 向量库双写）。
 * 不做这一步，检索永远是空的：原文表里有人，向量库里没人。
 *
 * @param {object} 参数
 * @param {Array} 参数.消息们
 * @param {string} 参数.会话
 * @returns {{入库:boolean, 原因:string, 句数:number}}
 */
export async function 入库新消息({ 消息们, 会话 } = {}) {
  const 列 = Array.isArray(消息们) ? 消息们.filter((m) => 消息文本(m).trim() !== '') : []
  if (列.length === 0) return { 入库: false, 原因: '没有可入库的正文', 句数: 0 }

  let 印 = ''
  try {
    印 = 批指纹(列)
  } catch {
    印 = ''
  }
  const 名 = String(会话 || 'dsh')
  if (印) {
    const 存 = 已入库指纹.get(名) || []
    if (存.indexOf(印) >= 0) return { 入库: false, 原因: '同一批已入库（指纹命中）', 句数: 0 }
  }

  let 入 = null
  try {
    入 = 找入库()
  } catch {
    入 = null
  }
  if (!入) return { 入库: false, 原因: '内核入库层不可用', 句数: 0 }

  try {
    const 果 = await 入.模块.入库一轮(
      名,
      列.map((m) => ({ 角色: 消息角色(m), 文本: 消息文本(m) })),
      { 根目录: 原文表根(), 数据根: 数据根() }
    )
    const 句数 = Number((果 && 果.原文 && 果.原文.写入) || 0)
    const 句ID们 = (果 && 果.原文 && Array.isArray(果.原文.句ID们)) ? 果.原文.句ID们 : []
    if (果 && 果.ok && 印) {
      const 存 = 已入库指纹.get(名) || []
      存.push(印)
      if (存.length > 每会话记指纹数) 存.splice(0, 存.length - 每会话记指纹数)
      已入库指纹.set(名, 存)
    }
    if (!果 || !果.ok) {
      return { 入库: false, 原因: String((果 && 果.原因) || '入库未成功'), 句数, 句ID们 }
    }
    return { 入库: true, 原因: '', 句数, 句ID们 }
  } catch (e) {
    return { 入库: false, 原因: '入库异常：' + String((e && e.message) || e), 句数: 0, 句ID们: [] }
  }
}

/* ─────────────────────── 四、查询 → 门控 → 文本 ─────────────────────── */

/**
 * 造一次记忆注入。
 * **永不抛错**——这条路一抛，这一步就废。
 *
 * @param {object} 参数
 * @param {Array} 参数.消息们 新进入这一步的候选消息（DSH 的 messages）
 * @param {string} 参数.会话 会话标识
 * @param {string} 参数.当前模型 可选，用于门控策略降档
 * @param {number} 参数.最大字符
 * @param {number} 参数.上下句数
 * @param {boolean} 参数.入库 默认 true：先把这批消息写进内核，再检索
 * @returns {{注入:boolean, 文本:string, 报告:object}}
 */
export async function 造记忆注入({ 消息们, 会话, 当前模型, 最大字符, 上下句数, 入库 } = {}) {
  const 名 = String(会话 || 'dsh')
  const 报告 = {
    会话: 名,
    查询: '',
    开口: false,
    理由: '',
    档位: '',
    句ID: '',
    注入字符: 0,
    截断: false,
    入库: '',
    跳过原因: '',
  }

  // ⓵ 先在「既有历史」上检索：本批还没入库，所以天然不会自己提自己。
  //    这一步任何失败都只是「这次没记起」，不影响下面入库。
  let 开口 = null
  try {
    报告.查询 = 取查询文本(消息们)
  } catch (e) {
    报告.查询 = ''
  }

  if (报告.查询.length > 0) {
    let 检索 = null
    try {
      检索 = 找检索()
    } catch (e) {
      检索 = null
      报告.跳过原因 = '找检索异常：' + String((e && e.message) || e)
    }
    if (!检索) {
      报告.跳过原因 = 报告.跳过原因 || '内核检索层不可用'
    } else {
      try {
        开口 = await 检索.模块.提话链路(报告.查询, {
          当前模型: 当前模型,
          前后句数: Number.isInteger(上下句数) ? 上下句数 : 默认上下句数,
          // 根目录 = 原文表目录（读原话坐标）；数据根 = 向量库所在（检索去那里比余弦）。
          // 两个必须都给：只给前者，候选映射 会把向量库也指到原文回溯目录 → 库分两处。
          根目录: 原文表根(),
          数据根: 数据根(),
        })
      } catch (e) {
        报告.跳过原因 = '提话链路异常：' + String((e && e.message) || e)
        开口 = null
      }
    }
  } else if (!报告.跳过原因) {
    报告.跳过原因 = '这一步没有新的用户输入'
  }

  if (开口) {
    报告.开口 = !!(开口 && 开口.开口)
    报告.理由 = String((开口 && 开口.理由) || '')
    报告.档位 = String((开口 && 开口.档位) || '')
    报告.句ID = String((开口 && 开口.原话 && 开口.原话.句ID) || (开口 && 开口.命中 && 开口.命中.记忆ID) || '')
    if (!报告.开口 && !报告.跳过原因) {
      // 自引与「门控闭嘴」不是同一回事，日志里分开，否则排障时分不清是刀没开还是门没开
      报告.跳过原因 = (开口 && 开口.自引) ? '自引：命中的原话与本轮输入几乎相同，不回灌' : '门控闭嘴'
    }
  }

  // ⓶ 无论检索结果如何，本批都要入库——这是记忆的入口，不能因为没提话就不记。
  let 本次句ID们 = []
  if (入库 !== false) {
    try {
      const 入果 = await 入库新消息({ 消息们, 会话: 名 })
      本次句ID们 = Array.isArray(入果.句ID们) ? 入果.句ID们 : []
      报告.入库 = 入果.入库 ? '写入 ' + 入果.句数 + ' 句' : '未写入：' + 入果.原因
    } catch (e) {
      报告.入库 = '入库异常：' + String((e && e.message) || e)
    }
  }

  // ⓷ 不开口 → 收工
  if (!报告.开口) {
    return { 注入: false, 文本: '', 报告 }
  }

  // ⓸ 去自噬（双保险）：命中的就是本批的句子 → 不回灌
  if (报告.句ID && 本次句ID们.indexOf(报告.句ID) >= 0) {
    报告.跳过原因 = '命中的是本轮新句（自己提自己），不回灌'
    return { 注入: false, 文本: '', 报告 }
  }

  let 文本 = ''
  try {
    文本 = 摆注入文本(开口, 最大字符)
  } catch (e) {
    报告.跳过原因 = '摆注入文本异常：' + String((e && e.message) || e)
    return { 注入: false, 文本: '', 报告 }
  }
  if (文本.length === 0) {
    报告.跳过原因 = 报告.跳过原因 || '开口了但摆不出可注入的字'
    return { 注入: false, 文本: '', 报告 }
  }

  报告.注入字符 = 文本.length
  // 截断必须可从报告里看出来：否则排障时只能看到“模型答得怪”，查不到“原话被裁了”
  报告.截断 = /〔已截断|〔截断〕/.test(文本)
  return { 注入: true, 文本, 报告 }
}

/* ─────────────────────── 五、原文表体检（给人看的） ─────────────────────── */

/** 只读体检：内核在不在、原文表目录有没有东西。不上报任何用户内容。 */
export function 体检() {
  const 出 = { 内核: false, 检索: false, 原文表根: '', 来处: '', 会话数: 0, 错误: '' }
  // 先算根（在 找内核/找检索 之前：它们会向 env 对齐，不能把“自写值”当作用户指定）
  let 解 = { 根: '', 来处: '' }
  try {
    解 = 解析原文表根()
  } catch (e) {
    出.错误 = String((e && e.message) || e)
  }
  try {
    出.内核 = !!找内核()
    出.检索 = !!找检索()
  } catch (e) {
    出.错误 = 出.错误 || String((e && e.message) || e)
  }
  try {
    // 与 归档.js 完全同口径：算法只有一份，在 lib/路径.js
    // ——两边各算一套，迟早会对不上，这里直接问它要
    出.原文表根 = path.resolve(解.根)
    出.来处 = 解.来处
    if (fs.existsSync(出.原文表根)) {
      出.会话数 = fs.readdirSync(出.原文表根).filter((f) => f.endsWith('.jsonl')).length
    }
  } catch (e) {
    出.错误 = 出.错误 || String((e && e.message) || e)
  }
  return 出
}

export const 常量 = { 默认最大注入字符, 默认上下句数 }

/* ─────────────────────── 六、配置归一（宿主壳不自己算） ─────────────────────── */

/**
 * 把 cordis.patch.yml 里的 config 归一成四个数/布尔值。
 *
 * 两套键都认：
 *   英文键：enabled / everyTurn / maxInjectChars / contextPairs   ← npm 用户的默认写法
 *   中文键：启用 / 每轮一次 / 最大注入字符 / 上下句数             ← 老配置，升级不改行为
 * 英文优先。值宽进严出：布尔误写成字符串 "false" 也能正确当 false。
 *
 * 放在核心层而不是宿主壳（记忆.js），因为这是纯逻辑——
 * 核心层的纪律是“不 import 任何 DSH 包”，这样它能脱开 DSH 单独验收。
 */
export function 归一配置(配置 = {}) {
  const c = 配置 && typeof 配置 === 'object' ? 配置 : {}
  const 取 = (英, 中, 缺) => {
    if (c[英] !== undefined && c[英] !== null) return c[英]
    if (c[中] !== undefined && c[中] !== null) return c[中]
    return 缺
  }
  const 布尔 = (值, 缺) => {
    if (typeof 值 === 'boolean') return 值
    if (值 === 'true' || 值 === 1 || 值 === '1') return true
    if (值 === 'false' || 值 === 0 || 值 === '0') return false
    return 缺
  }
  const 整数 = (值, 缺, 允许零) => {
    const 数 = Number(值)
    if (Number.isFinite(数) && (数 > 0 || (允许零 && 数 === 0))) return Math.round(数)
    return 缺
  }
  // 三级优先级：配置里显式写了 → 用它；没写 → 面板上拧的值；都没有 → 内置常量。
  // 「上下句数」直接跟随面板上的「想起一件事时前后各带几句」，一个旋钮管两处
  // （手动翻原话 + 自动想起），不造第二个同义参数让人纠结。
  const 参 = 取参数模块()
  const 缺字符 = 参 ? 整数(参.取('记忆注入.最大字符', 默认最大注入字符), 默认最大注入字符) : 默认最大注入字符
  const 缺句数 = 参 ? 整数(参.取('原文回溯.前后句数', 默认上下句数), 默认上下句数, true) : 默认上下句数
  const 缺每轮 = 参 ? !!参.取('记忆注入.每轮一次', true) : true
  return {
    启用: 布尔(取('enabled', '启用', true), true),
    每轮一次: 布尔(取('everyTurn', '每轮一次', 缺每轮), 缺每轮),
    最大字符: 整数(取('maxInjectChars', '最大注入字符', 缺字符), 缺字符),
    上下句数: 整数(取('contextPairs', '上下句数', 缺句数), 缺句数, true),
  }
}
