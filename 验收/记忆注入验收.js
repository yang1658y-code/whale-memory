#!/usr/bin/env node
/**
 * 记忆注入验收（离线·不依赖 DSH 运行时）
 *
 * 验的是这个产品另一半不可让的线：
 *   **模型在读用户这句话之前，我们记得的原话能递到它眼前；递不到时不许添乱。**
 *
 * 十四项，全可断言（其中 ⑬ 在未装时自动跳过）：
 *   ① 核心层不 import 任何 @deepseek-ai（能脱离 DSH 独立验收）
 *   ② 核心层导出齐全（造记忆注入/取查询文本/摆注入文本/入库新消息/体检…）
 *   ③ 取查询文本：只认最后一条有正文的 user，跳过空消息与 assistant
 *   ④ 空库闭嘴：库里没有历史 → 不注入、不抛错、如实标「门控闭嘴」
 *   ⑤ 跨轮真记得：第 3 句问「刚才那句压缩怎么说」→ 翻出第 1 句原话，含句ID
 *   ⑥ 不自己提自己：本批刚入库的句子，绝不回灌给模型
 *   ⑦ 长度上限：最大字符生效，注入文本不超限
 *   ⑧ 断内核闭嘴：内核不可用 → 不注入、不抛错（少一功能 ≠ 整插件崩）
 *   ⑨ 静态：宿主壳只追加消息（不改上下游任何一条），且注入点包了 try/catch
 *   ⑩ 静态：patch 同时挂了压缩引擎与记忆插件，官方 compaction-basic 被 disabled
 *   ⑪ 记忆不落插件包目录（默认落 ~/.dsh/whale-memory，npm update 不丢）
 *   ⑫ 配置键英文/中文双认，值归一后完全一致
 *   ⑬ 已装包自检（内核标 CJS / 带门控配置 / 数据接出包外）——未装则跳过
 *
 * 用法：node 验收/记忆注入验收.js
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')

const 项目根 = path.resolve(__dirname, '..')
const 插件根 = path.join(项目根, '适配器', 'dsh')
const 核心路径 = path.join(插件根, 'lib', '记忆核心.js')
const 壳路径 = path.join(插件根, '记忆.js')
const 结果们 = []

function 记(名, 通过, 说明) {
  结果们.push({ 检查: 名, 结果: !!通过, 说明 })
  console.log((通过 ? '✅ ' : '❌ ') + 名 + ' —— ' + 说明)
}

/** 干净临时目录 + 把内核与检索都指到它（绝不碰真实原文表） */
function 造沙箱(标) {
  const 根 = fs.mkdtempSync(path.join(os.tmpdir(), '鲸鱼记忆-' + 标 + '-'))
  process.env['鲸鱼数据目录'] = 根
  process.env['原文回溯根目录'] = path.join(根, '原文回溯')
  // 向量库与冷却表也必须进沙箱：只隔离原文表的话，上一轮验收写进真实库的句子
  // 会在这一轮被检索命中（查询句自己被当成「记忆」→ 自引闸拦下 → ⑤ 必红）。
  // 同一份脚本第一次绿、第二次红，就等于没验。
  process.env['鲸鱼数据根'] = path.join(根, '内核数据')
  delete process.env['鲸鱼禁用内核']
  delete process.env['鲸鱼原文表']
  return 根
}

function 加载核心() {
  return import(pathToFileURL(核心路径).href)
}

const 一句 = (文) => [{ role: 'user', content: [{ type: 'text', text: 文 }] }]

