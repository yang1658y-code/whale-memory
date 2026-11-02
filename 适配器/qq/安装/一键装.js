#!/usr/bin/env node
'use strict'
/**
 * 一键装.js · 安装线总编排：登录 → 建机器人 → 拿凭据 → 写配置 → 验令牌 → 起网关
 *
 * 【它解决的到底是什么问题】
 *   改之前，这条链是断的：
 *     一步装.js 落 临时/安装结果.json → **人照着手抄进 配置/qq.json** → 人再跑一次 --dry
 *   中间那一步「人抄凭据」是整条安装线上唯一会抄错一位、也是唯一说不清算不算「只做两步」的地方。
 *   本脚本把这一段剪掉：人只做一件事——在弹出的窗口里扫码。剩下全自动。
 *
 * 用法：
 *   node 适配器/qq/安装/一键装.js                            全链（默认 profile 配置/浏览器配置-新号，端口 9335）
 *   node 适配器/qq/安装/一键装.js --数据目录 配置/浏览器配置-干净   换一份干净 profile 跑（首次必扫码）
 *   node 适配器/qq/安装/一键装.js --演练                      拿到凭据+验令牌就停：不写 配置/qq.json、不动网关
 *   node 适配器/qq/安装/一键装.js --不重启网关                写配置+验令牌，但不碰常驻进程
 *   node 适配器/qq/安装/一键装.js --不建                      只用页面上已有的明文，不代建（不花配额）
 *   node 适配器/qq/安装/一键装.js --配置 临时/沙盘.json --不验网关   验收专用：写隔离配置、不碰网络不拉进程
 *   node 适配器/qq/安装/一键装.js --代建结果 临时/某结果.json        重跑专用：不实点（不花配额），直接吃这份结果
 *   node 适配器/qq/安装/一键装.js --端口 9336 --超时 600 --名字 鲸鱼 --建后等 45
 *
 * 四条判据（逐条落进 临时/一键装日志.json，可直接当 README 的实测数字）：
 *   ① 人动手次数 = 1（扫码）。除扫码外，脚本不要求人点页面任何一处。
 *   ② 写出 配置/qq.json 后**回读**，appId/appSecret 与抄到的逐字相符。
 *   ③ 用新凭据真调 bots.qq.com 换令牌，拿到 access_token 才算过。
 *   ④ 网关 --dry 三层全绿（凭据→令牌→网关 READY，退出码 0）。
 *
 * ⛔ 三条禁令（与代建.js 一致，写死不提供开关）：
 *   1. 永不点「查看 AppSecret」——腾讯那边「查看」= 重置入口，点了不可逆
 *   2. 永不删机器人
 *   3. 写配置前一定先备份（配置/qq.json.<时间戳>.bak，被 .gitignore 的 *.bak* 盖住）
 *
 * 零依赖：只用 Node 标准库。
 */
// ⛔ Node 版本闸门（2026-11-02 加）
// 【为什么卡在这里】网关与扫码浏览器用的是 Node 22 才有的全局 WebSocket / fetch。
// Node 18/20 LTS 上十层自检仍然全绿（内核完全不碰 WebSocket），
// 一到「弹出窗口扫码」这最关键的一步才崩 —— 人还以为是安装器坏了。
// 所以：在装任何东西之前就说一句真话，只停一次。
{
  const 主版 = Number(String(process.versions.node).split('.')[0])
  if (!(主版 >= 22)) {
    console.error('')
    console.error('  ✗ 需要 Node 22 或更高，当前是 ' + process.version + '。')
    console.error('    原因：QQ 网关和扫码浏览器用的是 Node 22 才有的全局 WebSocket / fetch。')
    console.error('    怎么办：把 Node 升到 22（或 24）再重跑本命令 —— 不用 npm install 任何包。')
    console.error('    验一下：node -v   → 应显示 v22.x 或更高')
    console.error('')
    process.exit(1)
  }
}

