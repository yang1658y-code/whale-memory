/**
 * 会记得你的鲸鱼 · 记忆内核 · L2 存储适配器（唯一入口）
 * ────────────────────────────────────────────────────────────────
 * 这一层的唯一职责：把「存一条消息 / 搜一段记忆 / 写一批向量 / 读一段原文」
 * 这四件事，从具体实现里切出来。
 *
 * 为什么要有它：内核原先直接 require 上游的 向量记忆.js —— 那条 require 就是
 * 把项目钉死在上游身上的脐带。项目要能 clone 出去单独跑，就必须自己有一份
 * 默认实现；上游那边想继续用 向量记忆.js（带 embedding/降级链/冷归档），
 * 只需要在调用时把 选项.向量模块 传进来，内核自动改用它，一行代码不用改。
 *
 * 契约（四方法，缺一不算实现）：
 *   存入消息(角色, 正文, 时间, _, 新鲜度档, 来源, 权威性, 附加) → {ok, id?, 跳过?, 原因?}
 *   搜索相关(查询, topK, 来源)        → [{content, similarity, ...}]
 *   写入向量库(条目们)                → {ok, 写入}
 *   读原文(会话, 选项)                → {句: [...]}（转发 原文回溯.读原文表）
 *
 * 兼容方法（内核里 L4/L5 会顺手调，缺了要降级）：
 *   读取向量库() / 关键词检索() / 搜索相关混合()
 *
 * 默认实现（零依赖兜底级）：
 *   - 落盘：数据/向量库.jsonl，一行一条，只追加；写入向量库 才整表覆写
 *   - 向量：中文 bigram 稀疏词频向量，余弦打分。不联网、不带模型、几十 KB 也能跑
 *   - 关键词：bigram 覆盖率打分（字面命中，专名查询靠它）
 *   - 混合：RRF（k=60）融合两路，与上游侧口径一致
 *
 * 随包小模型（L2 真语义级，默认开）：
 *   向量后端.js 在首次入库/首次显式调用时自动装配一次：
 *     ① 自定义 embed → ② 随包 bge-small-zh-v1.5 int8（512维，纯 WASM，零网络）→ ③ 哈希兜底
 *   装上了，设embed 就是真 512 维稠密向量；装不上，本文件照旧跑 ③，一条记忆也不丢。
 *   条目上的 模型ID 字段就是这条向量是谁算的 —— 检索时按 维度+模型ID 双重校验，
 *   绝不让两个模型（或两个维度）算出来的向量互相比余弦。
 *
 * 可插拔（硬约束：主链路不得以某个 embedding 模型可用为前置条件）：
 *   设embed(fn) 可注入任意 embedding 函数（返回 number[]）。
 *   注入了就用稠密向量；注入失败/返回空 → 该条自动退回稀疏向量，不抛错。
 *   上级不可用自动落下一级，任何一级都能独立出结果。
 *
 * 断依赖：目录不可写 / 文件损坏 / 单条写失败 → 一律不抛，只在返回值里报。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const 参数 = require('./参数.js')

const 版本 = '1.0.0'
const 默认根目录 = process.env.鲸鱼数据目录
  ? String(process.env.鲸鱼数据目录)
  : path.join(__dirname, '..', '数据')

const 默认库文件名 = '向量库.jsonl'
const RRF_K = 60
// ── 可调参数（真值优先取 配置/内核参数.json，热读；缺文件即退原常量） ──
const 取RRF_K = () => 参数.取整('存储适配器.RRF_K', RRF_K)
const 取默认TopK = () => 参数.取整('存储适配器.topK', 5)

// 附加字段白名单：只认这几个，别的一律不进库（避免调用方随手塞大对象）
const 附加白名单 = ['句ID', '句ID们', '会话', '轮次', '段ID', '轮', '标签']

let _embed外部 = null
// 当前嵌入后端的元信息。注入=false 即哈希兜底态。
let _嵌入元 = { 模型ID: 'bigram哈希256', 维度: 256, 注入: false }
let _候选表缓存 = null // { 文件, mtime, 条目们 }
let _后端就绪 = null   // Promise：自动装配只跑一次
let _后端结果 = null
let _嵌入失败次数 = 0

// ═══════════════════════ 工具 ═══════════════════════

function 数(v, d) {
  return Number.isFinite(Number(v)) ? Number(v) : d
}

/** 中文 bigram + 英文单词切词，去掉标点空白 */
function 切词(文本) {
  const s = String(文本 == null ? '' : 文本).toLowerCase()
  const 词 = []
  const 段们 = s.split(/[^\u4e00-\u9fa5a-z0-9]+/).filter(Boolean)
  for (const 段 of 段们) {
    if (/^[a-z0-9]+$/.test(段)) {
      词.push(段)
      continue
    }
    const 字 = Array.from(段)
    if (字.length === 1) { 词.push(字[0]); continue }
    for (let i = 0; i < 字.length - 1; i++) 词.push(字[i] + 字[i + 1])
  }
  return 词
}

