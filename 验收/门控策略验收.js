/**
 * 门控策略验收.js — 基线 v7「验收三条」的可执行版本
 *
 * 跑法：node 验收/门控策略验收.js
 *
 * 验的不是「代码写得对不对」，验的是三件制度上的事：
 *   ① 断配置演练：删掉/改坏配置 → 仍以 quiet + 全疑问句跑通，只 warn 不崩
 *   ② 换模型演练：标定标签与当前模型不符 → 自动降 quiet + 告警（日志含两组标签原文）
 *   ③ 加档演练：新增 profile 只改 JSON → 一行代码不动即生效
 * 附赠两项：
 *   ④ 三档复算：新引擎跑 50 题，数字必须与基线 v7 记的 44/95、54/96、66/88 对得上
 *   ⑤ 阈值字面量扫描：证明门控/判定/冷却/措辞四个函数体内没有硬编码阈值
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

const 根 = path.resolve(__dirname, '..')
const 引擎路径 = path.join(根, '内核', '门控策略.js')
const 配置路径 = path.join(根, '配置', '门控策略.json')
const 分组路径 = path.join(__dirname, '门控分组.json')

const 引擎 = require(引擎路径)
const 组 = JSON.parse(fs.readFileSync(分组路径, 'utf8'))

const 结果清单 = []
function 断言(编号, 名称, 通过, 详情) {
  结果清单.push({ 编号, 名称, 通过: !!通过, 详情 })
  console.log(`${通过 ? '✅' : '❌'} [${编号}] ${名称}${详情 ? '\n     ' + String(详情).replace(/\n/g, '\n     ') : ''}`)
}
function 小标题(t) { console.log('\n' + '═'.repeat(64) + '\n' + t + '\n' + '═'.repeat(64)) }

// 把门控分组.json 的 50 题映射成引擎认的候选
// 交集数 = 两路各自前3名有几条共同命中（交3==1 → 3，否则 0）；交集5 同理按前5
// 这样 gate.k=3 与基线里「前3有交集」严格等价，不会把「前5有交集」混进来
function 造候选() {
  return 组.map((题, i) => ({
    记忆ID: 'q' + (i + 1),
    族: 题.族 === '字面' ? 'literal' : 'rewrite',
    交集数: 题.交3 === 1 ? 3 : 0,
    交集5: 题.交5 === 1 ? 5 : 0,
    余弦: 题.余弦,
    _对: 题.对 === 1
  }))
}
const 候选池 = 造候选()

// 50 题跑一档，返回 {提出数, 提出率, 准确率}
function 跑档(策略) {
  let 提出 = 0, 提出且对 = 0, 反问 = 0
  for (const 候选 of 候选池) {
    const r = 引擎.门控([候选], 策略, {})
    if (r.开口) {
      提出++
      if (候选._对) 提出且对++
      if (r.措辞 === '疑问') 反问++
    }
  }
  return { 提出数: 提出, 题数: 候选池.length, 提出率: +(提出 / 候选池.length * 100).toFixed(0), 准确率: +(提出且对 / Math.max(1, 提出) * 100).toFixed(0), 疑问句占比: +(反问 / Math.max(1, 提出) * 100).toFixed(0) }
}

function 临时目录(名) {
  const d = path.join(os.tmpdir(), '门控策略验收_' + 名 + '_' + Date.now())
  fs.mkdirSync(d, { recursive: true })
  return d
}

// ═══════════════════════════════════════════
// ⓪ 基线：真配置能加载
// ═══════════════════════════════════════════
小标题('⓪ 基线：真配置加载')
const 基线 = 引擎.加载策略({ 静默: true, 当前模型: { 模型ID: 'bge-small-zh-v1.5', 维度: 512 } })
console.log('profile =', 基线.策略.profile, '｜来源 =', 基线.来源, '｜降档 =', 基线.降档)
console.log('日志：', 基线.日志.map(l => `${l.级别}:${l.内容}`).join(' / ') || '（无）')
断言('0-1', '真配置加载成功且停在 standard 档（标定标签匹配）', 基线.策略.profile === 'standard' && 基线.降档 === false, `profile=${基线.策略.profile}`)

// ═══════════════════════════════════════════
// ① 断配置演练
// ═══════════════════════════════════════════
小标题('① 断配置演练：删掉 / 改坏配置，产品仍是一只懂事的鲸鱼，只是话少')

const 甲 = 临时目录('断配置')
// 1-A 配置不存在
const 缺文件 = 引擎.加载策略({ 静默: true, 路径: path.join(甲, '根本不存在.json'), 当前模型: { 模型ID: 'bge-small-zh-v1.5', 维度: 512 } })
const 缺文件warn = 缺文件.日志.filter(l => l.级别 === 'warn')
断言('1-A', '配置文件不存在 → 回落 quiet + 全疑问句，只 warn 不崩',
  缺文件.策略.profile === 'quiet' && 缺文件.策略.强制疑问句 === true && 缺文件warn.length === 1,
  `profile=${缺文件.策略.profile} 强制疑问句=${缺文件.策略.强制疑问句} warn条数=${缺文件warn.length}\n${缺文件warn[0] ? 缺文件warn[0].内容 : ''}`)

// 1-B 配置是坏 JSON
const 坏路径 = path.join(甲, '坏掉.json')
fs.writeFileSync(坏路径, '{ "profile": "standard", 这里面根本不是JSON', 'utf8')
const 坏配置 = 引擎.加载策略({ 静默: true, 路径: 坏路径, 当前模型: { 模型ID: 'bge-small-zh-v1.5', 维度: 512 } })
断言('1-B', '配置是坏 JSON → 回落 quiet + 全疑问句',
  坏配置.策略.profile === 'quiet' && 坏配置.策略.强制疑问句 === true,
  `profile=${坏配置.策略.profile}　warn=${坏配置.日志.filter(l => l.级别 === 'warn').length}条`)

// 1-C 配置字段不全（缺 gates / 缺 profile）
const 残路径 = path.join(甲, '残疾.json')
fs.writeFileSync(残路径, JSON.stringify({ profile: 'standard' }), 'utf8')
const 残配置 = 引擎.加载策略({ 静默: true, 路径: 残路径, 当前模型: { 模型ID: 'bge-small-zh-v1.5', 维度: 512 } })
断言('1-C', '配置字段不全（只有 profile，无 profiles/gates）→ 回落 quiet + 全疑问句',
  残配置.策略.profile === 'quiet' && 残配置.策略.强制疑问句 === true,
  `profile=${残配置.策略.profile}　修正=${JSON.stringify(残配置.修正 || [])}`)

// 1-D 断配置之后门控必须还能跑（不崩、不提错句）
let 断配置跑通 = false, 断配置全疑问 = true, 断配置提出 = 0
try {
  for (const 候选 of 候选池) {
    const r = 引擎.门控([候选], 残配置.策略, {})
    if (r.开口) { 断配置提出++; if (r.措辞 !== '疑问') 断配置全疑问 = false }
  }
  断配置跑通 = true
} catch (e) { 断配置跑通 = false }
断言('1-D', '断配置后仍能跑完 50 题不抛异常，且开口一律疑问句',
  断配置跑通 && 断配置全疑问,
  `跑通=${断配置跑通} 全疑问=${断配置全疑问} 断配置下提出=${断配置提出}/50（应与真 quiet 档完全一致）`)

// ═══════════════════════════════════════════
// ② 换模型演练
// ═══════════════════════════════════════════
小标题('② 换模型演练：标定标签与当前模型不符 → 强制降 quiet + 告警')
const 乙 = 临时目录('换模型')
const 真配置 = JSON.parse(fs.readFileSync(配置路径, 'utf8'))
const 改过的 = JSON.parse(JSON.stringify(真配置))
改过的.标定.模型 = 'some-other-embed-v2'
delete 改过的.标定.维度
const 乙路径 = path.join(乙, '换模型.json')
fs.writeFileSync(乙路径, JSON.stringify(改过的, null, 2), 'utf8')

const 换模型 = 引擎.加载策略({ 静默: true, 路径: 乙路径, 当前模型: { 模型ID: 'bge-small-zh-v1.5', 维度: 512 } })
const 换模型warn = 换模型.日志.filter(l => l.级别 === 'warn').map(l => l.内容).join(' ｜ ')
断言('2-A', '标定.模型 被改成别名 → 自动降 standard→quiet，降档标记为真',
  换模型.策略.profile === 'quiet' && 换模型.降档 === true,
  `profile=${换模型.策略.profile} 降档=${换模型.降档}`)
断言('2-B', '告警日志同时含「旧标签」与「当前模型」两组原文，能直接排障',
  换模型warn.includes('some-other-embed-v2') && 换模型warn.includes('bge-small-zh-v1.5'),
  `日志：${换模型warn}`)
// 2-C 标签比对：模型/维度两端改成一致 → 不应再降档
// 注意这条验的是「按标签认人」的机制，不是「认可它准」——真换模型还得重标阈值
const 乙2 = 临时目录('换模型_同标签')
const 同标签配置 = JSON.parse(JSON.stringify(真配置))
同标签配置.标定.模型 = 'some-other-embed-v2'
const 乙2路径 = path.join(乙2, '同标签.json')
fs.writeFileSync(乙2路径, JSON.stringify(同标签配置, null, 2), 'utf8')
const 不降 = 引擎.加载策略({ 静默: true, 路径: 乙2路径, 当前模型: { 模型ID: 'some-other-embed-v2', 维度: 512 } })
断言('2-C', '标定标签与当前模型两端一致（模型别名 + 同维度）→ 不再降档，停在 standard',
  不降.策略.profile === 'standard' && 不降.降档 === false,
  `profile=${不降.策略.profile}（机制意义：标签一致才放行；但真换模型必须重标阈值，不是改了名就算对）`)

// ═══════════════════════════════════════════
// ③ 加档演练：只改 JSON，一行代码不动
// ═══════════════════════════════════════════
小标题('③ 加档演练：新增 chatty 档，只改 JSON，一行代码不动')
const 丙 = 临时目录('加档')
const 加档配置 = JSON.parse(JSON.stringify(真配置))
加档配置.profiles.chatty = ['cross3', 'cosine_literal', 'cosine_rewrite', 'cross5']
加档配置.gates.cross5 = { 类型: '交集', 字段: '交集5', k: 5, 置信: '高' }
加档配置.profile = 'chatty'
const 丙路径 = path.join(丙, '加档.json')
fs.writeFileSync(丙路径, JSON.stringify(加档配置, null, 2), 'utf8')

const 加大 = 引擎.加载策略({ 静默: true, 路径: 丙路径, 当前模型: { 模型ID: 'bge-small-zh-v1.5', 维度: 512 } })
const 生效 = 加大.策略.profiles[加大.策略.profile] || []
断言('3-A', '新增 profile 后加载即生效，profile=chatty，生效 gate 4 条，代码零改动',
  加大.策略.profile === 'chatty' && 生效.length === 4,
  `profile=${加大.策略.profile} 生效gate=${JSON.stringify(生效)}`)
const chatty统计 = 跑档(加大.策略)
断言('3-B', 'chatty 档在 50 题上真跑出数据（证明档位是数据不是逻辑）',
  chatty统计.提出数 > 0,
  `提出 ${chatty统计.提出数}/50 = ${chatty统计.提出率}%，准确 ${chatty统计.准确率}% —— 比 active 更活跃，也更不准，符合预期`)

// ═══════════════════════════════════════════
// ④ 三档复算：必须与基线 v7 数字对齐
// ═══════════════════════════════════════════
小标题('④ 三档复算：新引擎跑出来的数字，必须与基线 v7 记的一致')
const 基线数字 = {
  quiet: { 提出率: 44, 准确率: 95 },
  standard: { 提出率: 54, 准确率: 96 },
  active: { 提出率: 66, 准确率: 88 }
}
const 复算表 = []
for (const 档 of ['quiet', 'standard', 'active']) {
  const s = JSON.parse(JSON.stringify(基线.策略))
  s.profile = 档
  const 统 = 跑档(s)
  复算表.push({ 档位: 档, ...统, 需求单: 基线数字[档] })
  const 对齐 = 统.提出率 === 基线数字[档].提出率 && 统.准确率 === 基线数字[档].准确率
  断言('4-' + 档, `引擎复算 ${档} 档与基线对齐（提出率 ${基线数字[档].提出率}% / 准确 ${基线数字[档].准确率}%）`,
    对齐, `实得 提出率 ${统.提出率}%（${统.提出数}/50）　准确 ${统.准确率}%　疑问句占比 ${统.疑问句占比}%`)
}

// 4-X 档3一票否决与措辞分级
const 全不中 = 引擎.门控([{ 记忆ID: 'x1', 族: 'rewrite', 交集数: 0, 余弦: 0.42 }], 基线.策略, {})
断言('4-X', '三条 gate 全不过 → 不开口，理由里逐条说清是哪条 gate 拦的',
  全不中.开口 === false && /cross3拦1条/.test(全不中.理由) && 全不中.理由.includes('cosine_literal拦1条'),
  全不中.理由)
const 高置信 = 引擎.门控([{ 记忆ID: 'x2', 族: 'literal', 交集数: 3, 余弦: 0.5 }], 基线.策略, {})
const 中置信 = 引擎.门控([{ 记忆ID: 'x3', 族: 'literal', 交集数: 0, 余弦: 0.80 }], 基线.策略, {})
断言('4-Y', '措辞分级：交集命中→陈述（高置信），余弦命中→疑问（中置信）',
  高置信.措辞 === '陈述' && 中置信.措辞 === '疑问',
  `交集→${高置信.措辞}（置信${高置信.置信}）　余弦→${中置信.措辞}（置信${中置信.置信}）`)
const 活跃档策略 = Object.assign({}, 基线.策略, { profile: 'active' })
const 改写命中 = 引擎.门控([{ 记忆ID: 'x4', 族: 'rewrite', 交集数: 0, 余弦: 0.90 }], 活跃档策略, {})
断言('4-Z', '活跃档改写族命中 → 强制疑问句（把提错的代价降为「问一句」）',
  改写命中.开口 === true && 改写命中.措辞 === '疑问' && 改写命中.命中gate === 'cosine_rewrite',
  `命中gate=${改写命中.命中gate} 措辞=${改写命中.措辞}`)

// ═══════════════════════════════════════════
// ⑤ 冷却闸
// ═══════════════════════════════════════════
小标题('⑤ 冷却闸：A案/B案共用一张表')
const 候选A = { 记忆ID: 'm1', 族: 'literal', 交集数: 3, 余弦: 0.9 }
const 现在 = 1700000000000
const 上下文 = { 现在, 已提记录: {}, 最近提话: [] }
const 首次 = 引擎.门控([候选A], 基线.策略, 上下文)
引擎.登记已提(上下文, 候选A, 现在)
const 第二次 = 引擎.门控([候选A], 基线.策略, Object.assign({}, 上下文, { 现在: 现在 + 2 * 3600 * 1000 }))
断言('5-A', '同一条记忆 2 小时前提过 → 30 天冷却内不再提',
  首次.开口 === true && 第二次.开口 === false && 第二次.理由.includes('冷却'),
  `第一次开口=${首次.开口}　2小时后开口=${第二次.开口}｜${第二次.明细.filter(d => d.gate === '冷却闸').map(d => d.说明)[0] || ''}`)
const 另一条 = { 记忆ID: 'm2', 族: 'literal', 交集数: 3, 余弦: 0.9 }
const 频率基准 = 现在 + 3 * 3600 * 1000
const 频率 = 引擎.门控([另一条], 基线.策略, { 现在: 频率基准, 已提记录: {}, 最近提话: [频率基准 - 10 * 60 * 1000] })
断言('5-B', '不同记忆但 1 小时内已提过 1 次 → 频率闸拦住（每小时上限 1）',
  频率.开口 === false && 频率.理由.includes('频率闸'), 频率.理由)
const 隔夜 = 引擎.门控([候选A], 基线.策略, { 现在: 现在 + 2 * 3600 * 1000, 已提记录: { m1: 现在 - 31 * 24 * 3600 * 1000 }, 最近提话: [] })
断言('5-C', '31 天前提过的同一条记忆 → 冷却已过，可以再提',
  隔夜.开口 === true, `开口=${隔夜.开口}`)

// ═══════════════════════════════════════════
// ⑥ 阈值字面量扫描：函数体内不许有硬编码阈值
// ═══════════════════════════════════════════
小标题('⑥ 阈值字面量扫描：门控函数体内不许出现 0.65 / 3 / 30 这类数字')
const 源码 = fs.readFileSync(引擎路径, 'utf8')
function 切函数体(名) {
  const 起 = 源码.indexOf('function ' + 名 + '(')
  if (起 < 0) return ''
  // 从函数头找第一个 { 开始花括号配平
  let i = 源码.indexOf('{', 起), 深 = 0
  for (let j = i; j < 源码.length; j++) {
    if (源码[j] === '{') 深++
    else if (源码[j] === '}') { 深--; if (深 === 0) return 源码.slice(i, j + 1) }
  }
  return ''
}
// 白名单：循环索引/计数/小数位格式化，这些不是策略阈值
const 白名单 = new Set(['0', '1', '2', '4', '10'])
const 违规 = []
for (const 名 of ['门控', '判定单gate', '冷却闸', '选措辞']) {
  const 体 = 切函数体(名).replace(/\/\/[^\n]*/g, '') // 去行注释
  const 行们 = 体.split('\n')
  行们.forEach((行, idx) => {
    const 匹配 = 行.match(/(?<![\w$.])\d+(?:\.\d+)?/g) || []
    匹配.forEach(m => { if (!白名单.has(m)) 违规.push(`${名} 第${idx + 1}行 出现数字 ${m} → ${行.trim().slice(0, 70)}`) })
  })
}
断言('6-A', '门控/判定/冷却/措辞 四函数体内无策略阈值字面量（白名单仅限 0/1/2/4/10 这类计数与格式化）',
  违规.length === 0, 违规.length ? 违规.join('\n') : '扫描通过：0 处违规')