const fs = require('fs')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const 浏 = require('./浏览器.js')
const 登 = require('./登录态.js')
const 抄 = require('./抄凭据.js')
const 凭据 = require('../凭据.js')
const 令牌 = require('../令牌.js')

const 根 = path.join(__dirname, '..', '..', '..')
const 临时 = path.join(根, '临时')
const 日志文件 = path.join(临时, '一键装日志.json')

const 参 = process.argv.slice(2)
const 有 = (n) => 参.includes('--' + n)
const 取 = (n, d = null) => { const i = 参.indexOf('--' + n); return i >= 0 && 参[i + 1] ? 参[i + 1] : d }

// 【为什么要可指定配置路径】验收/沙盘必须写到隔离路径——测安装器时把真 配置/qq.json 覆盖掉，
// 那是把正在跑的机器人换个凭据，代价远大于测试本身。默认值没变。
const 配置路径 = 取('配置', '') ? path.resolve(根, 取('配置', '')) : path.join(根, '配置', 'qq.json')

const 端口 = Number(取('端口', '9335')) || 9335
const 数据目录 = path.resolve(根, 取('数据目录', '配置/浏览器配置-新号'))
const 超时秒 = Number(取('超时', '900')) || 900
const 名字 = 取('名字', '会记得你的鲸鱼')
const 建后等秒 = Number(取('建后等', '45')) || 45
const 演练 = 有('演练')
const 不建 = 有('不建')
const 不重启网关 = 有('不重启网关')
const 不验网关 = 有('不验网关')   // 验收/沙盘：连 --dry 那层都不跑（不碰网络、不拉进程）

// ── 日志：既是屏上输出，也是落盘证据 ─────────────────────────────
const 日志 = {
  开始: new Date().toISOString(),
  参数: { 端口, 数据目录, 超时秒, 名字, 建后等秒, 演练, 不建, 不重启网关, 不验网关 },
  人动手: [],
  步: [],
  结论: '进行中'
}
let 开始毫秒 = Date.now()
const 落日志 = () => {
  try {
    fs.mkdirSync(临时, { recursive: true })
    fs.writeFileSync(日志文件, JSON.stringify(Object.assign({}, 日志, { 更新: new Date().toISOString() }), null, 2), 'utf8')
  } catch { /* 落不下去也不该断了安装 */ }
}
const 打 = (级, 文) => {
  const 标 = { 步: '▸', 好: '✅', 坏: '❌', 等: '⏳', 注: '·', 喜: '🎉', 人: '👉' }[级] || '·'
  console.log(new Date().toISOString().slice(11, 19) + ' ' + 标 + ' ' + 文)
}
/** 记一步：屏上一行 + 日志一条（含耗时），返回这一步的结果便于继续用 */
const 记 = (名, 结果, 说明) => {
  const 项 = { 名, ok: !!(结果 && 结果.ok), 说明: 说明 || (结果 && (结果.说明 || 结果.原因)) || '', 耗时秒: +((Date.now() - 开始毫秒) / 1000).toFixed(1) }
  日志.步.push(项)
  落日志()
  打(项.ok ? '好' : '坏', 名 + '：' + (项.ok ? '通过' : '失败') + (项.说明 ? ' —— ' + 项.说明 : '') + '（累计 ' + 项.耗时秒 + ' 秒）')
  return 结果
}
/** 记一次「需要人动手」：这是判据①唯一的计数器，任何人工环节都必须过它 */
const 开人工 = (动作) => {
  const 项 = { 动作, 起: new Date().toISOString(), 起毫秒: Date.now() }
  日志.人动手.push(项)
  落日志()
  打('人', '需要你动手（第 ' + 日志.人动手.length + ' 次，也是唯一需要人的地方）')
  return {
    完: () => { 项.止 = new Date().toISOString(); 项.耗时秒 = +((Date.now() - 项.起毫秒) / 1000).toFixed(1); delete 项.起毫秒; 落日志(); 打('好', '人已动手完毕，耗时 ' + 项.耗时秒 + ' 秒') }
  }
}