/** 稀疏向量：{词: 权重}，词频 + 长度归一 */
function 稀疏向量(文本) {
  const 词 = 切词(文本)
  const 表 = Object.create(null)
  if (!词.length) return 表
  for (const w of 词) 表[w] = (表[w] || 0) + 1
  let 平方和 = 0
  for (const k in 表) 平方和 += 表[k] * 表[k]
  const 模 = Math.sqrt(平方和) || 1
  for (const k in 表) 表[k] = +(表[k] / 模).toFixed(6)
  return 表
}

/** 稀疏余弦：两路都做了长度归一，点积即余弦 */
function 稀疏余弦(a, b) {
  if (!a || !b) return 0
  let 和 = 0
  const 小 = Object.keys(a).length <= Object.keys(b).length ? a : b
  const 大 = 小 === a ? b : a
  for (const k in 小) {
    const v = 大[k]
    if (v) 和 += 小[k] * v
  }
  return 和 > 1 ? 1 : +和.toFixed(6)
}

/** 稠密余弦（外部 embedding 用） */
function 稠密余弦(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0
  let 点 = 0, 甲 = 0, 乙 = 0
  for (let i = 0; i < a.length; i++) { 点 += a[i] * b[i]; 甲 += a[i] * a[i]; 乙 += b[i] * b[i] }
  if (!甲 || !乙) return 0
  return +(点 / Math.sqrt(甲 * 乙)).toFixed(6)
}

/**
 * 稠密投影：把 bigram 稀疏向量哈希到固定 256 维。
 * 为什么要有它：外部 API / 向量库的接口都要 number[]，纯稀疏对象交不出去；
 * 而 256 维零依赖数组又足够撑起余弦排序。相同输入永远得到相同输出。
 */
const 稠密维度 = 256
function 哈希稠密(文本) {
  const 稀 = 稀疏向量(文本)
  const 出 = new Array(稠密维度).fill(0)
  for (const 词 in 稀) {
    let h = 0
    for (let i = 0; i < 词.length; i++) h = (h * 31 + 词.charCodeAt(i)) >>> 0
    出[h % 稠密维度] += 稀[词]
  }
  let 平方 = 0
  for (let i = 0; i < 稠密维度; i++) 平方 += 出[i] * 出[i]
  const 模 = Math.sqrt(平方)
  if (模 > 0) for (let i = 0; i < 稠密维度; i++) 出[i] = +(出[i] / 模).toFixed(6)
  return 出
}

/**
 * embed(文本) → number[]
 * 可插拔：注入了外部 embedding（含随包小模型）就用它，没注入/注入失败 → 哈希稠密兜底。永不抛错。
 * 【1.1.0 修正】旧版写成 `_embed外作`（多一个字）→ 外部 embedding 永远 ReferenceError，
 * 被 catch 吃成静默兜底。症状：模型明明装上了，检索还是字面水平。本轮修。
 */
async function embed(文本) {
  if (typeof _embed外部 === 'function') {
    try {
      const v = await _embed外部(文本)
      if (Array.isArray(v) && v.length) return v
    } catch { _嵌入失败次数++ /* 落下一级 */ }
  }
  return 哈希稠密(文本)
}

/**
 * embed批(文本们) → number[][]
 * 优先用后端自带的批量接口（小模型一次前向算一批，快 10 倍以上）；没有就逐条。
 */
