#!/usr/bin/env node
/**
 * 断上游演练（隔离全链路）
 * ─────────────────────────────────────────────────────────
 * 跑法：node 验收/隔离演练.js
 *
 * 验的是一句话：**把这个目录整个拷到一台没有宿主项目源码的机器上，它还能不能自己跑。**
 *
 * 不许 require 宿主的任何模块，不许读宿主的任何数据目录。全程只用一个临时现场，
 * 跑完就扔。任何一步需要"上游在"才能完成，就是架构错了，不是环境错了。
 *
 * 链路：入库一轮 → 语义检索 → 翻回原话 → 映射 + 门控 + 提话 → 断依赖不崩
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const 现场 = fs.mkdtempSync(path.join(os.tmpdir(), '鲸鱼隔离演练-'))
const 数据目录 = path.join(现场, '数据')
const 原文根 = path.join(现场, '原文回溯')
process.env.鲸鱼数据目录 = 数据目录
process.env.原文回溯根目录 = 原文根

const 根 = path.resolve(__dirname, '..')
const 入库 = require(path.join(根, '内核', '对话入库.js'))
const 回溯 = require(path.join(根, '内核', '原文回溯.js'))
const 映射 = require(path.join(根, '内核', '候选映射.js'))
const 存储 = require(path.join(根, '内核', '存储适配器.js'))

const 结果 = []
function 断言(名称, 通过, 详情) {
  结果.push({ 名称, 通过: !!通过, 详情 })
  console.log((通过 ? '✅ ' : '❌ ') + 名称 + (详情 ? '　' + String(详情).slice(0, 160) : ''))
}

;(async () => {
  console.log('断上游演练 · 现场=' + 现场 + '\n')

  // ① 双写入库
  const 会话 = '隔离演练'
  const r = await 入库.入库一轮(会话, [
    { 角色: '用户', 文本: '先给这个事挂份需求单出来吧。' },
    { 角色: '助理', 文本: '需求单已立，臣这就办。' }
  ], { 根目录: 原文根 })

  断言('① 入库一轮 ok', r.ok === true, JSON.stringify({ 原文: r.原文 && r.原文.写入, 向量: r.向量 && r.向量.写入 }))
  断言('① 原文表真落了盘', !!(r.原文.路径 && fs.existsSync(r.原文.路径)), r.原文.路径)
  断言('① 向量条目挂了句ID', r.ok && (r.原文.句ID们 || []).length >= 2, JSON.stringify(r.原文.句ID们))
  断言('① 一条都没降级', (r.降级 || []).length === 0, JSON.stringify(r.降级))

  // ② 检索（零依赖兜底档走字面+哈希向量，不靠外部 embedding）
  const 命中 = await 存储.搜索相关('先给这个事挂份需求单', 5)
  断言('② 检索有命中（不靠外部 embedding）', Array.isArray(命中) && 命中.length > 0, '命中 ' + (命中 && 命中.length))
  断言('② 命中带句ID（溯源字段透出）', 命中.length > 0 && typeof 命中[0].句ID === 'string', 命中[0] && 命中[0].句ID)

  // ③ 翻回原话
  const 原句 = 回溯.找原句('先给这个事挂份需求单出来吧', { 根目录: 原文根, topK: 1 })
  const 首 = 原句.结果 && 原句.结果[0]
  断言('③ 能翻回那句原话', !!首, 首 && 首.句ID)
  断言('③ 原句逐字相等', 首 && 首.文本 === '先给这个事挂份需求单出来吧。', 首 && JSON.stringify(首.文本))
  断言('③ 带得出位置', 首 && /第 1 轮 · 第 1 句/.test(首.位置 || ''), 首 && 首.位置)

  // ④ 映射 + 门控 + 提话（真检索，不注入）
  const 链路 = await 映射.提话链路('先给这个事挂份需求单', { 根目录: 原文根, 上下文: {} })
  断言('④ 提话链路跑得通（有结论就是通过）', typeof 链路.开口 === 'boolean', JSON.stringify({ 开口: 链路.开口, 理由: 链路.理由, 档位: 链路.档位 }))
  if (链路.开口) {
    断言('④ 开口时必带原话', !!(链路.原话 && 链路.原话.找到 === true), 链路.原话 && 链路.原话.句ID)
    断言('④ 措辞分档生效', 链路.措辞 === '陈述' || 链路.措辞 === '疑问', 链路.措辞)
  } else {
    断言('④ 没开口时不许编原话', !链路.原话, JSON.stringify(链路.理由))
  }

  // ⑤ 断依赖：数据目录整个删掉 → 只许降级，不许崩
  fs.rmSync(现场, { recursive: true, force: true })
  let 崩了 = false
  let r2 = null
  try {
    r2 = await 入库.入库一轮(会话 + '-断后', [{ 角色: '用户', 文本: '数据目录被我删了，你还活着吗。' }], { 根目录: 原文根 })
    const 搜 = await 存储.搜索相关('活着吗', 3)
    断言('⑤ 数据目录没了 → 检索回空数组不崩', Array.isArray(搜), '条数=' + 搜.length)
  } catch (e) {
    崩了 = true
    console.log('   异常：' + ((e && e.message) || e))
  }
  断言('⑤ 数据目录没了 → 入库不抛异常（降级即可）', !崩了, 崩了 ? '抛了' : 'ok')

  const 全过 = 结果.every(x => x.通过)
  console.log('\n' + '═'.repeat(56))
  console.log('断上游演练：' + (全过 ? '全部通过 ✅' : '有失败 ❌') + '（' + 结果.filter(x => x.通过).length + '/' + 结果.length + '）')
  console.log('═'.repeat(56))
  try { fs.rmSync(现场, { recursive: true, force: true }) } catch { }
  process.exit(全过 ? 0 : 1)
})().catch(e => {
  console.log('❌ 演练全程无未捕获异常：' + ((e && e.stack) || e))
  try { fs.rmSync(现场, { recursive: true, force: true }) } catch { }
  process.exit(1)
})
