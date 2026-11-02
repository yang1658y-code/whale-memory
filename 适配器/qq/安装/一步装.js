#!/usr/bin/env node
'use strict'
/**
 * 一步装.js · 序③+序④ 一口气跑完：判登录态 → 等扫码 → 抄 AppID/AppSecret → 落盘
 *
 * 用法：
 *   node 适配器/qq/安装/一步装.js               有头，扫码等 900 秒，抄完把浏览器留着
 *   node 适配器/qq/安装/一步装.js --无头         无头（实测：拿不到扫码后的登录态，仅调试用）
 *   node 适配器/qq/安装/一步装.js --超时 300     等多久
 *   node 适配器/qq/安装/一步装.js --appid 123    只抄这个 AppID 的 secret
 *   node 适配器/qq/安装/一步装.js --关窗         抄完关掉浏览器（默认不关，见下）
 *
 * 【为什么默认不关浏览器】2026-11-02 真机踩到的坑：
 *   腾讯的登录态是**会话级 cookie**——Browser.close 之后 profile 里的凭证就没了，
 *   下一次启动照样回到登录页。所以「扫完就关窗」= 白扫一次。
 *   本脚本抄完凭据后把窗口留着，下一次免扫还能成立；要关的时候由人关。
 *
 * 【为什么结果落盘】这条链路一跑就是几分钟（等人扫码），
 *   execute_command 会超时把 node 掐掉，结果就丢了。落盘到 临时/安装结果.json，谁都能事后取。
 */
const fs = require('fs')
const path = require('path')
const 浏 = require('./浏览器.js')
const 登 = require('./登录态.js')
const 抄 = require('./抄凭据.js')

const 根 = path.join(__dirname, '..', '..', '..')
const 临时 = path.join(根, '临时')
const 结果文件 = path.join(临时, '安装结果.json')
const 端口文件 = path.join(临时, '安装端口.txt')

const 参 = process.argv.slice(2)
const 有 = (名) => 参.includes('--' + 名)
const 取 = (名, 缺 = null) => { const i = 参.indexOf('--' + 名); return i >= 0 && 参[i + 1] ? 参[i + 1] : 缺 }

const 无头 = 有('无头')
const 关窗 = 有('关窗')
const 超时秒 = Number(取('超时', '900')) || 900
const 目标AppID = 取('appid', '')
// 固定端口（默认 9333）：窗口开着的时候重跑本脚本，会**直接接上那个窗口**，不再开第二个。
// 上一轮「窗口明明还在却连不上」就是因为端口每次随机（--remote-debugging-port=0），跑完把端口丢了。
const 端口 = Number(取('端口', '9333')) || 9333

const 打印 = (级别, 内容) => {
  const 标 = { 步: '▸', 好: '✅', 坏: '❌', 等: '⏳', 注: '·', 喜: '🎉' }[级别] || '·'
  console.log(new Date().toISOString().slice(11, 19) + ' ' + 标 + ' ' + 内容)
}
const 落盘 = (对象) => {
  try {
    fs.mkdirSync(临时, { recursive: true })
    fs.writeFileSync(结果文件, JSON.stringify(Object.assign({ 时间: new Date().toISOString() }, 对象), null, 2), 'utf8')
  } catch (e) { 打印('坏', '结果落盘失败：' + String(e.message || e)) }
}

// ── 心跳（2026-11-02 加）─────────────────────────────────────────────
// 【为什么】这条链路一跑就是几分钟（等人扫码）。宿主那头在挂起等待，
//   醒来第一件事就是读这个文件判断进度 —— 只在最后落一次盘，中间就是黑箱，他只能靠猜。
//   所以：阶段一变就落盘，另外每 2 秒把当前阶段刷新一次，
//   读的人任何时候都能看到「现在卡在哪一秒的哪一步」。
let 当前态 = { 阶段: '启动中' }
const 设阶段 = (阶, 附加) => {
  当前态 = Object.assign({ 阶段: 阶 }, 附加 || {})
  落盘(当前态)
}
const 心跳钟 = setInterval(() => { try { 落盘(当前态) } catch { /* 落不下去也不该断了安装 */ } }, 2000)
if (心跳钟.unref) 心跳钟.unref()

/** 页面上所有可点元素的文案 —— 抄不到时落盘，供下一轮写「创建机器人」分支取证 */
async function 抓现场(连) {
  const 求 = async (表达式) => {
    const r = await 连.发('Runtime.evaluate', { expression: 表达式, returnByValue: true, awaitPromise: true }).catch(() => null)
    if (!r || r.exceptionDetails || !r.result) return null
    return r.result.value
  }
  const 原 = await 求(`JSON.stringify([...document.querySelectorAll('button,[role=button],.xui-button,.xui-btn,a')]
    .map(e => (e.innerText || '').trim()).filter(Boolean).slice(0, 80))`)
  let 表 = []
  try { 表 = JSON.parse(原) || [] } catch { 表 = [] }
  const 文 = String(await 求('document.body ? (document.body.innerText || "") : ""') || '')
  return { 按钮清单: Array.isArray(表) ? 表 : [], 页面正文: 文.slice(0, 3000) }
}

