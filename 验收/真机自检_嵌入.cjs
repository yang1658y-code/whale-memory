// 真机自检：用 DSH 自己那个 Electron 内置 node 跑，验插件目录里的向量层真能算。
// 跑法（cmd）：
//   set ELECTRON_RUN_AS_NODE=1
//   "C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" 临时\真机自检_嵌入.js
// 为什么要在 Electron 的 node 里跑：DSH 插件不是用系统 node 加载的，
// 系统 node 跑通不等于 DSH 里跑通（wasm/线程/路径解析都可能不同）。
(async () => {
  const 插件 = 'C:/Users/Administrator/.dsh/profiles/desktop/node_modules/whale-memory-dsh/'
  const 存 = require(插件 + '内核/存储适配器.js')
  const 装 = await 存.确保后端()
  console.log('后端装配:', JSON.stringify({ 后端: 装.后端, 模式: 装.模式, 模型ID: 装.模型ID, 维度: 装.维度, 降级: 装.降级 }))

  const 句 = ['我养了一只橘猫，名字叫豆豆', '今天天气怎么样', '我的车牌号是苏A8K2L9']
  const 维 = await 存.embed批(句)
  const 余弦 = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
  console.log('维度:', 维[0].length, '｜ 猫/猫(自己):', 余弦(维[0], 维[0]).toFixed(4),
    '｜ 猫/天气:', 余弦(维[0], 维[1]).toFixed(4),
    '｜ 猫/车牌:', 余弦(维[0], 维[2]).toFixed(4))

  const 库 = 存.读取向量库()
  const 维们 = {}
  for (const x of 库) { const k = (x.vector || []).length + '/' + (x.模型ID || '?'); 维们[k] = (维们[k] || 0) + 1 }
  console.log('向量库:', 库.length, '条 ｜ 分布:', JSON.stringify(维们))
  console.log('健康自检:', JSON.stringify(存.健康自检()))
})().catch(e => { console.log('❌ 自检失败:', String((e && e.stack) || e).slice(0, 800)); process.exitCode = 1 })