async function embed批(文本们) {
  const 列 = Array.isArray(文本们) ? 文本们 : []
  if (!列.length) return []
  if (typeof _embed外部 === 'function' && typeof _embed外部.embed批 === 'function') {
    try {
      const r = await _embed外部.embed批(列)
      if (Array.isArray(r) && r.length === 列.length) return r
    } catch { _嵌入失败次数++ }
  }
  const 出 = []
  for (const t of 列) 出.push(await embed(t))
  return 出
}

/** 关键词覆盖率：查询词有多少落在这条里（字面族主用） */
function 关键词分(查询, 文本) {
  const q = Array.from(new Set(切词(查询)))
  if (!q.length) return 0
  const t = new Set(切词(文本))
  let 中 = 0
  for (const w of q) if (t.has(w)) 中++
  return +(中 / q.length).toFixed(6)
}

function 取根目录(选项) {
  const r = (选项 && (选项.根目录 || 选项.数据目录)) || 默认根目录
  return String(r)
}

function 库路径(选项) {
  return path.join(取根目录(选项), (选项 && 选项.库文件名) || 默认库文件名)
}

function 净化附加(附加) {
  const 出 = {}
  if (!附加 || typeof 附加 !== 'object') return 出
  for (const k of 附加白名单) {
    if (附加[k] !== undefined && 附加[k] !== null) 出[k] = 附加[k]
  }
  return 出
}

function 造ID(角色, 正文, 时间) {
  return crypto.createHash('sha1')
    .update(String(角色) + '|' + String(正文) + '|' + String(时间))
    .digest('hex').slice(0, 12)
}

// ═══════════════════════ 去重账本（记忆曲线的数据地基） ═══════════════════════

/**
 * 内容指纹(角色, 正文) —— 去重账本的键。
 *
 * 【为什么指纹里刻意不装时间】
 *   造ID 把时间算进了哈希，所以同一句话今天说、明天再说，会被当成两条新记忆。
 *   但对「记忆」这个概念来说，那不是两条，那是同一条记忆被复习了两次。
 *   时间差不进指纹，进 出现次数 / 首次时间 / 最近时间 —— 这三个量正是遗忘曲线的输入。
 *
 * 归一化只做最保守的三件：拆行压空格、去首尾空白、角色小写。
 * 不做同义改写、不做标点归并 —— 宁可少并一条，也不许把两句话认成一句。
 */
function 内容指纹(角色, 正文) {
  const 净 = String(正文 == null ? '' : 正文).replace(/\s+/g, ' ').trim()
  return crypto.createHash('sha1')
    .update(String(角色 || 'user').toLowerCase() + '|' + 净)
    .digest('hex').slice(0, 16)
}

let _指纹索引 = null // { 路径, mtime, 表:Map<指纹,条>, 冗余 }

/**
 * 取指纹索引 —— 首次或文件被外部改写后重建，平时命中内存，写入不读盘。
 * 以 mtime 为准：别的进程往库里追加了东西，mtime 一变自动重建，不会用旧账本误判。
 */
function 取指纹索引(选项 = {}) {
  const p = 库路径(选项)
  let mtime = 0
  try { mtime = fs.statSync(p).mtimeMs } catch { mtime = 0 }
  if (_指纹索引 && _指纹索引.路径 === p && _指纹索引.mtime === mtime) return _指纹索引

  const 表 = new Map()
  let 冗余 = 0
  for (const o of 读库(选项).条目们) {
    const 键 = o.指纹 || 内容指纹(o.role || o.角色, o.content != null ? o.content : o.正文)
    if (表.has(键)) 冗余++
    表.set(键, o)
  }
  _指纹索引 = { 路径: p, mtime, 表, 冗余 }
  return _指纹索引
}

/**
 * 合并重复 —— 命中已有条目时走这条：不新增行，只把这次当成一次「复习」。
 *
 * 做三件事：
 *   ① 出现次数 +1、最近时间 刷新、首次时间 保留最早（老条目没这两字段就按 time 补）
 *   ② 新句ID 并进 句ID们（原文表一个字不动，可回溯性不减：三条原话仍能逐句翻出来）
 *   ③ 历史遗留的重复行并到第一条、多余的清掉（这正是清库那一次）
 *
 * 成本：整表重写。重复不是每轮都有，库上万条也就几十毫秒，且走得是临时文件+改名，半截文件不会留下。
 */
