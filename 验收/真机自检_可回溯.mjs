// 终验：DSH 侧检索，能不能从「库里已有的旧语料」翻出逐字原话。
// 只读不写（调 提话链路，不入库），所以不会污染库。
// 跑法：set ELECTRON_RUN_AS_NODE=1 && "...DeepSeek Harness.exe" 临时\真机自检_可回溯.mjs
import { pathToFileURL } from 'node:url'

const 插件根 = 'C:/Users/Administrator/.dsh/profiles/desktop/node_modules/whale-memory-dsh/'
const 路径 = await import(pathToFileURL(插件根 + 'lib/路径.js').href)
const { 找检索 } = await import(pathToFileURL(插件根 + 'lib/记忆核心.js').href)

console.log('原文表根:', 路径.原文表根())
console.log('数据根  :', 路径.数据根())

const 检索 = 找检索()
const 查询们 = ['我家那只猫叫什么名字来着', '车子一般停在哪儿', '交东西的最后期限是什么时候']
for (const q of 查询们) {
  const 开 = await 检索.模块.提话链路(q, { 根目录: 路径.原文表根(), 数据根: 路径.数据根() })
  const 命中 = 开 && 开.命中
  console.log(`\nQ: ${q}`)
  console.log(`   开口=${开 && 开.开口} ｜ 理由=${(开 && 开.理由) || ''} ｜ 档位=${(开 && 开.档位) || ''}`)
  console.log(`   原句=${(命中 && 命中.原句) || '（没回溯到原话）'} ｜ 句ID=${(命中 && 命中.句ID) || ''} ｜ 来源=${(命中 && 命中.映射来源) || ''}`)
}
