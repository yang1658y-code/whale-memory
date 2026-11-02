#!/usr/bin/env node
'use strict'
/**
 * DSH装机体检.js —— L11：装到宿主上的那份必须与仓内逐字节一致，宿主契约点必须还在
 * ════════════════════════════════════════════════════════════════
 * 【它解决的到底是什么问题】
 *   两个真事，都发生在本机：
 *   ① 装机副本漂移：仓内 lib/记忆核心.js 是 11-02 版（23.9KB），
 *      ~/.dsh 里那份是 10-27 版（16.9KB）。差的 38 行正是「数据根隔离」与三个新旋钮——
 *      这些代码**从没在真机上跑过**，而验收一路是绿的。
 *      发现靠人手比 md5；换个日子就没人发现，于是这次把它变成一道闸门。
 *   ② 契约点静默失效：接管只靠几个外部契约点（插件节点 id、导出的引擎类、
 *      该类上的 summarize 钩子、agent/pre-step 这道门）。宿主升级后任一处改名，
 *      插件不报错、只是不再生效——表现为「模型变笨了」，日志一片安静。
 *
 * 【它验什么】（16 条，全部只读；不起 DSH、不改装机副本）
 *   ① 找到装机副本（找不到 = 没装 → 其余全标「跳过」算通过，不把没装当失败）
 *   ② 装机文件清单与仓内一致（缺件 / 多出杂物）
 *   ③④⑤ 适配器代码 · 内核 · 门控配置：md5 逐文件一致（漂移当场点名）
 *   ⑥⑦ 模型/ 第三方/ 在位且文件数与仓内一致（少了 → 向量层静默退化成词袋）
 *   ⑧ 内核/package.json 必须标 type:commonjs（否则内核被当 ESM，require 直接抛）
 *   ⑨ 数据目录接在用户数据根上（升级重装不丢原文表）
 *   ⑩ 找到宿主 app.asar（DSH 桌面端本体）
 *   ⑪⑫⑬ 宿主里三个契约点仍在：导出 BasicCompactionEngine、该类上有 summarize 钩子、
 *        compaction-basic 节点 id 与 agent/pre-step 门都在
 *   ⑭ 装机副本的 cordis.patch.yml 仍把 compaction-basic 禁掉
 *   ⑮ 记忆.js 仍监听 agent/pre-step
 *   ⑯ profile package.json 的 bundles 里本包排在 dsh-base 之后（patch 叠加顺序）
 *
 * 【为什么查 asar 而不是 require 那个包】
 *   实测：@deepseek-ai/dsh-compaction-basic 不落在 profile/node_modules 下，
 *   它打在 DSH 桌面端的 app.asar 里（174MB，代码未压缩，可当文本搜）。
 *   require 它既找不到路径，也会在别人机器上误红。查 asar 是**宿主真正带没带这个契约**。
 *
 * 【跑法】node 验收/DSH装机体检.js [--静默]
 *   换一份装机副本体检：环境变量 鲸鱼装机目录=<…/node_modules/whale-memory-dsh>
 *   换一个宿主体检：  环境变量 鲸鱼DSH宿主=<…/resources/app.asar 或 …/resources>
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const 根 = path.resolve(__dirname, '..')
const 静默 = process.argv.includes('--静默')

const 结果清单 = []
let 编号 = 0
function 断言(名称, 通过, 详情) {
  编号++
  结果清单.push({ 编号, 名称, 通过: !!通过, 详情 })
  if (!静默) console.log(`${通过 ? '✅' : '❌'} [${编号}] ${名称}${详情 ? '\n     ' + String(详情).replace(/\n/g, '\n     ') : ''}`)
}
function 小标题(t) { if (!静默) console.log('\n' + '═'.repeat(64) + '\n' + t + '\n' + '═'.repeat(64)) }

// 装机副本里必然存在、且不该与仓内逐字节一致的东西
const 装机自产 = new Set(['数据', 'node_modules', '.DS_Store'])
const 不比 = (名) => 名.endsWith('.bak') || 名 === '装.cjs'

/** 递归列文件（相对路径用正斜杠），跳过装机自产目录与备份文件 */
function 列文件(绝对根, 相对 = '', 出 = []) {
  let 们
  try { 们 = fs.readdirSync(绝对根, { withFileTypes: true }) } catch { return 出 }
  for (const e of 们) {
    const 子 = 相对 ? 相对 + '/' + e.name : e.name
    if (e.isDirectory()) { if (!装机自产.has(e.name)) 列文件(path.join(绝对根, e.name), 子, 出) }
    else if (!不比(e.name)) 出.push(子)
  }
  return 出
}