function 合并重复(选项, 指纹, 新句ID们, 时间戳) {
  const 条目们 = []
  let 目标 = null
  const 冗余们 = []
  for (const o of 读库(选项).条目们) {
    const 键 = o.指纹 || 内容指纹(o.role || o.角色, o.content != null ? o.content : o.正文)
    if (键 !== 指纹) { 条目们.push(o); continue }
    if (目标) { 冗余们.push(o); continue }
    目标 = o
    条目们.push(o)
  }
  if (!目标) return { ok: false, 原因: '合并时找不到目标条目（库刚被外部改写？）' }
  const 清理冗余 = 冗余们.length

  const 旧句 = Array.isArray(目标.句ID们) ? 目标.句ID们.slice() : (目标.句ID ? [目标.句ID] : [])
  for (const x of (新句ID们 || [])) if (x && !旧句.includes(x)) 旧句.push(x)

  // 历史遗留的重复行不能白丢：它们的出现次数、句ID 一律并到保留的那一条上。
  // 句ID 收齐 = 被并掉那几行的原话仍然能逐句翻出来（丢行不丢原话）。
  let 次数 = 正整数(目标.出现次数, 1)
  for (const r of 冗余们) {
    次数 += 正整数(r && r.出现次数, 1)
    const 副句 = Array.isArray(r && r.句ID们) ? r.句ID们 : ((r && r.句ID) ? [r.句ID] : [])
    for (const x of 副句) if (x && !旧句.includes(x)) 旧句.push(x)
  }
  次数 += 1 // 本次这次「复习」

  const 首次 = 数(目标.首次时间, 数(目标.time, 时间戳))
  const 改后 = Object.assign({}, 目标, {
    指纹,
    出现次数: 次数,
    首次时间: 首次,
    最近时间: Math.max(数(目标.最近时间, 首次), 时间戳),
    句ID们: 旧句,
    句ID: 目标.句ID || 旧句[0] || null
  })
  条目们[条目们.indexOf(目标)] = 改后

  const 写 = 写入向量库(条目们, 选项)
  _指纹索引 = null
  if (!写.ok) return { ok: false, 原因: '重写库失败：' + (写.原因 || '未知') }
  return { ok: true, id: 改后.id, 出现次数: 改后.出现次数, 清理冗余, 条数: 条目们.length }
}

// ═══════════════════════ 读 / 写 库 ═══════════════════════

/**
 * 读全库。坏行跳过并计数（不抛错，不许因一行坏掉整个库读不出来）。
 * @returns {{条目们, 坏行数, 路径, 存在}}
 */
function 读库(选项 = {}) {
  const p = 库路径(选项)
  const 出 = { 条目们: [], 坏行数: 0, 路径: p, 存在: false }
  let 缓存 = null
  try {
    const st = fs.statSync(p)
    出.存在 = true
    if (_候选表缓存 && _候选表缓存.路径 === p && _候选表缓存.mtime === st.mtimeMs) return Object.assign({}, _候选表缓存.数据, { 命中缓存: true })
    缓存 = st
  } catch { return 出 }

  let 文本 = ''
  try { 文本 = fs.readFileSync(p, 'utf8') } catch { return 出 }

  for (const 行 of 文本.split('\n')) {
    const s = 行.trim()
    if (!s) continue
    try {
      const o = JSON.parse(s)
      if (o && typeof o === 'object') 出.条目们.push(o)
      else 出.坏行数++
    } catch { 出.坏行数++ }
  }
  try {
    _候选表缓存 = { 路径: p, mtime: 缓存 ? 缓存.mtimeMs : 0, 数据: { 条目们: 出.条目们, 坏行数: 出.坏行数, 路径: p, 存在: true } }
  } catch { }
  return 出
}