// ── 统一收尾 ──────────────────────────────────────────
// 2026-11-02 现场：代建子进程退出时撞 libuv 断言（退出码 3221226505），父进程照样报成功，
// Edge 进程 PID 27908 却留着占 9337。两个根子：① CDP 的 ws 还在半关状态就硬退；② 没有统一收尾。
// 以后所有退出都走 收尾退出()，不要直接 process.exit。
const 现场 = { 启: null, 连: null, 已退: false }
async function 收尾退出(码) {
  if (现场.已退) return
  现场.已退 = true
  try { if (现场.连 && 现场.连.关) 现场.连.关() } catch { /* 已断 */ }
  现场.连 = null
  try {
    const 启 = 现场.启
    // 只关「本次新起的」：如果 启.复用=true，那是用户自己开着的窗口，不许动
    if (启 && 启.ok && !启.复用 && typeof 启.关闭 === 'function') {
      await 启.关闭()
      打('注', '已关掉本次起的浏览器窗口')
    }
  } catch (e) { 打('注', '关窗出岔子（不影响结果）：' + String((e && e.message) || e)) }
  try { 落日志() } catch { /* 落不下去也得退 */ }
  await 浏.睡(250)   // 留一拍给 ws 关闭握手，别让 libuv 在 handle 半关时硬切
  process.exit(码)
}

const 时间戳 = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

/** 跑一个子进程并把输出收回来 */
function 跑子(命令, 参数, 超时毫秒 = 120000) {  return new Promise((resolve) => {
    let 出 = ''
    let 完 = false
    const 子 = spawn(命令, 参数, { cwd: 根, windowsHide: true })
    const 收 = (b) => { 出 += b.toString(); if (出.length > 20000) 出 = 出.slice(-20000) }
    子.stdout.on('data', 收)
    子.stderr.on('data', 收)
    const 钟 = setTimeout(() => { if (!完) { 完 = true; try { 子.kill() } catch { /* 已死 */ } ; resolve({ ok: false, 码: null, 出, 说明: '超时 ' + Math.round(超时毫秒 / 1000) + ' 秒' }) } }, 超时毫秒)
    子.on('error', (e) => { if (完) return; 完 = true; clearTimeout(钟); resolve({ ok: false, 码: null, 出, 说明: String((e && e.message) || e) }) })
    子.on('exit', (码) => { if (完) return; 完 = true; clearTimeout(钟); resolve({ ok: 码 === 0, 码, 出 }) })
  })
}

/** 在页面上找「创建成功那一屏」的明文（只读，不点任何按钮） */
async function 页上找明文() {
  const r = await 抄.盯明文(端口, { 超时毫秒: 1200, 每毫秒: 800 })
  if (r && r.ok) return { ok: true, appId: r.appId, appSecret: r.appSecret, 来源页: r.来源页, 判据: r.判据 }
  return { ok: false, 说明: '页面上没有明文 AppSecret（正常：只有「创建成功那一屏」才有）' }
}

/** 只读地看一眼机器人列表 —— ⛔ 绝不点「查看」，那是重置入口 */
async function 看一眼列表(连) {
  try {
    const r = await 抄.读列表(连)
    if (!r.ok) return { ok: false, 说明: r.说明 || '读不到列表', 数: null }
    return { ok: true, 数: (r.列表 || []).length, 列表: (r.列表 || []).map(x => ({ appId: x.appId, 摘要: String(x.摘要 || '').slice(0, 60) })) }
  } catch (e) {
    return { ok: false, 说明: String((e && e.message) || e), 数: null }
  }
}

