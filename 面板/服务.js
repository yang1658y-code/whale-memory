'use strict'
/**
 * 面板/服务.js —— 会记得你的鲸鱼 · 内核面板（零依赖，只用 node 内置 http）
 * ════════════════════════════════════════════════════════════════
 * 为什么要有它：内核的深度不在功能多少，在「能从外面拧的旋钮多少」。
 * 命令行能跑十层自检，但没人看得见；配置文件能改，但没人知道改哪一项、
 * 改了会发生什么。这个面板只干三件事：
 *   ① 让人一眼看见这只鲸鱼记得什么（总览）
 *   ② 让人亲手翻一次原话，看它怎么从一句话找回到那句（翻原话）
 *   ③ 让每个旋钮都能拧，旁边写着默认值 + 拧大拧小会怎样（拧参数）
 * 外加一个「跑自检」按钮，把 npm run selfcheck 的十层结果搬进浏览器。
 *
 * 三条纪律：
 *   ① 只绑 127.0.0.1 —— 面板能写配置，绝不上公网、绝不 0.0.0.0。
 *   ② 不碰内核一行逻辑：只调内核的公开接口（参数/候选映射/门控策略/原文回溯）。
 *   ③ 内核挂了面板不许挂：每个数据源单独 try/catch，缺哪块就少显示哪块。
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const 根目录 = path.join(__dirname, '..')
const 端口 = Number(process.env.鲸鱼面板端口) || 9337
const 主机 = '127.0.0.1'

// 内核公开接口（任何一个 require 失败都不许拖垮面板）
function 试require(相对) {
  try { return require(path.join(根目录, 相对)) } catch (e) {
    console.warn('[面板] 内核模块加载失败 ' + 相对 + '：' + ((e && e.message) || e))
    return null
  }
}
const 参数 = 试require('内核/参数.js')
const 映射 = 试require('内核/候选映射.js')
const 门控 = 试require('内核/门控策略.js')
const 存储 = 试require('内核/存储适配器.js')
const 后端 = 试require('内核/向量后端.js')
const 原文回溯 = 试require('内核/原文回溯.js')

// ═══════════════════════ 小工具 ═══════════════════════
function 发JSON(res, 码, 体) {
  const 文 = JSON.stringify(体)
  res.writeHead(码, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(文)
}

function 读体(req) {
  return new Promise((解决, 拒绝) => {
    let 块 = ''
    let 长 = 0
    req.on('data', c => {
      长 += c.length
      if (长 > 1024 * 256) { 拒绝(new Error('请求体过大')); req.destroy(); return }
      块 += c
    })
    req.on('end', () => {
      if (!块.trim()) return 解决({})
      try { 解决(JSON.parse(块)) } catch (e) { 拒绝(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', 拒绝)
  })
}

function 字节可读(n) {
  const 数 = Number(n) || 0
  if (数 < 1024) return 数 + ' B'
  if (数 < 1024 * 1024) return (数 / 1024).toFixed(1) + ' KB'
  return (数 / 1024 / 1024).toFixed(2) + ' MB'
}

function 时间可读(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const d = new Date(n)
  const p = x => String(x).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

// ═══════════════════════ ① 总览 ═══════════════════════
function 取状态() {
  const 出 = { ok: true, 时间: Date.now(), 时间可读: 时间可读(Date.now()) }

  // 版本
  try {
    出.版本 = JSON.parse(fs.readFileSync(path.join(根目录, 'package.json'), 'utf8')).version
  } catch { 出.版本 = '未知' }

  // 后端（当前嵌入模式）
  try {
    const 元 = 存储.当前嵌入元()
    出.后端 = {
      模型ID: 元.模型ID, 维度: 元.维度, 注入: !!元.注入, 模式: 元.模式 || (元.注入 ? '稠密向量' : 'bigram 哈希兜底')
    }
  } catch (e) { 出.后端 = { 模式: '未知', 错误: String(e.message || e) } }

  // 向量库
  try {
    const 条们 = 存储.读取向量库()
    const 库路径 = 存储.库路径()
    let 体积 = 0
    try { 体积 = fs.statSync(库路径).size } catch {}
    出.向量库 = {
      条数: 条们.length,
      体积: 体积,
      体积可读: 字节可读(体积),
      路径: 库路径,
      最早: 条们.length ? 时间可读(Math.min(...条们.map(o => Number(o.time) || 0).filter(Boolean))) : '—',
      最新: 条们.length ? 时间可读(Math.max(...条们.map(o => Number(o.time) || 0))) : '—'
    }
  } catch (e) { 出.向量库 = { 条数: 0, 体积可读: '0 B', 错误: String(e.message || e) } }

  // 原文表（L1 的唯一事实源）
  try {
    const 名们 = 原文回溯.列会话() || []
    let 句数 = 0, 最早 = 0, 最新 = 0
    const 明细 = []
    for (const 名 of 名们) {
      let n = 0, 坏 = 0
      try {
        const t = 原文回溯.读原文表(名)
        n = (t.记录 || []).length
        坏 = Number(t.坏行数) || 0
        for (const r of (t.记录 || [])) {
          const ts = Number(r.时间) || 0
          if (ts > 0) { if (!最早 || ts < 最早) 最早 = ts; if (ts > 最新) 最新 = ts }
        }
      } catch {}
      句数 += n
      明细.push({ 会话: 名, 句数: n, 坏行数: 坏 })
    }
    出.原文表 = {
      会话数: 名们.length, 句数, 会话们: 明细,
      最早: 时间可读(最早), 最新: 时间可读(最新)
    }
  } catch (e) { 出.原文表 = { 会话数: 0, 句数: 0, 会话们: [], 错误: String(e.message || e) } }

  // 参数
  try {
    const d = 参数.面板数据()
    出.参数 = { 总数: d.参数.length, 已改: d.参数.filter(p => p.已改).length, 配置文件: d.配置文件, 文件存在: d.文件存在 }
  } catch (e) { 出.参数 = { 总数: 0, 已改: 0, 错误: String(e.message || e) } }

  // 门控策略
  try {
    const s = 门控.加载策略({ 静默: true })
    出.门控 = {
      档位: s.策略.profile,
      可用档: Object.keys(s.策略.profiles || {}),
      生效门: (s.策略.profiles || {})[s.策略.profile] || [],
      降档: !!s.降档,
      告警: (s.日志 || []).filter(x => x.级别 !== 'info').map(x => x.内容)
    }
  } catch (e) { 出.门控 = { 档位: '未知', 错误: String(e.message || e) } }

  return 出
}

// ═══════════════════════ ② 翻原话 ═══════════════════════
async function 翻原话(文本) {
  const 查询 = String(文本 || '').trim()
  if (!查询) return { ok: false, 原因: '给一句话再翻' }
  if (查询.length > 200) return { ok: false, 原因: '查询太长（≤200 字）' }

  const 开始 = Date.now()
  const r = await 映射.映射候选集(查询)
  const 策略包装 = 门控.加载策略({ 静默: true })
  const 判定 = 门控.门控(r.候选集 || [], 策略包装.策略, {})
  const 前后句数 = 参数 ? 参数.取整('原文回溯.前后句数', 2) : 2

  const 候选 = (r.候选集 || []).slice(0, 6).map(c => {
    let 原话 = null
    try {
      const g = 映射.取原话(c, { 前后句数 })
      if (g && g.找到) {
        原话 = {
          句ID: g.句ID, 原句: g.原句, 时间: 时间可读(g.时间), 会话: g.会话, 角色: g.角色,
          前: (g.前 || []).map(x => ({ 角色: x.角色, 文本: x.文本 })),
          后: (g.后 || []).map(x => ({ 角色: x.角色, 文本: x.文本 }))
        }
      }
    } catch (e) { 原话 = { 错误: String(e.message || e) } }
    return {
      记忆ID: c.记忆ID, 内容: c.内容, 族: c.族, 交集数: c.交集数, 余弦: c.余弦,
      检索路: c.检索路, 时间: 时间可读(c.时间), 会话: c.会话, 角色: c.角色,
      映射方式: c.映射方式, 原话
    }
  })

  const 诊断 = r.诊断 || {}
  return {
    ok: true, 查询,
    耗时毫秒: Date.now() - 开始,
    候选,
    条数: 候选.length,
    门控: {
      开口: 判定.开口, 档位: 判定.档位, 置信: 判定.置信, 措辞: 判定.措辞,
      理由: 判定.理由, 命中gate: 判定.命中gate,
      明细: (判定.明细 || []).map(x => ({ gate: x.gate, 通过: x.通过, 说明: x.说明 }))
    },
    诊断: {
      向量条数: 诊断.向量条数, 关键词条数: 诊断.关键词条数, 融合条数: 诊断.融合条数,
      交集条数: 诊断.交集条数, 交集数: 诊断.交集数, 前N: 诊断.前N,
      可回溯数: 诊断.可回溯数, 原文句数: 诊断.原文句数, 降级: 诊断.降级 || []
    },
    策略告警: (策略包装.日志 || []).filter(x => x.级别 !== 'info').map(x => x.内容)
  }
}

// ═══════════════════════ ③ 门控策略（可拧项白名单） ═══════════════════════
const 门控文件 = path.join(根目录, '配置', '门控策略.json')

function 读门控原文() {
  return JSON.parse(fs.readFileSync(门控文件, 'utf8'))
}
function 写门控原文(文) {
  const 临时 = 门控文件 + '.tmp-' + process.pid
  fs.writeFileSync(临时, JSON.stringify(文, null, 2) + '\n', 'utf8')
  fs.renameSync(临时, 门控文件)
}
function 取路径(对象, 点路径) {
  return 点路径.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), 对象)
}
function 放路径(对象, 点路径, 值) {
  const 段 = 点路径.split('.')
  let p = 对象
  for (let i = 0; i < 段.length - 1; i++) {
    if (!p[段[i]] || typeof p[段[i]] !== 'object') p[段[i]] = {}
    p = p[段[i]]
  }
  p[段[段.length - 1]] = 值
}

/** 门控策略可写项：路径 → 校验器。不在表里的一律拒绝（防把 _说明 也改了） */
const 门控白名单 = {
  'profile': { 名: '当前档位', 层: 'L5 门控', 重要: 3, 校验: (v, 文) => (文.profiles && 文.profiles[v] ? null : '档位不存在于 profiles：' + v), 类型: '枚举', 说明: '一句话决定「生效哪些 gate」。quiet 最安静、standard 默认、active 最主动。',
    档: '通用', 通俗名: '它多爱主动说话', 通俗说明: '一档一句：安静档几乎不开口，标准档默认，活跃档更爱提话、也更容易提错。' },
  'gates.cross3.k': { 名: 'cross3 交集门槛 k', 层: 'L5 门控', 最小: 1, 最大: 10, 类型: '整数', 说明: '两路交集数 ≥ k 才开口。与「候选映射.交集判定值」是同一个概念的两端，面板会自动同步。' },
  'gates.cosine_literal.cosine': { 名: '字面余弦阈值', 层: 'L5 门控', 最小: 0, 最大: 1, 类型: '小数', 说明: '字面族（记得专名）的余弦门槛。标准档靠它把提出率从 44% 抬到 54%，全档准确 96%。' },
  'gates.cosine_rewrite.cosine': { 名: '改写余弦阈值', 层: 'L5 门控', 最小: 0, 最大: 1, 类型: '小数', 说明: '改写族（只记得意思）的余弦门槛。⚠ 这一路会把整档准确率拉到 88%，低于 90% 验收线。' },
  '冷却.同记忆天': { 名: '同一条记忆几天内不再提', 层: 'L0 冷却', 最小: 0, 最大: 365, 类型: '整数', 说明: '开场提过的事，对话中途也不再提；反之亦然。调小 → 反复念叨，人设崩。' },
  '冷却.每小时上限': { 名: '每小时最多提几次', 层: 'L0 冷却', 重要: 3, 最小: 0, 最大: 100, 类型: '整数', 说明: '主动提话的频率天花板。默认 1 = 一小时最多主动说一次。',
    档: '通用', 通俗名: '一小时最多主动提几次', 通俗说明: '0 = 这一小时它不主动开口；1 是默认（一小时最多一次）；调大它会变得啰嗦。' },
  '强制疑问句': { 名: '一律用疑问口气', 层: 'L5 门控', 类型: '布尔', 说明: '打开后所有主动提话都变成「你是不是说过…？」，把准确率问题降级成措辞问题。' },
  '可提话.排除疑问句': { 名: '不把问句当记忆念回去', 层: 'L5 门控', 重要: 1, 类型: '布尔', 说明: '关掉会变成复读机：用户问「我最近在忙什么」，鲸鱼把上一轮同款问句当记忆还回去。',
    档: '通用', 通俗名: '别把我的问句当记忆还给我', 通俗说明: '打开（默认）：你问「我在忙什么」，它不会把这句话本身当成一段回忆念回来。' },
  '可提话.疑问最长字数': { 名: '只拦多长的问句', 层: 'L5 门控', 最小: 0, 最大: 200, 类型: '整数', 说明: '长问句里通常带着具体事实（拦了就丢记忆），所以只对短问句动手。' },
  '可提话.排除空话': { 名: '不把空话当记忆', 层: 'L5 门控', 重要: 1, 类型: '布尔', 说明: '「好的」「嗯嗯」这类只有语气词的句子不提。',
    档: '通用', 通俗名: '别把「好的」「嗯嗯」当记忆', 通俗说明: '打开（默认）：「好的」「嗯嗯」「哈哈」这类语气词不会被当成回忆接着念。' },
  '可提话.排除自引': { 名: '不复读本轮输入', 层: 'L5 门控', 重要: 1, 类型: '布尔', 说明: '与用户这一轮说的话几乎相同 → 不念。',
    档: '通用', 通俗名: '别复读我刚说的话', 通俗说明: '打开（默认）：你把十秒前说过的话原样再问一遍，它不会当成新发现拿出来邀功。' },
}

