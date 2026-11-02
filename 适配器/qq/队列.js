'use strict'
/**
 * 队列.js · 按会话分键的串行队列
 *
 * 为什么分键：旧版队列是全局一条。群里 A 正在生成（好几秒），单聊 B 的人
 * 发一句话得排在 A 后面干等——他并不知道前面还有别人。
 *
 * 为什么仍要串行：同一个会话内部绝不并发。两轮同时写同一个账本，
 * 轮次号会打架，翻原话时顺序会乱。串行是账本正确性的前提，不是性能取舍。
 *
 * 零依赖。
 */

/**
 * @param {object} 选项 { 日志?(级别,内容) }
 * @returns {{推, 表, 总长度, 忙键们, 空闲, 清}}
 */
function 造队列(选项 = {}) {
  const 日志 = typeof 选项.日志 === 'function' ? 选项.日志 : () => {}
  const 表 = new Map()      // 键 → { 列: [], 忙: false }
  const 等待们 = []         // 空闲等待者

  function 通知空闲() {
    if (表.size) return
    while (等待们.length) {
      const r = 等待们.shift()
      try { r() } catch {}
    }
  }

  function 推(键, fn) {
    if (typeof fn !== 'function') return { ok: false, 原因: '任务必须是函数' }
    const 道键 = String(键 == null ? '' : 键)
    let 道 = 表.get(道键)
    if (!道) { 道 = { 列: [], 忙: false }; 表.set(道键, 道) }
    道.列.push(fn)
    if (!道.忙) 跑(道键)
    return { ok: true, 排队数: 道.列.length }
  }

  async function 跑(键) {
    const 道 = 表.get(键)
    if (!道) return
    道.忙 = true
    while (道.列.length) {
      const fn = 道.列.shift()
      try { await fn() } catch (e) { 日志('error', '队列任务异常（' + 键 + '）：' + String((e && e.message) || e)) }
    }
    道.忙 = false
    if (!道.列.length) 表.delete(键)
    通知空闲()
  }

  return {
    推, 表,
    总长度: () => { let n = 0; for (const d of 表.values()) n += d.列.length; return n },
    忙键们: () => { const 出 = []; for (const [k, d] of 表) if (d.忙) 出.push(k); return 出 },
    空闲: () => (表.size ? new Promise((r) => 等待们.push(r)) : Promise.resolve())
  }
}

module.exports = { 造队列 }