/** 写配置：先备份，再写，再回读逐字比对（判据②） */
function 写配置并回读(appId, appSecret) {
  const 备份 = 配置路径 + '.' + 时间戳() + '.bak'
  let 备份到 = ''
  if (fs.existsSync(配置路径)) {
    try { fs.copyFileSync(配置路径, 备份); 备份到 = 备份 } catch (e) { return { ok: false, 说明: '备份老配置失败，不敢往下写：' + String((e && e.message) || e) } }
  } else if (演练) {
    return { ok: false, 说明: '演练模式：不写 配置/qq.json' }
  }
  // ⚠️ 2026-11-02 血亏一条：这里漏传了 配置路径，于是「指定沙盘配置」变成了「写沙盘、却覆盖真配置」，
  //    一次验收就把正在用的 配置/qq.json 改了。
  //    教训：凡是「取出一个路径变量」的函数，写盘时**必须把那个变量传进去**——不能指望下游默认值和自己一致。
  const w = 凭据.写配置(appId, appSecret, { 覆盖: true, 配置路径 })
  if (!w.ok) return { ok: false, 说明: '写配置失败：' + w.原因 }
  const 回 = 凭据.取凭据({ 配置路径, 环境: {} })   // 环境传空：逼它只读文件，不被 QQ_BOT_* 环境变量蒙住
  const 一致 = 回.ok && String(回.appId) === String(appId) && String(回.appSecret) === String(appSecret)
  return {
    ok: 一致,
    说明: 一致 ? '已写并回读逐字相符' : ('回读不符：' + JSON.stringify({ 期望: { appId, secret长: String(appSecret).length }, 回读: { appId: 回.appId, secret长: String(回.appSecret || '').length }, 问题: 回.问题 })),
    备份: 备份到, 路径: w.路径
  }
}

/** 验令牌（判据③）：真调 bots.qq.com，不用磁盘缓存、不吃内存缓存 */
async function 验令牌(凭据文件) {
  const t = await 令牌.换令牌(凭据文件 ? { 配置路径: 凭据文件 } : {})
  if (!t.ok) return { ok: false, 说明: '换令牌失败：' + t.原因 }
  return { ok: true, 说明: '令牌到手 ' + String(t.access_token).slice(0, 6) + '****（' + String(t.access_token).length + ' 位）· ' + t.寿命秒 + ' 秒 · ' + t.接口, 寿命秒: t.寿命秒, 位数: String(t.access_token).length }
}

/** 停掉在跑的常驻网关（只认命令行里带 适配器/qq/主.js 的 node 进程） */
function 停旧网关() {
  let pids = []
  try {
    const 脚本 = 'Get-CimInstance Win32_Process -Filter "name=\'node.exe\'" | Where-Object { $_.CommandLine -like \'*适配器/qq/主.js*\' -or $_.CommandLine -like \'*适配器\\\\qq\\\\主.js*\' } | ForEach-Object { $_.ProcessId }'
    // 用 -EncodedCommand（UTF-16LE base64）传脚本：中文路径当 argv 直传会被 Windows 控制台编码吃掉。
    // 2026-11-02 真机就这样漏杀了一个在跑的网关（25284），于是又起了 22464，两只抢同一条 WS 互相踢。
    const 静默 = "$ProgressPreference='SilentlyContinue';" + 脚本   // 不加这句，powershell 会往 stderr 吐一堆 CLIXML 进度噪音
    const 编码 = Buffer.from(静默, 'utf16le').toString('base64')
    const 出 = execFileSync('powershell', ['-NoProfile', '-EncodedCommand', 编码], { encoding: 'utf8', timeout: 15000 })
    pids = String(出).split(/\r?\n/).map(s => Number(String(s).trim())).filter(n => Number.isInteger(n) && n > 0 && n !== process.pid)
  } catch (e) {
    return { ok: false, 说明: '查旧网关失败：' + String((e && e.message) || e), 停掉: [] }
  }
  const 停掉 = []
  const 没停 = []
  for (const pid of pids) {
    try { process.kill(pid); 停掉.push(pid) } catch { 没停.push(pid) }
  }
  // kill 完不能立刻起新的：旧进程还没退干净就起，两只同握一条 WS 会互踢。
  // 等它真死（最多 3 秒），还在就补一刀强制终止。
  for (const pid of 停掉) {
    for (let i = 0; i < 6; i++) {
      try { process.kill(pid, 0) } catch { break }
      if (i === 5) { try { process.kill(pid, 'SIGKILL') } catch {} }
      else 睡同步(500)
    }
  }
  return { ok: true, 停掉, 没停, 说明: 停掉.length ? '停掉 ' + 停掉.join(',') : '没有在跑的常驻网关' }
}

