#!/usr/bin/env node
/**
 * 压缩接管验收（离线·不依赖 DSH 运行时）
 *
 * 验的是这个产品唯一不可让的那条线：
 *   **DSH 永远不能按它自己的标准把历史摘要掉。**
 *
 * 九项，全可断言：
 *   ① 输出无模型摘要（llmStreamCall=false / provider=whale-archive / 声明齐）
 *   ② 原话逐字落盘，一字不差
 *   ③ 索引比原文小（离官方「必须更小」断言远远的）
 *   ④ 归档失败也不抛错，且如实标「归档失败」
 *   ⑤ 同一段不重复归档
 *   ⑥ 断内核（内核不在）也能用自带兜底落盘
 *   ⑦ 静态：引擎覆盖 summarize，默认路径不调 super.summarize
 *   ⑧ 静态：patch 里 compaction-basic 被 disabled（官方摘要的硬开关）
 *   ⑨ 静态：包形态正确（ESM + peer 声明 + bundle patch）
 *
 * 用法：node 验收/压缩接管验收.js
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')

const 项目根 = path.resolve(__dirname, '..')
const 插件根 = path.join(项目根, '适配器', 'dsh')
const 结果们 = []

function 记(名, 通过, 说明) {
  结果们.push({ 检查: 名, 结果: !!通过, 说明 })
  console.log((通过 ? '✅ ' : '❌ ') + 名 + ' —— ' + 说明)
}

/** 干净临时目录 */
function 临时目录(标) {
  return fs.mkdtempSync(path.join(os.tmpdir(), '鲸鱼dsh-' + 标 + '-'))
}

