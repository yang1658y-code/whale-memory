#!/usr/bin/env node
'use strict'
/**
 * 主.js · 鲸鱼的 QQ 门房
 *
 * 用法：
 *   node 适配器/qq/主.js --dry            只验凭据 + 令牌 + 网关，收不到 READY 就退出码 1（不碰任何数据）
 *   node 适配器/qq/主.js --once           等第一条真实消息，处理完就退（调试用）
 *   node 适配器/qq/主.js --演练           常驻但不真发消息，只打日志（第一次上线建议先这么跑）
 *   node 适配器/qq/主.js                  常驻
 *   node 适配器/qq/主.js --回放 某事件.json  假事件回放，完全离线，用来验链路
 *   node 适配器/qq/主.js --配置 临时/某.json  换一份凭据文件（沙盘/验收/第二只机器人）
 *
 * 凭据从哪来：环境变量 QQ_BOT_APPID / QQ_BOT_SECRET，或 配置/qq.json（写进 .gitignore，绝不提交）
 * --配置 一旦指定，凭据与令牌缓存**一起**搬到那份配置旁边——否则第二只机器人会覆盖真机的 数据/qq令牌.json。
 *
 * 零依赖。
 */
const fs = require('fs')
const path = require('path')
const 凭据 = require('./凭据.js')
const 令牌 = require('./令牌.js')
const 网关 = require('./网关.js')
const 发送 = require('./发送.js')
const 桥 = require('./桥.js')
const 归一模块 = require('./归一.js')
const 攒话 = require('./攒话.js')
const 队列模块 = require('./队列.js')

const 参数 = process.argv.slice(2)
const 有 = (名) => 参数.includes('--' + 名)
const 取值 = (名) => { const i = 参数.indexOf('--' + 名); return i >= 0 && typeof 参数[i + 1] === 'string' && !String(参数[i + 1]).startsWith('--') ? 参数[i + 1] : null }

// ── --配置 <路径>：换一份凭据（沙盘/验收/多开）──────────────────────
// 不传 = 从前的行为，一个字节不变（配置/qq.json）。
// 传了就把三样东西一起隔离：凭据文件、令牌磁盘缓存、（横幅里标出来用的是哪份）
// ⚠️ 2026-11-02 的坑：老版本只认 配置/qq.json，于是「带 --配置 的 dry」
//    会拿真机凭据去验、然后报绿——最坏的一种假绿。
const 配置路径 = 取值('配置') ? path.resolve(取值('配置')) : null
function 凭据选项() {
  if (!配置路径) return {}
  return { 配置路径, 令牌缓存路径: path.join(path.dirname(配置路径), 'qq令牌.json') }
}

function 日志(级别, 内容) {
  const 时 = new Date().toLocaleString('zh-CN', { hour12: false })
  const 标 = { info: 'INFO', warn: 'WARN', error: 'ERR ', ok: ' OK ' }[级别] || 'INFO'
  console.log('[' + 时 + '] ' + 标 + ' ' + 内容)
}

function 横幅() {
  console.log('')
  console.log('  🐋 会记得你的鲸鱼 · QQ 适配器')
  console.log('  Node ' + process.version + ' · WebSocket: ' + ((网关.取WS实现() || {}).名字 || '无'))
  console.log('  凭据：' + (配置路径 ? (配置路径 + '（--配置 指定 · 不碰 配置/qq.json）') : '配置/qq.json（默认）'))
  console.log('')
}

/** 模型 key 报到（一眼看到钱从哪来，不靠猜） */
function 报模型(fn) {
  try {
    const 配 = 桥.读模型配置()
    const 尾 = 配.密钥 ? String(配.密钥).slice(0, 6) + '****' + String(配.密钥).slice(-4) : '（无）'
    fn(配.密钥 ? 'ok' : 'warn', '模型 ' + 配.模型 + ' · key ' + 尾 + ' · 来源：' + 配.密钥来源)
  } catch (e) {
    fn('warn', '模型配置读取失败：' + String((e && e.message) || e))
  }
}

/** 会话收尾：别把进程挂着，也别留半个连接 */
function 装收尾(清理fn) {
  let 已收 = false
  const 收 = (信号) => {
    if (已收) return
    已收 = true
    日志('warn', '收到 ' + 信号 + '，开始收尾')
    try { 清理fn && 清理fn() } catch {}
    setTimeout(() => process.exit(0), 300)
  }
  process.on('SIGINT', () => 收('SIGINT'))
  process.on('SIGTERM', () => 收('SIGTERM'))
}

