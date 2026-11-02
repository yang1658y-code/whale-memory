#!/usr/bin/env node
'use strict'
/**
 * 抄凭据.js · 从 QQ 开放平台后台把 AppID / AppSecret 抄下来
 *
 * 唯一职责：**在已经登录的页面上，把「我的机器人」里每个机器人的 AppID 与 AppSecret 读出来。**
 *
 * 为什么单独抽一个文件：
 *   「找浏览器 / 开页 / 判登录态」是三个各自成立的活（浏览器.js / 登录态.js），
 *   而「抄凭据」才是用户真正要的那一步。混进向导里，就变成「向导一改，抄录跟着坏」。
 *
 * 抄录的两条纪律：
 *   ① **不猜**：AppSecret 页面上是掩码（******），必须点「查看」才会露真身。
 *      没点开、点开了要验证、验证没过 —— 一律返回「没抄到 + 原因」，绝不返回掩码当凭据。
 *   ② **只抄差集**：点「查看」前把页面上所有像凭据的串扫一遍，点完再扫一遍，
 *      新增的那个才是刚揭开的 secret。这样不会把 AppID、版本号、时间戳误当 secret。
 *
 * 真机结构（2026-11-02，Edge 156，q.qq.com/qqbot/openclaw/ 机器人列表）：
 *   每张卡片一段文本：`<名字>\n扫码聊天\n删除\nAppID\n<纯数字>\nAppSecret\n******\n查看`
 *
 * 【2026-11-02 真机更正 · 本条推翻了上面那句「点查看才会露真身」，很重要】
 *   点「查看」弹出来的**不是明文，是「重置AppSecret」弹窗**，原话：
 *     「出于安全考虑，AppSecret不再被明文保存，忘记密钥请点击确认重置，
 *       重置后原有AppSecret立刻失效，请谨慎操作。」
 *   ➜ 结论：**读 secret 这条路在腾讯这边已经不存在了**。想拿明文 secret 只剩一条路——
 *     **创建新机器人**（创建那一下会明文给一次）。
 *   ⛔ 本文件永不得点「确认重置」：那是不可逆的，会把还在用的密钥当场废掉。
 *     所以判据里直接把「重置AppSecret」弹窗判成「这条路不通」，而不是「要验证」。
 *   ⛔ 更不要以为「点查看看看又不会怎样」——真机上一排卡片旁边就挨着「确认重置」，
 *     误点一次那台机器的机器人就废了。凡自动化，一律只读不点重置。
 */
const 浏 = require('./浏览器.js')

/** 页面里「像凭据」的串：AppSecret 是 16~64 位字母数字（腾讯目前给 16 位） */
const 候选串正则 = /[A-Za-z0-9_-]{16,64}/g

/** 安全求值：任何异常都折成 null，抄录链路不许因为一句 evaluate 崩掉 */
async function 求(连, 表达式) {
  const r = await 连.发('Runtime.evaluate', { expression: 表达式, returnByValue: true, awaitPromise: true }).catch(() => null)
  if (!r || r.exceptionDetails) return null
  return r.result ? r.result.value : null
}

async function 取正文(连) {
  return String(await 求(连, 'document.body ? (document.body.innerText || "") : ""') || '')
}

/** 页面上所有像凭据的串（用于点前/点后做差集） */
async function 抓串(连) {
  const 文 = await 取正文(连)
  // secret 有时渲染成只读输入框（innerText 里根本不存在），所以把 value 也扫进来
  const 值 = await 求(连, 'JSON.stringify([...document.querySelectorAll("input,textarea")].map(e => e.value || "").filter(Boolean))') || '[]'
  let 表 = []
  try { 表 = JSON.parse(值) || [] } catch { 表 = [] }
  const 全 = 文 + '\n' + (Array.isArray(表) ? 表.join('\n') : '')
  return new Set(全.match(候选串正则) || [])
}

/**
 * 读「我的机器人」列表。
 * @returns {Promise<{ok, 列表?, 说明?}>}
 */
