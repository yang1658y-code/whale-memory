'use strict'
/**
 * 会记得你的鲸鱼 · 安装线 · 登录态
 *
 * 唯一职责：**回答一个问题——这台机器现在是不是已经登录了 QQ 开放平台。**
 * 答对了，用户一次扫码都不用扫；答错了，要么白让人扫一次，要么在没登录时闷头往下跑然后报一堆看不懂的错。
 *
 * 判据不靠猜 cookie 名（腾讯随时改名）。用三条**页面自身承认的事实**：
 *   ① **重定向**：未登录访问后台，腾讯会亲手把你扔到 `…/openclaw/login.html?redirect_url=…`。
 *      这是最权威的一条——不是我们推断的，是它自己说的。
 *   ② **登录框在场**：未登录时页面里挂着一个 `xui.ptlogin2.qq.com` 的 iframe（QQ 快捷登录/扫码）。
 *      登录框本身就是未登录的证据；反过来，后台页里没有它，就是登录了。
 *   ③ **落在后台**：URL 进了 `q.qq.com/qqbot/` 的非 login 页（如 entity-picker.html）= 已登录。
 *
 * 三条都不成立 → 返回 已登录=null（不知道），由调用方决定是重试还是问用户。
 * **绝不把「不知道」说成「已登录」**：那会让用户对着一个空白页等半天。
 *
 * 真机实测（2026-11-02，Edge 156 无头）：
 *   未登录 → https://q.qq.com/qqbot/openclaw/login.html?redirect_url=https%3A%2F%2Fq.qq.com%2Fqqbot%2Fopenclaw%2F
 *   页面标题「快速注册创建QQ机器人」，正文是四步快速开始指南，iframe 指 ptlogin2。
 */

const 浏 = require('./浏览器.js')

const 后台入口 = 'https://q.qq.com/qqbot/openclaw/'
const 登录页标记 = 'login.html'
const 登录框域名标记 = 'ptlogin2'

/**
 * 页面自述的特征词——**比 URL 早一步，也比 URL 准一步**。
 * 腾讯这套是先渲染外壳再重定向：有一瞬间 URL 还是后台地址，页面内容却已经是登录页。
 * 只看 URL 会把它判成「已登录」——2026-11-02 真机栽过这一跤。
 */
const 登录页特征词 = ['快速开始指南', 'QQ账号登录', '账号密码登录']
const 后台特征词 = ['我的机器人', '创建机器人', '退出登录', 'AppID']

/** 纯判据（可离线验收：给 URL + 事实，返回结论，不碰网络） */
function 判登录态(落地URL, 事实 = {}) {
  const u = String(落地URL || '')
  if (!u) return { 已登录: null, 判据: '还没拿到落地地址' }
  if (u.includes(登录页标记)) {
    return { 已登录: false, 判据: '腾讯把后台入口重定向到了登录页（login.html）' }
  }
  if (事实.有登录框) {
    return { 已登录: false, 判据: '页面里挂着 QQ 登录框（ptlogin2）——登录框在场就是没登录' }
  }
  const 文 = String(事实.正文 || '')
  const 见登录词 = 登录页特征词.filter(w => 文.includes(w))
  if (见登录词.length) {
    return { 已登录: false, 判据: 'URL 还没跳，但页面内容已经是登录页（' + 见登录词.join('/') + '）' }
  }
  const 见后台词 = 后台特征词.filter(w => 文.includes(w))
  if (/^https:\/\/q\.qq\.com\/qqbot\//.test(u) && 见后台词.length) {
    return { 已登录: true, 判据: '停在机器人后台（' + u.replace(/^https:\/\/q\.qq\.com/, '').split('?')[0] + '），有后台特征（' + 见后台词.join('/') + '）且无登录框' }
  }
  if (/^https:\/\/q\.qq\.com\/qqbot\//.test(u)) {
    // 🚨 不知道就说不知道。判成「已登录」会让用户对着空白页干等，比说「看不出」坏十倍。
    return { 已登录: null, 判据: 'URL 像后台，但页面既无后台特征也无登录特征（可能还在渲染）——不敢判已登录' }
  }
  return { 已登录: null, 判据: '看不出登录态：落地在 ' + u }
}