// ── --dry：三层裸测 ───────────────────────────────────────────
async function 跑dry() {
  横幅()
  const 凭 = 凭据.取凭据(凭据选项())
  日志(凭.ok ? 'ok' : 'error', 凭据.摘要(凭))
  if (!凭.ok) { console.log('\n❌ 凭据不可用，后面不用测了。请填环境变量或 ' + (配置路径 || '配置/qq.json') + '\n'); return 1 }
  报模型(日志)

  日志('info', '正在换 access_token …')
  const t = await 令牌.取令牌(Object.assign({ 强制刷新: true }, 凭据选项()))
  if (!t.ok) { 日志('error', t.原因); return 1 }
  日志('ok', '令牌到手 · ' + String(t.access_token).slice(0, 6) + '****** · 有效期 ' + t.寿命秒 + ' 秒 · 接口 ' + t.接口)

  日志('info', '连网关，等 READY …')
  // ⚠️ 2026-11-02 实测炸出的坑：造网关时不递 凭据选项 → 网关内部取令牌会回退到默认
  //    数据/qq令牌.json（真机那只）→ READY 报的机器人不是本份配置里的，且串台报警也报不出来。
  const 通 = 网关.造网关(Object.assign({ 日志, 状态: () => {} }, 凭据选项()))
  装收尾(() => { try { 攒.关() } catch {} ; 通.关闭() })
  const 就绪 = await 通.启动({ 等就绪毫秒: 20000 })
  if (!就绪.ok) { 日志('error', '网关未就绪：' + 就绪.原因); 通.关闭(); return 1 }

  const 机 = 就绪.机器人 || {}
  日志('ok', 'READY · 机器人 ' + (机.username || 机.id || '未知') + ' · intents ' + (1 << 25) + ' · 会话 ' + String(就绪.就绪.session || '').slice(0, 8) + '…')
  日志('ok', '三层全部通过：凭据 → 令牌 → 网关。可以上线了（先跑 --演练 更稳）')
  通.关闭()
  await new Promise(r => setTimeout(r, 200))
  console.log('\n✅ dry 通过，退出码 0\n')
  return 0
}

// ── --回放：离线验链路 ────────────────────────────────────────
async function 跑回放(文件) {
  横幅()
  if (!文件 || !fs.existsSync(文件)) { 日志('error', '回放文件不存在：' + 文件); return 1 }
  let 数据 = null
  try { 数据 = JSON.parse(fs.readFileSync(文件, 'utf8')) } catch (e) { 日志('error', 'JSON 解析失败：' + e.message); return 1 }
  const 清单 = Array.isArray(数据) ? 数据 : [数据]
  日志('info', '回放 ' + 清单.length + ' 条假事件（不连 QQ，不真发消息）')
  let 全过 = true
  for (let i = 0; i < 清单.length; i++) {
    const 项 = 清单[i]
    const 事名 = 项.t || 项.事件 || 'GROUP_AT_MESSAGE_CREATE'
    const d = 项.d || 项
    const r = await 桥.处理事件(事名, d, Object.assign({ 日志, 只演练: true, 根目录: 项.根目录 }, 凭据选项()))
    日志(r.ok ? 'ok' : 'warn', '第 ' + (i + 1) + ' 条 → 会话 ' + (r.会话 || '-') + ' · 上下文 ' + (r.上下文轮数 || 0) + ' 轮 · 记忆 ' + (r.记忆数 || 0) + ' 条 · 回复「' + String(r.回复 || r.原因 || '').slice(0, 60) + '」')
    if (!r.ok && !r.跳过) 全过 = false
  }
  console.log(全过 ? '\n✅ 回放全过\n' : '\n⚠️ 有事件处理失败\n')
  return 全过 ? 0 : 1
}