async function 读列表(连) {
  const 原 = await 求(连, `(() => {
    const 钮们 = [...document.querySelectorAll('button,[role=button],.xui-button,.xui-btn')]
      .filter(e => (e.innerText || '').trim() === '查看')
    return JSON.stringify(钮们.map((b, i) => {
      let 盒 = b, 层 = 0
      while (盒 && 层 < 8) { if (/AppID/.test(盒.innerText || '')) break; 盒 = 盒.parentElement; 层++ }
      const 文 = ((盒 && 盒.innerText) || '').replace(/\\s+/g, ' ').trim()
      const m = 文.match(/AppID\\s*(\\d{5,})/) || 文.match(/(\\d{6,})/)
      return { 序号: i, appId: m ? m[1] : '', 摘要: 文.slice(0, 200), 找到卡片: !!盒 && 层 < 8 }
    }))
  })()`)
  if (!原) return { ok: false, 说明: '读不到页面（evaluate 失败）' }
  let 列表
  try { 列表 = JSON.parse(原) } catch { return { ok: false, 说明: '列表结构解析失败：' + String(原).slice(0, 200) } }
  if (!Array.isArray(列表) || !列表.length) {
    const 文 = await 取正文(连)
    return { ok: false, 说明: '页面上没有「查看」按钮——' + (文.includes('快速开始指南') ? '当前在登录页' : '可能不在机器人列表页'), 正文: 文.slice(0, 400) }
  }
  // 兜底：浏览器里那句正则万一被转义吃掉（2026-11-02 真踩过：AppID 明明在摘要里，appId 却是空），
  // 就在 Node 侧再解析一次 —— 这里的转义层级是正常的，不会被模板字符串吃掉。
  for (const 条 of 列表) {
    if (条.appId) continue
    const 文 = String(条.摘要 || '')
    const m = 文.match(/AppID\s*(\d{5,})/i) || 文.match(/(\d{6,})/)
    if (m) 条.appId = m[1]
  }
  return { ok: true, 列表 }
}

/**
 * 点第 N 个「查看」并把新揭开的 secret 抄出来。
 *
 * @param {object} 连   CDP 连接
 * @param {number} 序号 列表下标（0 起）
 * @param {object} 账号 期望的 AppID（可选）：点开后如果卡片里的 AppID 不是它，就不认
 * @returns {Promise<{ok, appId?, appSecret?, 原因?, 新增串?, 弹层?}>}
 */
async function 点查看并抄(连, 序号 = 0, 账号 = {}) {
  const 前 = await 抓串(连)
  const 页数前 = await 求(连, 'document.querySelectorAll("iframe").length')

  const 点 = await 求(连, `(() => {
    const 钮们 = [...document.querySelectorAll('button,[role=button],.xui-button,.xui-btn')]
      .filter(e => (e.innerText || '').trim() === '查看')
    if (!钮们[${序号 | 0}]) return '序号超界：共 ' + 钮们.length
    钮们[${序号 | 0}].scrollIntoView({ block: 'center' })
    钮们[${序号 | 0}].click()
    return '已点第 ${序号 | 0} 个（共 ' + 钮们.length + '）'
  })()`)

  await 浏.睡(2000)

  const 后 = await 抓串(连)
  const 新增串 = [...后].filter(s => !前.has(s))
  const 弹层 = await 求(连, `JSON.stringify([...document.querySelectorAll('[class*=modal],[class*=dialog],[class*=popup],[role=dialog],[class*=verify]')]
    .map(e => (e.innerText || '').replace(/\\s+/g, ' ').trim()).filter(t => t.length > 8).slice(0, 4))`)
  const 页数后 = await 求(连, 'document.querySelectorAll("iframe").length')
  const 正文 = await 取正文(连)

  // 判据一：出现了新串，且长度像 secret
  const 像Secret = 新增串.filter(s => /^[A-Za-z0-9_-]{16,64}$/.test(s) && !/^\\d+$/.test(s))

  if (像Secret.length === 1) {
    return { ok: true, appSecret: 像Secret[0], 新增串, 点击: 点, 弹层: 弹层 ? JSON.parse(弹层) : [], 页数变化: [页数前, 页数后] }
  }
  if (像Secret.length > 1) {
    return { ok: false, 原因: '点开后新增了多个像 secret 的串，不敢猜是哪个', 新增串: 像Secret, 弹层: 弹层 ? JSON.parse(弹层) : [] }
  }

  // 判据二：没新串 —— 分两种，必须说清是哪一种（2026-11-02 真机分清的）
  const 弹层文 = String(弹层 || '')
  if (/重置\s*AppSecret|不再被明文保存|确认重置/.test(弹层文)) {
    return {
      ok: false,
      原因: '点「查看」弹出的是「重置AppSecret」——腾讯已不再明文保存 secret，查看=重置入口。'
        + '要拿明文 secret 只能新建机器人；本脚本绝不会去点「确认重置」，那会把还在用的密钥当场废掉。',
      点击: 点,
      弹层: 弹层 ? JSON.parse(弹层) : [],
      判据: '弹层含「重置AppSecret」',
      正文尾巴: 正文.slice(-600)
    }
  }
  const 要验证 = /验证|短信|令牌|安全|身份/.test(弹层文) || 页数后 > 页数前
  return {
    ok: false,
    原因: 要验证 ? '点开后像是要走身份验证（弹层/新页面），需要人动手' : '点开后页面上没出现新的 secret 串',
    点击: 点,
    新增串,
    弹层: 弹层 ? JSON.parse(弹层) : [],
    页数变化: [页数前, 页数后],
    正文尾巴: 正文.slice(-600)
  }
}

