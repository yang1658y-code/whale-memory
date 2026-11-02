#!/usr/bin/env node
'use strict'
/**
 * 代建.js · 「人只扫码，机器把机器人建出来」
 *
 * 背景（2026-11-02 真机）：
 *   腾讯的 AppSecret **只在「创建成功那一屏」明文出现一次**，一重渲染就永久掩码，
 *   事后只能靠「重置」（不可逆）——那条路我们永不走。
 *   所以唯一正解是：**人扫码登录 → 机器立刻代点创建 → 人不在也没关系，机器盯着抄走**。
 *
 * 本脚本干的活（一条龙）：
 *   ① 接上已开的独立窗口（端口 9334，配置/浏览器配置-新号）
 *   ② 等新号扫码登录（人只做这一步）
 *   ③ 登录后**代点「创建机器人」**（真实鼠标点击，不是 el.click）
 *   ④ 点完「创建机器人」后**同时等两种结局，谁先到算谁**：
 *      ① 一键直建：腾讯自己建好、名字自动生成、当场给明文 AppSecret（2026-11-02 实测走这条）
 *      ② 填名表单：填名字（默认「会记得你的鲸鱼」）→ 点提交（旧版/别的账号类型走这条）
 *   ⑤ 盯住所有 q.qq.com 标签页，一出现明文 AppSecret 立刻抄走
 *   ⑥ 落盘 临时/代建结果.json（含 appId/appSecret/现场结构），不碰 配置/qq.json
 *
 * 用法：
 *   node 适配器/qq/安装/代建.js                      一条龙（默认端口 9334）
 *   node 适配器/qq/安装/代建.js --只看                只点到「创建页并填好名字」，不提交
 *   node 适配器/qq/安装/代建.js --名字 鲸鱼           换名字
 *   node 适配器/qq/安装/代建.js --端口 9334 --超时 900
 *   node 适配器/qq/安装/代建.js --建后等 45     点完「创建机器人」后等结果多少秒（默认 45）
 *
 * ⛔ 三条禁忌（写死，不提供开关）：
 *   1. 永不点「确认重置」——不可逆，会把在用密钥当场废掉
 *   2. 永不删机器人
 *   3. 永不覆盖 配置/qq.json —— 结果只落 临时/，由人确认后再换源
 */
const fs = require('fs')
const path = require('path')
const 浏 = require('./浏览器.js')
const 登 = require('./登录态.js')
const 抄 = require('./抄凭据.js')

const 根 = path.join(__dirname, '..', '..', '..')
const 临时 = path.join(根, '临时')

const 参 = process.argv.slice(2)
const 有 = (n) => 参.includes('--' + n)
const 取 = (n, d = null) => { const i = 参.indexOf('--' + n); return i >= 0 && 参[i + 1] ? 参[i + 1] : d }

// ── 两个可被编排器覆盖的路径（2026-11-02 加，为「一键装.js」串全链用）──
// 【为什么要能改】一键装要把「代建拿到的 appId/secret」直接喂给写配置那一步，
//   它必须能用**同一份 profile**（否则代建自己另开一个窗口，人还得再扫一次），
//   并读**自己那一份结果文件**（否则会读到上一轮遗留的成功结果，把旧凭据当新凭据写进配置）。
//   默认值一个都没动：单独跑 `node 代建.js` 的行为与从前完全一致。
const 结果文件 = 取('结果文件', '') ? path.resolve(根, 取('结果文件')) : path.join(临时, '代建结果.json')
const 数据目录 = 取('数据目录', '') ? path.resolve(根, 取('数据目录')) : path.join(根, '配置', '浏览器配置-新号')
const 端口 = Number(取('端口', '9334')) || 9334
const 名字 = 取('名字', '会记得你的鲸鱼')
const 超时秒 = Number(取('超时', '900')) || 900
const 建后等秒 = Number(取('建后等', '45')) || 45
const 只看 = 有('只看')

