'use strict'
/**
 * 去重验收.js —— 指纹去重（存储层哨兵）验收
 *
 * 一件事：同角色 + 同内容 = 同一条记忆。
 *   命中不新增行，只记一次「复习」→ 出现次数 / 首次时间 / 最近时间 / 句ID们 合并。
 *   原文表一个字不动（事实源只追加），所以可回溯性不减。
 *
 * 全部跑在临时目录，不碰 数据/ 真库。
 * 运行：node 验收/去重验收.js  （退出码 0 = 全绿）
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const 适配器 = require('../内核/存储适配器.js')
const 入库 = require('../内核/对话入库.js')
const 回溯 = require('../内核/原文回溯.js')

let 过 = 0, 败 = 0
const 报告 = []
function 断言(名, 条件, 附注) {
  if (条件) { 过++; 报告.push('  ✅ ' + 名) }
  else { 败++; 报告.push('  ❌ ' + 名 + (附注 ? '　—　' + 附注 : '')) }
}
function 分节(名) { 报告.push(''), 报告.push('【' + 名 + '】') }

const 临时根 = fs.mkdtempSync(path.join(os.tmpdir(), '鲸鱼去重验收-'))
function 新根(名) {
  const d = path.join(临时根, name2(名))
  fs.mkdirSync(d, { recursive: true })
  return d
}
function name2(s) { return String(s).replace(/[\\/:*?"<>|]/g, '_') }
function 读库(根) {
  const p = path.join(根, 适配器.默认库文件名)
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8').split('\n').filter(s => s.trim()).map(s => JSON.parse(s))
}
function 读原文(根, 会话) {
  // 不猜文件名：会话名会被归一回写（标点/空白），一律问内核要
  const 名 = typeof 回溯.归一会话名 === 'function' ? 回溯.归一会话名(会话) : 会话
  const 表 = 回溯.读原文表(名, { 根目录: 根 })
  return (表 && Array.isArray(表.记录)) ? 表.记录 : []
}

;(async () => {
  // ═══ ① 同内容三次不同时间 → 一条记忆、三次出现 ═══
  分节('① 同内容三次不同时间')
  const 根1 = 新根('重复三次')
  const T0 = Date.parse('2026-10-26T22:40:09')
  const r1 = await 适配器.存入消息('user', '我最近在忙什么', T0, null, '稳定', null, null, { 句ID们: ['会话A#2.1'] }, { 根目录: 根1 })
  const r2 = await 适配器.存入消息('user', '我最近在忙什么', T0 + 15 * 60000, null, '稳定', null, null, { 句ID们: ['会话A#3.1'] }, { 根目录: 根1 })
  const r3 = await 适配器.存入消息('user', '我最近在忙什么', T0 + 56 * 60000, null, '稳定', null, null, { 句ID们: ['会话A#4.1'] }, { 根目录: 根1 })
  let 库1 = 读库(根1)
  断言('第一次写入落盘', r1.ok && !r1.跳过 && 库1.length === 1, JSON.stringify(r1))
  断言('第二次被拦下（跳过）', r2.ok && r2.跳过 === true, JSON.stringify(r2))
  断言('第三次也被拦下', r3.ok && r3.跳过 === true, JSON.stringify(r3))
  断言('库里只有 1 条，不是 3 条', 库1.length === 1, '实际 ' + 库1.length)
  断言('出现次数 = 3', 库1[0].出现次数 === 3, '实际 ' + 库1[0].出现次数)
  断言('首次时间 = 最早那次', 库1[0].首次时间 === T0, '实际 ' + 库1[0].首次时间)
  断言('最近时间 = 最晚那次', 库1[0].最近时间 === T0 + 56 * 60000, '实际 ' + 库1[0].最近时间)
  断言('time 保持首次（不被复习时间顶掉）', 库1[0].time === T0, '实际 ' + 库1[0].time)
  断言('三个句ID全收回', Array.isArray(库1[0].句ID们) && 库1[0].句ID们.length === 3, JSON.stringify(库1[0].句ID们))
  断言('句ID 首句不变', 库1[0].句ID === '会话A#2.1', String(库1[0].句ID))
  断言('id 保持原条（不换新 id）', 库1[0].id === r1.id, r1.id + ' vs ' + 库1[0].id)

  // 归一条目 不得把去重账本吞掉（否则记忆曲线拿不到输入）
  const 归一 = 适配器.读取向量库({ 根目录: 根1 }).find(o => o.role === 'user' && o.content === '我最近在忙什么')
  断言('读取向量库 能带出 出现次数', 归一 && 归一.出现次数 === 3, JSON.stringify(归一 && 归一.出现次数))
  断言('读取向量库 能带出 首次/最近时间', !!(归一 && 归一.首次时间 && 归一.最近时间), JSON.stringify(归一 && [归一.首次时间, 归一.最近时间]))
  断言('读取向量库 能带出 指纹', !!(归一 && 归一.指纹), String(归一 && 归一.指纹))

  // ═══ ② 角色不同 = 两条记忆（同一句话用户说 vs 鲸鱼说，不能并） ═══  分节('② 同内容不同角色')
  await 适配器.存入消息('assistant', '我最近在忙什么', T0, null, '稳定', null, null, {}, { 根目录: 根1 })
  库1 = 读库(根1)
  断言('assistant 另起一条 → 共 2 条', 库1.length === 2, '实际 ' + 库1.length)
  断言('两条角色不同', 库1[0].role !== 库1[1].role, 库1.map(o => o.role).join('/'))

  // ═══ ③ 空白差异算同一条（保守归一化生效） ═══
  分节('③ 空白差异')
  const 根3 = 新根('空白差异')
  await 适配器.存入消息('user', 'VPS 换到新加坡了', T0, null, '稳定', null, null, {}, { 根目录: 根3 })
  const r3b = await 适配器.存入消息('user', '  VPS   换到新加坡了  \n', T0 + 1000, null, '稳定', null, null, {}, { 根目录: 根3 })
  断言('首尾空白+多空格+换行 → 判为重复', r3b.跳过 === true, JSON.stringify(r3b))
  断言('库仍 1 条', 读库(根3).length === 1, '实际 ' + 读库(根3).length)

  // ═══ ④ 内容不同绝不并（宁可少并一条，也不许把两句话认成一句） ═══
  分节('④ 不同内容不误并')
  const 根4 = 新根('不同内容')
  const 句表 = ['我最近在忙什么', '我最近忙不忙', '这两天在弄插件', '我是神仙吗']
  for (const s of 句表) await 适配器.存入消息('user', s, T0, null, '稳定', null, null, {}, { 根目录: 根4 })
  断言('四句不同内容 → 4 条', 读库(根4).length === 4, '实际 ' + 读库(根4).length)

  // ═══ ⑤ 历史遗留重复行：一次写入把老库清干净 ═══
  分节('⑤ 历史遗留重复行清理（真库现存问题）')
  const 根5 = 新根('遗留重复')
  fs.mkdirSync(path.join(根5, '原文回溯'), { recursive: true })
  const 老库 = [
    { id: 'aaa', role: 'user', content: '我最近在忙什么', time: T0, 句ID们: ['S#2.1'], 句ID: 'S#2.1' },
    { id: 'bbb', role: 'user', content: '我最近在忙什么', time: T0 + 60 * 60000, 句ID们: ['S#3.1'], 句ID: 'S#3.1' },
    { id: 'ccc', role: 'user', content: '我最近在忙什么', time: T0 + 120 * 60000, 句ID们: ['S#4.1'], 句ID: 'S#4.1' },
    { id: 'ddd', role: 'user', content: '我是神仙吗', time: T0 + 180 * 60000, 句ID们: ['S#5.1'], 句ID: 'S#5.1' }
  ]
  fs.writeFileSync(path.join(根5, 适配器.默认库文件名), 老库.map(o => JSON.stringify(o)).join('\n') + '\n', 'utf8')
  const r5 = await 适配器.存入消息('user', '我最近在忙什么', T0 + 240 * 60000, null, '稳定', null, null, { 句ID们: ['S#6.1'] }, { 根目录: 根5 })
  const 库5 = 读库(根5)
  const 合并条 = 库5.filter(o => o.content === '我最近在忙什么')
  断言('3 条老重复并成 1 条', 合并条.length === 1, '实际 ' + 合并条.length)
  断言('总条数 4 → 2', 库5.length === 2, '实际 ' + 库5.length)
  断言('清理冗余 = 2', r5.清理冗余 === 2, '实际 ' + r5.清理冗余)
  断言('出现次数 = 3 + 1 = 4（老条按 1 计）', 合并条[0].出现次数 === 4, '实际 ' + 合并条[0].出现次数)
  断言('四个句ID全收回', 合并条[0].句ID们.length === 4, JSON.stringify(合并条[0].句ID们))
  断言('不相关那条（我是神仙吗）原样留着', 库5.some(o => o.id === 'ddd'), JSON.stringify(库5.map(o => o.id)))

  // ═══ ⑥ 开关：选项.去重=false 时不拦 ═══
  分节('⑥ 去重开关')
  const 根6 = 新根('开关关闭')
  await 适配器.存入消息('user', '同一句话', T0, null, '稳定', null, null, {}, { 根目录: 根6 })
  const r6 = await 适配器.存入消息('user', '同一句话', T0 + 1000, null, '稳定', null, null, {}, { 根目录: 根6, 去重: false })
  断言('去重=false → 照写不拦', !r6.跳过, JSON.stringify(r6))
  断言('库有 2 条', 读库(根6).length === 2, '实际 ' + 读库(根6).length)

  // ═══ ⑦ 端到端：入库一轮 两次同内容不同轮 → 原文表 2 行 / 向量库 1 条 ═══
  分节('⑦ 端到端（双写层不被去重带偏）')
  const 根7 = 新根('端到端')
  const 轮1 = await 入库.入库一轮('会话-去重验收', [{ 角色: 'user', 文本: '我最近在忙什么' }], { 根目录: 根7, 时间: T0 })
  const 轮2 = await 入库.入库一轮('会话-去重验收', [{ 角色: 'user', 文本: '我最近在忙什么' }], { 根目录: 根7, 时间: T0 + 60000 })
  const 原文7 = 读原文(根7, '会话-去重验收')
  const 库7 = 读库(根7)
  断言('轮1 向量写入 1', 轮1.向量.写入 === 1, JSON.stringify(轮1.向量))
  断言('轮2 向量跳过 1（去重生效）', 轮2.向量.跳过 === 1 && 轮2.向量.写入 === 0, JSON.stringify(轮2.向量))
  断言('轮2 跳过原因写明是内容重复', !!(轮2.向量.明细[0] && /内容重复/.test(String(轮2.向量.明细[0].原因))), JSON.stringify(轮2.向量.明细[0]))
  断言('原文表 2 行（事实源照旧逐句追加）', 原文7.length === 2, '实际 ' + 原文7.length)
  断言('向量库 1 条', 库7.length === 1, '实际 ' + 库7.length)
  断言('条上挂着两个句ID（两句原话都能翻）', 库7[0].句ID们.length === 2, JSON.stringify(库7[0].句ID们))
  断言('轮1/轮2 都 ok（去重不算失败）', 轮1.ok && 轮2.ok, 轮1.ok + '/' + 轮2.ok)

  // ═══ ⑧ 索引随 mtime 重建（外部写入不被内存旧账本误判） ═══
  分节('⑧ 外部改写后索引重建')
  const 根8 = 新根('外部改写')
  await 适配器.存入消息('user', '外部写入测试', T0, null, '稳定', null, null, {}, { 根目录: 根8 })
  const 手工条 = { id: 'zzz', role: 'user', content: '另一句外部写的', time: T0, 句ID们: [], 句ID: null }
  fs.appendFileSync(path.join(根8, 适配器.默认库文件名), JSON.stringify(手工条) + '\n', 'utf8')
  const 根8b = await 适配器.存入消息('user', '另一句外部写的', T0 + 5000, null, '稳定', null, null, {}, { 根目录: 根8 })
  断言('外部追加的条目也能被认出重复', 根8b.跳过 === true, JSON.stringify(根8b))
  断言('库里仍 2 条', 读库(根8).length === 2, '实际 ' + 读库(根8).length)

  // ═══ 收尾 ═══
  报告.push('')
  报告.push('═'.repeat(48))
  报告.push('去重验收：' + 过 + ' 过 / ' + 败 + ' 败　（临时目录：' + 临时根 + '）')
  console.log(报告.join('\n'))
  process.exit(败 === 0 ? 0 : 1)
})().catch(e => {
  console.error('验收崩了：' + (e && e.stack || e))
  process.exit(2)
})