function 取门控面板() {
  const 文 = 读门控原文()
  const 项 = Object.entries(门控白名单).map(([路径, m]) => ({
    路径, 名: m.名, 层: m.层, 类型: m.类型, 最小: m.最小, 最大: m.最大, 说明: m.说明,
    重要: Number(m.重要) || 0,
    当前: 取路径(文, 路径),
    档: m.档 === '通用' ? '通用' : '专业', 通俗名: m.通俗名 || '', 通俗说明: m.通俗说明 || ''
  }))
  return {
    ok: true, 文件: 门控文件,
    项,
    档表: 文.profiles || {},
    标定: 文.标定 || null,
    风险提示: 文._活跃档风险 || null
  }
}

function 写门控(改动们) {
  const 文 = 读门控原文()
  const 回滚 = JSON.stringify(文)
  const 已改 = []
  try {
    for (const { 路径, 值 } of 改动们) {
      const m = 门控白名单[路径]
      if (!m) throw new Error('不在可写白名单：' + 路径)
      if (m.类型 === '布尔') {
        if (typeof 值 !== 'boolean') throw new Error(路径 + ' 只接受 true/false')
        放路径(文, 路径, 值)
      } else if (m.类型 === '枚举') {
        const 错 = m.校验(值, 文)
        if (错) throw new Error(错)
        放路径(文, 路径, 值)
      } else {
        const 数 = Number(值)
        if (!Number.isFinite(数)) throw new Error(路径 + ' 不是数字')
        const 落 = m.类型 === '小数' ? +数.toFixed(3) : Math.round(数)
        if (落 < m.最小 || 落 > m.最大) throw new Error(路径 + ' 超出范围 [' + m.最小 + ', ' + m.最大 + ']')
        放路径(文, 路径, 落)
      }
      已改.push({ 路径, 值: 取路径(文, 路径) })
    }
    写门控原文(文)
    return { ok: true, 已改, 生效: '下一次调用即生效（门控配置热读）' }
  } catch (e) {
    try { 写门控原文(JSON.parse(回滚)) } catch {}
    return { ok: false, 原因: String(e.message || e), 已回滚: true }
  }
}

