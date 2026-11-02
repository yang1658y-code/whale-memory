#!/usr/bin/env node
'use strict'
/**
 * 面板冒烟验收.js —— L9：面板这个东西，改坏了必须有人喊
 * ════════════════════════════════════════════════════════════════
 * 【它解决的到底是什么问题】
 *   改之前，面板/服务.js（22KB）+ 面板/首页.html（45KB）在验收里 0 命中。
 *   面板是陌生人除了 QQ 之外唯一看得见的界面，改坏了 selfcheck 照样全绿——
 *   绿的是内核，坏的是门面，人第一眼看到的就是坏的那半。
 *
 * 【它验什么】（十条，全是真起进程真发请求，不打桩）
 *   P01 首页 200，HTML 里四个页签都在（总览/翻原话/拧参数/跑自检）
 *   P02 首页零外链（面板要能离线打开，不许引 CDN）
 *   P03 /api/state 200，关键键都在（版本/后端/向量库/原文表）
 *   P04 /api/state 的后端已真装配（注入=true）——防「首屏自报哈希兜底」
 *   P05 /api/params 200，参数量 > 0 且每条字段齐（键/名/默认/当前/档）
 *   P06 /api/gate 200，门控白名单非空
 *   P07 未知路径 404 且回 JSON（不许吐 HTML 堆栈）
 *   P08 未知参数名写不进去（POST 被拒，且配置文件 mtime 不变）
 *   P09 面板只绑 127.0.0.1（源码里不许出现 0.0.0.0）
 *   P10 收到 SIGTERM 能干净退出，端口释放
 *
 * 【纪律】
 *   ① 不碰真数据：只 GET，另加一次「必然被拒」的 POST（不改盘）。
 *   ② 自带端口（默认 19437，可用环境变量 鲸鱼冒烟端口 换），不抢 9337。
 *   ③ 永远收尾杀进程，失败也杀。
 *
 * 跑法：node 验收/面板冒烟验收.js [--静默]
 */

const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

const 根目录 = path.join(__dirname, '..')
const 静默 = process.argv.includes('--静默')
const 主机 = '127.0.0.1'
const 端口 = Number(process.env.鲸鱼冒烟端口) || 19437
const 基址 = 'http://' + 主机 + ':' + 端口

const 结果清单 = []
function 报(编号, 名称, 通过, 详情) {
  结果清单.push({ 编号, 名称, 通过: !!通过, 详情 })
  if (!静默) console.log((通过 ? '✅' : '❌') + ' [' + 编号 + '] ' + 名称 + (详情 ? '\n     ' + String(详情).replace(/\n/g, '\n     ') : ''))
}

const 睡 = (毫秒) => new Promise(r => setTimeout(r, 毫秒))

async function 取(路, 选项 = {}) {
  const r = await fetch(基址 + 路, Object.assign({ signal: AbortSignal.timeout(120000) }, 选项))
  const 文 = await r.text()
  let 体 = null
  try { 体 = JSON.parse(文) } catch { }
  return { 码: r.status, 文, 体, 头: r.headers }
}

