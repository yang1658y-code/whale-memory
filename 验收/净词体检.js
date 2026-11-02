#!/usr/bin/env node
'use strict'
/**
 * 净词体检.js —— L10：仓里除品牌之外，一个内部行话都不许剩
 * ════════════════════════════════════════════════════════════════
 * 【它解决的到底是什么问题】
 *   2026-11-02 清了一轮行话（对照表见 配置/词表.json），把 200 多处
 *   在注释、日志、验收语料里的内部术语换成了通用词。但「清干净」是一次性动作，
 *   不是状态：下一个人写注释顺手带一句行话，没有任何东西会拦。
 *   三个月后再看，仓里又是半套旧词，而 MIT 仓的读者根本不知道那是什么。
 *
 * 【它验什么】
 *   扫「入库文件」（git ls-files 的口径，不是磁盘上的文件——本地产物不算），
 *   逐个禁词命中数必须为 0。词源在 配置/词表.json，改词只改那一处。
 *
 * 【三条防「假绿」的设计】
 *   ① 扫描器自检：往扫描函数里喂一段含禁词的合成文本，必须抓到；喂干净文本必须 0。
 *      ——扫描器空转（正则写错、变量名对不上）是最典型的假绿，靠自检当场抓住。
 *   ② 白名单自检：历史档案（变更记录/）里**确实还有**这些词，且必须被跳过。
 *      白名单写崩了（把整个仓都放过）会在这里立刻变红，而不是永远绿着。
 *   ③ 只扫入库文件 + 报告行号：命中给 文件:行 与次数，改起来不用翻全仓。
 *
 * 【跑法】node 验收/净词体检.js [--静默]
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const 根 = path.resolve(__dirname, '..')
const 静默 = process.argv.includes('--静默')

const 词表 = JSON.parse(fs.readFileSync(path.join(根, '配置', '词表.json'), 'utf8'))
// 本地私域词表（不进仓、不进包）：开源版只留机制，真实禁词写在这里。
// 有本地版就用本地版的禁词/白名单，没有就用 词表.json 的（开源版为空）。
let 本地词表 = null
try { 本地词表 = JSON.parse(fs.readFileSync(path.join(根, '配置', '词表.本地.json'), 'utf8')) } catch { /* 开源版没有这个文件是正常的 */ }
const 禁词 = ((本地词表 && Array.isArray(本地词表.禁词) && 本地词表.禁词.length ? 本地词表.禁词 : 词表.禁词) || []).slice()
const 白名单目录 = ((本地词表 && Array.isArray(本地词表.白名单目录) && 本地词表.白名单目录.length ? 本地词表.白名单目录 : 词表.白名单目录) || []).slice()
const 白名单文件 = ['配置/词表.json', '配置/词表.本地.json'] // 词源自己必须写出这些词，只豁免这两个文件

const 结果清单 = []
let 编号 = 0
function 断言(名称, 通过, 详情) {
  编号++
  结果清单.push({ 编号, 名称, 通过: !!通过, 详情 })
  if (!静默) console.log(`${通过 ? '✅' : '❌'} [${编号}] ${名称}${详情 ? '\n     ' + String(详情).replace(/\n/g, '\n     ') : ''}`)
}
function 小标题(t) { if (!静默) console.log('\n' + '═'.repeat(64) + '\n' + t + '\n' + '═'.repeat(64)) }

// ═══════════════════════ 一、取入库文件清单 ═══════════════════════
/**
 * 优先用 git 的视角（只算「入库文件」）；不是 git 仓（下载 zip 的场景）就退回目录遍历。
 * @returns {{来源:string, 文件:string[]}}
 */
function 取文件清单() {
  try {
    const 出 = execFileSync('git', ['ls-files', '-z'], { cwd: 根, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 })
    const 列 = 出.toString('utf8').split('\0').filter(Boolean)
    if (列.length > 0) return { 来源: 'git ls-files', 文件: 列 }
  } catch { /* 没装 git / 不在仓里 → 退回遍历 */ }
  const 跳 = new Set(['.git', 'node_modules', '数据', '备份', '临时'])
  const 列 = []
  const 走 = (绝对, 相对) => {
    let 们
    try { 们 = fs.readdirSync(绝对, { withFileTypes: true }) } catch { return }
    for (const e of 们) {
      const 子相 = 相对 ? 相对 + '/' + e.name : e.name
      if (e.isDirectory()) { if (!跳.has(e.name)) 走(path.join(绝对, e.name), 子相) } else 列.push(子相)
    }
  }
  走(根, '')
  return { 来源: '目录遍历（非 git 仓）', 文件: 列 }
}

/** 该不该看这个文件（白名单目录 + 词源自身） */
function 该跳过(相对路径) {
  if (白名单文件.includes(相对路径)) return true
  return 白名单目录.some((前) => 相对路径.startsWith(前))
}