async function 主() {
  // 整轮验收只用一个沙箱：内核的根目录是 require 时算定的常量，
  // 中途换目录会变成「换了个假沙箱」，验收就失去意义。会话名区分即可。
  造沙箱('总')

  // ── ① 核心层不依赖 DSH ─────────────────────────────────────────
  try {
    const 源 = fs.readFileSync(核心路径, 'utf8')
    const 命中 = 源.match(/from\s+['"]@deepseek-ai\/[^'"]+['"]/g) || []
    记('① 核心层零 DSH 依赖', 命中.length === 0, 命中.length === 0 ? '没有任何 @deepseek-ai import，可离线验收' : '发现依赖：' + 命中.join(', '))
  } catch (e) {
    记('① 核心层零 DSH 依赖', false, '读不到核心文件：' + e.message)
  }

  // ── ② 导出齐全 ────────────────────────────────────────────────
  let 核心 = null
  try {
    核心 = await 加载核心()
    const 要 = ['造记忆注入', '取查询文本', '摆注入文本', '入库新消息', '找检索', '找入库', '体检', '批指纹']
    const 缺 = 要.filter((k) => typeof 核心[k] !== 'function')
    记('② 核心层导出齐全', 缺.length === 0, 缺.length === 0 ? '八项导出全在' : '缺：' + 缺.join(', '))
  } catch (e) {
    记('② 核心层导出齐全', false, '加载核心失败：' + e.message)
  }
  if (!核心) {
    汇总()
    return
  }

  // ── ③ 取查询文本 ──────────────────────────────────────────────
  try {
    const 消息 = [
      { role: 'assistant', content: [{ type: 'text', text: '臣明白' }] },
      { role: 'user', content: [{ type: 'text', text: '用户说绝不能让 DSH 按他们的标准压缩' }] },
      { role: 'user', content: [] },
      { role: 'assistant', content: [{ type: 'text', text: '遵旨' }] },
    ]
    const 得 = 核心.取查询文本(消息)
    const 对 = 得 === '用户说绝不能让 DSH 按他们的标准压缩'
    记('③ 取查询文本只认最后一条有正文的 user', 对, 对 ? '得「' + 得.slice(0, 20) + '…」，空消息与 assistant 都被跳过' : '得「' + 得 + '」')
  } catch (e) {
    记('③ 取查询文本只认最后一条有正文的 user', false, '抛错：' + e.message)
  }

  // ── ④ 空库闭嘴 ────────────────────────────────────────────────
  try {
    const 出 = await 核心.造记忆注入({ 消息们: 一句('这是这个会话里的第一句话'), 会话: '空库会话' })
    const 对 = 出.注入 === false && 出.文本 === '' && 出.报告.开口 === false && !!出.报告.跳过原因
    记('④ 空库闭嘴且如实标注', 对, 对 ? '不注入，跳过原因：' + 出.报告.跳过原因 : JSON.stringify(出.报告))
  } catch (e) {
    记('④ 空库闭嘴且如实标注', false, '抛错：' + e.message)
  }

  // ── ⑤ 跨轮真记得 + ⑥ 不自己提自己 ────────────────────────────
  try {
    const 步1 = await 核心.造记忆注入({ 消息们: 一句('用户说绝不能让 DSH 按照他们的标准压缩摘要，不然那就废了'), 会话: '跨轮会话' })
    const 步2 = await 核心.造记忆注入({ 消息们: 一句('我们手里的记忆内核全部放在本地磁盘，输入输出都走 QQ 渠道'), 会话: '跨轮会话' })
    const 步3 = await 核心.造记忆注入({ 消息们: 一句('刚才说的压缩摘要那句话是怎么说的'), 会话: '跨轮会话' })

    const 记得 = 步3.注入 === true &&
      步3.文本.indexOf('绝不能让 DSH 按照他们的标准压缩摘要') >= 0 &&
      步3.文本.indexOf('跨轮会话#1.1') >= 0
    记('⑤ 跨轮真记得（翻出第 1 句原话 + 句ID）', 记得, 记得 ? '第 3 句问起，翻出「跨轮会话#1.1」逐字原话' : JSON.stringify(步3.报告))

    // 不自噬的定义：注入的永远不是「本批刚入库的那句」
    // 步1 库空 → 必不注入；步2 若注入，句ID 必不是本批的 #2.1
    const 不自噬 = 步1.注入 === false &&
      (步2.注入 === false || String(步2.报告.句ID).indexOf('#2.') < 0) &&
      (步3.注入 === false || String(步3.报告.句ID).indexOf('#3.') < 0)
    记('⑥ 不自己提自己', 不自噬, 不自噬
      ? '步1 不注入；步2/步3 即使注入也不是本批句子（步2 句ID=' + (步2.报告.句ID || '未注入') + '，步3 句ID=' + (步3.报告.句ID || '未注入') + '）'
      : '出了自噬：' + JSON.stringify([步1.报告, 步2.报告, 步3.报告]).slice(0, 300))

    const 有句ID = String(步3.报告.句ID).indexOf('#') > 0
    记('⑥b 注入带可回溯句ID', 有句ID, 有句ID ? '句ID = ' + 步3.报告.句ID : '句ID 异常：' + 步3.报告.句ID)
  } catch (e) {
    记('⑤ 跨轮真记得（翻出第 1 句原话 + 句ID）', false, '抛错：' + e.message)
    记('⑥ 不自己提自己', false, '抛错：' + e.message)
    记('⑥b 注入带可回溯句ID', false, '抛错：' + e.message)
  }

  // ── ⑦ 长度上限 ────────────────────────────────────────────────
  try {
    const 长 = await 核心.造记忆注入({ 消息们: 一句('这是一句很长很长的话，'.repeat(40)), 会话: '上限会话' })
    const 出 = await 核心.造记忆注入({ 消息们: 一句('刚才那句很长很长的话是怎么说的'), 会话: '上限会话', 最大字符: 60 })
    const 对 = 出.注入 === false || 出.文本.length <= 60
    记('⑦ 最大注入字符生效', 对, 对 ? '上限 60 时注入长度 ' + 出.文本.length + '（注入=' + 出.注入 + '）' : '超限：' + 出.文本.length)

    // ⑦b —— 超限必须“说出口”：不许默默断在 half 句上
    // 模型眼里这份注入就是全部凭据，它分不出「原话就到这里」和「被裁了一半」。
    // 只要出现截断，就必须能读出具体字数，并且长度仍不超上限。
    const 截了 = /〔已截断/.test(出.文本)
    const 有数 = /(原话共|本段原)\d+字/.test(出.文本)
    const 告警对 = 出.注入 === false || (截了 && 有数)
    记('⑦b 截断时写明「共多少字、到第几字」', 告警对, 告警对
      ? (出.注入 ? '尾部：…' + 出.文本.slice(-46) : '未注入，不适用')
      : '截了但没说清楚：' + 出.文本.slice(-60))

    const 标志对 = 出.注入 === false || 出.报告.截断 === 截了
    记('⑦c 报告.截断 与正文一致（排障时能看见）', 标志对, 标志对
      ? '报告.截断 = ' + 出.报告.截断
      : '正文' + (截了 ? '截了' : '没截') + '，报告写 ' + 出.报告.截断)
    void 长
  } catch (e) {
    记('⑦ 最大注入字符生效', false, '抛错：' + e.message)
  }

  // ── ⑦d 连发的那几句话：要整段摆出来 ────────────────────────
  // 真机形态：QQ 用户把一句话拆成三条发；一条消息也可能在归档时被切成几句。
  // 按「一句一记忆」摆，模型看到的就是残句。这里断言：整段逐句带角色 + ※ 标出命中句。
  try {
    const 开口 = {
      开口: true,
      措词句: '你之前是不是说过「猫跑了」？',
      命中: { 记忆ID: '段会话#2.1' },
      原话: {
        找到: true, 句ID: '段会话#2.1', 会话: '段会话', 轮次: 2, 句序: 1, 角色: '用户', 原句: '猫跑了',
        前: [], 后: [],
        段: {
          段ID: '段会话#1.1', 句数: 3,
          句们: [
            { 句ID: '段会话#1.1', 角色: '用户', 文本: '在吗', 主: false },
            { 句ID: '段会话#2.1', 角色: '用户', 文本: '猫跑了', 主: true },
            { 句ID: '段会话#3.1', 角色: '用户', 文本: '怎么办', 主: false }
          ]
        }
      }
    }
    const 文本 = 核心.摆注入文本(开口, 8000)
    const 对 = 文本.indexOf('在吗') >= 0 && 文本.indexOf('怎么办') >= 0 &&
      文本.indexOf('猫跑了  ※') >= 0 && /共 3 句/.test(文本)
    记('⑦d 连发的几句整段摆出（带角色 + ※ 标命中句）', 对, 对
      ? 文本.split('\n').slice(2, 6).join(' / ')
      : 文本.slice(0, 260))

    // ⑦e 回归：前/后 数组必须真能摆出来（旧实现读的是不存在的 前句/后句，上下句数拧到 10 也一个字不出）
    const 开口2 = {
      开口: true, 措词句: '', 命中: { 记忆ID: '前后会话#2.1' },
      原话: {
        找到: true, 句ID: '前后会话#2.1', 角色: '用户', 原句: '中间那句',
        前: [{ 句ID: '前后会话#1.1', 角色: '用户', 文本: '前面那句' }],
        后: [{ 句ID: '前后会话#3.1', 角色: '助理', 文本: '后面那句' }],
        段: null
      }
    }
    const 文本2 = 核心.摆注入文本(开口2, 8000)
    const 对2 = 文本2.indexOf('前面那句') >= 0 && 文本2.indexOf('中间那句') >= 0 && 文本2.indexOf('后面那句') >= 0
    记('⑦e 上下句数真的生效（前句/后句都摆出来）', 对2, 对2
      ? 文本2.split('\n').slice(2, 6).join(' / ')
      : 文本2.slice(0, 260))
  } catch (e) {
    记('⑦d 连发的几句整段摆出（带角色 + ※ 标命中句）', false, '抛错：' + e.message)
  }

  // ── ⑧ 断内核闭嘴 ──────────────────────────────────────────────
  try {
    process.env['鲸鱼禁用内核'] = '1'
    const 出 = await 核心.造记忆注入({ 消息们: 一句('内核不在的时候问一句话'), 会话: '断内核会话' })
    const 对 = 出.注入 === false && 出.文本 === '' && !!出.报告.跳过原因
    记('⑧ 断内核不注入也不抛错', 对, 对 ? '跳过原因：' + 出.报告.跳过原因 : JSON.stringify(出.报告))
    delete process.env['鲸鱼禁用内核']
  } catch (e) {
    delete process.env['鲸鱼禁用内核']
    记('⑧ 断内核不注入也不抛错', false, '抛错：' + e.message)
  }

  // ── ⑨ 宿主壳只追加 ────────────────────────────────────────────
  try {
    const 源 = fs.readFileSync(壳路径, 'utf8')
    const 只追加 = /messages:\s*\[\.\.\.决策\.messages/.test(源)
    const 有兜底 = /catch\s*\(/.test(源) && /return 决策/.test(源)
    const 有prepend = /prepend:\s*true/.test(源)
    const 对 = 只追加 && 有兜底 && 有prepend
    记('⑨ 宿主壳只追加消息 + 全程兜底', 对, '追加写法=' + 只追加 + '，异常回退=' + 有兜底 + '，prepend=' + 有prepend)
  } catch (e) {
    记('⑨ 宿主壳只追加消息 + 全程兜底', false, '读不到宿主壳：' + e.message)
  }

  // ── ⑩ patch 与包形态 ─────────────────────────────────────────
  try {
    const 补 = fs.readFileSync(path.join(插件根, 'cordis.patch.yml'), 'utf8')
    const pkg = JSON.parse(fs.readFileSync(path.join(插件根, 'package.json'), 'utf8'))
    const 禁官方 = /id:\s*compaction-basic[\s\S]{0,80}disabled:\s*true/.test(补)
    const 挂压缩 = 补.indexOf("whale-memory-dsh'") >= 0
    const 挂记忆 = 补.indexOf('whale-memory-dsh/memory') >= 0
    const 有导出 = !!(pkg.exports && pkg.exports['./memory'])
    const 有文件 = Array.isArray(pkg.files) && pkg.files.indexOf('记忆.js') >= 0
    const 对 = 禁官方 && 挂压缩 && 挂记忆 && 有导出 && 有文件
    记('⑩ patch 与包形态', 对,
      '禁官方=' + 禁官方 + '，挂压缩=' + 挂压缩 + '，挂记忆=' + 挂记忆 + '，exports=' + 有导出 + '，files=' + 有文件)
  } catch (e) {
    记('⑩ patch 与包形态', false, '检查失败：' + e.message)
  }

  // ── ⑪ 记忆不落插件包目录 ────────────────────────────────────
  try {
    const 路径模块 = await import(pathToFileURL(path.join(插件根, 'lib', '路径.js')).href + '?t=' + Date.now())
    const 存 = {
      鲸鱼原文表: process.env['鲸鱼原文表'],
      原文回溯根目录: process.env['原文回溯根目录'],
      鲸鱼数据目录: process.env['鲸鱼数据目录'],
    }
    delete process.env['鲸鱼原文表']
    delete process.env['原文回溯根目录']
    delete process.env['鲸鱼数据目录']
    const 解 = 路径模块.解析原文表根()
    for (const k of Object.keys(存)) {
      if (存[k] === undefined) delete process.env[k]
      else process.env[k] = 存[k]
    }
    const 根 = path.resolve(解.根)
    const 不在包内 = !根.startsWith(path.resolve(插件根) + path.sep)
    const 有用户段 = /[\\/]\.dsh[\\/]whale-memory[\\/]/.test(根)
    记(
      '⑪ 记忆不落插件包目录',
      不在包内 && 有用户段,
      '默认根=' + 根 + '（来处 ' + 解.来处 + '），不在包内=' + 不在包内 + '，在用户数据根=' + 有用户段
    )
  } catch (e) {
    记('⑪ 记忆不落插件包目录', false, '检查失败：' + e.message)
  }

  // ── ⑫ 配置键双认 ────────────────────────────────────────────
  try {
    if (typeof 核心.归一配置 !== 'function') throw new Error('核心层没有导出 归一配置')
    const 英 = 核心.归一配置({ enabled: false, everyTurn: false, maxInjectChars: 500, contextPairs: 2 })
    const 中 = 核心.归一配置({ 启用: false, 每轮一次: false, 最大注入字符: 500, 上下句数: 2 })
    const 默 = 核心.归一配置({})
    const 等 = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    const 对 = 等(英, 中) && 英.启用 === false && 英.最大字符 === 500 && 默.启用 === true && 默.最大字符 === 900
    记(
      '⑫ 配置键英文/中文双认',
      对,
      '英文=' + JSON.stringify(英) + '，中文一致=' + 等(英, 中) + '，空配置默认=' + JSON.stringify(默)
    )
  } catch (e) {
    记('⑫ 配置键英文/中文双认', false, '抛错：' + e.message)
  }

  // ── ⑬ 已装包自检（未装则跳过，不算失败） ──────────────────
  try {
    const 档根 = path.join(os.homedir(), '.dsh', 'profiles')
    let 已装包们 = []
    try {
      已装包们 = fs
        .readdirSync(档根)
        .map((n) => path.join(档根, n, 'node_modules', 'whale-memory-dsh'))
        .filter((p) => fs.existsSync(p))
    } catch {
      已装包们 = []
    }
    if (已装包们.length === 0) {
      记('⑬ 已装包自检（内核标 CJS / 门控配置 / 数据接出包外）', true, '本机未装，跳过（不影响插件本身）')
    } else {
      const 行们 = []
      let 全对 = true
      for (const 包 of 已装包们) {
        const 内核标 = (() => {
          try {
            return JSON.parse(fs.readFileSync(path.join(包, '内核', 'package.json'), 'utf8')).type
          } catch {
            return ''
          }
        })()
        const 有门控 = fs.existsSync(path.join(包, '配置', '门控策略.json'))
        const 数据接出 = (() => {
          try {
            return fs.lstatSync(path.join(包, '数据')).isSymbolicLink()
          } catch {
            return false
          }
        })()
        const 对 = 内核标 === 'commonjs' && 有门控 && 数据接出
        if (!对) 全对 = false
        行们.push(path.basename(path.dirname(path.dirname(包))) + '：内核=' + (内核标 || '缺') + '，门控=' + 有门控 + '，数据junction=' + 数据接出)
      }
      记('⑬ 已装包自检（内核标 CJS / 门控配置 / 数据接出包外）', 全对, 行们.join(' ｜ '))
    }
  } catch (e) {
    记('⑬ 已装包自检（内核标 CJS / 门控配置 / 数据接出包外）', false, '检查失败：' + e.message)
  }

  汇总()
}

function 汇总() {
  const 过 = 结果们.filter((r) => r.结果).length
  const 总 = 结果们.length
  console.log('\n═══ 记忆注入验收：' + 过 + '/' + 总 + ' 通过 ═══')
  require('./断言报告.js').报(过, 总)
  if (过 !== 总) {
    console.log('未通过项：')
    for (const r of 结果们) if (!r.结果) console.log('  ❌ ' + r.检查 + ' —— ' + r.说明)
    process.exitCode = 1
  }
  // 机器可读结果落盘：其余九层都有，独缺 L8 的话接 CI 就少一块。
  try {
    fs.writeFileSync(path.join(__dirname, '记忆注入验收结果.json'), JSON.stringify({
      时间: new Date().toISOString(), 通过: 过, 总数: 总, 结果: 结果们
    }, null, 1), 'utf8')
  } catch { }
}

主().catch((e) => {
  console.log('❌ 验收本身崩了：' + (e && e.stack ? e.stack : e))
  process.exitCode = 1
})