// ═══════════════════════════════════════════
// 汇总
// ═══════════════════════════════════════════
小标题('汇总')
const 过 = 结果清单.filter(r => r.通过).length
console.log(`验收项 ${结果清单.length} 条：通过 ${过} 条，失败 ${结果清单.length - 过} 条`)
require('./断言报告.js').报(过, 结果清单.length)
console.log('\n三档复算表：')
console.log('档位\t\t提出数\t提出率\t准确率\t疑问句占比')
复算表.forEach(r => console.log(`${r.档位}\t\t${r.提出数}/50\t${r.提出率}%\t${r.准确率}%\t${r.疑问句占比}%`))
console.log(`\nchatty（演练用第四档）\t${chatty统计.提出数}/50\t${chatty统计.提出率}%\t${chatty统计.准确率}%\t${chatty统计.疑问句占比}%`)

const 报告 = {
  跑测时间: new Date().toISOString(),
  引擎: 引擎路径,
  配置: 配置路径,
  通过: 过,
  失败: 结果清单.length - 过,
  验收项: 结果清单,
  三档复算: 复算表,
  加档演练: chatty统计
}
const 报告路径 = path.join(__dirname, '门控策略验收结果.json')
fs.writeFileSync(报告路径, JSON.stringify(报告, null, 2), 'utf8')
console.log('\n报告已落盘：' + 报告路径)

// 清理临时目录
for (const d of [甲, 乙, 乙2, 丙]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch (e) {} }

if (结果清单.some(r => !r.通过)) console.log('\n⚠️ 有验收项未通过，见上方 ❌')
