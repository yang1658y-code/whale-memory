'use strict'
/**
 * 切段.js · 把一次生成的长回复，切成 1–N 条 QQ 消息
 *
 * 为什么要有这一层：
 *   模型不知道 QQ 有长度上限。它给 800 字，我们一条发出去，平台 4xx，
 *   日志里只有「发送失败」四个字，群里的人什么也看不到——用户以为机器人死了。
 *
 * 四条铁律（改这个文件前先读）：
 *   ① 短回复不许拆。≤ 不分段字数 且 换行不足两行 → 原样一条发完。
 *      绝大多数对话走这条，用户感知与「没有这个模块」完全一样。
 *   ② 拆只按自然边界拆，优先级：换行 → 句末标点 → 逗号 → 最后才是字数硬切。
 *      按字数硬剁会把「不加糖」剁成「不加/糖」。
 *   ③ 段数受平台额度约束，不受模型字数约束。超出的块并进最后一段，
 *      不是丢掉——丢掉的都是内容。
 *   ④ 有硬上限。并完还超，才截断并加「…」，且必须把 截断 标出来（不许静默）。
 *
 * 零依赖。
 */

/** 参数热读（拿不到就用出厂常量，绝不报错） */
function 读整数(键, 兜底) {
  try { return require('../../内核/参数.js').取整(键, 兜底) } catch { return 兜底 }
}
function 读布尔(键, 兜底) {
  try { return require('../../内核/参数.js').取布尔(键, 兜底) } catch { return 兜底 }
}

const 句末 = '。！？…～；;.!?'
const 逗号 = '，,、：:'

/**
 * 把所有自然边界都切开，得到一堆「块」；每块正文长度 ≤ 宽。
 *
 * 每块自带 前导（不是事后补）：
 *   前导 = 这块前面的分隔符（来自上一行就带 '\n'）+ 这一行的行首空白（缩进）。
 * 为什么这么改：旧版只记一个布尔「这块是不是行首」，合并时补一个 '\n' 了事，
 * 行首缩进在 trim() 里被吃掉且没有数据能补回来——两层列表会被压平成同级。
 * 换行和缩进现在走同一条数据通道，要么都在、要么都不在。
 */
function 切小块(文本, 宽) {
  const 出 = []
  let 已出过 = false
  for (const 行 of String(文本 == null ? '' : 文本).split('\n')) {
    const 行首空白 = (行.match(/^[ \t]*/) || [''])[0]
    const 行文 = 行.trim()          // 只用于切分，缩进另存进 前导
    if (!行文) continue              // 空行丢弃：它没有内容，但它造的换行仍记在下一块的前导里
    const 行前导 = (已出过 ? '\n' : '') + 行首空白
    // ① 按句末标点切成句（标点跟在前一句尾巴上，不单独成句）
    const 句们 = []
    let 起 = 0
    for (let i = 0; i < 行文.length; i++) {
      if (句末.includes(行文[i])) { 句们.push(行文.slice(起, i + 1)); 起 = i + 1 }
    }
    if (起 < 行文.length) 句们.push(行文.slice(起))
    // ② 句子太长 → 退到逗号；还不够 → 交给 ③ 硬切
    let 首个 = true
    for (const 句 of 句们) {
      const 文 = 句.trim()
      if (!文) continue
      const 本行首 = 首个 ? 行前导 : ''
      首个 = false
      if (文.length <= 宽) { 出.push({ 文, 前导: 本行首 }); 已出过 = true; continue }
      let 片起 = 0
      let 片首 = 本行首
      for (let i = 0; i < 文.length; i++) {
        // 只在「已经攒够半段」的逗号处断，否则「我叫小王，」这种会被切成一堆碎渣
        if (逗号.includes(文[i]) && i + 1 - 片起 >= 宽 / 2) {
          出.push({ 文: 文.slice(片起, i + 1), 前导: 片首 })
          已出过 = true
          片首 = ''
          片起 = i + 1
        }
      }
      if (片起 < 文.length) { 出.push({ 文: 文.slice(片起), 前导: 片首 }); 已出过 = true }
    }
  }
  // ③ 兜底：仍然超宽（长句无标点），按字数切
  const 收 = []
  for (const 块 of 出) {
    const 文 = 块.文.trim()
    if (!文) continue
    if (文.length <= 宽) { 收.push({ 文, 前导: 块.前导 }); continue }
    let 首 = 块.前导
    for (let i = 0; i < 文.length; i += 宽) { 收.push({ 文: 文.slice(i, i + 宽), 前导: 首 }); 首 = '' }
  }
  return 收
}

