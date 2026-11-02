// 真机自检（注入全链路）：用 DSH 自己的 Electron node，加载「装上去的那份插件」，
// 走一遍 pre-step 的记忆路径：入库 → 检索 → 门控 → 注入文本。
// 跑法（cmd）：
//   set ELECTRON_RUN_AS_NODE=1
//   "C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" 临时\真机自检_注入.mjs
// 用的是会话名「真机自检」，跑完可整表删除，不污染真实记忆。
import { pathToFileURL } from 'node:url'

const 内核根 = 'C:/Users/Administrator/.dsh/profiles/desktop/node_modules/whale-memory-dsh/'
const { 造记忆注入 } = await import(pathToFileURL(内核根 + 'lib/记忆核心.js').href)
const 存 = (await import(pathToFileURL(内核根 + '内核/存储适配器.js').href)).default

const 一句 = (t) => [{ role: 'user', content: t }]
const 会话 = '真机自检'

const 步1 = await 造记忆注入({ 消息们: 一句('绝不能让宿主按它自己的标准压缩摘要，原话必须能翻出来'), 会话 })
const 步2 = await 造记忆注入({ 消息们: 一句('记忆内核全部放本地磁盘，输入输出都走本机渠道'), 会话 })
const 步3 = await 造记忆注入({ 消息们: 一句('刚才说的压缩摘要那句话是怎么说的'), 会话 })

for (const [名, 步] of [['步1', 步1], ['步2', 步2], ['步3', 步3]]) {
  const r = 步.报告 || {}
  console.log(`${名}: 注入=${步.注入} ｜ 开口=${r.开口} ｜ 理由=${r.理由 || r.跳过原因 || ''} ｜ 句ID=${r.句ID || ''} ｜ 入库=${r.入库 || ''}`)
}
console.log('\n--- 步3 注入文本 ---')
console.log((步3.文本 || '（空：门控没开口）').slice(0, 600))

const 后 = 存.健康自检()
console.log('\n--- 向量库体检 ---')
console.log(`条数=${后.条数} ｜ 模型ID=${后.模型ID} ｜ 维度=${后.维度} ｜ 后端=${后.后端} ｜ 带句ID=${后.带句ID数} ｜ 可回溯率=${后.可回溯率}%`)
console.log('库路径:', 后.库路径)
const 库 = 存.读取向量库().filter(x => String(x.会话 || '') === 会话 || String(x.句ID || '').startsWith(会话))
console.log('本会话条目维度:', JSON.stringify(库.map(x => (x.vector || []).length)))

// 【跨库统一验证】问一条「我这轮没说过」的事——若只是这一轮那 3 句，永远召不回；
// 能召回「豆豆」就证明 DSH 侧检索和我写测试语料用的是同一个库。
const 库2 = await 存.搜索相关('我家那只贪吃的猫咪叫什么名字', 3)
console.log('\n--- 跨库验证：问一句本轮没说过的话 ---')
for (const x of 库2) console.log(`  ${Number(x.similarity).toFixed(4)} ｜ ${String(x.content).slice(0, 30)} ｜ ${x.句ID || ''}`)

