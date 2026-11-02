'use strict'
/**
 * 攒话.js · 入向攒话桶（把「连着说三句」攒成「一轮」）
 *
 * 人在 QQ 里不会一句话说完整：
 *   「在吗」「我跟你说个事」「昨晚那个」
 * 这是三轮事件，不是说三件事。旧版一条一处理 → 三次入库、三次检索、三次调模型、
 * 三条回复，模型还以为对方在连珠炮。
 *
 * 判定标准只有一条（记死它，别改）：
 *   一轮 = 同一会话内，最后一条到达之后，静默满 N 毫秒。
 *   不是「从第一条算 N 毫秒」——用户手速多快，系统就等多久。
 *
 * 六条规则（每条都对应一处会翻车的地方）：
 *   ① 事件一到就起表，不是排队到处理器才起表（否则实际延迟 = N 毫秒 + 排队时间）。
 *   ② 新的一条到达 → 旧表作废，从这一条重计。
 *   ③ 攒满 最多句数 → 立刻放行（防刷屏被无限挂住）。
 *   ④ 命令类（以 / 开头）直接放行、不进桶，也不重置表（用户敲命令盼立刻有反应）。
 *   ⑤ 重复 msgId 丢弃，且不重置表（网关抖一次就重置一次，会永远放不出去）。
 *   ⑥ 桶按会话分键。跨会话拼轮 = 灾难，翻原话会看到两个人被缝成一句话。
 *
 * 定时器可注入（选项.定时器），验收不必真等 2 秒。
 * 零依赖。
 */

function 读整数(键, 兜底) {
  try { return require('../../内核/参数.js').取整(键, 兜底) } catch { return 兜底 }
}

/**
 * @param {object} 选项
 *   日志?(级别,内容)  放行(会话, 条目们, 附加)  静默毫秒?  最多句?  去重窗口?
 *   定时器? { set(fn,ms)→句柄, clear(句柄), 现在()→ms }
 * @returns {{投递, 立即放行, 待发数, 桶数, 关, 参数}}
 */