/** 从活着的页面读事实（只看，不动手） */
async function 看(连) {
  const 求 = async (表达式) => {
    const r = await 连.发('Runtime.evaluate', { expression: 表达式, returnByValue: true }).catch(() => null)
    if (!r || r.exceptionDetails) return null
    return r.result ? r.result.value : null
  }
  const 落地URL = await 求('location.href')
  const 有登录框 = await 求(`!!document.querySelector('iframe[src*="${登录框域名标记}"]')`)
  const 标题 = await 求('document.title')
  const 正文 = await 求('(document.body ? (document.body.innerText || "") : "").slice(0, 3000)')
  return { 落地URL, 有登录框: !!有登录框, 标题, 正文: String(正文 || '') }
}

/** 看一眼并下结论 */
async function 检测(连) {
  const 事实 = await 看(连)
  const 判 = 判登录态(事实.落地URL, 事实)
  return Object.assign(判, 事实)
}

/**
 * 打开后台入口并判定登录态。返回 { ok, 页, 连, 登录态 }。
 * 调用方负责在结束时 连.关() 与 浏览器.关闭()。
 */
async function 打开后台(浏览器, 选项 = {}) {
  const 页 = await 浏.开页(浏览器.端口, 选项.入口 || 后台入口, { 超时毫秒: 选项.开页超时毫秒 || 10000 })
  if (!页.ok) return { ok: false, 说明: 页.说明 }
  const 连 = await 浏.连接(页.ws地址, { 超时毫秒: 选项.连接超时毫秒 || 10000 })
  if (!连.ok) return { ok: false, 说明: 连.说明 }
  await 连.发('Page.enable').catch(() => {})
  await 连.发('Runtime.enable').catch(() => {})

  // 等首屏落定：腾讯这套是先渲染外壳再重定向。
  // 落定判据 = 「URL 连续两次读到相同」且「已过最短等待」——只等 URL 出现是不够的，
  // 那正好把「还没跳转的登录页」读成「已登录」。
  const 最短毫秒 = 选项.首屏毫秒 || 3000
  const 起 = Date.now()
  let 上次URL = null
  let 稳了 = 0
  let 态 = await 检测(连)
  while (Date.now() - 起 < 20000) {
    if (态.落地URL && 态.落地URL === 上次URL) 稳了++
    else 稳了 = 0
    上次URL = 态.落地URL
    if (稳了 >= 2 && Date.now() - 起 >= 最短毫秒) break
    await 浏.睡(700)
    态 = await 检测(连)
  }
  if (选项.额外等毫秒) { await 浏.睡(选项.额外等毫秒); 态 = await 检测(连) }
  return { ok: true, 页, 连, 登录态: 态 }
}

/**
 * 等用户扫码登录。
 * 每 每毫秒 看一眼，直到 已登录=true 或超时。
 * 中间状态（null/未登录）一律继续等——用户可能正好在扫码。
 *
 * @returns {{ok:boolean, 已登录:boolean, 登录态, 等了秒:number, 说明?}}
 */
async function 等登录(连, 选项 = {}) {
  const 超时毫秒 = 选项.超时毫秒 || 5 * 60 * 1000
  const 每毫秒 = 选项.每毫秒 || 1500
  const 回调 = typeof 选项.进度回调 === 'function' ? 选项.进度回调 : null
  const 起 = Date.now()
  let 上次判据 = ''
  let 第几 = 0
  while (Date.now() - 起 < 超时毫秒) {
    const 态 = await 检测(连)
    第几++
    if (态.已登录 === true) {
      return { ok: true, 已登录: true, 登录态: 态, 等了秒: +((Date.now() - 起) / 1000).toFixed(1) }
    }
    if (回调 && 态.判据 !== 上次判据) { 回调(态, 第几); 上次判据 = 态.判据 }
    await 浏.睡(每毫秒)
  }
  const 态 = await 检测(连)
  return {
    ok: false, 已登录: 态.已登录 === true, 登录态: 态, 等了秒: +((Date.now() - 起) / 1000).toFixed(1),
    说明: '等了 ' + Math.round(超时毫秒 / 1000) + ' 秒还没登录（' + 态.判据 + '）'
  }
}

module.exports = {
  后台入口, 判登录态, 看, 检测, 打开后台, 等登录
}