// ═══════════════════════ ④ 跑自检 ═══════════════════════
function 跑自检() {
  return new Promise(解决 => {
    const 开始 = Date.now()
    const 子 = spawn(process.execPath, [path.join(根目录, '验收', '一键跑.js')], {
      cwd: 根目录, env: Object.assign({}, process.env, { 鲸鱼面板内跑: '1' })
    })
    let 出 = ''
    let 错 = ''
    let 已结束 = false
    const 收尾 = (码, 超时) => {
      if (已结束) return
      已结束 = true
      解决({
        ok: 码 === 0, 退出码: 码, 耗时毫秒: Date.now() - 开始,
        超时: !!超时,
        输出: 出.slice(-20000),
        错误输出: 错.slice(-4000)
      })
    }
    const 定时 = setTimeout(() => { try { 子.kill() } catch {} 收尾(null, true) }, 5 * 60 * 1000)
    子.stdout.on('data', d => { 出 += d.toString('utf8') })
    子.stderr.on('data', d => { 错 += d.toString('utf8') })
    子.on('close', 码 => { clearTimeout(定时); 收尾(码, false) })
    子.on('error', e => { clearTimeout(定时); 错 += String(e.message || e); 收尾(-1, false) })
  })
}

// ═══════════════════════ ⑤ 装配语义后端（可选·慢） ═══════════════════════
let _装配中 = null
async function 装配后端() {
  if (!后端) return { ok: false, 原因: '向量后端模块不可用' }
  if (_装配中) return _装配中
  _装配中 = (async () => {
    try {
      const r = await 后端.自动装配({})
      return { ok: !!(r && r.ok), 结果: r }
    } catch (e) {
      return { ok: false, 原因: String(e.message || e) }
    } finally {
      setTimeout(() => { _装配中 = null }, 1000)
    }
  })()
  return _装配中
}