function 造攒话桶(选项 = {}) {
  const 日志 = typeof 选项.日志 === 'function' ? 选项.日志 : () => {}
  const 放行回调 = typeof 选项.放行 === 'function' ? 选项.放行 : () => {}

  const 静默毫秒 = Math.max(0, 选项.静默毫秒 !== undefined && 选项.静默毫秒 !== null
    ? Math.round(Number(选项.静默毫秒)) : 读整数('qq.入向静默毫秒', 2000))
  const 最多句 = Math.max(1, 选项.最多句 !== undefined && 选项.最多句 !== null
    ? Math.round(Number(选项.最多句)) : 读整数('qq.入向最多句数', 10))
  const 去重窗口 = Math.max(0, 选项.去重窗口 !== undefined && 选项.去重窗口 !== null
    ? Math.round(Number(选项.去重窗口)) : 读整数('qq.入向去重窗口', 200))

  const 定时 = 选项.定时器 || {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (句柄) => clearTimeout(句柄),
    现在: () => Date.now()
  }

  const 桶表 = new Map()          // 会话 → { 条目们: [], 句柄 }
  const 已见 = []                 // msgId 环形列表（先进先出）
  const 已见集 = new Set()
  let 已关 = false

  function 记msgId(msgId) {
    if (!msgId || 去重窗口 <= 0) return
    已见.push(msgId)
    已见集.add(msgId)
    while (已见.length > 去重窗口) 已见集.delete(已见.shift())
  }
  function 是重复(msgId) {
    if (!msgId || 去重窗口 <= 0) return false
    return 已见集.has(msgId)
  }

  /** 把一个桶交出去（清表、删桶）。命令类也会走这里，只是桶里只有一条 */
  function 交出去(会话, 条目们, 附加 = {}) {
    const 桶 = 桶表.get(会话)
    if (桶) {
      if (桶.句柄) { try { 定时.clear(桶.句柄) } catch {} }
      桶.句柄 = null
      桶表.delete(会话)
    }
    if (!条目们 || !条目们.length) return
    try {
      const r = 放行回调(会话, 条目们, 附加)
      if (r && typeof r.catch === 'function') r.catch(e => 日志('error', '放行处理异常：' + String((e && e.message) || e)))
    } catch (e) {
      日志('error', '放行处理异常：' + String((e && e.message) || e))
    }
  }

  /**
   * 投递一条到货。返回 { 收下, 原因?, 丢弃?, 放行方式? }
   * @param {object} 条目 { 会话, 文本?, msgId?, 时间?, 归?, 原始? }
   */
  function 投递(条目) {
    const 会 = 条目 && 条目.会话
    if (!会) return { 收下: false, 原因: '没有会话标识（宁可不收，也不建垃圾账本）' }
    if (已关) return { 收下: false, 原因: '桶已关闭' }

    // ⑤ 去重：重投同一条 → 丢弃，且**不动计时**
    if (是重复(条目.msgId)) {
      日志('warn', '重复 msgId 丢弃（' + 会 + ' · ' + String(条目.msgId).slice(0, 24) + '），不重置计时')
      return { 收下: false, 丢弃: '重复 msgId' }
    }
    记msgId(条目.msgId)

    // ④ 命令类：直接放行，不进桶、不重置计时
    const 文本 = String((条目 && 条目.文本) || '')
    if (/^\s*\//.test(文本)) {
      日志('info', '命令类消息直接放行（' + 会 + '）')
      交出去(会, [条目], { 命令: true })
      return { 收下: true, 放行方式: '命令直放' }
    }

    // ①② 入桶 + 重计表
    let 桶 = 桶表.get(会)
    if (!桶) { 桶 = { 条目们: [], 句柄: null }; 桶表.set(会, 桶) }
    桶.条目们.push(条目)
    if (桶.句柄) { try { 定时.clear(桶.句柄) } catch {} ; 桶.句柄 = null }

    // ③ 攒满强制放行
    if (桶.条目们.length >= 最多句) {
      日志('info', '攒满 ' + 最多句 + ' 句，不等静默立即放行（' + 会 + '）')
      const 条目们 = 桶.条目们.slice()
      交出去(会, 条目们, { 满额: true })
      return { 收下: true, 放行方式: '满额', 句数: 条目们.length }
    }

    桶.句柄 = 定时.set(() => {
      const 现桶 = 桶表.get(会)
      if (!现桶) return
      const 条目们 = 现桶.条目们.slice()
      现桶.句柄 = null
      日志('info', '静默满 ' + 静默毫秒 + 'ms，放行 ' + 条目们.length + ' 句成一轮（' + 会 + '）')
      交出去(会, 条目们, { 静默: true })
    }, 静默毫秒)

    return { 收下: true, 待静默毫秒: 静默毫秒, 桶内句数: 桶.条目们.length }
  }

  /** 立刻把某会话的桶交出去（收尾 / --once / 测试用） */
  function 立即放行(会话, 附加 = {}) {
    const 桶 = 桶表.get(会话)
    if (!桶) return { ok: false, 原因: '该会话没有待放的桶' }
    const 条目们 = 桶.条目们.slice()
    交出去(会话, 条目们, Object.assign({ 手动: true }, 附加))
    return { ok: true, 句数: 条目们.length }
  }

  function 关() {
    已关 = true
    for (const [会, 桶] of 桶表) {
      if (桶.句柄) { try { 定时.clear(桶.句柄) } catch {} }
      桶.句柄 = null
      // 关桶时不丢话：桶里还剩的话，最后交一次（收尾不要吞掉用户刚说的话）
      if (桶.条目们.length) {
        try { 放行回调(会, 桶.条目们.slice(), { 收尾: true }) } catch {}
      }
    }
    桶表.clear()
  }

  return {
    投递, 立即放行, 关,
    待发数: () => { let n = 0; for (const b of 桶表.values()) n += b.条目们.length; return n },
    桶数: () => 桶表.size,
    参数: { 静默毫秒, 最多句, 去重窗口 }
  }
}

module.exports = { 造攒话桶 }