/** 条目正向化：兼容上游 向量记忆.js 的字段名（content / similarity / role / time） */
function 归一条目(o) {
  const t = o && typeof o === 'object' ? o : {}
  return {
    id: t.id || t.记忆ID || null,
    role: t.role || t.角色 || 'user',
    content: String(t.content != null ? t.content : (t.正文 != null ? t.正文 : '')),
    time: 数(t.time != null ? t.time : t.时间, 0),
    来源: t.来源 || t.source || null,
    权威性: t.权威性 != null ? t.权威性 : null,
    新鲜度档: t.新鲜度档 != null ? t.新鲜度档 : null,
    vector: Array.isArray(t.vector) ? t.vector : null,
    句ID: t.句ID != null ? t.句ID : null,
    句ID们: Array.isArray(t.句ID们) ? t.句ID们 : (t.句ID ? [t.句ID] : []),
    // 去重账本（记忆曲线的输入）：同一句话被复习了几次、从何时到何时
    指纹: t.指纹 || null,
    出现次数: 正整数(t.出现次数, 1),
    首次时间: t.首次时间 != null ? t.首次时间 : null,
    最近时间: t.最近时间 != null ? t.最近时间 : null,
    会话: t.会话 || null,
    轮次: t.轮次 != null ? t.轮次 : null,
    vec: t.vec && typeof t.vec === 'object' ? t.vec : null,
    dv: Array.isArray(t.dv) ? t.dv : null,
    模型ID: t.模型ID || (t.dv ? '外部embed' : 'bigram稀疏')
  }
}

/** 读取向量库() —— 内核 L2/L4 兼容用，返回归一后的条目数组 */
function 读取向量库(选项 = {}) {
  return 读库(选项).条目们.map(归一条目)
}

/**
 * 写入向量库(条目们) —— 整表覆写。存量补挂句ID 走这条。
 * 只接受数组；写入前全量序列化到临时文件再改名，避免半截文件。
 */
function 写入向量库(条目们, 选项 = {}) {
  const p = 库路径(选项)
  if (!Array.isArray(条目们)) return { ok: false, 写入: 0, 原因: '条目们不是数组' }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const 临时 = p + '.tmp-' + process.pid
    const 行们 = 条目们.map(o => JSON.stringify(o)).join('\n')
    fs.writeFileSync(临时, 行们 + (行们 ? '\n' : ''), 'utf8')
    fs.renameSync(临时, p)
    _候选表缓存 = null
    return { ok: true, 写入: 条目们.length, 路径: p }
  } catch (e) {
    return { ok: false, 写入: 0, 原因: String((e && e.message) || e) }
  }
}

// ═══════════════════════ 四方法契约 ═══════════════════════

/**
 * 存入消息(角色, 正文, 时间, _, 新鲜度档, 来源, 权威性, 附加)
 * 第4参保留（上游侧是 会话/来源相关占位，内核调用统一传 null）
 * @returns {{ok, id?, 跳过?, 原因?}}
 */