// ── 常驻 / --once ────────────────────────────────────────────
async function 跑常驻(只到第一条) {
  横幅()
  const 凭 = 凭据.取凭据(凭据选项())
  日志(凭.ok ? 'ok' : 'error', 凭据.摘要(凭))
  if (!凭.ok) return 1
  报模型(日志)

  const 演练 = 有('演练')

  // ── 按会话分键的串行队列（实现在 队列.js，验收要验它，所以抽成模块）──
  const 队列 = 队列模块.造队列({ 日志 })

  // ── 入向攒话桶：连着说几句，算一轮 ──────────────────────────
  // 放行回调里不直接干活，而是丢进该会话的队列——
  // 上一轮还在生成时，这一轮必须等，否则同一个账本两轮并行写，轮次必乱。
  const 攒 = 攒话.造攒话桶({
    日志,
    放行: (会话, 条目们) => {
      队列.推(会话, async () => {
        // 凭据选项必须一起递下去：发消息那一步要用它取令牌，
        // 不递就会拿真机的 配置/qq.json 去发——第二只机器人回到真机身上去了。
        const r = await 桥.处理一轮(条目们.map((e) => e.归), Object.assign({ 日志, 只演练: 演练 }, 凭据选项()))
        日志(r.ok ? 'ok' : 'warn',
          '[' + (r.会话 || 会话) + '] '
          + (Number(r.本轮句数) > 1 ? '一轮 ' + r.本轮句数 + ' 句' : '一条')
          + ' · 上下文 ' + (r.上下文轮数 || 0) + ' 轮/' + (r.上下文条数 || 0) + ' 条' + (r.上下文截断 ? '(已截)' : '')
          + ' · 记忆 ' + (r.记忆数 || 0) + ' 条'
          + ' · 回复 ' + (r.段数 || 0) + ' 段'
          + (r.切段被并 ? '(超额已并)' : '') + (r.切段截断 ? '(已截断)' : '')
          + ' · 已发 ' + (r.已发 ? '是' : '否')
          + (r.跳过 ? ' · 跳过:' + r.原因 : ''))
        if (只到第一条 && !r.跳过) { 日志('info', '--once 已处理一条，退出'); 攒.关(); 通.关闭(); setTimeout(() => process.exit(0), 400) }
      })
    }
  })

  const 通 = 网关.造网关(Object.assign({
    日志,
    状态: (s) => { if (s.阶段 === '已就绪') 日志('info', '网关就绪（重连 ' + s.重连次数 + ' 次，事件 ' + s.事件数 + ' 条）') },
    事件: async (事名, d) => {
      if (事名 === 'READY' || 事名 === 'RESUMED') return
      // 先归一，只为拿到会话键（桶要按会话分，跨会话拼轮 = 把两个人缝成一句话）
      const 归 = 归一模块.归一(事名, d)
      if (!归) { 日志('info', '非对话类事件，跳过：' + 事名); return }
      if (!归.文本) { 日志('warn', '空文本（只有附件且被过滤），不入桶：' + 事名); return }
      const 收 = 攒.投递({ 会话: 归.会话, 文本: 归.文本, msgId: 归.msgId, 时间: 归.时间, 归 })
      if (!收.收下) 日志('warn', '未收下（' + (收.原因 || 收.丢弃 || '未知') + '）：' + 事名)
      else if (收.待静默毫秒) 日志('info', '入桶等静默 ' + 收.待静默毫秒 + 'ms（桶内 ' + 收.桶内句数 + ' 句 · ' + 归.会话 + '）')
    }
  }, 凭据选项()))

  装收尾(() => 通.关闭())
  const 就绪 = await 通.启动({})
  if (!就绪.ok) { 日志('error', '未就绪：' + 就绪.原因); 通.关闭(); return 1 }
  日志('ok', '鲸鱼已下水' + (演练 ? '（演练模式：只入库，不真发）' : '') + '，群里 @ 它试试')
  if (只到第一条) 日志('info', '等待第一条消息…（Ctrl+C 退出）')
  return new Promise(() => {})   // 常驻，靠 Ctrl+C 结束
}

// ── 入口 ─────────────────────────────────────────────────────
;(async () => {
  try {
    let 码 = 0
    if (有('dry')) 码 = await 跑dry()
    else if (取值('回放')) 码 = await 跑回放(取值('回放'))
    else 码 = await 跑常驻(有('once'))
    if (码 !== undefined && 码 !== null) process.exit(码)
  } catch (e) {
    日志('error', '启动失败：' + String((e && e.stack) || e))
    process.exit(1)
  }
})()