/** 阻塞睡一下（停旧网关是同步流程，不能 await） */
function 睡同步(毫秒) {
  const 止 = Date.now() + 毫秒
  while (Date.now() < 止) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50) } catch { break } }
}

/** 起常驻网关（判据④的正式版：真起进程，等日志里出现 READY） */
async function 起常驻网关() {
  const 乙志 = path.join(临时, 'qq网关-' + 时间戳() + '.log')
  let fd
  try { fd = fs.openSync(乙志, 'a') } catch (e) { return { ok: false, 说明: '开日志文件失败：' + String((e && e.message) || e) } }
  const 子 = spawn(process.execPath, [path.join(根, '适配器', 'qq', '主.js')], {
    cwd: 根, detached: true, windowsHide: true, stdio: ['ignore', fd, fd]
  })
  子.unref()
  const 起 = Date.now()
  let 见到 = null
  while (Date.now() - 起 < 45000) {
    await 浏.睡(1000)
    let 文 = ''
    try { 文 = fs.readFileSync(乙志, 'utf8') } catch { 文 = '' }
    if (/READY/.test(文)) { 见到 = (文.match(/.*READY.*/) || [''])[0].trim(); break }
    if (/ERR|错误|失败/.test(文.slice(-800))) { 见到 = ''; break }
  }
  // 起完还要对一次号：READY 报回来的机器人必须是配置里那只。
  // 2026-11-02 真机：令牌缓存串台——日志「凭据就绪 AppID 1906239808」与「READY」
  // 两行都是绿的，实际连的是上一只 1906238509。不对号，就会把这种假绿报成通过。
  let 串 = null
  if (见到) {
    const 数 = String(见到).match(/(\d{6,})/)
    const 凭 = 凭据.取凭据({ 配置路径 })
    if (数 && 凭.ok && String(数[1]) !== String(凭.appId)) {
      串 = 'READY 报的是 ' + 数[1] + '，配置里是 ' + 凭.appId + ' —— 令牌串台（删 数据/qq令牌.json 再跑）'
    }
  }
  return {
    ok: !!见到 && !串,
    pid: 子.pid,
    乙志,
    说明: 串 ? 串 : (见到 ? 见到.slice(0, 160) : '45 秒内日志里没出现 READY'),
    串台: 串,
    日志尾巴: (() => { try { return fs.readFileSync(乙志, 'utf8').slice(-600) } catch { return '' } })()
  }
}

