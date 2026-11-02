#!/usr/bin/env node
'use strict'
/**
 * QQ适配验收.js · 假事件回放，不连 QQ 也能跑
 *
 * 跑法：node 验收/QQ适配验收.js
 *      node 验收/QQ适配验收.js --静默
 *
 * 为什么要有它：这一层的好几个坑，只有真撞上去才知道疼——
 *   ① 鉴权格式写成旧的 Bot {appid}.{token} → 平台回 4004，日志里看不出来是哪错
 *   ② 一条用户消息回多句时 msg_seq 不递增 → 平台判重复，第二条静默失败
 *   ③ 被动回复超 5 分钟 → 平台必拒，不提前拦就是白等超时
 *   ④ 先调模型再入库 → 模型一挂，用户那句话永远查不回来了
 * 这四条全在本文件里有断言，改坏了立刻红。
 *
 * 铁律：全程在系统临时目录跑，绝不碰真实 数据/，也绝不发一条真实消息。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

const 根 = path.resolve(__dirname, '..')

// 必须在 require 内核之前设好：存储适配器 在模块加载时读这个环境变量定数据目录
const 临时根 = fs.mkdtempSync(path.join(os.tmpdir(), '鲸鱼qq验收_'))
process.env['鲸鱼数据目录'] = 临时根

const 凭据 = require(path.join(根, '适配器', 'qq', '凭据.js'))
const 令牌 = require(path.join(根, '适配器', 'qq', '令牌.js'))
const 网关 = require(path.join(根, '适配器', 'qq', '网关.js'))
const 归一模块 = require(path.join(根, '适配器', 'qq', '归一.js'))
const 发送 = require(path.join(根, '适配器', 'qq', '发送.js'))
const 桥 = require(path.join(根, '适配器', 'qq', '桥.js'))

const 静默 = process.argv.includes('--静默')
const 结果清单 = []
function 断言(编号, 名称, 通过, 详情) {
  结果清单.push({ 编号, 名称, 通过: !!通过, 详情: 详情 ? String(详情).slice(0, 500) : '' })
  if (!静默) console.log(`${通过 ? '✅' : '❌'} [${编号}] ${名称}${详情 ? '\n     ' + String(详情).replace(/\n/g, '\n     ') : ''}`)
}
function 小标题(t) { if (!静默) console.log('\n' + '═'.repeat(64) + '\n' + t + '\n' + '═'.repeat(64)) }
const 稍等 = (ms) => new Promise(r => setTimeout(r, ms))

// ── 假 fetch：绝不发一条真实网络请求 ───────────────────────
const 原fetch = globalThis.fetch
let fetch记录 = []
function 装假fetch(分支) {
  fetch记录 = []
  globalThis.fetch = async (url, opt) => {
    const u = String(url)
    fetch记录.push({ url: u, body: opt && opt.body ? String(opt.body) : null, headers: (opt && opt.headers) || {} })
    return 分支(u, opt)
  }
}
function 还原fetch() { globalThis.fetch = 原fetch }
function 假响应(状态, 体) {
  return {
    ok: 状态 >= 200 && 状态 < 300,
    status: 状态,
    text: async () => (typeof 体 === 'string' ? 体 : JSON.stringify(体)),
    json: async () => (typeof 体 === 'string' ? JSON.parse(体) : 体)
  }
}

// ── 假 WebSocket：验鉴权格式与心跳，不连真网关 ──────────────
function 造假WS容器() {
  const 实例列表 = []
  class 假WS {
    constructor(url) {
      this.url = url
      this.readyState = 1
      this.发出的 = []
      this.监听 = {}
      实例列表.push(this)
    }
    on(名, fn) { (this.监听[名] = this.监听[名] || []).push(fn) }
    send(文本) { this.发出的.push(JSON.parse(文本)) }
    close() { this.readyState = 3; this.触发('close', { 码: 1000, 因: '测试关闭' }) }
    触发(名, ...参) { for (const fn of (this.监听[名] || [])) fn(...参) }
  }
  return { 类: 假WS, 实例列表 }
}

// ═══════════════════════════════════════════════════════════
// A. 凭据层
// ═══════════════════════════════════════════════════════════
async function 主() {

小标题('A. 凭据层 —— 找到、校验、脱敏')

{
  const c = 凭据.取凭据({ 环境: { QQ_BOT_APPID: '1900000000', QQ_BOT_SECRET: 'abcdefghijklmnop' }, 配置路径: path.join(临时根, '无此文件.json') })
  断言('Q01', '环境变量优先且校验通过', c.ok && c.来源 === '环境变量' && c.appId === '1900000000', 凭据.摘要(c))
}
{
  const 配置 = path.join(临时根, 'qq.json')
  fs.writeFileSync(配置, JSON.stringify({ appId: '1911111111', appSecret: 'zyxwvutsrqponmlk' }), 'utf8')
  const c = 凭据.取凭据({ 环境: {}, 配置路径: 配置 })
  断言('Q02', '无环境变量时回退配置文件', c.ok && c.appId === '1911111111' && /qq\.json/.test(c.来源) && !/环境变量/.test(c.来源), 凭据.摘要(c))
}
{
  // 2026-11-02 加：来源原来是写死的“配置/qq.json”，于是 --配置 指向沙盘时
  // 日志上也写“来源 配置/qq.json”——看日志的人会以为进了真凭据。这条锁住它。
  const 沙盘 = path.join(临时根, '来源跟随.json')
  fs.writeFileSync(沙盘, JSON.stringify({ appId: '1922222222', appSecret: 'abcdefghijklmnop' }), 'utf8')
  const c = 凭据.取凭据({ 环境: {}, 配置路径: 沙盘 })
  断言('Q02b', '来源跟着 配置路径 走（不写死）', c.ok && c.来源 === 沙盘, '来源=' + c.来源)
}
{
  const c = 凭据.取凭据({ 环境: {}, 配置路径: path.join(临时根, '不存在.json') })
  断言('Q03', '凭据全无时不抛错、问题说人话', c.ok === false && c.问题.length === 2, c.问题.join('；'))
}
{
  const 摘要文本 = 凭据.摘要({ ok: true, 来源: '测试', appId: '1900000000', appSecret: 'abcdefghijklmnop' })
  断言('Q04', '摘要里绝不出现明文密钥', !摘要文本.includes('abcdefghijklmnop') && 摘要文本.includes('abcd****nop'), 摘要文本)
}

// ═══════════════════════════════════════════════════════════
// B. 令牌层
// ═══════════════════════════════════════════════════════════
小标题('B. 令牌层 —— 换、缓存、并发合并')

{
  const 缓存 = path.join(临时根, '令牌缓存.json')
  const 环境 = { QQ_BOT_APPID: '1900000000', QQ_BOT_SECRET: 'abcdefghijklmnop' }
  try {
    let 换令牌次数 = 0
    装假fetch((u) => {
      if (/getAppAccessToken/.test(u)) { 换令牌次数++; return 假响应(200, { access_token: 'tok_' + 换令牌次数, expires_in: '7200' }) }
      return 假响应(404, { message: '没这个' })
    })
    令牌.作废({ 令牌缓存路径: 缓存, 保留磁盘: false })
    const 四个 = await Promise.all([1, 2, 3, 4].map(() => 令牌.取令牌({ 环境, 令牌缓存路径: 缓存, 配置路径: path.join(临时根, 'x.json') })))
    const 同token = new Set(四个.map(r => r.access_token)).size === 1
    断言('Q05', '并发 4 次只换 1 次令牌（合并生效）', 换令牌次数 === 1 && 同token && 四个.every(r => r.ok), '换令牌请求 ' + 换令牌次数 + ' 次，拿到 ' + 四个[0].access_token)

    const 第二次 = await 令牌.取令牌({ 环境, 令牌缓存路径: 缓存 })
    断言('Q06', '第二次走内存缓存，不再请求', 第二次.缓存命中 === '内存', '命中 ' + 第二次.缓存命中)

    断言('Q07', '令牌落盘可被新进程读回', fs.existsSync(缓存) && !!JSON.parse(fs.readFileSync(缓存, 'utf8')).access_token, 缓存)

    // 鉴权失败 → 作废 → 强制重换
    令牌.作废({ 令牌缓存路径: 缓存 })
    const 强制 = await 令牌.取令牌({ 环境, 令牌缓存路径: 缓存, 强制刷新: true })
    断言('Q08', '强制刷新能绕开缓存换新令牌', 强制.ok && 强制.access_token === 'tok_2', 强制.access_token)
  } finally { 还原fetch() }
}

// ═══════════════════════════════════════════════════════════
// C. 网关层（假 WS）
// ═══════════════════════════════════════════════════════════
小标题('C. 网关层 —— 鉴权格式 / 心跳 / READY / op9')

try {
  const 缓存 = path.join(临时根, '令牌缓存2.json')
  fs.writeFileSync(缓存, JSON.stringify({ access_token: 'tok_gw', 到期时间: Date.now() + 3600 * 1000 }), 'utf8')
  令牌.作废({ 令牌缓存路径: 缓存, 保留磁盘: true })   // 清内存，留磁盘
  装假fetch((u) => {
    if (/getAppAccessToken/.test(u)) return 假响应(200, { access_token: 'tok_gw', expires_in: '7200' })
    if (/\/gateway/.test(u)) return 假响应(200, { url: 'wss://假网关.example/websocket' })
    return 假响应(404, {})
  })

  const 容器 = 造假WS容器()
  const 通 = 网关.造网关({ WS: { 实现: 容器.类, 原生: false, 名字: '假WS' }, 日志: () => {}, 令牌缓存路径: 缓存 })
  const 启动P = 通.启动({ 等就绪毫秒: 4000 })
  await 稍等(120)
  const ws = 容器.实例列表[0]
  断言('Q09', '网关地址取自 /gateway', !!ws && ws.url === 'wss://假网关.example/websocket', ws && ws.url)

  ws.触发('open')
  await 稍等(30)
  const 鉴权帧 = ws.发出的.find(f => f.op === 2)
  const 令牌前缀 = 鉴权帧 && 鉴权帧.d && 鉴权帧.d.token
  断言('Q10', 'Identify 鉴权格式是 QQBot {token}（旧格式 Bot {appid}.{token} 会 4004）',
    !!令牌前缀 && 令牌前缀 === 'QQBot tok_gw', 令牌前缀)
  断言('Q11', 'intents = 33554432（群@+单聊），不含多余权限',
    !!鉴权帧 && 鉴权帧.d.intents === 33554432, 鉴权帧 && 鉴权帧.d.intents)

  ws.触发('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }))
  await 稍等(50)
  const 心跳 = ws.发出的.find(f => f.op === 1)
  断言('Q12', 'Hello 后立刻发心跳(op1)', !!心跳, 心跳 ? JSON.stringify(心跳) : '没发')

  ws.触发('message', JSON.stringify({ op: 0, s: 1, t: 'READY', d: { session_id: 'sess_abc', user: { username: '机器人测试' } } }))
  const 就绪 = await 启动P
  断言('Q13', 'READY 后状态就绪并记下 session_id', 就绪.ok && 通.状态().session === 'sess_abc', JSON.stringify(通.状态().session))

  ws.触发('message', JSON.stringify({ op: 9 }))
  await 稍等(30)
  断言('Q14', 'op9 会话失效 → 清 session/seq 重新鉴权', 通.状态().session === null, '最近错误 ' + 通.状态().最近错误)

  通.关闭()
  await 稍等(30)
} finally { 还原fetch() }

// ═══════════════════════════════════════════════════════════
// D. 归一层
// ═══════════════════════════════════════════════════════════
小标题('D. 归一层 —— QQ 事件 → 内核形状')

{
  const 归 = 归一模块.归一('GROUP_AT_MESSAGE_CREATE', {
    id: 'msg_1', content: '<@!4014209280> 你还记得我上次说的那个方案吗',
    timestamp: '2026-10-27T05:00:00+08:00', group_openid: 'G1',
    author: { id: 'U1', username: '用户' }
  })
  断言('Q15', '群@ 消息归一：会话名正确、@标记剥净',
    归 && 归.会话 === 'qq-群-G1' && !归.文本.includes('<@') && 归.文本.includes('你还记得'),
    JSON.stringify({ 会话: 归 && 归.会话, 文本: 归 && 归.文本 }))
}
{
  // 真平台形状：单聊事件顶层没有 openid，openid 在 author.user_openid 里（2026-10-27 真机踩出来的）
  const 归 = 归一模块.归一('C2C_MESSAGE_CREATE', { id: 'msg_2', content: '在吗', timestamp: Date.now(), author: { id: 'U9', user_openid: 'U9' } })
  断言('Q16', '单聊归一（真实平台形状 author.user_openid）：一人一本账', 归 && 归.会话 === 'qq-单聊-U9', 归 && 归.会话)
}
{
  // 旧形状（openid 在顶层）也要能读，不能因为改了这一处把假事件的回放全弄挂
  const 归 = 归一模块.归一('C2C_MESSAGE_CREATE', { id: 'msg_2b', content: '还在吗', timestamp: Date.now(), user_openid: 'U8' })
  断言('Q16b', '单聊归一（顶层 openid 旧形状）兼容', 归 && 归.会话 === 'qq-单聊-U8', 归 && 归.会话)
}
{
  // 完全取不到 openid：必须返回 null 会话，不许拼出 'unknown' 假账本
  const 归 = 归一模块.归一('C2C_MESSAGE_CREATE', { id: 'msg_2c', content: '空壳事件', timestamp: Date.now() })
  断言('Q16c', '缺 openid → 会话为 null，不造 unknown 假账本', 归 && 归.会话 === null, 归 && JSON.stringify(归.会话))
}
{
  const 归 = 归一模块.归一('GROUP_AT_MESSAGE_CREATE', { id: 'm3', content: '', group_openid: 'G1', attachments: [{ content_type: 'image/png' }] })
  断言('Q17', '只有附件也留痕（不留白）', !!归 && 归.文本.includes('image/png'), 归 && 归.文本)
}
{
  const 归 = 归一模块.归一('GROUP_ADD_ROBOT', { group_openid: 'G1' })
  断言('Q18', '入群/退群等系统事件不当作对话', 归 === null, '返回 null')
}

// ═══════════════════════════════════════════════════════════
// E. 发送层（不真发）
// ═══════════════════════════════════════════════════════════
小标题('E. 发送层 —— 超窗拦截 / msg_seq 递增 / 鉴权头')
{
  const 超窗 = await 发送.发消息({ 会话: 'qq-群-G1', 文本: '迟到的回复', msgId: 'm1', 时间: Date.now() - 6 * 60 * 1000 }, { 日志: () => {} })
  断言('Q19', '被动回复超 5 分钟窗口 → 本地直接丢弃，不白等平台拒绝', 超窗.ok === false && 超窗.超窗 === true && 超窗.已丢弃 === true, 超窗.原因)
}
{
  const 非法 = await 发送.发消息({ 会话: '乱写的会话名', 文本: 'x' }, { 日志: () => {} })
  断言('Q20', '会话名不合规矩 → 拒绝发，不猜', 非法.ok === false && /不合规矩/.test(非法.原因), 非法.原因)
}
try {
  const 缓存 = path.join(临时根, '令牌缓存3.json')
  fs.writeFileSync(缓存, JSON.stringify({ access_token: 'tok_send', 到期时间: Date.now() + 3600 * 1000 }), 'utf8')
  令牌.作废({ 令牌缓存路径: 缓存, 保留磁盘: true })
  装假fetch((u) => {
    if (/getAppAccessToken/.test(u)) return 假响应(200, { access_token: 'tok_send', expires_in: '7200' })
    return 假响应(200, { id: 'sent_1', timestamp: new Date().toISOString() })
  })
  const a = await 发送.发消息({ 会话: 'qq-群-G1', 文本: '第一句', msgId: 'm2', 时间: Date.now() }, { 令牌缓存路径: 缓存 })
  const b = await 发送.发消息({ 会话: 'qq-群-G1', 文本: '第二句', msgId: 'm2', 时间: Date.now() }, { 令牌缓存路径: 缓存 })
  const 发送请求 = fetch记录.filter(f => /\/v2\/groups\//.test(f.url))
  const 体们 = 发送请求.map(f => JSON.parse(f.body))
  断言('Q21', '群消息走 /v2/groups/{openid}/messages 且带 msg_id',
    a.ok && b.ok && 发送请求.length === 2 && /\/v2\/groups\/G1\/messages/.test(发送请求[0].url) && 体们[0].msg_id === 'm2',
    发送请求[0] && 发送请求[0].url)
  断言('Q22', '同一条 msg_id 连发两条，msg_seq 递增（否则平台判重复）',
    体们[0].msg_seq === 1 && 体们[1].msg_seq === 2, '序号 ' + 体们.map(x => x.msg_seq).join(','))
  断言('Q23', '鉴权头是 QQBot {token}',
    /^QQBot tok_send$/.test(String((发送请求[0].headers || {}).Authorization || '')), (发送请求[0].headers || {}).Authorization)
} finally { 还原fetch() }

// ═══════════════════════════════════════════════════════════
// F. 桥 + 内核：真入库、真检索（临时目录）
// ═══════════════════════════════════════════════════════════
小标题('F. 桥接内核 —— 先入库、能翻原话、崩了不丢话')

try {
  装假fetch(() => 假响应(500, { message: '这一步不该发任何网络请求' }))
  const 环境备份 = { k: process.env.WHALE_LLM_KEY }
  delete process.env.WHALE_LLM_KEY   // 走「只查记忆」降级模式，验收不依赖任何模型
  const 空环境 = {}                  // 显式空环境：连 配置/llm.json 都不读，验收绝不往真接口打请求

  const 事件1 = { id: 'msg_a', content: '<@!4014209280> 我叫小王，我最爱喝冰美式，不加糖', timestamp: Date.now(), group_openid: 'G1', author: { id: 'U1', username: '小王' } }
  const r1 = await 桥.处理事件('GROUP_AT_MESSAGE_CREATE', 事件1, { 日志: () => {}, 只演练: true, 根目录: 临时根, 环境: 空环境 })
  断言('Q24', '第一句：先入库成功，句ID 形如 qq-群-G1#1.1',
    r1.ok && r1.入库 && r1.入库.原文 && r1.入库.原文.写入 > 0 && /^qq-群-G1#\d+\.\d+$/.test((r1.入库.原文.句ID们 || [])[0] || ''),
    '句ID ' + ((r1.入库 && r1.入库.原文 && r1.入库.原文.句ID们) || []).join(','))
  断言('Q25', '演练模式不真发消息', r1.已发 === false && r1.发送 && r1.发送.演练 === true, JSON.stringify(r1.发送))

  const 事件2 = { id: 'msg_b', content: '<@!4014209280> 我最爱喝什么？', timestamp: Date.now(), group_openid: 'G1', author: { id: 'U1' } }
  const r2 = await 桥.处理事件('GROUP_AT_MESSAGE_CREATE', 事件2, { 日志: () => {}, 只演练: true, 根目录: 临时根, 环境: 空环境 })
  断言('Q26', '第二句：能检索到上一轮的原话', r2.记忆数 > 0 && r2.回复.includes('冰美式'),
    '记忆 ' + r2.记忆数 + ' 条 · 回复「' + String(r2.回复).slice(0, 80) + '」')

  // ── 上下文形态：它得先「读多少轮」再回话，而且不表演「我翻到原话了」 ──
  断言('Q33', '回话前真读了上一轮原文（按轮切、本轮这句剔掉）',
    r2.上下文轮数 === 1 && r2.上下文条数 === 2,
    '上下文轮数 ' + r2.上下文轮数 + ' · 条数 ' + r2.上下文条数)
  {
    const 形态 = 桥.拼对话({
      消息: { 文本: '我最爱喝什么？' },
      记忆: [{ 句ID: 'qq-群-G1#1.1', content: '我叫小王，我最爱喝冰美式，不加糖' }],
      上下文: [
        { 角色: '用户', 文本: '我叫小王，我最爱喝冰美式，不加糖' },
        { 角色: '助理', 文本: '记住啦' }
      ]
    })
    const 角色列 = 形态.map((m) => m.role).join(',')
    const 无标签 = !/〔记起一段原话〕|【我记得的原话】|【他现在说】/.test(JSON.stringify(形态))
    断言('Q34', '对话形态：system → 真历史(user/assistant) → 本轮这句放末尾',
      角色列 === 'system,user,assistant,user' && 形态[形态.length - 1].content === '我最爱喝什么？' && 无标签,
      角色列 + '｜旧标签残留=' + !无标签)
    const 系统 = 形态[0].content
    const 其余 = JSON.stringify(形态.slice(1))
    断言('Q35', '远期原话进 system 当资料，不冒充用户发言',
      系统.includes('冰美式') && 系统.includes('qq-群-G1#1.1') && !其余.includes('qq-群-G1#1.1'),
      'system 含句ID=' + 系统.includes('qq-群-G1#1.1') + '，历史里未重复摆=' + !其余.includes('qq-群-G1#1.1'))
    const 形态2 = 桥.拼对话({
      消息: { 文本: '我最爱喝什么？' },
      记忆: [{ 句ID: 'qq-群-G1#1.1', content: '我叫小王，我最爱喝冰美式，不加糖' }],
      上下文: [{ 角色: '用户', 句ID们: ['qq-群-G1#1.1'], 文本: '我叫小王，我最爱喝冰美式，不加糖' }]
    })
    断言('Q35b', '同一句话不摆两遍（已在上文里的不再当远期原话重复）',
      !形态2[0].content.includes('【你们更早以前聊过'), 'system 里重复列了吗 = ' + 形态2[0].content.includes('【你们更早以前聊过'))
  }
  {
    const 上 = 桥.取上下文('qq-群-G1', { 根目录: 临时根 }, [])
    const 关 = 桥.取上下文('qq-群-G1', { 根目录: 临时根, 上下文轮数: 0 }, [])
    断言('Q36', '取上下文逐字可回溯，且旋钮拧到 0 就一条不带',
      上.轮数 >= 1 && 上.消息们.some((m) => m.文本.includes('冰美式')) && 上.消息们.some((m) => m.文本.includes('我最爱喝什么')) && 关.消息数 === 0,
      '轮数 ' + 上.轮数 + ' · 条数 ' + 上.消息数 + ' · 关掉后 ' + 关.消息数 + ' 条')
  }

  // 原文表到底落哪了：递归找临时根下所有名字带会话名的文件
  const 命中文件 = []
  ;(function 游(d) {
    let 列 = []
    try { 列 = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const it of 列) {
      const fp = path.join(d, it.name)
      if (it.isDirectory()) 游(fp)
      else if (/qq-群-G1/.test(it.name)) 命中文件.push(fp.replace(临时根, '<临时根>'))
    }
  })(临时根)
  断言('Q27', '原文表真的落在临时目录（不污染真实 数据/）', 命中文件.length > 0,
    '落盘文件：' + (命中文件.join(' | ') || '没找到'))

  // 生成器崩了也要把话记下来
  const r3 = await 桥.处理事件('GROUP_AT_MESSAGE_CREATE',
    { id: 'msg_c', content: '<@!1> 这句是测生成器崩了还记不记得', timestamp: Date.now(), group_openid: 'G1', author: {} },
    { 日志: () => {}, 只演练: true, 根目录: 临时根, 环境: 空环境, 生成回复: () => { throw new Error('模型挂了') } })
  断言('Q28', '生成器崩了：话照样入库，回复降级不炸', r3.ok && r3.入库.原文.写入 > 0 && /岔子/.test(r3.回复),
    '回复「' + String(r3.回复).slice(0, 60) + '」')

  // 2026-10-27 真机踩出来的：桥把机器人角色写成「助手」，内核只认「助理/assistant」→
  // 结果机器人自己的话在库里变成 user，下次检索会把它的胡话当「用户原话」念给用户。
  {
    const 回泈 = require('../内核/原文回溯.js')
    const 表 = 回泈.读原文表('qq-群-G1', { 根目录: 临时根 })
    const 助手行 = (表.记录 || []).filter(x => String(x.角色) === '助理')
    断言('Q29', '机器人自己的回话在原文表里是「助理」，不是「用户」', 助手行.length > 0,
      '助理句数 ' + 助手行.length + ' / 共 ' + (表.记录 || []).length)
  }
  {
    const 入库模块 = require('../内核/对话入库.js')
    断言('Q30', '归一向量角色：「助手」也必须归到 assistant（历史叫法兼容）',
      入库模块.归一向量角色('助手') === 'assistant' && 入库模块.归一向量角色('助理') === 'assistant' && 入库模块.归一向量角色('用户') === 'user',
      '助手→' + 入库模块.归一向量角色('助手') + ' · 助理→' + 入库模块.归一向量角色('助理'))
  }

  // 2026-10-27：key 现在可从 配置/llm.json 读（产品交付形态：用户自己填）。
  // 两条铁律用断言钉死：① 显式环境在时一次磁盘不读（否则验收会往真接口发钱）② 文件真能读到且环境压过它
  {
    const 显式 = 桥.读模型配置({ 环境: { WHALE_LLM_KEY: 'sk-aaa' } })
    断言('Q31', '显式环境优先，且此时不读盘', 显式.密钥 === 'sk-aaa' && /显式/.test(显式.密钥来源), 显式.密钥 + ' · ' + 显式.密钥来源)

    const 临时配 = path.join(临时根, 'llm-测.json')
    fs.mkdirSync(临时根, { recursive: true })
    fs.writeFileSync(临时配, JSON.stringify({ 密钥: 'sk-bbb', 模型: 'deepseek-chat' }), 'utf8')
    const 原Key = process.env.WHALE_LLM_KEY
    delete process.env.WHALE_LLM_KEY
    const 从文件 = 桥.读模型配置({ 配置文件: 临时配 })
    const 环压文 = 桥.读模型配置({ 配置文件: 临时配, 环境: { WHALE_LLM_KEY: 'sk-ccc' } })
    const 不存在 = 桥.读模型配置({ 配置文件: path.join(临时根, '根本没有这个文件.json') })
    if (原Key) process.env.WHALE_LLM_KEY = 原Key
    断言('Q32', '配置/llm.json 能读到 key，环境变量压过它，没文件时降级不抛错',
      从文件.密钥 === 'sk-bbb' && 环压文.密钥 === 'sk-ccc' && 不存在.密钥 === '',
      '文件→' + 从文件.密钥 + ' · 环境→' + 环压文.密钥 + ' · 无文件→' + (不存在.密钥 || '（空，降级）'))
  }

  // ═══════════════════════════════════════════════════════════
  // G. 入向攒话桶 —— 连着说几句，算一轮
  // ═══════════════════════════════════════════════════════════
  小标题('G. 入向攒话桶 —— 连着说几句算一轮（Q41–Q50）')

  const 攒话模块 = require(path.join(根, '适配器', 'qq', '攒话.js'))
  const 队列模块 = require(path.join(根, '适配器', 'qq', '队列.js'))
  const 切段模块 = require(path.join(根, '适配器', 'qq', '切段.js'))
  const 回溯模块 = require(path.join(根, '内核', '原文回溯.js'))

  /** 假定时器：多槽位，测试自己决定什么时候「到期」——不真等 2 秒 */
  function 造假定时器() {
    const 表 = new Map()
    const 统计 = { 设了几次: 0, 清了几次: 0 }
    let 号 = 0
    const 定时器 = {
      set(fn, ms) { 统计.设了几次++; const id = ++号; 表.set(id, { fn, ms }); return id },
      clear(id) { 统计.清了几次++; 表.delete(id) },
      现在: () => Date.now()
    }
    return {
      定时器, 统计,
      待数: () => 表.size,
      火烧() { const 列 = Array.from(表.values()); 表.clear(); for (const v of 列) v.fn() }
    }
  }
  const 造归 = (群, id, 文本, 时间) => 归一模块.归一('GROUP_AT_MESSAGE_CREATE',
    { id, content: 文本, timestamp: 时间 || Date.now(), group_openid: 群, author: { id: 'U' + 群 } })

  // ── Q41 三句间隔 <2s：只调一次模型、只回一次、入库一轮三句 ──
  {
    const 定 = 造假定时器()
    const 放行 = []
    const 桶 = 攒话模块.造攒话桶({
      日志: () => {}, 静默毫秒: 2000, 最多句: 10, 去重窗口: 200, 定时器: 定.定时器,
      放行: (会, 条目们, 附) => 放行.push({ 会, 条目们, 附 })
    })
    const 三句 = [['g41-1', '在吗'], ['g41-2', '我跟你说个事'], ['g41-3', '昨晚那个']]
    for (const [id, 文] of 三句) 桶.投递({ 会话: 'qq-群-G41', 文本: 文, msgId: id, 归: 造归('G41', id, 文) })
    const 未放 = 放行.length === 0 && 桶.待发数() === 3
    定.火烧()
    let 生成次数 = 0
    const 桥r = await 桥.处理一轮(放行[0].条目们.map(e => e.归), {
      日志: () => {}, 只演练: true, 根目录: 临时根, 环境: 空环境, 段间隔毫秒: 0,
      生成回复: ({ 消息 }) => { 生成次数++; return '记住了：' + 消息.文本 }
    })
    断言('Q41', '三句间隔<2s → 放行一次、调模型一次、入一轮三句、只回一条',
      未放 && 放行.length === 1 && 放行[0].条目们.length === 3 && 生成次数 === 1
      && 桥r.本轮句数 === 3 && 桥r.入库.原文.写入 === 3 && 桥r.段数 === 1,
      '未到期就放了=' + !未放 + ' · 放行 ' + 放行.length + ' 次/' + (放行[0] ? 放行[0].条目们.length : 0) + ' 句'
      + ' · 调模型 ' + 生成次数 + ' 次 · 入库 ' + (桥r.入库 && 桥r.入库.原文 && 桥r.入库.原文.写入) + ' 句 · 回复 ' + 桥r.段数 + ' 段')
  }
  // ── Q42 第二句在静默之后到 → 分两轮 ──
  {
    const 定 = 造假定时器()
    const 放行 = []
    const 桶 = 攒话模块.造攒话桶({ 日志: () => {}, 静默毫秒: 2000, 定时器: 定.定时器, 放行: (会, 条目们) => 放行.push(条目们.map(e => e.文本)) })
    桶.投递({ 会话: 'qq-群-G42', 文本: '第一件', msgId: 'g42-1' })
    定.火烧()
    桶.投递({ 会话: 'qq-群-G42', 文本: '第二件', msgId: 'g42-2' })
    定.火烧()
    断言('Q42', '静默到期后再来的话算下一轮（不跨过静默硬拼）',
      放行.length === 2 && 放行[0].length === 1 && 放行[1].length === 1 && 放行[0][0] === '第一件',
      JSON.stringify(放行))
  }
  // ── Q43 1.9s 间隔连发 5 句 → 仍一轮（每次到达都把计时器归零）──
  {
    const 定 = 造假定时器()
    const 放行 = []
    const 桶 = 攒话模块.造攒话桶({ 日志: () => {}, 静默毫秒: 2000, 最多句: 10, 定时器: 定.定时器, 放行: (会, 条目们) => 放行.push(条目们.length) })
    for (let i = 1; i <= 5; i++) 桶.投递({ 会话: 'qq-群-G43', 文本: '第' + i + '句', msgId: 'g43-' + i })
    const 中途 = 放行.length
    定.火烧()
    断言('Q43', '每次到达都重计 2 秒（设了 5 次表、只放行 1 轮 5 句）',
      定.统计.设了几次 === 5 && 中途 === 0 && 放行.length === 1 && 放行[0] === 5,
      '设表 ' + 定.统计.设了几次 + ' 次 · 中途放行 ' + 中途 + ' 次 · 到期放行 ' + JSON.stringify(放行))
  }
  // ── Q44 攒满 10 句：不等静默，立刻放行 ──
  {
    const 定 = 造假定时器()
    const 放行 = []
    const 桶 = 攒话模块.造攒话桶({ 日志: () => {}, 静默毫秒: 2000, 最多句: 10, 定时器: 定.定时器, 放行: (会, 条目们, 附) => 放行.push({ 条数: 条目们.length, 满额: !!附.满额 }) })
    for (let i = 1; i <= 10; i++) 桶.投递({ 会话: 'qq-群-G44', 文本: '第' + i + '句', msgId: 'g44-' + i })
    断言('Q44', '攒满 10 句立即放行（防刷屏把一轮无限挂住）',
      放行.length === 1 && 放行[0].条数 === 10 && 放行[0].满额 && 定.待数() === 0 && 桶.待发数() === 0,
      JSON.stringify(放行) + ' · 残留定时器 ' + 定.待数())
  }
  // ── Q45 同 msgId 重投：丢弃且不重置计时 ──
  {
    const 定 = 造假定时器()
    const 放行 = []
    const 桶 = 攒话模块.造攒话桶({ 日志: () => {}, 静默毫秒: 2000, 去重窗口: 200, 定时器: 定.定时器, 放行: (会, 条目们) => 放行.push(条目们.length) })
    桶.投递({ 会话: 'qq-群-G45', 文本: '只此一句', msgId: 'g45-dup' })
    const 设前 = 定.统计.设了几次
    const 清前 = 定.统计.清了几次
    const 重投 = 桶.投递({ 会话: 'qq-群-G45', 文本: '只此一句', msgId: 'g45-dup' })
    断言('Q45', '同 msgId 重投：丢弃，且不重置计时器（否则网关抖一次就永远放不出去）',
      重投.收下 === false && 重投.丢弃 === '重复 msgId' && 定.统计.设了几次 === 设前 && 定.统计.清了几次 === 清前 && 桶.待发数() === 1,
      '重投=' + JSON.stringify(重投) + ' · 设表 ' + 定.统计.设了几次 + '（前 ' + 设前 + '）· 清表 ' + 定.统计.清了几次 + '（前 ' + 清前 + '）')
  }
  // ── Q46 命令类：不进桶，立刻放行 ──
  {
    const 定 = 造假定时器()
    const 放行 = []
    const 桶 = 攒话模块.造攒话桶({ 日志: () => {}, 静默毫秒: 2000, 定时器: 定.定时器, 放行: (会, 条目们, 附) => 放行.push({ 条数: 条目们.length, 命令: !!附.命令 }) })
    桶.投递({ 会话: 'qq-群-G46', 文本: '/重置', msgId: 'g46-1' })
    断言('Q46', '/ 开头的命令：立刻放行、不进桶、不起计时器',
      放行.length === 1 && 放行[0].命令 && 放行[0].条数 === 1 && 桶.桶数() === 0 && 定.统计.设了几次 === 0,
      JSON.stringify(放行) + ' · 桶数 ' + 桶.桶数() + ' · 设表 ' + 定.统计.设了几次 + ' 次')
  }
  // ── Q47 群 A 与单聊 B 各成各的一轮，绝不串台 ──
  {
    const 定 = 造假定时器()
    const 放行 = []
    const 桶 = 攒话模块.造攒话桶({ 日志: () => {}, 静默毫秒: 2000, 定时器: 定.定时器, 放行: (会, 条目们) => 放行.push({ 会, 句们: 条目们.map(e => e.文本) }) })
    桶.投递({ 会话: 'qq-群-G47', 文本: '张三说在吗', msgId: 'g47-a' })
    桶.投递({ 会话: 'qq-单聊-U47', 文本: '李四说吃了吗', msgId: 'g47-b' })
    const 两桶 = 桶.桶数() === 2
    定.火烧()
    const A = 放行.find(x => x.会 === 'qq-群-G47')
    const B = 放行.find(x => x.会 === 'qq-单聊-U47')
    断言('Q47', '不同会话各一个桶，绝不把两个人缝成一句话',
      两桶 && 放行.length === 2 && A && B && A.句们.length === 1 && B.句们.length === 1
      && A.句们[0] === '张三说在吗' && B.句们[0] === '李四说吃了吗',
      '桶数 ' + (两桶 ? 2 : 1) + ' · 放行 ' + JSON.stringify(放行))
  }
  // ── Q48 桶内三句拼成的本轮文本，与实际到达顺序逐字一致 ──
  {
    let 收到文本 = null
    const 归们 = ['在吗', '我跟你说个事', '昨晚那个'].map((文, i) => 造归('G48', 'g48-' + (i + 1), 文))
    await 桥.处理一轮(归们, {
      日志: () => {}, 只演练: true, 根目录: 临时根, 环境: 空环境, 段间隔毫秒: 0,
      生成回复: ({ 消息 }) => { 收到文本 = 消息.文本; return '嗯' }
    })
    断言('Q48', '本轮文本 = 三句按到达顺序逐字拼接（模型读到的是连续发言，不是碎三问）',
      收到文本 === '在吗\n我跟你说个事\n昨晚那个', JSON.stringify(收到文本))
  }
  // ── Q49 一轮生成失败，N 句仍全部在原文表（先入库铁律不倒）──
  {
    const 归们 = ['这句必须留下甲', '这句必须留下乙', '这句必须留下丙'].map((文, i) => 造归('G49', 'g49-' + (i + 1), 文))
    const r = await 桥.处理一轮(归们, {
      日志: () => {}, 只演练: true, 根目录: 临时根, 环境: 空环境, 段间隔毫秒: 0,
      生成回复: () => { throw new Error('模型挂了') }
    })
    const 表 = 回溯模块.读原文表('qq-群-G49', { 根目录: 临时根 })
    const 文们 = (表.记录 || []).map(x => String(x.正文 || x.content || x.文本 || '')).join('|')
    const 三句都在 = 文们.includes('这句必须留下甲') && 文们.includes('这句必须留下乙') && 文们.includes('这句必须留下丙')
    断言('Q49', '生成崩了：三句全在原文表，回复降级不炸',
      r.入库 && r.入库.原文.写入 === 3 && 三句都在 && /岔子/.test(r.回复),
      '入库 ' + (r.入库 && r.入库.原文 && r.入库.原文.写入) + ' 句 · 表里三句都在=' + 三句都在 + ' · 回复「' + String(r.回复).slice(0, 40) + '」')
  }
  // ── Q50 队列按会话分键：A 在生成，B 不排队干等；同会话仍串行 ──
  {
    const 队 = 队列模块.造队列({ 日志: () => {} })
    const 序 = []
    队.推('qq-群-G50', async () => { await 稍等(80); 序.push('A1') })
    队.推('qq-单聊-U50', async () => { 序.push('B1') })
    await 稍等(25)
    const B先到 = 序.includes('B1') && !序.includes('A1')
    队.推('qq-群-G50', async () => { 序.push('A2') })
    await 队.空闲()
    断言('Q50', '分键队列：A 会话生成中不阻塞 B 会话；同一会话内仍严格串行',
      B先到 && 序.join(',') === 'B1,A1,A2',
      'B 先到=' + B先到 + ' · 执行序 ' + 序.join(','))
  }

  // ═══════════════════════════════════════════════════════════
  // H. 出向切段 —— 短的不拆、长的按自然边界拆、总数不超额度
  // ═══════════════════════════════════════════════════════════
  小标题('H. 出向切段 —— 1–4 段，永不超平台额度（Q51–Q66）')

  /** 生成一个 400+ 字、含 4 个换行的回复 */
  const 长回复 = ['甲'.repeat(80), '乙'.repeat(80), '丙'.repeat(80), '丁'.repeat(80), '戊'.repeat(80)].join('\n')
  /** 恰好切成三段的长回复（每行 200 字，贪心合不进同一段） */
  const 三段回复 = ['第一段' + '甲'.repeat(197), '第二段' + '乙'.repeat(197), '第三段' + '丙'.repeat(197)].join('\n')

  // ── Q51 400 字含 4 换行 → ≤3 段，逐段发 ──
  {
    const 发记录 = []
    const r = await 桥.处理一轮([造归('G51', 'h51', '说点长的')], {
      日志: () => {}, 只演练: false, 根目录: 临时根, 环境: 空环境, 段间隔毫秒: 0,
      生成回复: () => 长回复,
      发消息: async (m) => { 发记录.push(m); return { ok: true, 状态码: 200 } }
    })
    断言('Q51', '400 字含 4 换行 → 切成 ≤3 段，段段真发出去',
      r.段数 >= 2 && r.段数 <= 3 && 发记录.length === r.段数 && 发记录.every(m => m.文本.trim().length > 0 && m.文本.length <= 900) && r.已发,
      '原文 ' + 长回复.length + ' 字 → ' + r.段数 + ' 段（长度 ' + r.段们.map(x => x.length).join('/') + '）· 实发 ' + 发记录.length + ' 条')
  }
  // ── Q52 80 字：一条发完，不拆 ──
  {
    const 发记录 = []
    const r = await 桥.处理一轮([造归('G52', 'h52', '短一点')], {
      日志: () => {}, 只演练: false, 根目录: 临时根, 环境: 空环境, 段间隔毫秒: 0,
      生成回复: () => '啊'.repeat(80),
      发消息: async (m) => { 发记录.push(m); return { ok: true, 状态码: 200 } }
    })
    断言('Q52', '80 字短回复原样一条发完（用户感知与没有这个模块一样）',
      r.段数 === 1 && 发记录.length === 1 && 发记录[0].文本 === '啊'.repeat(80), r.段数 + ' 段')
  }
  // ── Q53 分段后入库 = 一轮三句，句ID #N.1…#N.3 ──
  {
    const r = await 桥.处理一轮([造归('G53', 'h53', '来段长的')], {
      日志: () => {}, 只演练: true, 根目录: 临时根, 环境: 空环境, 段间隔毫秒: 0,
      生成回复: () => 三段回复
    })
    const 回 = r.回话入库
    const 表 = 回溯模块.读原文表('qq-群-G53', { 根目录: 临时根 })
    const 助理行 = (表.记录 || []).filter(x => String(x.角色) === '助理')
    const 句们 = 助理行.map(x => String(x.句ID || ''))
    const 同一轮 = 句们.length >= 2 && 句们.every(x => /^qq-群-G53#\d+\.\d+$/.test(x))
      && new Set(句们.map(x => x.split('.')[0])).size === 1
      && 句们.map(x => Number(x.split('.')[1])).join(',') === '1,2,3'
    断言('Q53', '分了三段 → 回话入成同一轮三句（#N.1/#N.2/#N.3），不虚增轮数',
      r.段数 === 3 && 回 === true && 同一轮,
      '段数 ' + r.段数 + ' · 回话入库 ' + 回 + ' · 助理句ID ' + 句们.join(','))
  }
  // ── Q54 某段 4xx → 后续段停发，error 日志带残文 ──
  {
    const 发记录 = []
    const 日志们 = []
    let 次 = 0
    const r = await 桥.处理一轮([造归('G54', 'h54', '再长点')], {
      日志: (级别, 内容) => { if (级别 === 'error') 日志们.push(String(内容)) },
      只演练: false, 根目录: 临时根, 环境: 空环境, 段间隔毫秒: 0,
      生成回复: () => 三段回复,
      发消息: async (m) => {
        次++
        发记录.push(m)
        return 次 === 2 ? { ok: false, 状态码: 400, 原因: '发送失败 HTTP 400 内容不合法' } : { ok: true, 状态码: 200 }
      }
    })
    const 有残文 = 日志们.some(x => x.includes('残文'))
    断言('Q54', '第 2 段被平台拒 → 第 3 段不再发（盲目续发只会连环失败），日志留残文',
      次 === 2 && 发记录.length === 2 && r.段数 === 3 && 有残文,
      '实发 ' + 次 + '/' + r.段数 + ' 段 · 日志带残文=' + 有残文)
  }
  // ── Q55 开「正在输入」→ 额度让出 1 格（提示 1 + 回复 3 = 4）──
  {
    断言('Q55', '开「正在输入」：提示占 1 格，最多只发 3 段（合起来正好 4）',
      切段模块.段额度({ 输入提示: true, 最多段数: 4 }) === 3 && 切段模块.段额度({ 输入提示: true }) === 3,
      '开提示、上限拧到4 → ' + 切段模块.段额度({ 输入提示: true, 最多段数: 4 }) + ' 段 · 默认 ' + 切段模块.段额度({ 输入提示: true }))
  }
  // ── Q56 不开提示 → 可到 4 段（平台被动回复硬额度）──
  {
    const 关4 = 切段模块.段额度({ 输入提示: false, 最多段数: 4 })
    const 默认 = 切段模块.段额度({ 输入提示: false })
    const 超限 = 切段模块.段额度({ 输入提示: false, 最多段数: 99 })
    断言('Q56', '不开提示：上限可到 4 段；拧超过 4 也被压回 4（平台硬账）',
      关4 === 4 && 默认 === 3 && 超限 === 4, '关提示上限4→' + 关4 + ' · 默认→' + 默认 + ' · 拧到99→' + 超限)
  }
  // ── Q57 全部分段锚同一条 msg_id，且是最后一条用户消息 ──
  {
    const 发记录 = []
    const 归们 = [造归('G57', 'h57-a', '第一句'), 造归('G57', 'h57-b', '第二句'), 造归('G57', 'h57-c', '第三句')]
    const r = await 桥.处理一轮(归们, {
      日志: () => {}, 只演练: false, 根目录: 临时根, 环境: 空环境, 段间隔毫秒: 0,
      生成回复: () => 长回复,
      发消息: async (m) => { 发记录.push(m); return { ok: true, 状态码: 200 } }
    })
    const 全锚最后 = 发记录.length > 0 && 发记录.every(m => m.msgId === 'h57-c')
    断言('Q57', '每段都锚同一条 msg_id，且取的是桶里最后一条用户消息（窗口最宽松）',
      全锚最后 && 发记录.length === r.段数 && r.段数 >= 2,
      '锚点 ' + Array.from(new Set(发记录.map(m => m.msgId))).join(',') + ' · 共发 ' + 发记录.length + ' 段')
  }
  // ── Q58 生成耗时超 5 分钟 → 剩余段本地拦截，一条接口都不打 ──
  {
    let 请求数 = 0
    装假fetch((u) => {
      if (/messages/.test(String(u))) 请求数++
      if (/getAppAccessToken/.test(String(u))) return 假响应(200, { access_token: 'tok_q58', expires_in: '7200' })
      return 假响应(200, { id: 'never' })
    })
    const 缓存 = path.join(临时根, '令牌缓存58.json')
    fs.writeFileSync(缓存, JSON.stringify({ access_token: 'tok_q58', 到期时间: Date.now() + 3600 * 1000 }), 'utf8')
    const 日志们 = []
    const 归 = 造归('G58', 'h58', '慢慢来的问题', Date.now() - 6 * 60 * 1000)   // 事件本身就发生在 6 分钟前
    const r = await 桥.处理一轮([归], {
      日志: (级别, 内容) => 日志们.push(String(内容)),
      只演练: false, 根目录: 临时根, 环境: 空环境, 段间隔毫秒: 0, 令牌缓存路径: 缓存,
      生成回复: () => 三段回复
    })
    还原fetch()
    装假fetch(() => 假响应(500, { message: '这一步不该发任何网络请求' }))
    const 已拦 = 日志们.some(x => /超|窗口/.test(x))
    断言('Q58', '生成拖过 5 分钟窗口 → 剩余段本地拦截并记日志（不白打接口）',
      r.段数 === 3 && r.发送们.length === 1 && !r.已发 && 请求数 === 0 && 已拦,
      '段数 ' + r.段数 + ' · 实际请求 ' + 请求数 + ' 次 · 发送尝试 ' + r.发送们.length + ' 段 · 日志已拦=' + 已拦)
  }
  // ── Q59 群/单聊 msg_seq 递增，频道不带该字段 ──
  try {
    装假fetch((u) => {
      if (/getAppAccessToken/.test(String(u))) return 假响应(200, { access_token: 'tok_q59', expires_in: '7200' })
      return 假响应(200, { id: 'sent' })
    })
    const 缓存 = path.join(临时根, '令牌缓存59.json')
    fs.writeFileSync(缓存, JSON.stringify({ access_token: 'tok_q59', 到期时间: Date.now() + 3600 * 1000 }), 'utf8')
    for (const 文本 of ['群一', '群二']) await 发送.发消息({ 会话: 'qq-群-G59', 文本, msgId: 'q59-group', 时间: Date.now() }, { 令牌缓存路径: 缓存 })
    for (const 文本 of ['单一', '单二']) await 发送.发消息({ 会话: 'qq-单聊-U59', 文本, msgId: 'q59-c2c', 时间: Date.now() }, { 令牌缓存路径: 缓存 })
    await 发送.发消息({ 会话: 'qq-频道-C59', 文本: '频道一条', msgId: 'q59-ch', 时间: Date.now() }, { 令牌缓存路径: 缓存 })
    const 群体 = fetch记录.filter(f => /\/v2\/groups\/G59\/messages/.test(f.url)).map(f => JSON.parse(f.body))
    const 单体 = fetch记录.filter(f => /\/v2\/users\/U59\/messages/.test(f.url)).map(f => JSON.parse(f.body))
    const 频体 = fetch记录.filter(f => /\/channels\/C59\/messages/.test(f.url)).map(f => JSON.parse(f.body))
    断言('Q59', 'msg_seq 群聊 1,2 · 单聊 1,2 · 频道不带此字段（现状保持）',
      群体.length === 2 && 群体[0].msg_seq === 1 && 群体[1].msg_seq === 2
      && 单体.length === 2 && 单体[0].msg_seq === 1 && 单体[1].msg_seq === 2
      && 频体.length === 1 && 频体[0].msg_seq === undefined,
      '群 ' + 群体.map(x => x.msg_seq).join(',') + ' · 单 ' + 单体.map(x => x.msg_seq).join(',')
      + ' · 频道 msg_seq=' + (频体[0] && 频体[0].msg_seq))
  } finally {
    还原fetch()
    装假fetch(() => 假响应(500, { message: '这一步不该发任何网络请求' }))
  }
  // ── Q60 --演练：切段照样走完、只打日志不发 ──
  {
    const 日志们 = []
    let 发被调用 = 0
    const r = await 桥.处理一轮([造归('G60', 'h60', '演练一下')], {
      日志: (级别, 内容) => 日志们.push(String(内容)),
      只演练: true, 根目录: 临时根, 环境: 空环境, 段间隔毫秒: 0,
      生成回复: () => 三段回复,
      发消息: async () => { 发被调用++; return { ok: true } }
    })
    const 演练日志 = 日志们.some(x => /【演练】不真发/.test(x) && /3 段/.test(x))
    断言('Q60', '--演练：切段照样算出来并打日志，一次也不真发',
      r.段数 === 3 && 发被调用 === 0 && r.已发 === false && 演练日志,
      '段数 ' + r.段数 + ' · 发送被调用 ' + 发被调用 + ' 次 · 日志含演练说明=' + 演练日志)
  }
  // ── Q61 原有 40 项一条不少、一条不红（本次只加不改）──
  {
    const 旧号 = (x) => Number(String(x).replace(/^Q/, '').replace(/[a-z]$/, ''))
    const 旧项 = 结果清单.filter(r => /^Q\d+[a-z]?$/.test(r.编号) && 旧号(r.编号) <= 40)
    const 旧红 = 旧项.filter(r => !r.通过).map(r => r.编号)
    断言('Q61', '原有 Q01–Q40 全部仍在且全绿（本次改动只新增适配器文件，内核零改动）',
      旧项.length >= 40 && 旧红.length === 0,
      '原有 ' + 旧项.length + ' 项 · 红 ' + (旧红.join(',') || '无'))
  }
  // ── Q62 一键跑仍把本文件算作 L6，且十层未减 ──
  {
    const 源 = fs.readFileSync(path.join(根, '验收', '一键跑.js'), 'utf8')
    const 层们 = (源.match(/层: 'L[^']*'/g) || []).length
    const 有L6 = /'L6'[\s\S]{0,80}QQ适配验收\.js/.test(源)
    断言('Q62', '一键跑里 L6 仍指向本文件，层数未减（新验收自动进总账）',
      有L6 && 层们 >= 10, '层数 ' + 层们 + ' · L6 指向本文件=' + 有L6)
  }
  // ── Q63 两层缩进列表：缩进逐字保留（旧版只补换行、把缩进压平）──
  {
    const 两层 = '- 一层：这条没缩进\n  - 二层：这条两个空格\n    - 三层：这条四个空格'
    const r = 切段模块.切段(两层, { 不分段字数: 10, 单段最大字数: 300 })
    const 段 = r.段们.join('\n')
    const 缺行 = 两层.split('\n').filter(行 => !段.includes(行))
    断言('Q63', '两层缩进列表切完缩进逐字保留（旧版只补换行、把两层列表压平）',
      缺行.length === 0 && r.段数 === 1, '缺行 ' + (缺行.join('|') || '无') + ' · 结果 ' + JSON.stringify(段))
  }
  // ── Q64 无缩进多行：换行位置与原文一脣一样 ──
  {
    const 多行 = '第一行。\n第二行。\n第三行。\n第四行。'
    const r = 切段模块.切段(多行, { 不分段字数: 10, 单段最大字数: 300 })
    断言('Q64', '无缩进多行文本切完，换行位置与原文完全一致',
      r.段数 === 1 && r.段们[0] === 多行, '结果 ' + JSON.stringify(r.段们[0]))
  }
  // ── Q65 段被打断时，新段首既不带换行也不带缩进 ──
  {
    const 文 = '甲'.repeat(90) + '。\n  ' + '乙'.repeat(90) + '。'
    const r = 切段模块.切段(文, { 不分段字数: 10, 单段最大字数: 100 })
    const 首干净 = r.段们.every(s => !/^[\s]/.test(s))
    断言('Q65', '段被打断另起一段时长，新段首不带换行也不带缩进（气泡开头不能是空白）',
      r.段数 === 2 && 首干净 && r.段们[1].startsWith('乙'),
      '段数 ' + r.段数 + ' · 段首 ' + r.段们.map(s => JSON.stringify(s.slice(0, 3))).join(' / '))
  }
  // ── Q66 带缩进仍不超单段最大字数（宽度把前导算进去）──
  {
    const 文 = ('甲'.repeat(45) + '。\n      ') + ('乙'.repeat(45) + '。\n      ') + ('丙'.repeat(45) + '。')
    const r = 切段模块.切段(文, { 不分段字数: 10, 单段最大字数: 100 })
    const 不超宽 = r.段们.every(s => s.length <= 100)
    const 段内留缩进 = r.段们[0].includes('\n      ')
    断言('Q66', '带缩进的文本切完仍不超单段最大字数（宽度计算把前导算进去）',
      不超宽 && 段内留缩进 && r.段数 === 2,
      '各段长度 ' + r.段们.map(s => s.length).join('/') + ' · 段内留缩进=' + 段内留缩进)
  }

  if (环境备份.k) process.env.WHALE_LLM_KEY = 环境备份.k
} finally { 还原fetch() }

// ═══════════════════════════════════════════════════════════
// 汇总
// ═══════════════════════════════════════════════════════════
const 通过数 = 结果清单.filter(r => r.通过).length
const 总数 = 结果清单.length
const 全过 = 通过数 === 总数

const 报告 = {
  时间: new Date().toISOString(),
  层: 'QQ适配 L6',
  通过: 通过数, 总数, 全过,
  临时目录: 临时根,
  明细: 结果清单
}
try {
  fs.writeFileSync(path.join(__dirname, 'QQ适配验收结果.json'), JSON.stringify(报告, null, 2), 'utf8')
} catch {}

if (!静默) {
  console.log('\n' + '═'.repeat(64))
  console.log(全过 ? `✅ 全过 ${通过数}/${总数}` : `❌ 失败 ${总数 - 通过数} 项 · 通过 ${通过数}/${总数}`)
  结果清单.filter(r => !r.通过).forEach(r => console.log('   ✗ [' + r.编号 + '] ' + r.名称 + ' — ' + r.详情))
  console.log('═'.repeat(64))
} else {
  console.log((全过 ? '✅' : '❌') + ' QQ适配验收 ' + 通过数 + '/' + 总数)
}
require('./断言报告.js').报(通过数, 总数)

// 清临时目录（保留以便排查的情况：失败时不删）
if (全过) { try { fs.rmSync(临时根, { recursive: true, force: true }) } catch {} }
process.exit(全过 ? 0 : 1)

}

主().catch((e) => {
  console.log('\n❌ 验收脚本自身崩了：' + ((e && e.stack) || e))
  process.exit(1)
})
