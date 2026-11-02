/**
 * 会记得你的鲸鱼 · L2 向量层 · 后端探测链
 * ────────────────────────────────────────────────────────────────
 * 一句话职责：决定「这次用哪个 embed 后端」，并把结果装进 存储适配器。
 *
 * 探测顺序（上一级不可用 → 落下一级，任何一级都要能独立出结果）：
 *   ① 自定义   —— 调用方显式传进来的 选项.embed 函数（用户自己的 API / 大模型）
 *   ② 随包小模型 —— 内核/向量小模型.js（bge-small-zh-v1.5 int8，纯 WASM，零网络）
 *   ③ 哈希兜底  —— bigram 投影到 256 维（零依赖，永远可用，链尾永不断）
 *
 * 硬约束：主链路不得以某个 embedding 模型可用为前置条件。
 *   → 自动装配永不抛错；三级全挂也返回 ③，检索仍出结果，只是语义能力退化。
 *   → 降级不是故障，是设计。但必须**说出来**：每次装配都返回 降级[] 与 原因。
 *
 * 为什么 ③ 不能被 ② 顶掉：
 *   ② 需要 40MB 模型文件在位。用户删了模型目录、或磁盘只读，② 就没了。
 *   ③ 是纯函数，不碰磁盘不碰网络，它是「永远有结果」这句话的全部支撑。
 *
 * 【环境变量】
 *   鲸鱼向量=hash   强制走 ③（省内存/省启动时间，验收对比用）
 *   鲸鱼向量=off    同 hash，且不再尝试加载（永久跳过 ②）
 *   鲸鱼向量=auto   默认
 */

const path = require('path')
const 参数 = require('./参数.js')

const 兜底模型ID = 'bigram哈希256'
const 兜底维度 = 256

function 取模式() {
  const v = String(process.env.鲸鱼向量 || 'auto').toLowerCase()
  if (v === 'hash' || v === 'off' || v === 'bigram' || v === '0') return 'hash'
  return 'auto'
}

function 超时(p, 毫秒, 说明) {
  let 定时器 = null
  return Promise.race([
    Promise.resolve(p).finally(() => { if (定时器) clearTimeout(定时器) }),
    new Promise((_, 拒) => {
      定时器 = setTimeout(() => {
        const e = new Error((说明 || '操作') + '超时 ' + 毫秒 + 'ms')
        e.code = 'TIMEOUT'
        拒(e)
      }, 毫秒)
      if (定时器.unref) 定时器.unref()
    })
  ])
}

/**
 * 自动装配(选项) → { ok, 后端, 模式, 模型ID, 维度, 嵌入器, 降级[], 原因[], 耗时毫秒 }
 *   选项.embed          自定义 embed 函数（返回 number[]）
 *   选项.embed模型ID    自定义后端的名字
 *   选项.embed维度      自定义后端维度
 *   选项.向量模型       false = 跳过随包小模型，直接 ③
 *   选项.模型目录 / 选项.第三方目录   覆盖随包路径
 *   选项.超时毫秒       单级超时，默认 20000
 *   选项.不落盘         只探测不装机（验收用）
 *
 * 永不抛错。
 */
async function 自动装配(选项 = {}) {
  const t0 = Date.now()
  const 超时毫秒 = Number(选项.超时毫秒) || 参数.取整('向量后端.超时毫秒', 20000)
  const 降级 = []
  const 原因 = []

  let 存储 = null
  try { 存储 = require('./存储适配器.js') } catch (e) {
    原因.push('存储适配器不可用：' + String((e && e.message) || e))
  }

  const 装机 = (fn, 元) => {
    if (!存储 || 选项.不落盘) return
    try { 存储.设embed(fn, 元) } catch (e) { 原因.push('设embed 失败：' + String((e && e.message) || e)) }
  }

  // ── ① 自定义 ──
  if (typeof 选项.embed === 'function') {
    const 元 = { 模型ID: 选项.embed模型ID || '外部embed', 维度: Number(选项.embed维度) || null }
    装机(选项.embed, 元)
    return {
      ok: true, 后端: '自定义', 模式: '外部embed',
      模型ID: 元.模型ID, 维度: 元.维度, 嵌入器: null,
      降级, 原因, 耗时毫秒: Date.now() - t0
    }
  }

  // ── ② 随包小模型 ──
  const 模式 = 取模式()
  if (选项.向量模型 !== false && 模式 !== 'hash') {
    try {
      const 小模型 = require('./向量小模型.js')
      const 检查 = 小模型.检查模型(选项.模型目录, 选项.第三方目录)
      if (!检查.ok) throw new Error('文件不全：' + 检查.缺.join('、'))
      const 嵌入器 = await 超时(小模型.创建嵌入器({
        模型目录: 选项.模型目录,
        第三方目录: 选项.第三方目录,
        线程数: 选项.线程数,
        批大小: 选项.批大小,
        缓存条数: 选项.缓存条数
      }), 超时毫秒, '随包小模型加载')
      装机(嵌入器.embed, { 模型ID: 嵌入器.模型ID, 维度: 嵌入器.维度 })
      return {
        ok: true, 后端: '随包小模型', 模式: '外部embed',
        模型ID: 嵌入器.模型ID, 维度: 嵌入器.维度, 嵌入器,
        降级, 原因, 耗时毫秒: Date.now() - t0
      }
    } catch (e) {
      降级.push('随包小模型不可用 → 落哈希兜底｜' + String((e && e.message) || e))
    }
  } else {
    降级.push(模式 === 'hash'
      ? '按 鲸鱼向量=' + String(process.env.鲸鱼向量) + ' 跳过随包小模型'
      : '调用方指定 向量模型=false，跳过随包小模型')
  }

  // ── ③ 哈希兜底 ──
  装机(null, { 模型ID: 兜底模型ID, 维度: 兜底维度 })
  return {
    ok: true, 后端: '哈希兜底', 模式: 'bigram稀疏',
    模型ID: 兜底模型ID, 维度: 兜底维度, 嵌入器: null,
    降级, 原因, 耗时毫秒: Date.now() - t0
  }
}