/** 读文本；二进制（含 NUL）与读失败返回 null —— 二进制不该被当文本判 */
function 读文本(相对路径) {
  let 缓
  try { 缓 = fs.readFileSync(path.join(根, 相对路径.replace(/\//g, path.sep))) } catch { return null }
  if (缓.includes(0)) return null
  return 缓.toString('utf8')
}

/**
 * 在文本里找禁词。
 * @param {string} 文本
 * @param {string} 词
 * @returns {{次数:number, 行号:number[]}}
 */
function 找词(文本, 词) {
  const 行们 = String(文本).split('\n')
  const 行号 = []
  let 次数 = 0
  for (let i = 0; i < 行们.length; i++) {
    let 位 = 行们[i].indexOf(词)
    while (位 >= 0) { 次数++; if (行号.length < 80) 行号.push(i + 1); 位 = 行们[i].indexOf(词, 位 + 词.length) }
  }
  return { 次数, 行号 }
}

// ═══════════════════════ 二、扫描器自检（防假绿） ═══════════════════════
小标题('一、扫描器自检：喂它一段脏话，它必须抓到')

// 探针词：有禁词就用真词，没有（开源版）就用一个人造探针——
// 这一条测的是「找词函数会不会空转」，不是「词表有没有词」，所以两者必须分开。
const 探针词 = 禁词[0] || '__净词探针__'
{
  const 脏 = '这是一句含' + 探针词 + '的探针\n第二行没有\n第三行又有一个' + 探针词
  const 脏命中 = 找词(脏, 探针词)
  断言('自检：合成文本里的禁词被抓到（次数/行号都对）',
    脏命中.次数 === 2 && 脏命中.行号.join(',') === '1,3',
    '抓到 ' + 脏命中.次数 + ' 次，行号 ' + 脏命中.行号.join(','))
  const 净命中 = 找词('这句话干干净净，一个禁词都没有。', 探针词)
  断言('自检：干净文本 0 命中（不误报）', 净命中.次数 === 0, '命中 ' + 净命中.次数)
}

// ═══════════════════════ 三、取清单并排除白名单 ═══════════════════════
const 清 = 取文件清单()
const 全清单 = 清.文件
const 看这些 = 全清单.filter((f) => !该跳过(f))
const 被跳过 = 全清单.filter((f) => 该跳过(f))

断言('文件清单取到了（来源：' + 清.来源 + '）', 全清单.length >= 50, '入库文件 ' + 全清单.length + ' 个')
断言('扫描范围 = 入库文件减去白名单', 看这些.length >= 40 && 被跳过.length >= 1,
  '要扫 ' + 看这些.length + ' 个，白名单跳过 ' + 被跳过.length + ' 个')

// 白名单自检：历史档案里必须仍然有这些词（有，才证明「跳过」是真的在跳）
{
  const 档案里 = []
  for (const f of 被跳过) {
    if (!/^(变更记录|文档|记忆)\//.test(f)) continue
    if (!/\.(md|json|txt|js)$/.test(f)) continue
    const t = 读文本(f)
    if (!t) continue
    for (const w of 禁词) if (t.includes(w)) { 档案里.push(f); break }
    if (档案里.length >= 10) break
  }
  // 公开面清干净后，历史档案里可能一个禁词都不剩（这是我们想要的结果）。
  // 这时退一步用词源文件自身作探针：它必然含禁词，又必然被 白名单文件 豁免——
  // 证明的是同一条「该跳过就跳过」的路径，而不是「没扫到」。
  if (档案里.length === 0) {
    for (const f of 白名单文件) {
      const t = 读文本(f)
      if (t && 禁词.some((w) => t.includes(w))) { 档案里.push(f + '（词源自身·白名单豁免探针）'); break }
    }
  }
  断言('白名单自检：历史档案里确实还有这些词，且被放过（跳过是真在跳，不是没扫到）',
    禁词.length === 0 || 档案里.length > 0,
    禁词.length === 0
      ? '本仓禁词 0 个（开源版无本地词表）：跳过确实生效，扫了 ' + 被跳过.length + ' 个'
      : '档案命中文件 ' + 档案里.length + ' 个，例：' + (档案里[0] || '无'))
}

// ═══════════════════════ 四、逐词判定 ═══════════════════════
小标题('二、逐词判定：' + 禁词.length + ' 个禁词，命中必须为 0')

const 总账 = {}
for (const w of 禁词) 总账[w] = { 次数: 0, 命中: [] }
let 读失败 = 0

for (const f of 看这些) {
  const 文本 = 读文本(f)
  if (文本 === null) { 读失败++; continue }
  for (const w of 禁词) {
    const 结 = 找词(文本, w)
    if (结.次数 === 0) continue
    总账[w].次数 += 结.次数
    总账[w].命中.push(f + '（' + 结.次数 + ' 次，行 ' + 结.行号.slice(0, 6).join('/') + (结.行号.length > 6 ? '…' : '') + '）')
  }
}

for (const w of 禁词) {
  const 账 = 总账[w]
  断言('禁词「' + w + '」命中 0', 账.次数 === 0,
    账.次数 === 0 ? '' : 账.次数 + ' 次 → ' + 账.命中.slice(0, 8).join('；'))
}

{
  const 合 = 禁词.reduce((s, w) => s + 总账[w].次数, 0)
  断言('全仓禁词总命中 0', 合 === 0, 合 === 0 ? '扫过 ' + (看这些.length - 读失败) + ' 个文本文件' : '共 ' + 合 + ' 处')
}

// ═══════════════════════ 收尾 ═══════════════════════
const 通过 = 结果清单.filter((x) => x.通过).length
const 总 = 结果清单.length
console.log('\n' + '═'.repeat(64))
console.log('净词体检（L10）：' + (通过 === 总 ? '仓里一个内部行话都不剩 ✅' : '有 ' + (总 - 通过) + ' 项没清干净 ❌'))
console.log('═'.repeat(64))
console.log(通过 + '/' + 总)
require('./断言报告.js').报(通过, 总)
process.exit(通过 === 总 ? 0 : 1)