const 打印 = (级, 文) => {
  const 标 = { 步: '▸', 好: '✅', 坏: '❌', 等: '⏳', 注: '·', 喜: '🎉', 网: '🌐' }[级] || '·'
  console.log(new Date().toISOString().slice(11, 19) + ' ' + 标 + ' ' + 文)
}
const 落盘 = (o) => {
  try {
    fs.mkdirSync(临时, { recursive: true })
    fs.writeFileSync(结果文件, JSON.stringify(Object.assign({ 时间: new Date().toISOString() }, o), null, 2), 'utf8')
  } catch (e) { 打印('坏', '落盘失败：' + String(e.message || e)) }
}
let 当前态 = { 阶段: '启动中' }

// ── 统一收尾 ────────────────────────────────────────────
// 2026-11-02 现场：代建跑完 → 子进程退出码 3221226505（0xC0000409），stderr 一行
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`。原因：CDP 的 ws 还在半关，
// 就硬 process.exit，libuv 在 Windows 上直接 fastfail，父进程以为崩了。
// 所以：先关 ws，留一拍 → 再退。
const 现场 = { 连: null, 已退: false }
async function 收尾退出(码) {
  if (现场.已退) return
  现场.已退 = true
  try { if (现场.连 && 现场.连.关) 现场.连.关() } catch { /* 已断 */ }
  await 浏.睡(250)
  process.exit(码)
}
const 设阶段 = (阶, 附) => { 当前态 = Object.assign({ 阶段: 阶 }, 附 || {}); 落盘(当前态) }
const 心跳 = setInterval(() => { try { 落盘(当前态) } catch { /* 心跳失败不该断主流程 */ } }, 2000)
if (心跳.unref) 心跳.unref()

/** 安全求值 */
const 求 = async (连, 表达式) => {
  const r = await 连.发('Runtime.evaluate', { expression: 表达式, returnByValue: true, awaitPromise: true }).catch(() => null)
  if (!r || r.exceptionDetails) return null
  return r.result ? r.result.value : null
}

const 取正文 = async (连) => String(await 求(连, 'document.body ? (document.body.innerText || "") : ""') || '')

/** 让浏览器按真实鼠标点一下（React 只认这个，el.click() 在部分遮罩层下会被吞） */
async function 真点(连, 表达式) {
  const 坐 = await 求(连, `(() => {
    const el = (${表达式});
    if (!el) return null;
    el.scrollIntoView({block:'center'});
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height, t: (el.innerText||'').trim().slice(0,40)});
  })()`)
  let p = null
  try { p = JSON.parse(坐) } catch { p = null }
  if (!p) return { ok: false, 说明: '找不到可见的可点元素' }
  try {
    await 连.发('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' })
    await 连.发('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await 浏.睡(60)
    await 连.发('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    return { ok: true, 文案: p.t, 坐标: { x: Math.round(p.x), y: Math.round(p.y) }, 方法: '真鼠标' }
  } catch (e) {
    // 兜底：合成 click（验证过在列表页的按钮上有效）
    const 兜 = await 求(连, `(() => { const el = (${表达式}); if (!el) return false; el.click(); return true })()`)
    return { ok: !!兜, 文案: p.t, 方法: '合成click' }
  }
}

/** 找「创建机器人」按钮的表达式（文案优先，退而求其次用 href / 类名） */
const 建钮表达式 = `(() => {
  const 钮 = [...document.querySelectorAll('button,[role=button],a,.xui-button,.xui-btn,span,div')]
    .filter(e => {
      const t = (e.innerText || '').replace(/\\s+/g,'').trim();
      if (t !== '创建机器人' && t !== '新建机器人' && t !== '创建QQ机器人') return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  // 取最内层那个（外层 div 也会匹配到同样文案，点外层可能点偏）
  return 钮.length ? 钮[钮.length - 1] : null;
})()`

/** 抓创建页表单结构（给下一轮/人工看，也用于自动填） */
async function 抓表单(连) {
  const 原 = await 求(连, `JSON.stringify((() => {
    const 字 = [...document.querySelectorAll('input,textarea')].map((e, i) => {
      const 邻 = (() => { let b = e, n = 0; while (b && n < 5) { const t = (b.innerText || '').trim(); if (t) return t.slice(0, 40); b = b.parentElement; n++ } return '' })();
      return { 序: i, 类型: e.type || e.tagName.toLowerCase(), 占位: e.placeholder || '', 值: e.value || '', 只读: !!e.readOnly, 可见: !!(e.getBoundingClientRect().width), 邻文: 邻 };
    });
    const 钮 = [...document.querySelectorAll('button,[role=button],.xui-button,.xui-btn,a')]
      .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
      .map(e => (e.innerText || '').replace(/\\s+/g,' ').trim()).filter(Boolean).slice(0, 60);
    return { 字, 钮, 标题: document.title, URL: location.href };
  })())`)
  let 表 = null
  try { 表 = JSON.parse(原) } catch { 表 = null }
  return 表 || { 字: [], 钮: [], 标题: '', URL: '' }
}

/** 填一个 input（React 受控组件必须走原生 setter + input 事件） */
async function 填字(连, 元素表达式, 值) {
  const 码 = `(() => {
    const el = (${元素表达式});
    if (!el) return '没找到元素';
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    el.focus();
    setter.call(el, ${JSON.stringify(值)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    return el.value;
  })()`
  return await 求(连, 码)
}

/** 找到「名字」那个输入框的表达式 */
const 名字框表达式 = `(() => {
  const 全 = [...document.querySelectorAll('input:not([type=hidden]),textarea')].filter(e => e.getBoundingClientRect().width > 0 && !e.readOnly);
  const 明 = 全.find(e => /名称|名字|昵称|机器人名/.test(e.placeholder || ''));
  if (明) return 明;
  // 退一步：找 label 里带「名称」的
  for (const e of 全) {
    let b = e, n = 0;
    while (b && n < 5) { if (/名称|名字|昵称/.test(b.innerText || '')) return e; b = b.parentElement; n++ }
  }
  return 全[0] || null;
})()`

/** 抓所有 q.qq.com 页的现场（正文 + 表单），失败时存档用 */
async function 抓快照(端口) {
  const 列 = await 浏.列页(端口).catch(() => [])
  const 页z = (列 || []).filter(p => p && p.type === 'page' && /q\.qq\.com/.test(p.url || ''))
  const 快照 = []
  for (const p of 页z) {
    const c = await 浏.连接(p.webSocketDebuggerUrl || p.wsDebuggerUrl).catch(() => null)
    if (!c || !c.ok) continue
    const 文 = await 取正文(c)
    快照.push({ url: p.url, 正文: 文.slice(0, 1200), 表单: await 抓表单(c) })
    c.关()
  }
  return 快照
}

/**
 * 点完「创建机器人」之后等两种结局，谁先到算谁：
 *   ① '明文' —— 一键直建：腾讯自己建好、名字自动生成、当场给 AppID/AppSecret（2026-11-02 实测这条）
 *   ② '表单' —— 旧路线：给一张要填名字的表单
 *   ③ '无'   —— 都没等到（没渲染完 / 被踢回登录页 / 要实名）
 *
 * ⛔ 老代码只认②，所以在①的机器上必然报「这一页没有输入框」失败退出——
 *    而机器人其实已经建好、secret 也已经闪过去了。今天第三条误判，在此修掉。
 *
 * 只认「名称/名字/昵称」这类框，纯搜索框不算表单（否则列表页的搜索框会被当成创建表单）。
 */
async function 等明文或表单(端口, 秒) {
  const 起 = Date.now()
  let 末表 = { 字: [], 钮: [], 标题: '', URL: '' }
  let 末文 = ''
  while (Date.now() - 起 < 秒 * 1000) {
    const 列 = await 浏.列页(端口).catch(() => null)
    const 页们 = (列 || []).filter(p => p && p.type === 'page' && /q\.qq\.com/.test(p.url || ''))
    for (const p of 页们) {
      const c = await 浏.连接(p.webSocketDebuggerUrl || p.wsDebuggerUrl).catch(() => null)
      if (!c || !c.ok) continue
      let 文 = ''
      try { 文 = await 取正文(c) } catch { 文 = '' }
      const 命中 = 抄.抠明文(文)
      if (命中.length) {
        const 名 = ((文.match(/机器人\s*[A-Za-z0-9_-]{4,}/) || [''])[0] || '').replace(/\s+/g, '')
        c.关()
        return { 类型: '明文', 命中: 命中[0], 全部: 命中, 机器人名: 名, 来源页: p.url, 正文: 文.slice(0, 1500), 等了秒: +((Date.now() - 起) / 1000).toFixed(1) }
      }
      const 表 = await 抓表单(c)
      c.关()
      末表 = 表; 末文 = 文
      const 有名字框 = 表.字.some(x => x.可见 && !x.只读 && /名称|名字|昵称/.test((x.占位 || '') + (x.邻文 || '')))
      if (有名字框) return { 类型: '表单', 表单: 表, 来源页: p.url, 等了秒: +((Date.now() - 起) / 1000).toFixed(1) }
    }
    await 浏.睡(1200)
  }
  return { 类型: '无', 表单: 末表, 正文: 末文.slice(0, 1500), 等了秒: +((Date.now() - 起) / 1000).toFixed(1) }
}

;(async () => {
  fs.mkdirSync(临时, { recursive: true })
  设阶段('启动中')

  // ① 接窗口（活着就复用，不重开）
  const 找 = 浏.找浏览器()
  if (!找.ok) { 打印('坏', 找.说明); 设阶段('失败', { 原因: 找.说明 }); await 收尾退出(1) }
  const 启 = await 浏.启动({ 路径: 找.路径, 端口, 数据目录, 起始页: 登.后台入口 })
  if (!启.ok) { 打印('坏', '起窗口失败：' + 启.说明); 设阶段('失败', { 原因: 启.说明 }); await 收尾退出(1) }
  打印('好', (启.复用 ? '接上已开窗口' : '窗口已起') + '｜端口 ' + 启.端口 + '｜独立配置 ' + 启.数据目录)

  // ② 找到 q.qq.com 的页面并连上（复用已有标签页，别开一堆）
  const 挑页 = async () => {
    const 列 = await 浏.列页(端口).catch(() => [])
    const 页们 = (列 || []).filter(p => p && p.type === 'page' && /q\.qq\.com/.test(p.url || ''))
    return 页们
  }
  let 页们 = await 挑页()
  if (!页们.length) {
    const 开 = await 浏.开页(端口, 登.后台入口)
    if (!开.ok) { 打印('坏', '开页失败：' + 开.说明); 设阶段('失败', { 原因: 开.说明 }); await 收尾退出(1) }
    await 浏.睡(2500)
    页们 = await 挑页()
  }
  let 页 = 页们[页们.length - 1]
  let 连 = 现场.连 = await 浏.连接(页.webSocketDebuggerUrl)
  if (!连.ok) { 打印('坏', '连不上页面：' + 连.说明); 设阶段('失败', { 原因: 连.说明 }); await 收尾退出(1) }
  await 连.发('Page.enable').catch(() => {})
  await 连.发('Runtime.enable').catch(() => {})

  // ③ 等登录（人只做这一步）
  let 态 = await 登.检测(连)
  打印(态.已登录 ? '好' : '注', '登录态：' + (态.已登录 === true ? '已登录' : 态.已登录 === false ? '未登录' : '看不出') + ' —— ' + 态.判据)
  if (态.已登录 !== true) {
    console.log('')
    console.log('  ══════ 请用「新 QQ 号」在窗口里扫码 ══════')
    console.log('   扫完什么都不用点。机器人在线等着，登录成功自己就点「创建机器人」了。')
    console.log('  ══════════════════════════════════════════')
    console.log('')
    设阶段('等扫码', { 端口, 落地: 态.落地URL, 名字 })
    打印('等', '等扫码（最多 ' + 超时秒 + ' 秒）…')
    // 页面可能自己跳转/换 target，整轮重新挑页
    const 起 = Date.now()
    let 成 = false
    while (Date.now() - 起 < 超时秒 * 1000) {
      页们 = await 挑页()
      for (const p of 页们) {
        const c = await 浏.连接(p.webSocketDebuggerUrl).catch(() => null)
        if (!c || !c.ok) continue
        const 判 = await 登.检测(c)
        if (判.已登录 === true) {
          if (连) 连.关()
          连 = c; 现场.连 = 连; 页 = p; 态 = 判; 成 = true
          break
        }
        c.关()
      }
      if (成) break
      await 浏.睡(2000)
    }
    if (!成) { 打印('坏', '等到超时也没登录'); 设阶段('超时未登录', { 端口 }); await 收尾退出(3) }
    打印('喜', '登录成功（等了 ' + Math.round((Date.now() - 起) / 1000) + ' 秒）')
  }

  await 浏.睡(2000)
  let 正文 = await 取正文(连)
  设阶段('已登录', { 端口, 名字, 正文头: 正文.slice(0, 200) })
  打印('注', '当前页：' + (await 求(连, 'location.href')))

  // ④ 代点「创建机器人」（若列表页已有按钮）
  let 点态 = { ok: false, 说明: '页面上没有「创建机器人」按钮' }
  const 已有 = await 求(连, `!!(${建钮表达式})`)
  if (已有) {
    const 点前 = new Set((await 浏.列页(端口)).map(p => p.id))
    点态 = await 真点(连, 建钮表达式)
    打印(点态.ok ? '好' : '坏', '点「创建机器人」：' + (点态.ok ? '已点（' + 点态.方法 + '，坐标 ' + JSON.stringify(点态.坐标) + '）' : 点态.说明))
    await 浏.睡(3500)
    // 可能新开页
    const 新页 = (await 浏.列页(端口)).filter(p => p.type === 'page' && !点前.has(p.id) && /q\.qq\.com/.test(p.url || ''))
    if (新页.length) {
      打印('注', '腾讯新开了 ' + 新页.length + ' 页：' + 新页.map(p => (p.url || '').slice(0, 80)).join(' ｜ '))
      const c = await 浏.连接(新页[新页.length - 1].webSocketDebuggerUrl)
      if (c.ok) { await c.发('Page.enable').catch(() => {}); await c.发('Runtime.enable').catch(() => {}); if (连) 连.关(); 连 = c; 现场.连 = 连; 页 = 新页[新页.length - 1] }
    }
    await 浏.睡(1500)
  } else {
    打印('注', '这一页没有「创建机器人」按钮，先抓现场看看')
  }

  // ⑤ 点完先等「两种结局」里的任意一种 —— 别急着找输入框
  //    ⛔ 2026-11-02 实测：腾讯是**一键直建**，名字自动生成，压根不给填名的机会；
  //       老代码硬找输入框 → 报「这一页没有输入框」失败退出，而机器人其实已经建好、secret 已经闪过去了。
  let 落址 = await 求(连, 'location.href')
  打印('等', '等「明文 AppSecret」或「填名表单」，最多 ' + 建后等秒 + ' 秒…')
  设阶段('等结果', { 端口, 名字, 落址, 点态 })
  const 等 = await 等明文或表单(端口, 建后等秒)
  打印(等.类型 === '无' ? '坏' : '好', '等到：' + (等.类型 === '明文' ? '明文 AppSecret（一键直建路线）' : 等.类型 === '表单' ? '填名表单（旧路线）' : '什么都没有') + '｜' + 等.等了秒 + ' 秒')

  // 5A 一键直建：secret 已到手，不填名、不提交，直接收工
  if (等.类型 === '明文') {
    const 出 = {
      阶段: '成功', 路线: '一键直建（腾讯自动生成名字）',
      端口, 名字: 等.机器人名 || 名字, 生成名: 等.机器人名 || '',
      落址: 等.来源页 || 落址, 点态, 提交: null,
      appId: 等.命中.appId, appSecret: 等.命中.appSecret,
      命中: 等.全部, 等了秒: 等.等了秒, 正文: 等.正文
    }
    打印('喜', 'AppID = ' + 出.appId + '｜AppSecret = ' + 出.appSecret)
    打印('注', '⛔ 别再点「查看 AppSecret」——腾讯：二次查看将会强制重置')
    设阶段('成功', 出)
    落盘(出)
    console.log('\n结果已落盘：' + 结果文件)
    await 收尾退出(0)
  }

  // 5B 什么都没等到：存档现场再退，别拿一句「没有输入框」糊弄人
  if (等.类型 === '无') {
    const 快照 = await 抓快照(端口)
    打印('坏', '既没等到明文、也没等到表单——可能还没渲染完 / 被踢回登录页 / 要实名。详见 临时/代建结果.json')
    设阶段('没进展', { 端口, 落址, 表单: 等.表单 })
    落盘({ 阶段: '没进展', 端口, 名字, 落址, 点态, 等了秒: 等.等了秒, 表单: 等.表单, 正文: 等.正文, 快照 })
    await 收尾退出(4)
  }

  // 5C 旧路线：有填名表单，接着填
  let 表 = 等.表单
  落址 = await 求(连, 'location.href') || 落址
  打印('注', '落点：' + 落址)
  打印('注', '表单：' + 表.字.length + ' 个输入框 ｜ 按钮 ' + JSON.stringify(表.钮.slice(0, 12)))
  设阶段('到了创建页', { 端口, 名字, 落址, 表单: 表 })
  落盘({ 阶段: '到了创建页', 端口, 名字, 落址, 点态, 表单: 表, 正文: (await 取正文(连)).slice(0, 2000) })

  // ⑤ 填名字
  const 填回 = await 填字(连, 名字框表达式, 名字)
  打印(填回 === 名字 ? '好' : '坏', '填名字「' + 名字 + '」→ 回读：' + JSON.stringify(填回))
  await 浏.睡(800)
  if (只看) {
    const 表2 = await 抓表单(连)
    落盘({ 阶段: '已填名·未提交', 端口, 名字, 落址, 表单: 表2 })
    打印('注', '--只看 模式，停在这里不提交')
    await 收尾退出(0)
  }

  // ⑥ 提交（找「创建/下一步/确定」）
  const 提交表达式 = `(() => {
    const 候 = ['创建', '完成创建', '下一步', '确定', '提交', '立即创建', '保存'];
    const 钮 = [...document.querySelectorAll('button,[role=button],.xui-button,.xui-btn,a')]
      .filter(e => {
        const t = (e.innerText || '').replace(/\\s+/g,'').trim();
        const r = e.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        if (e.disabled || e.getAttribute('aria-disabled') === 'true') return false;
        return 候.some(w => t === w || t === w + '机器人');
      });
    return 钮.length ? 钮[钮.length - 1] : null;
  })()`
  const 提交 = await 真点(连, 提交表达式)
  打印(提交.ok ? '好' : '注', '点提交：' + (提交.ok ? '已点「' + 提交.文案 + '」' : 提交.说明 + '（可能还要选类目/头像，等人工）'))
  设阶段('已提交', { 端口, 名字, 落址, 提交 })

  // ⑦ 盯明文（提交后可能跳页/开新 tab，逐个盯所有 q.qq.com 页）
  await 浏.睡(2500)
  打印('等', '盯明文 AppSecret（最多 300 秒）…')
  设阶段('盯明文中', { 端口, 名字, 提交 })
  const 抄到 = await 抄.盯明文(端口, {
    超时毫秒: 300 * 1000,
    每毫秒: 1500,
    进度回调: (t) => { if (t.正文头) 打印('网', '在盯：' + String(t.在 || '').replace('https://q.qq.com', '') + ' ｜ ' + t.正文头) }
  })

  const 出 = {
    阶段: 抄到.ok ? '成功' : '没抄到',
    端口, 名字, 落址, 提交, 抄录: 抄到
  }
  if (抄到.ok) {
    出.appId = 抄到.appId; 出.appSecret = 抄到.appSecret
    打印('喜', 'AppID = ' + 抄到.appId + '｜AppSecret = ' + 抄到.appSecret)
  } else {
    打印('坏', '没抄到：' + (抄到.原因 || ''))
    出.快照 = await 抓快照(端口)
  }
  设阶段(出.阶段, 出)
  落盘(出)
  console.log('\n结果已落盘：' + 结果文件)
  await 收尾退出(抄到.ok ? 0 : 4)
})().catch(async (e) => {
  打印('坏', '代建崩了：' + String(e && e.stack || e))
  落盘({ 阶段: '崩了', 原因: String(e && e.message || e) })
  await 收尾退出(1)
})