/**
 * 一次抄完：列表 + 指定 AppID 的 secret。
 *
 * @param {object} 连
 * @param {object} 选项 { 目标AppID } —— 不传则抄列表里第一个
 */
async function 抄(连, 选项 = {}) {
  const 列 = await 读列表(连)
  if (!列.ok) return { ok: false, 说明: 列.说明, 正文: 列.正文 }

  let 目标 = 列.列表[0]
  if (选项.目标AppID) {
    const 命中 = 列.列表.find(x => x.appId === String(选项.目标AppID))
    if (!命中) return { ok: false, 说明: '列表里找不到 AppID=' + 选项.目标AppID + ' 的机器人', 列表: 列.列表 }
    目标 = 命中
  }

  const 抄 = await 点查看并抄(连, 目标.序号, { 目标AppID: 选项.目标AppID })
  return Object.assign({}, 抄, {
    appId: 目标.appId,
    列表: 列.列表,
    说明: 抄.ok ? '抄到了' : '没抄到：' + 抄.原因
  })
}

/**
 * 从一段页面正文里抠「明文 AppSecret」。
 *
 * 【为什么单独抽一条路】2026-11-02 真机两件事推翻了原来的全部假设：
 *   ① 点「查看」= 重置入口，弹出来的原话是「AppSecret不再被明文保存…确认重置」；⛔ 永不能点。
 *   ② 但**创建机器人成功那一屏，secret 是以明文直接印在页面上的**，而且它一直留在那儿刷不掉：
 *        机器人1906xxxxxx / AppID / 1906xxxxxx / AppSecret / <32位大小写数字混排串>
 *        ⛔ 真值已于 2026-11-02 封版前抹去，勿回填：这段注释曾经装着活的 AppSecret，差一步随 MIT 仓发出去
 *        出于安全考虑，AppSecret不支持明文保存，二次查看将会强制重置，请自行妥善保存。
 *      把这串拿去 bots.qq.com 换令牌：HTTP 200、79 位、7200 秒 —— 是真身，不是掩码。
 *   ➜ 所以真正能自动化的路不是「点查看」，是「人建完机器人那一屏，机器立刻抄」。
 *
 * 判据只认「贴着 AppSecret 这个词的那一串」，不去猜页面上所有像 secret 的串——
 * 后者会把 AppID、版本号、时间戳认成 secret（上一版就是这么栽的）。
 *
 * @param {string} 正文
 * @returns {Array<{appId, appSecret, 片段}>}
 */
function 抠明文(正文) {
  const 文 = String(正文 || '')
  const 出 = []
  const re = /AppSecret\s*[:：]?\s*\n?\s*([A-Za-z0-9_-]{16,64})/g
  let m
  while ((m = re.exec(文))) {
    const secret = m[1]
    if (/^\d+$/.test(secret)) continue          // 纯数字 = AppID 粘上来了，不是 secret
    if (/^[x*×_-]+$/i.test(secret)) continue    // 掩码
    const 前文 = 文.slice(Math.max(0, m.index - 400), m.index)
    const ids = [...前文.matchAll(/AppID\s*[:：]?\s*(\d{6,})/g)]
    const appId = ids.length ? ids[ids.length - 1][1] : ''
    出.push({ appId, appSecret: secret, 片段: 文.slice(m.index, m.index + 96).replace(/\s+/g, ' ').trim() })
  }
  return 出
}

/**
 * 盯页面，等「创建成功那一屏」的明文 secret 出现。
 *
 * 盯的是**所有 q.qq.com 的标签页**：创建成功后腾讯有可能跳新页/开新 tab，
 * 只盯原来那一个会白等（2026-11-02 点「创建机器人」就把那一页踢去了登录页）。
 *
 * @param {number} 端口 CDP 端口
 * @param {object} 选项 { 目标AppID?, 超时毫秒?, 每毫秒?, 进度回调? }
 * @returns {Promise<{ok, appId?, appSecret?, 命中?, 等了秒?, 判据?, 原因?}>}
 */