/**
 * 文件指纹。
 * 文本文件先统一成 LF 再算 md5：换行是 git 的事（core.autocrlf=true 的 Windows 上
 * clone 下来就是 CRLF），不该被当成「装机副本漂了」。真正的漂移（内容/行数/少文件）一样抓得到。
 * 二进制按原字节算。
 * @returns {string|null} 读不到返回 null
 */
const 二进制尾 = /\.(onnx|wasm|mjs|png|ico|jpg|jpeg|woff2?|gz|zip|pdf)$/i
function md5(p) {
  let 缓
  try { 缓 = fs.readFileSync(p) } catch { return null }
  if (二进制尾.test(p) || 缓.includes(0)) return crypto.createHash('md5').update(缓).digest('hex')
  const 文 = 缓.toString('utf8').replace(/\r\n/g, '\n')
  return crypto.createHash('md5').update(Buffer.from(文, 'utf8')).digest('hex')
}

function 量(绝对根) {
  const 列 = 列文件(绝对根)
  let 字节 = 0
  for (const f of 列) { try { 字节 += fs.statSync(path.join(绝对根, f.replace(/\//g, path.sep))).size } catch { } }
  return { 数: 列.length, 字节 }
}

/** 找装机副本：环境变量 > ~/.dsh/profiles/<名字>/node_modules/whale-memory-dsh */
function 找装机() {
  const 指定 = String(process.env.鲸鱼装机目录 || '').trim()
  if (指定) {
    const 绝 = path.resolve(指定)
    if (fs.existsSync(path.join(绝, 'package.json'))) return { 目录: 绝, 来源: '环境变量 鲸鱼装机目录' }
    return { 目录: null, 原因: '环境变量 鲸鱼装机目录 指向的地方没有 package.json：' + 绝 }
  }
  const 根目录 = path.join(os.homedir(), '.dsh', 'profiles')
  const 候选 = []
  let 们 = []
  try { 们 = fs.readdirSync(根目录, { withFileTypes: true }) } catch { }
  for (const e of 们) {
    if (!e.isDirectory()) continue
    const p = path.join(根目录, e.name, 'node_modules', 'whale-memory-dsh')
    if (fs.existsSync(path.join(p, 'package.json'))) 候选.push(p)
  }
  if (候选.length === 1) return { 目录: 候选[0], 来源: '自动发现' }
  if (候选.length === 0) return { 目录: null, 原因: '在 ' + 根目录 + ' 下没找到装着 whale-memory-dsh 的 profile（这台机器没装 DSH 适配层）' }
  return { 目录: null, 原因: '发现 ' + 候选.length + ' 个装机副本，请用环境变量 鲸鱼装机目录 指定：' + 候选.join(' ｜ ') }
}

/** 找宿主 app.asar：环境变量 > ~/AppData/Local/Programs/<任意>/resources/app.asar */
function 找宿主() {
  const 指定 = String(process.env.鲸鱼DSH宿主 || '').trim()
  const 收 = (p) => {
    if (!p) return ''
    if (/\.asar$/i.test(p) && fs.existsSync(p)) return p
    for (const 尾 of [['app.asar'], ['resources', 'app.asar']]) {
      const q = path.join(p, ...尾)
      if (fs.existsSync(q)) return q
    }
    return ''
  }
  const 来的 = 收(指定)
  if (来的) return { asar: 来的, 来源: '环境变量 鲸鱼DSH宿主' }
  const 程序目录 = path.join(os.homedir(), 'AppData', 'Local', 'Programs')
  let 们 = []
  try { 们 = fs.readdirSync(程序目录, { withFileTypes: true }) } catch { }
  const 候选 = []
  for (const e of 们) {
    if (!e.isDirectory()) continue
    const p = path.join(程序目录, e.name, 'resources', 'app.asar')
    if (fs.existsSync(p)) 候选.push(p)
  }
  const 显得 = 候选.find((p) => /harness|dsh|deepseek/i.test(p)) || 候选[0]
  if (显得) return { asar: 显得, 来源: '自动发现' }
  return { asar: null, 原因: '没找到 DSH 宿主的 app.asar（' + 程序目录 + ' 下没有任何 */resources/app.asar）' }
}

/** 仓内清单：装机副本里该有、且该与仓内逐字节一致的文件 */
function 仓内清单() {
  const 出 = []
  for (const f of 列文件(path.join(根, '适配器', 'dsh'))) 出.push({ 仓: '适配器/dsh/' + f, 装: f })
  for (const f of 列文件(path.join(根, '内核'))) 出.push({ 仓: '内核/' + f, 装: '内核/' + f })
  出.push({ 仓: '配置/门控策略.json', 装: '配置/门控策略.json' })
  return 出
}

/** 装机侧允许比仓内多出来的东西（装机自产） */
const 允许多 = (f) => f === '内核/package.json' || f === '数据' || f.startsWith('数据/') || f.startsWith('模型/') || f.startsWith('第三方/')

async function 主() {
  const 找 = 找装机()
  const 装 = 找.目录
  断言('找到 DSH 装机副本', !!装 || !!找.原因,
    !装 ? '跳过：' + 找.原因 : 装 + '（' + 找.来源 + '）')

  const 检查名 = [
    '装机文件清单与仓内一致（缺件/多余）',
    '适配器代码 md5 逐文件一致',
    '内核 md5 逐文件一致',
    '门控配置 md5 一致',
    '模型目录在位且文件数与仓内一致',
    '第三方运行集在位且文件数与仓内一致',
    '内核/package.json 标了 type:commonjs',
    '数据目录接在用户数据根上',
    '找到宿主 app.asar',
    '宿主里导出 BasicCompactionEngine',
    '宿主里该引擎类上仍有 summarize 钩子',
    '宿主里 compaction-basic 节点与 agent/pre-step 门都在',
    '装机副本 cordis.patch.yml 仍禁掉 compaction-basic',
    '记忆.js 仍监听 agent/pre-step',
    'profile bundles 里本包排在 dsh-base 之后'
  ]

  if (!装) {
    for (const 名 of 检查名) 断言(名, true, '跳过：' + 找.原因)
    return 收尾()
  }

  // ── ① 文件清单 ──
  const 应装 = 仓内清单()
  const 应装集 = new Set(应装.map((x) => x.装))
  const 实装 = 列文件(装)
  const 缺 = 应装.filter((x) => !实装.includes(x.装)).map((x) => x.装)
  const 多 = 实装.filter((f) => !应装集.has(f) && !允许多(f))
  断言(检查名[0], 缺.length === 0 && 多.length === 0,
    缺.length === 0 && 多.length === 0
      ? '应装 ' + 应装.length + ' 个，实装 ' + 实装.length + ' 个（模型/第三方/数据 单独核）'
      : (缺.length ? '缺 ' + 缺.length + '：' + 缺.slice(0, 8).join('、') : '') + (多.length ? '　多 ' + 多.length + '：' + 多.slice(0, 8).join('、') : ''))

  // ── ②③④ md5 分组比对 ──
  const 组 = [
    [检查名[1], (x) => !x.装.startsWith('内核/') && x.装 !== '配置/门控策略.json'],
    [检查名[2], (x) => x.装.startsWith('内核/')],
    [检查名[3], (x) => x.装 === '配置/门控策略.json']
  ]
  for (const [名, 筛] of 组) {
    const 项们 = 应装.filter(筛)
    const 漂 = []
    for (const x of 项们) {
      const a = md5(path.join(根, x.仓.replace(/\//g, path.sep)))
      const b = md5(path.join(装, x.装.replace(/\//g, path.sep)))
      if (a !== b) 漂.push(x.装 + (b === null ? '（装机侧缺）' : '（内容不同）'))
    }
    断言(名, 漂.length === 0, 漂.length === 0 ? 项们.length + ' 个文件全一致' : '漂移 ' + 漂.length + ' 个：' + 漂.slice(0, 8).join('、'))
  }

  // ── ⑤⑥ 模型 / 第三方 ──
  for (const [目, 名] of [['模型', 检查名[4]], ['第三方', 检查名[5]]]) {
    const 仓量 = 量(path.join(根, 目))
    const 装量 = 量(path.join(装, 目))
    断言(名, 仓量.数 > 0 && 装量.数 === 仓量.数,
      '仓内 ' + 仓量.数 + ' 个 / 装机 ' + 装量.数 + ' 个，共 ' + 仓量.字节 + ' / ' + 装量.字节 + ' 字节')
  }

  // ── ⑦ 内核 package.json 的 type ──
  {
    const p = path.join(装, '内核', 'package.json')
    let 单 = null
    try { 单 = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { }
    断言(检查名[6], !!(单 && 单.type === 'commonjs'),
      单 ? JSON.stringify(单) : '不存在或不是合法 JSON：' + p)
  }

  // ── ⑧ 数据目录 ──
  {
    const p = path.join(装, '数据')
    let 是链接 = false
    try { 是链接 = fs.lstatSync(p).isSymbolicLink() } catch { }
    const 在 = fs.existsSync(p)
    断言(检查名[7], 在, !在 ? '数据目录不存在：' + p
      : (是链接 ? 'junction → ' + (() => { try { return fs.readlinkSync(p) } catch { return '?' } })() : '实体目录（重装会丢，装.cjs --装 会换成 junction）'))
  }

  // ── ⑨⑩⑪⑫ 宿主契约点（读 app.asar 文本） ──
  const 宿 = 找宿主()
  断言(检查名[8], !!宿.asar, 宿.asar ? 宿.asar + '（' + 宿.来源 + '）' : '跳过：' + 宿.原因)

  let 宿主文本 = ''
  let 读到 = ''
  if (宿.asar) {
    try { 宿主文本 = fs.readFileSync(宿.asar).toString('latin1') } catch (e) { 读到 = String((e && e.message) || e).slice(0, 160) }
  }
  const 有文本 = !!宿主文本

  // 【为什么认 "X = class" 这个串】asar 里同一名字出现五次：两处 README 文案、
  //   一处类定义（var BasicCompactionEngine = class …）、两处 export 尾巴。
  //   只有类定义后面那段才是方法体；拿第一次出现的位置找 summarize 就会误红。
  const 定义位 = 有文本 ? 宿主文本.indexOf('BasicCompactionEngine = class') : -1
  const 类位 = 定义位 >= 0 ? 定义位 : (有文本 ? 宿主文本.indexOf('BasicCompactionEngine') : -1)
  断言(检查名[9], 类位 >= 0, 有文本 ? (类位 >= 0 ? (定义位 >= 0 ? '找到类定义（… = class extends CompactionEngine）' : '只找到名字，没找到类定义') : '符号不在 → 宿主已改内建摘要引擎，接管这条路断了') : '跳过：' + (读到 || 宿.原因))

  const 搵 = (位) => 宿主文本.slice(位, 位 + 6000).includes('summarize(')
  let 钩子在 = false
  if (类位 >= 0) 钩子在 = 搵(类位)
  断言(检查名[10], 钩子在, 类位 >= 0 ? (钩子在 ? '类定义后 6KB 内出现 summarize( 钩子' : '类定义附近没有 summarize( → 覆盖 summarize 已不可能') : '跳过：宿主文本没读到或类没找到')

  {
    const 有节点 = 有文本 ? 宿主文本.includes('compaction-basic') : false
    const 有门 = 有文本 ? 宿主文本.includes('agent/pre-step') : false
    断言(检查名[11], 有节点 && 有门, 有文本 ? 'compaction-basic=' + 有节点 + '，agent/pre-step=' + 有门 : '跳过：宿主文本没读到')
  }

  // ── ⑬ 装机副本里的 patch 硬开关 ──
  {
    let 文本 = ''
    try { 文本 = fs.readFileSync(path.join(装, 'cordis.patch.yml'), 'utf8') } catch { }
    const 禁 = /id:\s*compaction-basic[\s\S]{0,80}?disabled:\s*true/.test(文本)
    const 挂 = /whale-memory-dsh\/memory/.test(文本) && /whale-memory-dsh'/.test(文本)
    断言(检查名[12], 禁 && 挂, '禁 compaction-basic=' + 禁 + '，挂本包两个节点=' + 挂)
  }

  // ── ⑭ agent/pre-step 监听 ──
  {
    let 文本 = ''
    try { 文本 = fs.readFileSync(path.join(装, '记忆.js'), 'utf8') } catch { }
    const 在 = /ctx\.on\(\s*['"]agent\/pre-step['"]/.test(文本)
    断言(检查名[13], 在, 文本 ? (在 ? '有' : '没有 → 注入这条路断了') : '记忆.js 读不到')
  }

  // ── ⑮ bundles 顺序 ──
  {
    const profile包 = path.join(装, '..', '..', 'package.json')
    let 单 = null
    try { 单 = JSON.parse(fs.readFileSync(profile包, 'utf8')) } catch { }
    const 列 = 单 && 单.dsh && 单.dsh.profile && Array.isArray(单.dsh.profile.bundles) ? 单.dsh.profile.bundles : []
    const 我 = 列.indexOf('whale-memory-dsh')
    const 基 = 列.findIndex((x) => String(x).startsWith('@deepseek-ai/dsh-base') || String(x).startsWith('dsh-base'))
    断言(检查名[14], 我 >= 0 && 基 >= 0 && 我 > 基,
      列.length ? 列.join(' → ') : '读不到 bundles（' + profile包 + '）')
  }

  收尾()
}

function 收尾() {
  const 通过 = 结果清单.filter((x) => x.通过).length
  const 总 = 结果清单.length
  console.log('\n' + '═'.repeat(64))
  console.log('DSH 装机体检（L11）：' + (通过 === 总 ? '装机副本与仓内逐字节一致，宿主契约点都在 ✅' : '有 ' + (总 - 通过) + ' 项不合格 ❌'))
  console.log('═'.repeat(64))
  console.log(通过 + '/' + 总)
  require('./断言报告.js').报(通过, 总)
  process.exit(通过 === 总 ? 0 : 1)
}

主().catch((e) => {
  console.error('装机体检脚本自身出错：' + ((e && e.stack) || e))
  require('./断言报告.js').报(结果清单.filter((x) => x.通过).length, Math.max(结果清单.length, 16))
  process.exit(1)
})