;(async () => {
  fs.mkdirSync(临时, { recursive: true })
  设阶段('启动中')

  // ① 找浏览器 + 起窗口
  const 找 = 浏.找浏览器()
  if (!找.ok) { 打印('坏', 找.说明); 设阶段('失败', { 原因: 找.说明 }); process.exit(1) }
  打印('好', '浏览器：' + 找.名字 + '（' + 找.路径 + '）')

  const 启 = await 浏.启动({ 路径: 找.路径, 无头, 端口 })
  if (!启.ok) { 打印('坏', 启.说明); 设阶段('失败', { 原因: 启.说明 }); process.exit(1) }
  打印('好', (启.复用 ? '接上已有窗口' : '窗口已起') + '，CDP 端口 ' + 启.端口 + '（独立配置：' + 启.数据目录 + '）')
  try { fs.writeFileSync(端口文件, String(启.端口), 'utf8') } catch { /* 无所谓 */ }
  设阶段('等登录', { 端口: 启.端口 })

  // ② 开后台 + 稳判登录态
  const 开 = await 登.打开后台(启, { 额外等毫秒: 2000 })
  if (!开.ok) { 打印('坏', '开后台失败：' + 开.说明); 设阶段('失败', { 原因: 开.说明 }); if (!关窗 && 启.进程) 启.进程.unref(); process.exit(1) }
  const 连 = 开.连
  let 态 = 开.登录态
  打印('注', '落地：' + (态.落地URL || '(读不到)'))
  打印(态.已登录 ? '好' : '注', '登录态：' + (态.已登录 === true ? '已登录' : 态.已登录 === false ? '未登录' : '看不出') + ' —— ' + 态.判据)

  // ③ 没登录就等人扫
  if (态.已登录 !== true) {
    console.log('')
    console.log('  ══════════ 需要你动手（只有这一步） ══════════')
    console.log('   在弹出的窗口里，用要挂机器人的那个 QQ 号扫码登录。')
    console.log('   扫完什么都不用点——我这边每 2 秒看一眼，登录成功自己往下走。')
    console.log('  ════════════════════════════════════════════')
    console.log('')
    设阶段('等扫码', { 端口: 启.端口, 落地: 态.落地URL })
    打印('等', '等你扫码（最多 ' + 超时秒 + ' 秒）…')
    const 等 = await 登.等登录(连, { 超时毫秒: 超时秒 * 1000, 每毫秒: 2000, 进度回调: (t) => { if (t.已登录 === null) 打印('注', '页面：' + t.判据) } })
    if (!等.已登录) {
      打印('坏', 等.说明 || '没等到登录')
      设阶段('超时未登录', { 端口: 启.端口, 说明: 等.说明 })
      if (关窗) await 启.关闭()
      process.exit(3)
    }
    打印('喜', '登录成功（等了 ' + 等.等了秒 + ' 秒）')
    态 = 等.登录态
  }

  // ④ 列表渲染需要一点时间；宁可多等 2 秒，也别在骨架屏上抄空
  await 浏.睡(2500)
  设阶段('抄凭据中', { 端口: 启.端口 })

  let 结果 = null
  for (let 试 = 1; 试 <= 3; 试++) {
    结果 = await 抄.抄(连, { 目标AppID })
    if (结果.ok) break
    打印('注', '第 ' + 试 + ' 次没抄到：' + (结果.说明 || 结果.原因) + '（再试一次）')
    await 浏.睡(2000)
  }

  const 出 = {
    阶段: 结果 && 结果.ok ? '抄到了' : '没抄到',
    端口: 启.端口,
    留窗: !关窗,
    列表: (结果 && 结果.列表) || [],
    appId: (结果 && 结果.appId) || '',
    appSecret: (结果 && 结果.appSecret) || '',
    说明: (结果 && (结果.说明 || 结果.原因)) || '',
    证据: 结果 || null
  }
  if (出.阶段 !== '抄到了') {
    // 抄不到时把「页面上还有什么能点的」全抓下来 —— 下一轮写「创建机器人」分支要靠它，
    // 不靠人回忆页面长什么样。
    try {
      const 现场 = await 抓现场(连)
      if (现场) { 出.按钮清单 = 现场.按钮清单; 出.页面正文 = 现场.页面正文 }
    } catch { /* 抓不到现场不影响主结论 */ }
  }
  设阶段(出.阶段, 出)

  if (出.阶段 === '抄到了') {
    打印('喜', 'AppID = ' + 出.appId + '｜AppSecret = ' + 出.appSecret)
  } else {
    打印('坏', '没抄到：' + 出.说明)
    console.log('\n--- 抄录现场（末尾 600 字）---\n' + String((结果 && 结果.正文尾巴) || ''))
  }

  if (关窗) { await 启.关闭(); 打印('注', '按要求关窗（会话 cookie 会丢，下次要重扫）') }
  else { 打印('注', '窗口留着不关——关了会话就丢，下次要重扫') }

  // 不关窗时别让 node 因为 stdin 挂着不退：明确退出（Edge 是独立进程，父进程退了它照样活）
  process.exit(出.阶段 === '抄到了' ? 0 : 4)
})().catch(e => {
  打印('坏', '一步装崩了：' + String(e && e.stack || e))
  落盘({ 阶段: '崩了', 原因: String(e && e.message || e) })
  process.exit(1)
})