async function 盯明文(端口, 选项 = {}) {
  const 超时毫秒 = 选项.超时毫秒 || 5 * 60 * 1000
  const 每毫秒 = 选项.每毫秒 || 2000
  const 回调 = typeof 选项.进度回调 === 'function' ? 选项.进度回调 : null
  const 起 = Date.now()
  const 已报 = new Set()
  while (Date.now() - 起 < 超时毫秒) {
    const 列 = await 浏.列页(端口).catch(() => null)
    const 页们 = (列 || []).filter(p => p && p.type === 'page' && /q\.qq\.com/.test(p.url || ''))
    for (const 页 of 页们) {
      const 连 = await 浏.连接(页.wsDebuggerUrl || 页.webSocketDebuggerUrl).catch(() => null)
      if (!连 || !连.ok) continue
      let 正文 = ''
      try { 正文 = await 取正文(连) } catch { 正文 = '' }
      连.关()
      const 命中 = 抠明文(正文)
      const 选 = 选项.目标AppID
        ? (命中.find(x => String(x.appId) === String(选项.目标AppID)) || null)
        : (命中[0] || null)
      if (选) {
        return {
          ok: true, appId: 选.appId, appSecret: 选.appSecret, 命中,
          等了秒: +((Date.now() - 起) / 1000).toFixed(1),
          判据: '页面上出现了明文 AppSecret（创建成功那一屏）',
          来源页: 页.url
        }
      }
      if (回调) {
        const 摘要 = (页.url || '').replace(/^https:\/\/q\.qq\.com/, '') + ' · ' + String(正文 || '').slice(0, 50).replace(/\s+/g, ' ')
        if (!已报.has(摘要)) { 已报.add(摘要); 回调({ 页数: 页们.length, 在: 页.url, 正文头: String(正文 || '').slice(0, 80).replace(/\s+/g, ' ') }) }
      }
    }
    await 浏.睡(每毫秒)
  }
  return {
    ok: false,
    原因: '等了 ' + Math.round(超时毫秒 / 1000) + ' 秒，页面上没出现明文 AppSecret',
    判据: '明文只在「创建成功那一屏」出现；那一屏一关就再也拿不到（只能重置，不可逆）'
  }
}

module.exports = { 读列表, 点查看并抄, 抄, 抠明文, 盯明文, 取正文, 候选串正则 }

// ── CLI：接一个已经开着的浏览器端口抄一次（调试与人工复核用） ──
if (require.main === module) {
  ;(async () => {
    const 参 = process.argv.slice(2)
    const 取 = (名, 缺) => { const i = 参.indexOf('--' + 名); return i >= 0 && 参[i + 1] ? 参[i + 1] : 缺 }
    const 端口 = Number(取('端口', 0))
    if (!端口) { console.log('用法：node 适配器/qq/安装/抄凭据.js --端口 <CDP端口> [--appid <目标AppID>] [--盯]'); process.exit(1) }
    if (参.includes('--盯')) {
      // 盯「创建成功那一屏」的明文 secret —— 人建完机器人，这里立刻抄走。
      // 放在「找页」之前：人正建的时候页面可能还在登录页/骨架屏，不能因为找不到后台页就退出。
      const r = await 盯明文(端口, {
        目标AppID: 取('appid', ''),
        超时毫秒: Number(取('超时', '300')) * 1000,
        进度回调: (t) => console.log('· 在盯：' + (t.在 || '').replace(/^https:\/\/q\.qq\.com/, '') + ' ｜ ' + (t.正文头 || ''))
      })
      console.log(JSON.stringify(r, null, 2))
      process.exit(r.ok ? 0 : 4)
    }
    const 列 = await 浏.列页(端口)
    const 页 = (列 || []).filter(p => p.type === 'page' && /q\.qq\.com/.test(p.url)).pop()
    if (!页) { console.log('❌ 端口 ' + 端口 + ' 上没有 q.qq.com 的页面'); process.exit(2) }
    const 连 = await 浏.连接(页.wsDebuggerUrl || 页.webSocketDebuggerUrl)
    if (!连.ok) { console.log('❌ 连不上：' + 连.说明); process.exit(3) }
    const r = await 抄(连, { 目标AppID: 取('appid', '') })
    console.log(JSON.stringify(r, null, 2))
    连.关()
  })().catch(e => { console.error('❌ 抄凭据崩了：', e && e.stack || e); process.exit(1) })
}