async function 主() {
  // ── 起面板 ──
  const 子 = spawn(process.execPath, [path.join(根目录, '面板', '服务.js')], {
    cwd: 根目录,
    env: Object.assign({}, process.env, { 鲸鱼面板端口: String(端口) }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let 子输出 = ''
  子.stdout.on('data', d => { 子输出 += d.toString('utf8') })
  子.stderr.on('data', d => { 子输出 += d.toString('utf8') })
  let 子退出 = false
  子.on('exit', () => { 子退出 = true })

  try {
    // ── 等就绪：/api/state 是面板最重的接口（要装配模型），通了就算起来了 ──
    let 就绪 = false
    const 起 = Date.now()
    for (let i = 0; i < 120; i++) {
      if (子退出) break
      try {
        const r = await 取('/api/state')
        if (r.码 === 200) { 就绪 = true; break }
      } catch { }
      await 睡(500)
    }
    if (!就绪) {
      报('P00', '面板能在 60s 内起来', false,
        '起不来，子进程输出末尾：\n' + 子输出.trim().split('\n').slice(-8).join('\n'))
      return
    }
    const 就绪秒 = ((Date.now() - 起) / 1000).toFixed(1)

    // ── P01 首页 + 四页签 ──
    const 页 = await 取('/')
    const 页签 = ['总览', '翻原话', '拧参数', '跑自检']
    const 缺页签 = 页签.filter(t => !页.文.includes('data-页="' + t + '"'))
    报('P01', '首页 200 且四个页签齐全', 页.码 === 200 && 缺页签.length === 0,
      页.码 !== 200 ? 'HTTP ' + 页.码 : (缺页签.length ? '缺页签：' + 缺页签.join('、') : 'HTML ' + 页.文.length + ' 字符，四页签都在（就绪 ' + 就绪秒 + 's）'))

    // ── P02 零外链 ──
    const 外链 = (页.文.match(/https?:\/\/[^"'\s)>]+/g) || []).filter(u => !u.includes(主机) && !u.includes('localhost'))
    报('P02', '首页零外链（可纯离线打开）', 外链.length === 0, 外链.length ? '发现外链：' + 外链.slice(0, 5).join(' ' ) : '无 http/https 外链')

    // ── P03 总览关键键 ──
    const 态 = await 取('/api/state')
    const 要 = ['版本', '后端', '向量库', '原文表']
    const 缺 = 要.filter(k => !(态.体 && 态.体[k] !== undefined))
    报('P03', '/api/state 200 且关键键齐全', 态.码 === 200 && 缺.length === 0,
      缺.length ? '缺键：' + 缺.join('、') + '｜实收：' + Object.keys(态.体 || {}).join(',') : '版本 ' + (态.体.版本) + '｜后端 ' + JSON.stringify(态.体.后端))

    // ── P04 后端已真装配（这一条是「首屏不许自报哈希兜底」的哨兵）──
    const 后端 = (态.体 && 态.体.后端) || {}
    报('P04', '总览后端已真装配（注入=true）', 后端.注入 === true,
      '注入=' + 后端.注入 + '｜模式=' + 后端.模式 + '｜模型ID=' + 后端.模型ID +
      (后端.注入 === true ? '' : '　← 面板首次打开就自报兜底，陌生人会以为随包模型没生效'))

    // ── P05 参数面板 ──
    const 参 = await 取('/api/params')
    const 参数们 = (参.体 && Array.isArray(参.体.参数)) ? 参.体.参数 : []
    const 字段缺 = 参数们.filter(p => p.键 === undefined || p.名 === undefined || p.默认 === undefined || p.当前 === undefined || p.档 === undefined)
    报('P05', '/api/params 成分完整', 参.码 === 200 && 参数们.length > 0 && 字段缺.length === 0,
      参.码 !== 200 ? 'HTTP ' + 参.码 : '参数 ' + 参数们.length + ' 条' + (字段缺.length ? '｜缺字段 ' + 字段缺.length + ' 条（首例 ' + 字段缺[0].键 + '）' : '｜每条的 键/名/默认/当前/档 都在'))

    // ── P06 门控白名单 ──
    const 门 = await 取('/api/gate')
    const 门体 = 门.体 || {}
    const 门项 = Array.isArray(门体.项) ? 门体.项.length : (Array.isArray(门体.参数) ? 门体.参数.length : (Array.isArray(门体.清单) ? 门体.清单.length : 0))
    报('P06', '/api/gate 200 且白名单非空', 门.码 === 200 && 门体.ok !== false && 门项 > 0,
      'HTTP ' + 门.码 + '｜ok=' + 门体.ok + '｜项数=' + 门项 + '｜键=' + Object.keys(门体).slice(0, 6).join(','))

    // ── P07 未知路径 404 + JSON ──
    const 野 = await 取('/api/不存在的接口-冒烟')
    报('P07', '未知路径回 404 且是 JSON', 野.码 === 404 && !!野.体 && 野.体.ok === false,
      'HTTP ' + 野.码 + '｜体=' + 野.文.slice(0, 60).replace(/\n/g, ' '))

    // ── P08 未知参数名必须被拒，且不许动盘 ──
    const 参文件 = path.join(根目录, '配置', '参数.json')
    let 前mtime = -1
    try { 前mtime = fs.statSync(参文件).mtimeMs } catch { }
    const 写试 = await 取('/api/params', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 值: { '__冒烟不存在.的键': 1 } })
    })
    let 后mtime = -1
    try { 后mtime = fs.statSync(参文件).mtimeMs } catch { }
    报('P08', '未知参数名被拒且不动配置文件', 写试.码 === 400 && 前mtime === 后mtime,
      'HTTP ' + 写试.码 + '｜配置文件 mtime ' + (前mtime === 后mtime ? '未变' : '变了 ← 被野键写进去了'))

    // ── P09 只绑本机 ──
    // 注意：不能全文搜 0.0.0.0 —— 文件头注释里就写着「绝不 0.0.0.0」，那是禁令本身，不是代码。
    // 只看真代码行（剔掉整行注释），并真取 主机 常量的值。
    const 源 = fs.readFileSync(path.join(根目录, '面板', '服务.js'), 'utf8')
    const 代码行 = 源.split('\n').filter(l => {
      const t = l.trim()
      return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    const 有公网 = 代码行.some(l => l.includes('0.0.0.0'))
    const 主 = /const\s+主机\s*=\s*'([^']+)'/.exec(源)
    const 主值 = 主 ? 主[1] : '(没找到 const 主机)'
    报('P09', '面板只绑 127.0.0.1（代码里无 0.0.0.0）', !有公网 && 主值 === '127.0.0.1',
      '主机常量=' + 主值 + '｜代码行含 0.0.0.0=' + 有公网 + (有公网 ? '　← 面板能写配置，绝不能上公网' : ''))

    // ── P10 收尾：SIGTERM 能干净退出 ──
    子.kill()
    const 死线 = Date.now() + 6000
    while (!子退出 && Date.now() < 死线) await 睡(100)
    let 端口释放 = false
    if (子退出) {
      try {
        await fetch(基址 + '/api/state', { signal: AbortSignal.timeout(1200) })
      } catch { 端口释放 = true }
    }
    报('P10', '收到停止信号能干净退出', 子退出 && 端口释放,
      '子进程退出=' + 子退出 + '｜端口已释放=' + 端口释放)
  } finally {
    // 无论成败都杀：验收绝不许留一个占端口的面板在后台
    try { if (!子退出) 子.kill('SIGKILL') } catch { }
  }
}

主().catch(e => {
  报('P99', '冒烟脚本自身不崩', false, String((e && e.stack) || e))
}).finally(() => {
  const 通过 = 结果清单.filter(r => r.通过).length
  const 总数 = 结果清单.length
  console.log('\n' + '═'.repeat(64))
  console.log('面板冒烟验收（L9）：' + (通过 === 总数 ? '全部通过 ✅' : '有失败 ❌'))
  for (const r of 结果清单.filter(x => !x.通过)) console.log('  ✗ [' + r.编号 + '] ' + r.名称 + ' — ' + String(r.详情 || '').slice(0, 200))
  console.log('═'.repeat(64))
  require('./断言报告.js').报(通过, Math.max(总数, 10))
  try {
    fs.writeFileSync(path.join(__dirname, '面板冒烟验收结果.json'), JSON.stringify({
      时间: new Date().toISOString(), 通过, 总数, 明细: 结果清单
    }, null, 2), 'utf8')
  } catch { }
  process.exit(通过 === 总数 && 总数 >= 10 ? 0 : 1)
})