/**
 * 一轮最多发几段。平台的被动回复额度是 4 条，开了「正在输入」要占 1 条。
 * @returns {number} 1..4
 */
function 段额度(选项 = {}) {
  const 输入提示 = (选项.输入提示 === undefined || 选项.输入提示 === null)
    ? 读布尔('qq.输入提示', false)
    : !!选项.输入提示
  const 配的上限 = 选项.最多段数 !== undefined && 选项.最多段数 !== null
    ? Number(选项.最多段数)
    : 读整数('qq.最多段数', 3)
  const 平台额度 = 4
  const 上限 = Number.isFinite(配的上限) ? Math.round(配的上限) : 3
  return Math.max(1, Math.min(上限, 平台额度 - (输入提示 ? 1 : 0)))
}

/**
 * 切段主函数。
 * @param {string} 文本 一次生成的完整回复
 * @param {object} 选项 { 不分段字数?, 单段最大字数?, 单段硬上限?, 最多段数?, 输入提示? }
 * @returns {{段们:string[], 段数:number, 单段:boolean, 被并:boolean, 截断:boolean, 原字数:number, 额度:number}}
 */
function 切段(文本, 选项 = {}) {
  const 原文 = String(文本 == null ? '' : 文本).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  const 不分段字数 = 选项.不分段字数 !== undefined && 选项.不分段字数 !== null
    ? Number(选项.不分段字数) : 读整数('qq.不分段字数', 120)
  const 单段最大 = 选项.单段最大字数 !== undefined && 选项.单段最大字数 !== null
    ? Number(选项.单段最大字数) : 读整数('qq.单段最大字数', 300)
  const 硬上限 = 选项.单段硬上限 !== undefined && 选项.单段硬上限 !== null
    ? Number(选项.单段硬上限) : 读整数('qq.单段硬上限', 900)

  const 宽 = Math.max(20, Math.round(Number.isFinite(单段最大) ? 单段最大 : 300))
  const 硬 = Math.max(宽, Math.round(Number.isFinite(硬上限) ? 硬上限 : 900))
  const 额度 = 段额度(选项)
  const 出 = { 段们: [], 段数: 0, 单段: true, 被并: false, 截断: false, 原字数: 原文.length, 额度 }

  if (!原文) { 出.段们 = []; 出.段数 = 0; return 出 }

  // 铁律 ①：短回复不拆（换行不足两行 = 还是「一段话」）
  const 换行数 = (原文.match(/\n/g) || []).length
  if (原文.length <= 不分段字数 && 换行数 < 2) {
    出.段们 = [原文]
    出.段数 = 1
    return 出
  }

  // 铁律 ②：按自然边界切块，再贪心合成段
  const 块们 = 切小块(原文, 宽)
  if (!块们.length) { 出.段们 = [原文]; 出.段数 = 1; return 出 }

  const 段们 = []
  let 当前 = ''
  for (const 块 of 块们) {
    // 段首（含被上一块撑满后新起的一段）一律不带前导：气泡开头出现换行和缩进很难看
    if (!当前) { 当前 = 块.文; continue }
    const 增 = 块.前导.length + 块.文.length
    // 前导（换行 + 缩进）也算长度：合并进来不能悄悄把段撑过硬上限
    if (当前.length + 增 <= 宽) 当前 += 块.前导 + 块.文
    else { 段们.push(当前); 当前 = 块.文 }
  }
  if (当前) 段们.push(当前)

  // 铁律 ③：超出额度 → 并进最后一段，不丢
  let 结果段 = 段们
  if (结果段.length > 额度) {
    出.被并 = true
    const 头 = 结果段.slice(0, 额度 - 1)
    const 尾 = 结果段.slice(额度 - 1).join('\n')
    头.push(尾)
    结果段 = 头
  }

  // 铁律 ④：并完仍超硬上限 → 截断，且必须标出来
  for (let i = 0; i < 结果段.length; i++) {
    if (结果段[i].length > 硬) {
      结果段[i] = 结果段[i].slice(0, 硬 - 1) + '…'
      出.截断 = true
    }
  }

  出.段们 = 结果段.filter(s => String(s).trim())
  出.段数 = 出.段们.length
  出.单段 = 出.段数 <= 1
  return 出
}

module.exports = { 切段, 切小块, 段额度 }