/**
 * 当前后端快照（不加载、不耗时，给健康自检/UI 用）
 */
function 当前后端() {
  try {
    const 存储 = require('./存储适配器.js')
    const m = typeof 存储.当前模式 === 'function' ? 存储.当前模式() : null
    const 元 = typeof 存储.当前嵌入元 === 'function' ? 存储.当前嵌入元() : {}
    return { 模式: m, 模型ID: 元.模型ID || 兜底模型ID, 维度: 元.维度 || 兜底维度 }
  } catch {
    return { 模式: null, 模型ID: 兜底模型ID, 维度: 兜底维度 }
  }
}

/**
 * 重算向量库(选项) → { ok, 总数, 重算, 跳过, 换维, 失败[], 模型ID, 维度 }
 *
 * 什么时候要跑：库里的向量是 ③ 算的（256 维），后来 ② 装上了（512 维），
 * 老条目的稠密分永远算不出来（维度不符），只能靠稀分混。重算一次就对齐了。
 *
 * 不做的事：不删任何字段，不动原文表，失败条目原样保留并列入 失败[]。
 */
async function 重算向量库(选项 = {}) {
  const 出 = { ok: false, 总数: 0, 重算: 0, 跳过: 0, 换维: 0, 失败: [], 模型ID: null, 维度: null }
  let 存储 = null
  try { 存储 = require('./存储适配器.js') } catch (e) {
    出.失败.push('存储适配器不可用：' + String((e && e.message) || e)); return 出
  }
  const 元 = typeof 存储.当前嵌入元 === 'function' ? 存储.当前嵌入元() : {}
  出.模型ID = 元.模型ID || 兜底模型ID
  出.维度 = 元.维度 || 兜底维度
  if (!元.注入 || !元.维度) {
    出.失败.push('当前是哈希兜底，没有可重算的目标后端（先把 ② 装上再跑）')
    return 出
  }

  let 条目们 = []
  try { 条目们 = 存储.读取向量库(选项) || [] } catch (e) {
    出.失败.push('读向量库失败：' + String((e && e.message) || e)); return 出
  }
  出.总数 = 条目们.length
  const 批 = Math.max(1, Number(选项.批大小) || 参数.取整('向量后端.批大小', 16))
  let 改过 = false

  for (let p = 0; p < 条目们.length; p += 批) {
    const 片 = 条目们.slice(p, p + 批)
    const 待算 = 片.filter(o => {
      const 现维 = Array.isArray(o.vector) ? o.vector.length : 0
      return 现维 !== 元.维度 || (o.模型ID && o.模型ID !== 元.模型ID)
    })
    if (!待算.length) { 出.跳过 += 片.length; continue }
    try {
      const 向量们 = await 存储.embed批(待算.map(o => o.content))
      for (let i = 0; i < 待算.length; i++) {
        const o = 待算[i]
        const 旧维 = Array.isArray(o.vector) ? o.vector.length : 0
        o.vector = 向量们[i]
        o.模型ID = 元.模型ID
        if (旧维 && 旧维 !== 元.维度) 出.换维++
        出.重算++
        改过 = true
      }
      出.跳过 += 片.length - 待算.length
    } catch (e) {
      出.失败.push('第 ' + (p + 1) + ' 条起一批失败：' + String((e && e.message) || e))
      出.跳过 += 待算.length
    }
  }

  if (改过) {
    try {
      const r = 存储.写入向量库(条目们, 选项)
      if (r && r.ok === false) 出.失败.push('写回失败：' + (r.原因 || '未知'))
      else 出.ok = true
    } catch (e) {
      出.失败.push('写回失败：' + String((e && e.message) || e))
    }
  } else {
    出.ok = true
  }
  return 出
}

module.exports = {
  兜底模型ID, 兜底维度,
  自动装配, 当前后端, 重算向量库, 取模式
}