async function 存入消息(角色, 正文, 时间, _, 新鲜度档, 来源, 权威性, 附加, 选项 = {}) {
  const 正文串 = String(正文 == null ? '' : 正文)
  if (!正文串.trim()) return { ok: true, 跳过: true, 原因: '空正文' }
  if (Array.from(正文串.trim()).length < 2) return { ok: true, 跳过: true, 原因: '正文过短（<2字）' }

  // 首次入库顺手把向量后端装上（自动装配只跑一次；装不上不报错，落哈希兜底）。
  // 故意放在「空正文/过短」检查之后：这两种情况不需要模型，不许为一条空话付 1 秒启动成本。
  if (选项.自动向量 !== false) {
    try { await 确保后端(选项) } catch { /* 永远不因模型阻碍入库 */ }
  }

  const 时间戳 = 数(时间, Date.now())
  const 指纹 = 内容指纹(角色, 正文串)

  // 去重哨兵：同角色 + 同内容 = 同一条记忆。
  //   命中 → 不新增行，只记一次「复习」（见 合并重复），原文表照旧逐句追加（事实源不动）。
  //   传 选项.去重=false 可关掉（演练/造重复数据时用）。
  if (选项.去重 !== false) {
    const 索引 = 取指纹索引(选项)
    if (索引.表.has(指纹)) {
      const 合 = 合并重复(选项, 指纹, Array.isArray(附加 && 附加.句ID们) ? 附加.句ID们 : [], 时间戳)
      if (!合.ok) return { ok: false, 原因: 合.原因, 指纹 }
      return {
        ok: true, 跳过: true, id: 合.id, 指纹, 出现次数: 合.出现次数, 清理冗余: 合.清理冗余,
        原因: '内容重复 → 已并入原条（第 ' + 合.出现次数 + ' 次出现）'
      }
    }
  }

  const id = 造ID(角色, 正文串, 时间戳)
  const 条目 = Object.assign({
    id,
    role: String(角色 || 'user'),
    content: 正文串,
    time: 时间戳,
    来源: 来源 || null,
    权威性: 权威性 != null ? 权威性 : null,
    新鲜度档: 新鲜度档 != null ? 新鲜度档 : null,
    入库时: Date.now(),
    指纹,
    出现次数: 1,
    首次时间: 时间戳,
    最近时间: 时间戳,
    vec: 稀疏向量(正文串),
    vector: await embed(正文串)
  }, 净化附加(附加))

  // 外部 embedding 可用就升级成稠密向量；失败静默退回稀疏（硬约束：不许以模型可用为前置）
  // 由 embed() 统一处理：它自己会选外部还是哈希稠密，返回值永远是 number[]
  // （上面 Object.assign 里已 embed 过一次，这里不再算第二遍——小模型每算一次都是真推理）
  条目.模型ID = _嵌入元.模型ID || (typeof _embed外部 === 'function' ? '外部embed' : 'bigram哈希256')

  const p = 库路径(选项)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, JSON.stringify(条目) + '\n', 'utf8')
    _候选表缓存 = null
    return { ok: true, id, 路径: p }
  } catch (e) {
    return { ok: false, 原因: String((e && e.message) || e) }
  }
}

/**
 * 搜索相关(查询, topK, 来源) —— 语义近似路
 * 有稠密向量用稠密，没有就用稀疏；两类混库时各自算各自的分，再取并集排序。
 */
async function 搜索相关(查询, topK = 取默认TopK(), 来源 = null, 选项 = {}) {
  const 查询串 = String(查询 == null ? '' : 查询)
  const k = 正整数(topK, 取默认TopK())
  if (!查询串.trim()) return []

  let 查询dv = null
  if (_嵌入元.注入) {
    try {
      const v = await embed(查询串)
      if (Array.isArray(v) && v.length) 查询dv = v
    } catch { 查询dv = null }
  }
  const 查询vec = 稀疏向量(查询串)
  const 查询vec2 = 哈希稠密(查询串)
  // 同源校验：模型ID 不同（含旧数据无标签）就不比稠密余弦，交给稀分。
  // 宁可比得粗，也绝不把两个模型算的向量拿来对余弦。
  const 同源 = id => !id || !_嵌入元.模型ID || String(id) === String(_嵌入元.模型ID)

  const 出 = []
  for (const o of 读取向量库(选项)) {
    if (来源 && o.来源 && String(o.来源) !== String(来源)) continue
    // 稠密分：优先用当前后端算的向量，维度必须一致且同源
    let 分 = 0
    if (Array.isArray(o.vector) && o.vector.length) {
      if (查询dv) {
        if (o.vector.length === 查询dv.length && 同源(o.模型ID)) 分 = 稠密余弦(o.vector, 查询dv)
      } else if (o.vector.length === 查询vec2.length) {
        // 哈希兜底态：库里存的也是同维哈希向量（旧数据无模型ID也走这条）
        分 = 稠密余弦(o.vector, 查询vec2)
      }
    }
    if (o.dv && 查询dv && o.dv.length === 查询dv.length) 分 = Math.max(分, 稠密余弦(o.dv, 查询dv))
    const 稀分 = 稀疏余弦(o.vec, 查询vec)
    if (!分) 分 = 稀分
    else 分 = Math.max(分, 稀分 * 0.98)
    if (分 <= 0) continue
    出.push({
      id: o.id, content: o.content, similarity: 分, 检索路: '向量',
      role: o.role, time: o.time, 来源: o.来源,
      句ID: o.句ID, 句ID们: o.句ID们, 会话: o.会话, 轮次: o.轮次
    })
  }
  出.sort((a, b) => b.similarity - a.similarity || (b.time || 0) - (a.time || 0))
  return 出.slice(0, k)
}