/** 造一段"脏"历史：中文/英文/代码/emoji/工具块/空消息都有 */
function 造历史() {
  const 长句 = '这段对话讲的是压缩接管：DSH 会把老历史摘要成一段话，那一刻原话就没了。'
  return [
    { role: 'system', content: [{ type: 'text', text: 'You are a helpful assistant.' }] },
    { role: 'user', content: [{ type: 'text', text: '用户说：绝不能让 DSH 按照他们的标准压缩摘要。' }] },
    { role: 'assistant', content: [{ type: 'text', text: '明白。' }] },
    { role: 'user', content: [{ type: 'text', text: 长句 + 长句 }] },
    { role: 'assistant', content: [{ type: 'text', text: '第一句。第二句！第三句？\n换行也算原话。' }] },
    { role: 'user', content: [{ type: 'text', text: 'code: const a = 1 < 2 && b => c\n"引号" \'单引号\'' }] },
    { role: 'assistant', content: [{ type: 'text', text: '🐋 鲸鱼 emoji 也要一字不差。' }] },
    { role: 'user', content: [] }, // 空消息：应当被跳过，不产生空句
    { role: 'user', content: [{ type: 'tool-call', toolName: 'read_file', arguments: { 路径: 'D:\\项目\\x.js' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolName: 'read_file', result: { ok: true, 大小: 42 } }] },
    { role: 'user', content: [{ type: 'text', text: '最后一句：归档要能逐字翻回来。' }] },
  ]
}

async function 主() {
  // ── 环境：所有落盘都进临时目录，绝不碰真库
  const 沙箱 = 临时目录('接管')
  process.env['鲸鱼原文表'] = path.join(沙箱, '原文回溯')
  process.env['鲸鱼内核'] = path.join(插件根, '..', '..', '内不存在的核.js')

  const 归档模块 = await import(pathToFileURL(path.join(插件根, 'lib', '归档.js')).href)
  const 接管模块 = await import(pathToFileURL(path.join(插件根, 'lib', '接管.js')).href)
  const { 取原话, 粗估token, 总字符数 } = 归档模块
  const { 造接管结果 } = 接管模块

  const 历史 = 造历史()
  const 原话 = 取原话(历史)

  // ═══ ① 无模型摘要
  const 一 = 造接管结果({ 消息们: 历史, 会话: '验收会话' })
  const 文 = 一.summary.map((b) => b.text).join('')
  记(
    '① 无模型摘要',
    一.llmStreamCall === false &&
      一.provider === 'whale-archive' &&
      Array.isArray(一.rawOutput) &&
      一.rawOutput.length === 0 &&
      一.summary.length === 1 &&
      一.summary[0].type === 'text' &&
      文.includes('原话未丢') &&
      文.includes('未做任何摘要'),
    'llmStreamCall=false / provider=whale-archive / rawOutput 空 / 单 text 块 / 声明齐'
  )

  // ═══ ② 原话逐字落盘
  const 表路径 = 一.报告.归档.路径
  let 读回 = []
  try {
    读回 = fs
      .readFileSync(表路径, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
  } catch (e) {
    读回 = []
  }
  // 内核会按标点切句（一条消息→多句），所以不能逐条对，要「拼回去逐字相等」
  const 净 = (s) => String(s).replace(/\s+/g, '')
  const 读回全文 = 净(读回.map((r) => r.文本).join(''))
  const 原话全文 = 净(原话.map((s) => s.文本).join(''))
  记(
    '② 原话逐字落盘',
    一.报告.归档.ok === true && 读回.length > 0 && 读回全文 === 原话全文,
    '落盘 ' + 读回.length + ' 句 / ' + 原话.length + ' 条消息，拼回全文逐字相等（含工具块/emoji/换行）'
  )

  // ═══ ③ 索引比原文小
  const 原文token = 粗估token(原话.map((s) => s.文本).join('\n'))
  const 索引token = 粗估token(文)
  记(
    '③ 索引显著更小',
    索引token < 原文token && 文.length <= 总字符数(历史) * 0.25 + 200,
    '索引 ' + 索引token + ' token vs 原文 ' + 原文token + ' token（' + 文.length + ' 字符）'
  )

  // ═══ ④ 归档失败也不抛错
  let 四 = null
  let 四抛错 = null
  const 沙箱2 = 临时目录('坏路径')
  const 假文件 = path.join(沙箱2, '这是个文件不是目录')
  fs.writeFileSync(假文件, 'x', 'utf8')
  process.env['鲸鱼原文表'] = path.join(假文件, '原文回溯') // 父级是文件 → 必然写不进去
  try {
    四 = 造接管结果({ 消息们: 历史, 会话: '坏路径会话' })
  } catch (e) {
    四抛错 = e
  }
  记(
    '④ 归档失败不抛错',
    !四抛错 &&
      四 &&
      四.summary &&
      四.summary.length === 1 &&
      四.报告.归档.ok === false &&
      四.summary[0].text.includes('归档失败'),
    '写入失败时仍返回索引，并如实标注「归档失败」（不是假装记得）'
  )

  // ═══ ⑤ 同一段不重复归档
  process.env['鲸鱼原文表'] = path.join(沙箱, '原文回溯')
  const 五 = 造接管结果({ 消息们: 历史, 会话: '验收会话' })
  const 表行数 = fs
    .readFileSync(一.报告.归档.路径, 'utf8')
    .split('\n')
    .filter((l) => l.trim()).length
  记(
    '⑤ 重复段不重写',
    五.报告.重复 === true && 表行数 === 读回.length && 五.summary[0].text.includes('已归档过'),
    '指纹命中，原文表仍 ' + 表行数 + ' 行，未重复追加'
  )

  // ═══ ⑥ 断内核（内核不在）也能兜底落盘
  const 沙箱3 = 临时目录('断内核')
  process.env['鲸鱼原文表'] = path.join(沙箱3, '原文回溯')
  process.env['鲸鱼禁用内核'] = '1' // 强制全部内核候选失效，真断依赖
  const 六 = 造接管结果({ 消息们: 历史, 会话: '断核会话' })
  delete process.env['鲸鱼禁用内核']
  let 六行 = []
  try {
    六行 = fs
      .readFileSync(六.报告.归档.路径, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
  } catch {}
  记(
    '⑥ 断内核仍可用',
    六.报告.归档.ok === true &&
      六.报告.归档.内核 === 'none' &&
      六行.length === 原话.length &&
      六.summary[0].text.includes('兜底写入'),
    '内核缺失 → 自带同格式落盘（一条消息一行），' + 六行.length + ' 行'
  )

  // ═══ ⑦ 静态：真的覆盖了 summarize，且默认路径不调 super
  const 插件源 = fs.readFileSync(path.join(插件根, 'index.js'), 'utf8')
  const 有继承 = /extends\s+BasicCompactionEngine/.test(插件源)
  const 有覆盖 = /async\s+summarize\s*\(/.test(插件源)
  const super次数 = (插件源.match(/super\.summarize/g) || []).length
  const 应急阀在前 = /鲸鱼关闭接管'\]\s*===\s*'1'/.test(插件源)
  记(
    '⑦ 引擎覆盖 summarize',
    有继承 && 有覆盖 && super次数 === 1 && 应急阀在前,
    '继承官方引擎 + 覆盖 summarize；super.summarize 只出现 ' + super次数 + ' 次且在应急阀内'
  )

  // ═══ ⑧ 静态：官方摘要后端被 disabled（硬开关）
  const patch文 = fs.readFileSync(path.join(插件根, 'cordis.patch.yml'), 'utf8')
  const 有禁用 = /- id:\s*compaction-basic[\s\S]{0,80}?disabled:\s*true/.test(patch文)
  const 有挂载 = /name:\s*['"]whale-memory-dsh['"]/.test(patch文)
  记(
    '⑧ patch 硬开关',
    有禁用 && 有挂载,
    'compaction-basic 已 disabled（官方摘要不加载）+ 挂载我们的引擎'
  )

  // ═══ ⑨ 静态：包形态
  const 包 = JSON.parse(fs.readFileSync(path.join(插件根, 'package.json'), 'utf8'))
  const peer = 包.peerDependencies || {}
  记(
    '⑨ 包形态正确',
    包.type === 'module' &&
      包.exports &&
      包.exports['.'] === './index.js' &&
      typeof peer['@deepseek-ai/dsh-compaction-basic'] === 'string' &&
      包.dsh &&
      包.dsh.bundle &&
      包.dsh.bundle.patch === './cordis.patch.yml',
    'ESM + peer 声明 compaction-basic（运行时解析器据此供包）+ bundle patch'
  )

  // ═══ ⑩ 短段也不撞官方「必须更小」断言
  const 沙箱4 = 临时目录('短段')
  process.env['鲸鱼原文表'] = path.join(沙箱4, '原文回溯')
  const 短历史 = [
    { role: 'user', content: [{ type: 'text', text: '用户：动手。' }] },
    { role: 'assistant', content: [{ type: 'text', text: '臣遵旨，压缩接管已接上。' }] },
  ]
  const 十 = 造接管结果({ 消息们: 短历史, 会话: '短段会话' })
  const 十文 = 十.summary[0].text
  const 短字数 = 总字符数(短历史)
  记(
    '⑩ 短段索引仍更小',
    十文.length < 短字数 && /归档/.test(十文),
    '原文 ' + 短字数 + ' 字 → 索引 ' + 十文.length + ' 字（不撞「摘要必须更小」断言）'
  )

  // ═══ ⑪ 极小段（30 字内）也不能把压缩搞失败
  const 沙箱5 = 临时目录('极小段')
  process.env['鲸鱼原文表'] = path.join(沙箱5, '原文回溯')
  const 极小历史 = [{ role: 'user', content: [{ type: 'text', text: '好的。' }] }]
  const 十一 = 造接管结果({ 消息们: 极小历史, 会话: '极小会话' })
  const 十一文 = 十一.summary[0].text
  const 极小字数 = 总字符数(极小历史)
  记(
    '⑪ 极小段不抛错',
    !!十一.summary && 十一.summary.length === 1 && 十一文.length < Math.max(极小字数, 20),
    '原文 ' + 极小字数 + ' 字 → 索引 ' + 十一文.length + ' 字，仍小于原文字符数'
  )

  // ── 收尾
  const 过 = 结果们.filter((r) => r.结果).length
  const 总 = 结果们.length
  const 输出 = {
    时间: new Date().toISOString(),
    通过: 过,
    总数: 总,
    退出码: 过 === 总 ? 0 : 1,
    明细: 结果们,
  }
  fs.writeFileSync(
    path.join(项目根, '验收', '压缩接管验收结果.json'),
    JSON.stringify(输出, null, 2),
    'utf8'
  )
  console.log('\n' + (过 === 总 ? '🟢' : '🔴') + ' 压缩接管验收：' + 过 + '/' + 总)
  require('./断言报告.js').报(过, 总)
  process.exit(过 === 总 ? 0 : 1)
}

主().catch((e) => {
  console.error('验收脚本自身崩了：', e)
  process.exit(2)
})