;(async () => {
  fs.mkdirSync(临时, { recursive: true })
  console.log('')
  console.log('  🐋 会记得你的鲸鱼 · 一键装（登录 → 建机器人 → 拿凭据 → 写配置 → 验令牌 → 起网关）')
  console.log('  ───────────────────────────────────────────────────────────────')
  console.log('  ' + (演练
    ? '【演练模式】只跑到验令牌，不写配置、不动网关'
    : 不验网关
      ? '【不验网关】凭据 → 令牌照验，网关那层一步不碰（不起进程、不重启、不 dry）'
      : 不重启网关
        ? '【不重启网关】写配置+验令牌，不碰常驻进程'
        : '【全链】会重启一次网关（当前在跑的鲸鱼断约 10 秒）'))
  console.log('  凭据写入：' + 配置路径 + (配置路径 === path.join(根, '配置', 'qq.json') ? '（默认·真机）' : '（--配置 指定·隔离）'))
  console.log('')
  开始毫秒 = Date.now()

  // ① 找浏览器 + 起窗口
  const 找 = 浏.找浏览器()
  if (!找.ok) { 记('找浏览器', { ok: false, 说明: 找.说明 }); 日志.结论 = '失败：没浏览器'; await 收尾退出(1) }
  打('注', '浏览器：' + 找.名字 + '（' + 找.路径 + '）')
  const 启 = 现场.启 = await 浏.启动({ 路径: 找.路径, 端口, 数据目录, 起始页: 登.后台入口 })
  if (!启.ok) { 记('起窗口', { ok: false, 说明: 启.说明 }); 日志.结论 = '失败：窗口没起来'; await 收尾退出(1) }
  记('起窗口', { ok: true, 说明: (启.复用 ? '接上已有窗口（跑完不关）' : '新窗口') + ' · 端口 ' + 启.端口 + ' · profile ' + 启.数据目录 })

  // ② 开后台 + 判登录态
  const 开 = await 登.打开后台(启, { 额外等毫秒: 2000 })
  if (!开.ok) { 记('开后台', { ok: false, 说明: 开.说明 }); 日志.结论 = '失败：后台打不开'; await 收尾退出(1) }
  let 连 = 现场.连 = 开.连
  let 态 = 开.登录态
  记('判登录态', { ok: 态.已登录 !== false, 说明: (态.已登录 === true ? '已登录（免扫）' : 态.已登录 === false ? '未登录' : '看不出') + ' —— ' + 态.判据 })

  // ③ 没登录就等人扫 —— 全流程唯一的人工动作
  if (态.已登录 !== true) {
    console.log('')
    console.log('  ══════ 请在弹出的窗口里扫码登录（本流程只有这一步需要你） ══════')
    console.log('   用要挂机器人的那个 QQ 号扫。扫完什么都不用点，我这边每 2 秒看一眼。')
    console.log('  ═══════════════════════════════════════════════════════════')
    console.log('')
    const 人工 = 开人工('扫码登录')
    const 等 = await 登.等登录(连, { 超时毫秒: 超时秒 * 1000, 每毫秒: 2000, 进度回调: (t) => { if (t.已登录 === null) 打('注', '页面：' + t.判据) } })
    if (!等.已登录) {
      记('等扫码', { ok: false, 说明: (等.说明 || '超时') + '（人动手已发生 1 次，未完成）' })
      日志.结论 = '失败：超时没登录'
      await 收尾退出(3)
    }
    人工.完()
    态 = 等.登录态
    记('等扫码', { ok: true, 说明: '等了 ' + 等.等了秒 + ' 秒登录成功' })
    // 登录后页面通常换了 target，重连一次更稳
    const 新 = await 登.打开后台(启, { 额外等毫秒: 1200 }).catch(() => null)
    if (新 && 新.ok) { try { if (连) 连.关() } catch { /* 已断 */ } ; 连 = 现场.连 = 新.连 }
  }

  // ④ 页面上有没有现成的明文（0 成本、不点击）
  let 凭 = await 页上找明文()
  if (!凭.ok) {
    打('注', 凭.说明)
    // ⑬ 列表读不到就是读不到，不许打 ✅（上一轮就是这里报了假绿：ok 写死 true）
    const 列 = await 看一眼列表(连)
    记('看列表', { ok: !!列.ok, 说明: 列.ok ? ('列表里 ' + 列.数 + ' 个机器人' + (列.数 ? '（secret 不可读，因为腾讯已不明文保存）' : '（一个都没有）')) : ('读不到列表：' + 列.说明 + '（能继续，但后面代建得真点「创建机器人」拿明文）') })
    日志.列表 = 列

    // ⑤ 代建：spawn 出去，复用同一个窗口（同端口同 profile，人不用再扫一次）
    if (不建) { 日志.结论 = '失败：没有明文且 --不建'; 记('代建', { ok: false, 说明: '--不建：没有现成明文，按参数不代建' }); await 收尾退出(4) }
    const 代建结果 = 取('代建结果', '') ? path.resolve(根, 取('代建结果', '')) : path.join(临时, '一键装-代建结果.json')
    const 预置结果 = !!取('代建结果', '')
    打('步', '代建：点「创建机器人」并盯明文（复用同一窗口，人不用再扫）…')
    let 子 = { 码: 0, 出: '' }
    if (预置结果) {
      // 联调/重跑专用：直接吃一份已落盘的代建结果，不再点一次「创建机器人」（不花配额）
      打('注', '--代建结果 指定：跳过实点，直接吃 ' + path.basename(代建结果))
    } else {
      try { if (fs.existsSync(代建结果)) fs.unlinkSync(代建结果) } catch { /* 删不掉就靠下面的阶段判定 */ }
      const 代建入 = [
        path.join(__dirname, '代建.js'),
        '--端口', String(端口),
        '--数据目录', 数据目录,
        '--名字', 名字,
        '--建后等', String(建后等秒),
        '--结果文件', 代建结果,
        '--超时', '240'
      ]
      子 = await 跑子(process.execPath, 代建入, (建后等秒 + 120) * 1000)
    }
    let 结 = null
    try { 结 = JSON.parse(fs.readFileSync(代建结果, 'utf8')) } catch { 结 = null }
    const 拿到 = !!(结 && 结.阶段 === '成功' && 结.appId && 结.appSecret)
    // ⑭ 一键直建路线是腾讯自己命名，--名字 根本不生效。不说清楚，用户手里就多个
    //    叫「机器人1906xxx」的东西，还以为装错了。
    const 生成名 = String((结 && 结.生成名) || '')
    const 名不符 = !!(拿到 && 生成名 && 生成名 !== String(名字))
    记('代建', { ok: 拿到, 说明: 拿到 ? ('建成了 ' + 结.appId + '（' + (结.路线 || '') + '）' + (名不符 ? ' · 名字没进去：腾讯自动命名为「' + 生成名 + '」，跑完去 QQ 后台改' : ' · 名字「' + 名字 + '」已写入')) : ('未拿到：' + ((结 && (结.阶段 + ' ' + (结.原因 || ''))) || 子.说明 || ('退出码 ' + 子.码))) })
    日志.代建 = { 阶段: 结 && 结.阶段, 路线: 结 && 结.路线, 名字: 拿到 ? (生成名 || 名字) : null, 名不符, 退出码: 子.码, 输出尾: String(子.出 || '').slice(-1200) }
    if (!拿到) { 日志.结论 = '失败：代建没拿到凭据'; await 收尾退出(4) }
    凭 = { ok: true, appId: 结.appId, appSecret: 结.appSecret, 来源页: '代建结果' }
  } else {
    记('页上明文', { ok: true, 说明: '抄到 AppID ' + 凭.appId })
  }

  日志.凭据 = { appId: 凭.appId, appSecret: 凭据.脱敏(凭.appSecret), 位数: String(凭.appSecret).length }
  落日志()

  // ⑥ 写配置（判据②）—— 演练模式改写临时文件，绝不碰真配置
  let 验用 = null
  if (演练) {
    验用 = path.join(临时, '待验凭据-' + 时间戳() + '.json')
    fs.writeFileSync(验用, JSON.stringify({ appId: String(凭.appId), appSecret: String(凭.appSecret) }, null, 2), 'utf8')
    记('写配置', { ok: true, 说明: '演练模式：只写临时文件 ' + path.basename(验用) + '，配置/qq.json 一个字节没动' })
    日志.演练凭据文件 = 验用
  } else {
    日志.写配置 = 写配置并回读(凭.appId, 凭.appSecret)
    记('写配置', 日志.写配置)
    if (!日志.写配置.ok) { 日志.结论 = '失败：写配置/回读不符'; await 收尾退出(5) }
  }

  // ⑦ 验令牌（判据③）
  const 验 = await 验令牌(验用)
  日志.令牌 = 验
  记('验令牌', 验)
  if (!验.ok) { 日志.结论 = '失败：令牌验不通（凭据可能是假/已失效）'; await 收尾退出(6) }

  if (演练) {
    日志.结论 = '演练成功（凭据可用、令牌可用；未写配置、未动网关）'
    日志.结束 = new Date().toISOString()
    落日志()
    console.log('\n🎉 演练通过：凭据 → 令牌 两关都过。人动手 ' + 日志.人动手.length + ' 次，总耗时 ' + ((Date.now() - 开始毫秒) / 1000).toFixed(1) + ' 秒\n')
    await 收尾退出(0)
  }

  // ⑧ 起网关（判据④）
  if (不验网关) {
    打('注', '--不验网关：跳过网关那一层（验收/沙盘用，不碰网络也不拉进程）')
    日志.网关 = { 方式: '跳过', ok: true }
    记('网关', { ok: true, 说明: '按要求跳过' })
  } else if (不重启网关) {
    打('注', '--不重启网关：跳过常驻进程，单独跑一次 --dry 验三层')
    // ⑫ 必须把 --配置 递下去：不递就是拿默认 配置/qq.json 去验，
    //    沙盘里会报「绿」，而验的根本是真机凭据——最坏的一种假绿。
    const dry = await 跑子(process.execPath, [path.join(根, '适配器', 'qq', '主.js'), '--dry', '--配置', 配置路径], 90000)
    日志.网关 = { 方式: '只 dry', 凭据: 配置路径, ok: dry.ok, 输出尾: String(dry.出 || '').slice(-800) }
    记('网关 dry', { ok: dry.ok, 说明: dry.ok ? ('三层全绿（凭据 ' + 配置路径 + '）') : ('退出码 ' + dry.码) })
    if (!dry.ok) { 日志.结论 = '失败：网关 dry 未过'; await 收尾退出(7) }
  } else {
    // 先停后起：两个常驻网关同时跑会抢同一个机器人的 WS 连接（2026-11-02 现场抓到 2 个，本步顺手收口）
    const 停 = 停旧网关()
    记('停旧网关', 停)
    const 起 = await 起常驻网关()
    日志.网关 = 起
    记('起常驻网关', 起)
    if (!起.ok) { 日志.结论 = '失败：常驻网关没 READY（凭据/网络/机器人状态，看日志尾巴）'; await 收尾退出(7) }
  }

  日志.结论 = '成功'
  日志.结束 = new Date().toISOString()
  日志.人动手次数 = 日志.人动手.length
  日志.总耗时秒 = +((Date.now() - 开始毫秒) / 1000).toFixed(1)
  落日志()

  console.log('')
  console.log('  ┌─ 收尾账 ────────────────────────────────────────────')
  console.log('  │ 人动手次数：' + 日志.人动手.length + '（' + (日志.人动手.map(x => x.动作 + ' ' + x.耗时秒 + ' 秒').join('、') || '零') + '）')
  console.log('  │ 机器步数：  ' + 日志.步.length + ' 步 · 总耗时 ' + 日志.总耗时秒 + ' 秒')
  console.log('  │ AppID：     ' + 凭.appId + '（Secret ' + 凭据.脱敏(凭.appSecret) + '）')
  console.log('  │ 机器人名：  ' + ((日志.代建 && 日志.代建.名字) || 名字) + (日志.代建 && 日志.代建.名不符 ? '（腾讯自动命名，后台可改）' : ''))
  console.log('  │ 凭据写入：  ' + 配置路径)
  console.log('  │ 令牌：      ' + 验.说明)
  console.log('  │ 日志：      ' + 日志文件)
  console.log('  └────────────────────────────────────────────────────')
  console.log('')
  console.log('🎉 一键装全链通过。下一步：在 QQ 里对机器人说一句话，看它回不回第一句。')
  console.log('')
  await 收尾退出(0)
})().catch(async (e) => {
  日志.结论 = '崩了：' + String((e && e.message) || e)
  日志.栈 = String((e && e.stack) || e).slice(0, 2000)
  console.error('❌ 一键装崩了：', (e && e.stack) || e)
  await 收尾退出(1)
})