/** 关键词检索(查询, topK) —— 字面命中路 */
function 关键词检索(查询, topK = 取默认TopK(), 选项 = {}) {
  const 查询串 = String(查询 == null ? '' : 查询)
  const k = 正整数(topK, 取默认TopK())
  if (!查询串.trim()) return []
  const 出 = []
  for (const o of 读取向量库(选项)) {
    const 分 = 关键词分(查询串, o.content)
    if (分 <= 0) continue
    出.push({
      id: o.id, content: o.content, similarity: 分, 检索路: '关键词',
      role: o.role, time: o.time, 来源: o.来源,
      句ID: o.句ID, 句ID们: o.句ID们, 会话: o.会话, 轮次: o.轮次
    })
  }
  出.sort((a, b) => b.similarity - a.similarity || (b.time || 0) - (a.time || 0))
  return 出.slice(0, k)
}

/** 搜索相关混合(查询, topK, 来源) —— RRF 融合（k=60，与上游口径一致） */
async function 搜索相关混合(查询, topK = 取默认TopK(), 来源 = null, 选项 = {}) {
  const k = 正整数(topK, 取默认TopK())
  let 向量列 = [], 关键词列 = []
  try { 向量列 = await 搜索相关(查询, Math.max(k, 10), 来源, 选项) } catch { 向量列 = [] }
  try { 关键词列 = 关键词检索(查询, Math.max(k, 10), 选项) } catch { 关键词列 = [] }

  const 分表 = new Map()
  const 收 = (列, 名) => {
    for (let i = 0; i < 列.length; i++) {
      const 项 = 列[i]
      const 键 = 项.id || (项.content || '').slice(0, 160)
      const 记录 = 分表.get(键) || { 项, rrf: 0, 路: [] }
      记录.rrf += 1 / (取RRF_K() + i + 1)
      if (!记录.路.includes(名)) 记录.路.push(名)
      分表.set(键, 记录)
    }
  }
  收(向量列, '向量')
  收(关键词列, '关键词')

  return Array.from(分表.values())
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, k)
    .map(r => Object.assign({}, r.项, { similarity: +r.rrf.toFixed(6), 检索路: r.路.join('+') || r.项.检索路, rrf: +r.rrf.toFixed(6) }))
}

/**
 * 读原文(会话, 选项) —— 转发 L1 原文回溯内核。
 * 适配层不自己实现原文表：句ID 的账本只有一个，不能有两份。
 */
function 读原文(会话, 选项 = {}) {
  let 回溯 = null
  try { 回溯 = require('./原文回溯.js') } catch { return { 句: [], 降级: ['原文回溯内核不可用'] } }
  try {
    return 回溯.读原文表(会话, 选项)
  } catch (e) {
    return { 句: [], 降级: ['读原文表失败：' + String((e && e.message) || e)] }
  }
}

// ═══════════════════════ 可插拔 / 自检 ═══════════════════════

/**
 * 设embed(fn, 元) —— 注入外部 embedding（返回 number[]）。传 null 撤掉，退回哈希兜底。
 *   元 = { 模型ID, 维度 }；不传则从 fn.模型ID / fn.维度 读，再不行标 '外部embed'。
 *   维度不传不猜：宁可为 null，也不假装知道——门控标定自检靠它判断要不要降 quiet。
 */
function 设embed(fn, 元) {
  _embed外部 = typeof fn === 'function' ? fn : null
  if (!_embed外部) {
    _嵌入元 = { 模型ID: 'bigram哈希256', 维度: 稠密维度, 注入: false }
    return { ok: true, 模式: 'bigram稀疏', 模型ID: _嵌入元.模型ID, 维度: _嵌入元.维度 }
  }
  const 取 = (k, 默认值) => {
    if (元 && 元[k] != null) return 元[k]
    if (fn[k] != null) return fn[k]
    return 默认值
  }
  const 维 = Number(取('维度', null))
  _嵌入元 = {
    模型ID: String(取('模型ID', '外部embed')),
    维度: Number.isFinite(维) && 维 > 0 ? 维 : null,
    注入: true
  }
  _嵌入失败次数 = 0
  return { ok: true, 模式: '外部embed', 模型ID: _嵌入元.模型ID, 维度: _嵌入元.维度 }
}