// ═══════════════════════ 路由 ═══════════════════════
const 首页路径 = path.join(__dirname, '首页.html')

async function 处理(req, res) {
  const u = new URL(req.url, 'http://' + 主机 + ':' + 端口)
  let 路 = u.pathname
  try { 路 = decodeURIComponent(路) } catch {}
  // 接口路径一律用 ASCII：非英语客户端（cmd/curl）发的可能是 GBK 字节，
  // 中文路由在不同客户端下会变成两套编码。中文只留在注释和界面文案里。
  const 法 = req.method

  if (路 === '/' || 路 === '/首页.html') {
    try {
      const 文 = fs.readFileSync(首页路径, 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(文)
    } catch (e) { return 发JSON(res, 500, { ok: false, 原因: '首页.html 读不到：' + e.message }) }
  }

  if (路 === '/api/state' && 法 === 'GET') {
    // 【为什么在这里等一次后端】后端只在「首次入库/首次检索」时自动装配（存储适配器 确保后端 只跑一次）。
    // 不在这里等：人刚开面板、还没入库，总览就自报「bigram 哈希 256 / 注入 false」——
    // 陌生人第一眼以为随包的 23MB 模型没生效，第一印象直接掉档。
    // 代价：进程冷启动后第一次打开总览多约 0.2～1s（模型加载一次，之后走缓存 Promise）。
    // 纪律不变：装配失败也只是降级成哈希兜底并写进 后端.降级，绝不让面板倒下。
    if (存储 && typeof 存储.确保后端 === 'function') {
      try { await 存储.确保后端() } catch { /* 装配失败不阻断总览 */ }
    }
    return 发JSON(res, 200, 取状态())
  }

  if (路 === '/api/params' && 法 === 'GET') {
    if (!参数) return 发JSON(res, 500, { ok: false, 原因: '内核参数模块不可用' })
    return 发JSON(res, 200, 参数.面板数据())
  }

  if (路 === '/api/params' && 法 === 'POST') {
    if (!参数) return 发JSON(res, 500, { ok: false, 原因: '内核参数模块不可用' })
    const 体 = await 读体(req)
    const 改动 = 体.值 || 体
    const r = 参数.写(改动)
    // 联动：交集判定值 与 门控 gates.cross3.k 是同一个概念的两端，一起改，别让人拧出一个永远提不出话的组合
    if (r.ok && 改动 && 改动['候选映射.交集判定值'] !== undefined) {
      try {
        const 同步 = 写门控([{ 路径: 'gates.cross3.k', 值: 改动['候选映射.交集判定值'] }])
        r.联动 = 同步.ok ? { 已同步: '门控策略.json → gates.cross3.k = ' + 同步.已改[0].值 } : { 失败: 同步.原因 }
      } catch (e) { r.联动 = { 失败: String(e.message || e) } }
    }
    return 发JSON(res, r.ok ? 200 : 400, r)
  }

  if (路 === '/api/params/reset' && 法 === 'POST') {
    if (!参数) return 发JSON(res, 500, { ok: false, 原因: '内核参数模块不可用' })
    return 发JSON(res, 200, 参数.恢复出厂())
  }

  if (路 === '/api/gate' && 法 === 'GET') {
    try { return 发JSON(res, 200, 取门控面板()) } catch (e) { return 发JSON(res, 500, { ok: false, 原因: String(e.message || e) }) }
  }

  if (路 === '/api/gate' && 法 === 'POST') {
    const 体 = await 读体(req)
    const 改动们 = Array.isArray(体.改动) ? 体.改动 : []
    if (!改动们.length) return 发JSON(res, 400, { ok: false, 原因: '改动为空' })
    try { const r = 写门控(改动们); return 发JSON(res, r.ok ? 200 : 400, r) } catch (e) { return 发JSON(res, 500, { ok: false, 原因: String(e.message || e) }) }  }

  if (路 === '/api/recall' && 法 === 'POST') {
    try {
      const 体 = await 读体(req)
      return 发JSON(res, 200, await 翻原话(体.文本))
    } catch (e) { return 发JSON(res, 500, { ok: false, 原因: String(e.message || e) }) }
  }

  if (路 === '/api/selfcheck' && 法 === 'POST') {
    try { return 发JSON(res, 200, await 跑自检()) } catch (e) { return 发JSON(res, 500, { ok: false, 原因: String(e.message || e) }) }
  }

  if (路 === '/api/backend' && 法 === 'POST') {
    try { return 发JSON(res, 200, await 装配后端()) } catch (e) { return 发JSON(res, 500, { ok: false, 原因: String(e.message || e) }) }
  }

  发JSON(res, 404, { ok: false, 原因: '没有这个接口：' + 法 + ' ' + 路 })
}

const 服务 = http.createServer((req, res) => {
  // 同源防线：写接口只认本面板自己的来源（跨站 preflight 无 CORS 头 → 直接撞墙）
  const 源 = req.headers.origin
  if (源 && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(源)) {
    return 发JSON(res, 403, { ok: false, 原因: '面板只服务本机（127.0.0.1），拒绝跨源请求' })
  }
  处理(req, res).catch(e => {
    try { 发JSON(res, 500, { ok: false, 原因: String((e && e.message) || e) }) } catch {}
  })
})

服务.on('error', e => {
  if (e && e.code === 'EADDRINUSE') {
    console.log('')
    console.log('  端口 ' + 端口 + ' 已被占用——面板可能已经起过了。')
    console.log('  直接打开 http://' + 主机 + ':' + 端口 + '；或设环境变量 鲸鱼面板端口=xxxx 换一个。')
    console.log('')
    process.exit(1)
  }
  throw e
})

服务.listen(端口, 主机, () => {
  console.log('')
  console.log('  🐋 会记得你的鲸鱼 · 内核面板')
  console.log('  ───────────────────────────────────────────')
  console.log('  地址：http://' + 主机 + ':' + 端口)
  console.log('  只绑本机，不对外。按 Ctrl+C 关掉，不留后台进程。')
  console.log('')
})

process.on('SIGINT', () => { console.log('\n  面板已关闭。'); 服务.close(() => process.exit(0)); setTimeout(() => process.exit(0), 800) })