/** 当前模式（不暴露内部对象，只报名字） */
function 当前模式() {
  return _嵌入元.注入 ? '外部embed' : 'bigram稀疏'
}

/** 当前嵌入元（模型ID / 维度 / 是否注入 / 失败次数 / 后端名 / 降级原因） */
function 当前嵌入元() {
  return {
    模型ID: _嵌入元.模型ID,
    维度: _嵌入元.维度,
    注入: _嵌入元.注入,
    模式: 当前模式(),
    嵌入失败次数: _嵌入失败次数,
    后端: _后端结果 ? _后端结果.后端 : null,
    降级: _后端结果 && Array.isArray(_后端结果.降级) ? _后端结果.降级.slice() : []
  }
}

/**
 * 确保后端(选项) —— 自动装配向量后端，只跑一次，永不抛错。
 * 并发调用拿到同一个 Promise，不会重复加载 40MB 模型。
 */
function 确保后端(选项 = {}) {
  if (_后端就绪) return _后端就绪
  _后端就绪 = (async () => {
    if (选项.自动向量 === false) {
      _后端结果 = { ok: true, 后端: '哈希兜底', 模型ID: _嵌入元.模型ID, 维度: _嵌入元.维度, 跳过: true, 降级: ['调用方指定 自动向量=false'] }
      return _后端结果
    }
    try {
      const 后端 = require('./向量后端.js')
      _后端结果 = await 后端.自动装配(选项)
    } catch (e) {
      _后端结果 = {
        ok: false, 后端: '哈希兜底', 模型ID: _嵌入元.模型ID, 维度: _嵌入元.维度,
        降级: ['自动装配抛错 → 保持哈希兜底：' + String((e && e.message) || e)]
      }
    }
    return _后端结果
  })()
  return _后端就绪
}

/** 重置后端（验收用）：把「只装配一次」那个开关拨回去，回哈希兜底态 */
function 重置后端() {
  _后端就绪 = null
  _后端结果 = null
  _embed外部 = null
  _嵌入元 = { 模型ID: 'bigram哈希256', 维度: 稠密维度, 注入: false }
  _嵌入失败次数 = 0
  _候选表缓存 = null
  return { ok: true }
}

function 正整数(v, d) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d
}

/** 健康自检：路径 / 条数 / 坏行 / 可回溯率 / 模式 */
function 健康自检(选项 = {}) {
  const 库 = 读库(选项)
  const 条目们 = 库.条目们.map(归一条目)
  const 带句ID = 条目们.filter(o => o.句ID || (o.句ID们 && o.句ID们.length)).length
  return {
    版本, 模式: 当前模式(),
    模型ID: _嵌入元.模型ID, 维度: _嵌入元.维度, 后端: _后端结果 ? _后端结果.后端 : null,
    库路径: 库.路径, 存在: 库.存在, 条数: 条目们.length, 坏行数: 库.坏行数,
    带句ID数: 带句ID,
    可回溯率: 条目们.length ? +(带句ID / 条目们.length * 100).toFixed(2) : 0,
    数据目录: 取根目录(选项)
  }
}

module.exports = {
  版本,
  默认根目录,
  默认库文件名,
  // 四方法契约
  存入消息, 搜索相关, 写入向量库, 读原文,
  // 向量（维度探测 / 外部 embedding 统一入口）
  embed, embed批, 哈希稠密,
  // 兼容方法
  读取向量库, 关键词检索, 搜索相关混合,
  // 可插拔与自检
  设embed, 当前模式, 当前嵌入元, 健康自检, 库路径, 切词, 稀疏向量,
  // 后端自动装配
  确保后端, 重置后端,
  // 去重账本
  内容指纹, 取指纹索引,
  参数: { get RRF_K() { return 取RRF_K() }, 附加白名单 }
}
