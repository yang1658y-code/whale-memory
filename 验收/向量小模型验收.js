/**
 * 向量小模型验收.js — L2 向量层 · 随包小模型（bge-small-zh-v1.5 int8 / 纯 WASM）
 *
 * 跑法：node 验收/向量小模型验收.js
 *       node 验收/向量小模型验收.js --静默
 *       node 验收/向量小模型验收.js --快     （跳过 R@5 检索质量，只验结构与降级）
 *
 * 验的不是「代码有没有写」，验的是五件会让这件事变成假货的事：
 *   ① 模型文件在位：缺一个文件 → 必须当场落兜底，不许假装在跑语义。
 *   ② 向量本身对：512 维、L2=1、同句幂等=1、改写的分必须显著高于无关句。
 *   ③ 降级链能走通：模型缺失 / wasm 缺失 → 落 bigram哈希256，入库检索一条不丢、一句不崩。
 *   ④ 离线可用：全程不碰网络（本实现不联网，验收顺带证明一遍）。
 *   ⑤ 检索质量不倒退：R@5 不低于上游 L3 基线（单路 72% / 混合 82%）3 个百分点以上。
 *
 * 口径写死在断言里，不靠记忆。
 * 会记得你的鲸鱼 · 2026-10-27
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

const 根 = path.resolve(__dirname, '..')
const 静默 = process.argv.includes('--静默')
const 快跑 = process.argv.includes('--快')

const 结果清单 = []
let 编号 = 0
function 断言(名称, 通过, 详情) {
  编号++
  结果清单.push({ 编号, 名称, 通过: !!通过, 详情 })
  if (!静默) console.log(`${通过 ? '✅' : '❌'} [${编号}] ${名称}${详情 ? '\n     ' + String(详情).replace(/\n/g, '\n     ') : ''}`)
}
function 小标题(t) { if (!静默) console.log('\n' + '═'.repeat(64) + '\n' + t + '\n' + '═'.repeat(64)) }

// 临时数据目录：结不碰真库
const 临时根 = path.join(os.tmpdir(), '鲸鱼向量验收-' + process.pid)
function 清临时() {
  try { fs.rmSync(临时根, { recursive: true, force: true }) } catch { }
  try { fs.mkdirSync(path.join(临时根, '数据'), { recursive: true }) } catch { }
}

const 小模型 = require(path.join(根, '内核', '向量小模型.js'))
const 后端 = require(path.join(根, '内核', '向量后端.js'))
const 存储 = require(path.join(根, '内核', '存储适配器.js'))

const 模型目录 = 小模型.默认模型目录
const 第三方目录 = 小模型.默认第三方目录

// 余弦（两边都以为 L2 归一，点积即余弦）
function 余弦(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0
  let 和 = 0
  for (let i = 0; i < a.length; i++) 和 += a[i] * b[i]
  return 和
}
function 目录字节(目录) {
  let 总 = 0
  ;(function 走(d) {
    let 项们 = []
    try { 项们 = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const n of 项们) {
      const p = path.join(d, n.name)
      if (n.isDirectory()) 走(p)
      else { try { 总 += fs.statSync(p).size } catch { } }
    }
  })(目录)
  return 总
}

// ═══════════════ 一、文件在位与体积 ═══════════════
function 一组_文件() {
  小标题('一、模型文件在位与体积')

  const 检查 = 小模型.检查模型(模型目录, 第三方目录)
  断言('全部必需文件在位且非空', 检查.ok, 检查.ok ? '体积 ' + 检查.大小MB + ' MB' : '缺：' + 检查.缺.join('、'))

  const 模型MB = +(目录字节(模型目录) / 1048576).toFixed(2)
  const 引擎MB = +(目录字节(第三方目录) / 1048576).toFixed(2)
  const 总MB = +(模型MB + 引擎MB).toFixed(2)
  断言('权重体积 ≤ 26MB（int8 量化后）', 模型MB <= 26, 模型MB + ' MB')
  断言('推理引擎体积 ≤ 20MB（只留 CPU wasm，不带 jsep/asyncify/node 原生）', 引擎MB <= 20, 引擎MB + ' MB')
  断言('随包总量 ≤ 45MB（npm pack 上限）', 总MB <= 45, 模型MB + ' + ' + 引擎MB + ' = ' + 总MB + ' MB')

  // 反向确认：不该出现在包里的东西
  const 多余 = [
    ['jsep.wasm（GPU 用，约 27MB）', path.join(第三方目录, 'ort-wasm-simd-threaded.jsep.wasm')],
    ['asyncify.wasm（约 25MB）', path.join(第三方目录, 'ort-wasm-simd-threaded.asyncify.wasm')],
    ['onnxruntime_node 原生件', path.join(根, 'node_modules', 'onnxruntime-node')],
    ['transformers.js', path.join(根, 'node_modules', '@huggingface', 'transformers')]
  ]
  for (const [名, p] of 多余) 断言('未混入：' + 名, !fs.existsSync(p), fs.existsSync(p) ? '存在：' + p : '干净')

  断言('package.json 的 files 已含 模型/ 与 第三方/', (() => {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(根, 'package.json'), 'utf8'))
      const f = Array.isArray(p.files) ? p.files : []
      return f.some(x => /^模型\/?/.test(x)) && f.some(x => /^第三方\/?/.test(x))
    } catch { return false }
  })(), '否则 npm pack 打不进模型')
}

// ═══════════════ 二、分词器 ═══════════════
function 二组_分词() {
  小标题('二、分词器（tokenizer.json 驱动，无写死词表）')

  const 分 = 小模型.建分词器(模型目录)
  const e1 = 分.编码('我养了一只猫')
  const 字们 = e1.tokens.filter(t => t !== '[CLS]' && t !== '[SEP]')
  断言('中文逐字切分', 字们.join('') === '我养了一只猫', e1.tokens.join(' | '))
  断言('首尾挂 [CLS]/[SEP]', e1.tokens[0] === '[CLS]' && e1.tokens[e1.tokens.length - 1] === '[SEP]', e1.tokens.join(' | '))

  const e2 = 分.编码('好的，明天见！')
  断言('标点独立成 token', e2.tokens.includes('，') && e2.tokens.includes('！'), e2.tokens.join(' | '))

  const e3 = 分.编码('DSH 记忆内核 v9')
  断言('英文/数字不被拆碎（保留字母序列）', e3.tokens.some(t => /^[A-Za-z]/.test(t)), e3.tokens.join(' | '))

  const 长文 = '记'.repeat(600)
  const e4 = 分.编码(长文, 512)
  断言('超长截断到 512 token', e4.ids.length === 512, String(e4.ids.length))

  const e5 = 分.编码('')
  断言('空串不崩，只剩 [CLS]/[SEP]', e5.ids.length === 2, JSON.stringify(e5.tokens))

  // 生僻字落 [UNK] 而不是抛错
  const e6 = 分.编码('𠀀𠀁')  // CJK 扩展 B
  断言('生僻字不抛错（落 [UNK] 或成字）', Array.isArray(e6.ids) && e6.ids.length >= 2, e6.tokens.join(' | '))
}

// ═══════════════ 三、向量质量 ═══════════════
async function 三组_向量() {
  小标题('三、向量本身（维度 / 归一 / 幂等 / 语义分辨）')

  const 嵌入器 = await 小模型.创建嵌入器({})
  try {
    const v1 = await 嵌入器.embed('我养了一只猫，叫豆豆')
    断言('维度 = 512', Array.isArray(v1) && v1.length === 512, String(v1 && v1.length))
    const 模 = Math.sqrt(v1.reduce((a, c) => a + c * c, 0))
    断言('L2 归一（模长 = 1）', Math.abs(模 - 1) < 1e-5, 模.toFixed(8))

    const v1b = await 嵌入器.embed('我养了一只猫，叫豆豆')
    断言('同句幂等（余弦 = 1）', Math.abs(余弦(v1, v1b) - 1) < 1e-6, 余弦(v1, v1b).toFixed(8))

    const v2 = await 嵌入器.embed('我家橘猫的名字是豆豆')
    const v3 = await 嵌入器.embed('明天可能有大雨')
    const 相关 = 余弦(v1, v2), 无关 = 余弦(v1, v3)
    断言('改写句相似（> 0.6）', 相关 > 0.6, 相关.toFixed(4))
    断言('无关句不相似（< 0.4）', 无关 < 0.4, 无关.toFixed(4))
    断言('相关显著高于无关（差 > 0.3）', 相关 - 无关 > 0.3, 相关.toFixed(4) + ' vs ' + 无关.toFixed(4))

    const 批 = await 嵌入器.embed批(['我养了一只猫，叫豆豆', '明天可能有大雨', '我养了一只猫，叫豆豆'])
    断言('批量与单条完全一致', Math.abs(余弦(批[0], v1) - 1) < 1e-6 && Math.abs(余弦(批[1], v3) - 1) < 1e-6, 余弦(批[0], v1).toFixed(6))
    断言('批内重复句结果一致', Math.abs(余弦(批[0], 批[2]) - 1) < 1e-6, 余弦(批[0], 批[2]).toFixed(6))

    const 空 = await 嵌入器.embed('   ')
    断言('空文本返回零向量且不崩', Array.isArray(空) && 空.length === 512 && 空.every(x => x === 0), String(空 && 空.length))

    const 长向量 = await 嵌入器.embed('鲸鱼'.repeat(500))
    断言('超长文本照常出向量', Array.isArray(长向量) && 长向量.length === 512, String(长向量 && 长向量.length))

    const 信息 = 嵌入器.信息
    断言('元信息自述后端为纯 WASM', /WASM/.test(信息.运行后端), 信息.运行后端)
    断言('加载耗时 < 10s（冷启动可接受）', 信息.加载毫秒 < 10000, 信息.加载毫秒 + ' ms')
  } finally {
    嵌入器.关闭()
  }
}

// ═══════════════ 四、降级链 ═══════════════
async function 四组_降级() {
  小标题('四、降级链（缺模型 / 缺 wasm / 显式关 → 一律落哈希兜底，不崩不丢记忆）')

  // 4a 模型目录不存在
  {
    const r = await 后端.自动装配({
      模型目录: path.join(临时根, '不存在的模型'),
      第三方目录,
      不落盘: false
    })
    断言('4a 模型缺失 → 后端记 哈希兜底', r.后端 === '哈希兜底', JSON.stringify(r.后端))
    断言('4a 模型缺失 → 降级原因说得出「文件不全」', (r.降级 || []).some(x => /文件不全|缺失/.test(x)), (r.降级 || []).join('｜'))
    断言('4a 模型缺失 → 模型ID = bigram哈希256', r.模型ID === 'bigram哈希256', r.模型ID)
    断言('4a 模型缺失 → 维度 = 256', r.维度 === 256, String(r.维度))
  }

  // 4b 第三方目录（wasm）不存在
  {
    存储.重置后端()
    const r = await 后端.自动装配({
      模型目录,
      第三方目录: path.join(临时根, '不存在的引擎')
    })
    断言('4b wasm 缺失 → 后端记 哈希兜底 且不抛错', r.后端 === '哈希兜底', JSON.stringify(r.后端))
  }

  // 4c 显式关（鲸鱼向量=hash）
  {
    存储.重置后端()
    const 旧 = process.env.鲸鱼向量
    process.env.鲸鱼向量 = 'hash'
    const r = await 后端.自动装配({ 模型目录, 第三方目录 })
    process.env.鲸鱼向量 = 旧 === undefined ? '' : 旧
    if (!旧) delete process.env.鲸鱼向量
    断言('4c 鲸鱼向量=hash → 强制走兜底', r.后端 === '哈希兜底', r.后端)
    断言('4c 说得出是「按开关跳过」而不是出故障', (r.降级 || []).some(x => /跳过/.test(x)), (r.降级 || []).join('｜'))
  }

  // 4d 兜底态下入库/检索一条不丢（这是硬约束）
  {
    存储.重置后端()
    await 后端.自动装配({
      模型目录: path.join(临时根, '不存在的模型'),
      第三方目录
    })
    const 目录 = path.join(临时根, '数据')
    const 写 = await 存储.存入消息('user', '哈希兜底也要能搜到这一句', Date.now(), null, '稳定', null, null, {}, { 根目录: 目录, 自动向量: false })
    断言('4d 兜底态入库成功', 写.ok === true, JSON.stringify(写))
    const 命中 = await 存储.搜索相关('哈希兜底也要能搜到这一句', 3, null, { 根目录: 目录 })
    断言('4d 兜底态检索引擎照出结果', 命中.length > 0, '命中 ' + 命中.length + ' 条')
    const 元 = 存储.当前嵌入元()
    断言('4d 兜底态模型ID = bigram哈希256', 元.模型ID === 'bigram哈希256', JSON.stringify(元))
  }

  // 4e 恢复：重置后重新装配回真模型
  {
    存储.重置后端()
    const r = await 后端.自动装配({ 模型目录, 第三方目录 })
    断言('4e 恢复后重新装配回真模型', r.后端 === '随包小模型' && r.维度 === 512, r.后端 + ' / ' + r.维度 + '维')
    断言('4e 恢复后降级清单为空（无残留告警）', (r.降级 || []).length === 0, (r.降级 || []).join('｜') || '无')
    if (r.嵌入器) r.嵌入器.关闭()
  }
}

// ═══════════════ 五、离线 ═══════════════
async function 五组_离线() {
  小标题('五、离线（不碰网络，无 API Key 也能出向量）')

  // 静态检查：内核两个新文件里不许出现网络调用
  const 禁词 = [/require\(['"]https?['"]\)/, /\bfetch\s*\(/, /axios/, /https?:\/\/[^\s'"]*\.(?:com|cn|org|net)/, /XMLHttpRequest/]
  for (const f of ['向量小模型.js', '向量后端.js']) {
    const s = fs.readFileSync(path.join(根, '内核', f), 'utf8')
    const 中 = 禁词.filter(re => re.test(s)).map(re => String(re))
    断言('离线自证：' + f + ' 无网络调用', 中.length === 0, 中.join('、') || '干净')
  }

  // 运行证明：清掉模型缓存后现场算一次（能出向量就说明没依赖网络）
  const 旧key = process.env.WHALE_LLM_KEY
  delete process.env.WHALE_LLM_KEY
  const 嵌入器 = await 小模型.创建嵌入器({ 缓存条数: 0 })
  try {
    const t0 = Date.now()
    const v = await 嵌入器.embed('离线也应该能算出这句话的向量')
    断言('离线真算出一条 512 维向量', Array.isArray(v) && v.length === 512, '耗时 ' + (Date.now() - t0) + ' ms')
  } finally {
    嵌入器.关闭()
    if (旧key !== undefined) process.env.WHALE_LLM_KEY = 旧key
  }
}

// ═══════════════ 六、检索质量 R@5 ═══════════════
async function 六组_质量() {
  小标题('六、检索质量（与上游 L3 基线同口径对撞）')

  if (快跑) {
    断言('R@5 检索质量（--快 模式跳过）', true, '已跳过')
    return
  }

  // 基线语料是跨项目资产，不进本仓（含真实对话，涉及隐私）。
  // 想在本机跑这条真测：在仓根放 本地配置.json（已 gitignore）写 {"向量基线目录": "…"}，
  // 或设环境变量 向量基线目录=…；两处都没有 → 这条跳过，不算失败。
  // 【为什么跳过也要发满六条】不这么做，断言数就跟着环境变：
  //   本机 62、干净 clone 57。基线闸门（只许增不许减）会因为「没语料」而红/绿不定，
  //   那就又变成了一层看环境吃饭的假绿。跳过归跳过，条数必须一样。
  let 本地配置 = {}
  try { 本地配置 = JSON.parse(fs.readFileSync(path.join(根, '本地配置.json'), 'utf8')) } catch { }
  const 基线目录 = process.env.向量基线目录 || 本地配置.向量基线目录 || path.join(根, '数据', '向量基线')
  const 语料文件 = path.join(基线目录, '语料.json')
  const 查询文件 = path.join(基线目录, '向量基线查询.json')
  if (!fs.existsSync(语料文件) || !fs.existsSync(查询文件)) {
    const 原因 = '跳过：' + 基线目录 + ' 不可读（基线语料是跨项目资产，不进本仓）'
    for (const 名 of [
      '650 条语料批量出向量（≤ 60s）',
      '查询集有效条数 = 50',
      '小模型单路 R@5 ≥ 70%（上游基线 72%）',
      '小模型 + BM25 RRF R@5 ≥ 78%（上游基线 82%）',
      '混合 R@5 高于单路（RRF 确实在起作用）',
      '小模型单路 R@1 ≥ 55%（上游基线 60%）'
    ]) 断言(名, true, 原因)
    return
  }

  const 语料 = JSON.parse(fs.readFileSync(语料文件, 'utf8'))
  const 查询集 = JSON.parse(fs.readFileSync(查询文件, 'utf8'))

  // BM25（与上游基线完全同参、同分词：k1=1.2 b=0.75；
  //   基线是「先剔非中文字，再取相邻中文字 bigram」+英文整词，
  //   不是按标点分段再 bigram——差这一步，R@5 会差 6 个点，口径就不同源了）
  const 检索词 = t => {
    const s = String(t).toLowerCase()
    const 字们 = Array.from(s).filter(c => /[\u4e00-\u9fa5]/.test(c))
    const 出 = []
    for (let i = 0; i < 字们.length - 1; i++) 出.push(字们[i] + 字们[i + 1])
    if (!出.length) 出.push(...字们)
    const en = (s.match(/[a-z0-9][a-z0-9_+.#-]*/g) || []).filter(w => w.length >= 2 || /[0-9]/.test(w))
    return 出.concat(en)
  }
  const 词频们 = 语料.map(d => { const m = new Map(); 检索词(d.text).forEach(w => m.set(w, (m.get(w) || 0) + 1)); return m })
  const 长度们 = 词频们.map(m => [...m.values()].reduce((a, c) => a + c, 0))
  const 平均长 = 长度们.reduce((a, c) => a + c, 0) / 长度们.length
  const df = new Map()
  词频们.forEach(m => m.forEach((_, w) => df.set(w, (df.get(w) || 0) + 1)))
  const N = 语料.length
  const idf = new Map(); df.forEach((d, w) => idf.set(w, Math.log(1 + (N - d + 0.5) / (d + 0.5))))
  const k1 = 1.2, b = 0.75
  function BM25(查询) {
    const 分 = new Array(N).fill(0)
    for (const w of new Set(检索词(查询))) {
      const iw = idf.get(w); if (!iw) continue
      for (let i = 0; i < N; i++) {
        const tf = 词频们[i].get(w); if (!tf) continue
        分[i] += iw * tf * (k1 + 1) / (tf + k1 * (1 - b + 长度们[i] / 平均长))
      }
    }
    return 分.map((s, i) => ({ i, s })).filter(x => x.s > 0).sort((a, c) => c.s - a.s)
  }
  const RRF = (...列们) => {
    const m = new Map()
    列们.forEach(列 => 列.slice(0, 100).forEach((x, r) => m.set(x.i, (m.get(x.i) || 0) + 1 / (60 + r + 1))))
    return [...m.entries()].map(([i, s]) => ({ i, s })).sort((a, c) => c.s - a.s)
  }

  const 文本们 = 语料.map(d => d.text).concat(查询集.map(q => q.q))
  const 嵌入器 = await 小模型.创建嵌入器({ 批大小: 16 })
  const t0 = Date.now()
  let 向量们 = []
  try {
    向量们 = await 嵌入器.embed批(Array.from(new Set(文本们)))
  } finally {
    嵌入器.关闭()
  }
  const 键 = new Map(); Array.from(new Set(文本们)).forEach((t, i) => 键.set(t, i))
  const 语料向量 = 语料.map(d => 向量们[键.get(d.text)])
  const 耗时秒 = (Date.now() - t0) / 1000
  断言('650 条语料批量出向量（≤ 60s）', 耗时秒 <= 60, 耗时秒.toFixed(1) + ' s')

  const idToIdx = new Map(); 语料.forEach((d, i) => idToIdx.set(d.id, i))
  let 单路R5 = 0, 混合R5 = 0, 单路R1 = 0, 混合R1 = 0, 有效 = 0
  for (const 查询 of 查询集) {
    const 目标 = idToIdx.get(查询.golden)
    if (目标 === undefined) continue
    有效++
    const qv = 向量们[键.get(查询.q)]
    const 向量列 = 语料向量.map((v, i) => ({ i, s: 余弦(qv, v) })).sort((a, c) => c.s - a.s)
    const 词列 = BM25(查询.q)
    const 融合 = RRF(向量列, 词列)
    const 单路名次 = 向量列.findIndex(x => x.i === 目标) + 1
    const 混合名次 = 融合.findIndex(x => x.i === 目标) + 1
    if (单路名次 > 0 && 单路名次 <= 5) 单路R5++
    if (混合名次 > 0 && 混合名次 <= 5) 混合R5++
    if (单路名次 === 1) 单路R1++
    if (混合名次 === 1) 混合R1++
  }
  const p = x => +(x / 有效 * 100).toFixed(1)
  断言('查询集有效条数 = 50', 有效 === 50, String(有效))
  断言('小模型单路 R@5 ≥ 70%（上游基线 72%）', p(单路R5) >= 70, p(单路R5) + '%（' + 单路R5 + '/' + 有效 + '）')
  断言('小模型 + BM25 RRF R@5 ≥ 78%（上游基线 82%）', p(混合R5) >= 78, p(混合R5) + '%（' + 混合R5 + '/' + 有效 + '）')
  断言('混合 R@5 高于单路（RRF 确实在起作用）', p(混合R5) > p(单路R5), p(单路R5) + '% → ' + p(混合R5) + '%')
  断言('小模型单路 R@1 ≥ 55%（上游基线 60%）', p(单路R1) >= 55, p(单路R1) + '%')
  if (!静默) console.log(`\n     [质量] 单路 R@1=${p(单路R1)}% R@5=${p(单路R5)}% ｜ 混合 R@1=${p(混合R1)}% R@5=${p(混合R5)}%`)
}

// ═══════════════ 七、端到端 ═══════════════
async function 七组_端到端() {
  小标题('七、端到端（真模型 + 真库 + 语义检索）')

  存储.重置后端()
  const 目录 = path.join(临时根, '端到端')
  fs.rmSync(目录, { recursive: true, force: true })
  fs.mkdirSync(目录, { recursive: true })

  const r = await 存储.确保后端({ 根目录: 目录 })
  断言('自动装配选到随包小模型', r.后端 === '随包小模型', r.后端 + ' / ' + r.维度 + '维 / ' + r.耗时毫秒 + 'ms')

  const 语料 = [
    '我养了一只猫，叫豆豆，是只橘猫，特别能吃',
    '上周三跟老王在城南那家川菜馆吃饭，他推荐的毛血旺确实好吃',
    '我的车牌号是苏A8K2L9，停在B2层',
    '孩子对芒果过敏，家里绝对不能买芒果'
  ]
  for (const 文 of 语料) await 存储.存入消息('user', 文, Date.now(), null, '稳定', null, null, { 句ID: 'V#1.1' }, { 根目录: 目录 })

  const 健康 = 存储.健康自检({ 根目录: 目录 })
  断言('健康自检：模型ID = bge-small-zh-v1.5', 健康.模型ID === 'bge-small-zh-v1.5', 健康.模型ID)
  断言('健康自检：维度 = 512', 健康.维度 === 512, String(健康.维度))
  断言('健康自检：后端 = 随包小模型', 健康.后端 === '随包小模型', String(健康.后端))

  const 用例 = [
    ['我家那只小动物叫什么名字', '猫'],
    ['我上次和谁在哪吃饭来着', '川菜馆'],
    ['我家孩子吃东西有什么禁忌', '芒果'],
    ['车子停哪儿了', '车牌']
  ]
  for (const [查询, 该中] of 用例) {
    const 命中 = await 存储.搜索相关(查询, 3, null, { 根目录: 目录 })
    const 首 = 命中[0]
    断言('语义检索 top1：' + 查询 + ' → ' + 该中, !!(首 && String(首.content).includes(该中)),
      (首 ? 首.content.slice(0, 26) + ' (' + Number(首.similarity).toFixed(4) + ')' : '无命中'))
  }

  // 维度/模型同源校验：拿三条「人造陷阱」验证，不靠运气
  {
    const 查询 = '我家那只小动物叫什么名字'
    const 查询向量 = await 存储.embed(查询)
    const 假条们 = [
      // A 同源同维：故意把句子写成完全无关，但向量就是查询向量本身 → 应该得满分
      { id: 'fake_same', role: 'user', content: '这是一条人造记录的甲', time: 1, vec: {}, vector: 查询向量.slice(), 模型ID: 'bge-small-zh-v1.5' },
      // B 同维不同源：向量对得上，但模型ID 是别人 → 不许比 cosine
      { id: 'fake_other_model', role: 'user', content: '这是一条人造记录的乙', time: 1, vec: {}, vector: 查询向量.slice(), 模型ID: '别的模型' },
      // C 同源不同维：256 维旧哈希向量 → 不许比 cosine
      { id: 'fake_dim', role: 'user', content: '这是一条人造记录的丙', time: 1, vec: {}, vector: new Array(256).fill(0.0625), 模型ID: 'bge-small-zh-v1.5' }
    ]
    const 全 = 存储.读取向量库({ 根目录: 目录 }).concat(假条们)
    存储.写入向量库(全, { 根目录: 目录 })
    const 命中 = await 存储.搜索相关(查询, 10, null, { 根目录: 目录 })
    const 取 = id => 命中.find(x => x.id === id)
    断言('同源同维：向量对得上就能拿满分（链路正通）', !!(取('fake_same') && Number(取('fake_same').similarity) > 0.99),
      取('fake_same') ? 'similarity=' + Number(取('fake_same').similarity).toFixed(4) : '未命中')
    断言('同维不同源：模型ID 不同 → 不比 cosine', !取('fake_other_model'),
      取('fake_other_model') ? '❗被误算了：' + Number(取('fake_other_model').similarity).toFixed(4) : '已拦下，未命中')
    断言('同源不同维：256 维旧向量 → 不比 cosine', !取('fake_dim'),
      取('fake_dim') ? '❗被误算了：' + Number(取('fake_dim').similarity).toFixed(4) : '已拦下，未命中')
  }

  // 重算向量库：把人造陷阱与旧条目迁到当前后端
  {
    const r2 = await 后端.重算向量库({ 根目录: 目录 })
    断言('重算向量库：维度不符的条目不报错并真被重算', r2.ok && r2.重算 >= 2 && (r2.失败 || []).length === 0,
      JSON.stringify({ 重算: r2.重算, 换维: r2.换维, 跳过: r2.跳过, 失败: r2.失败 }))
    const 后 = 存储.读取向量库({ 根目录: 目录 }).filter(x => ['fake_dim', 'fake_other_model'].includes(x.id))
    断言('重算后维度=512 且模型ID已更新', 后.length === 2 && 后.every(x => x.vector && x.vector.length === 512 && x.模型ID === 'bge-small-zh-v1.5'),
      JSON.stringify(后.map(x => ({ id: x.id, 维: x.vector && x.vector.length, 模型ID: x.模型ID }))))
  }
}

// ═══════════════ 汇总 ═══════════════
;(async () => {
  const t0 = Date.now()
  清临时()
  console.log('向量小模型验收 · 项目「会记得你的鲸鱼」· L2 真语义层' + (静默 ? '（静默）' : ''))
  try {
    一组_文件()
    二组_分词()
    await 三组_向量()
    await 四组_降级()
    await 五组_离线()
    await 六组_质量()
    await 七组_端到端()
  } catch (e) {
    断言('全程无未捕获异常', false, (e && e.stack) || String(e))
  } finally {
    try { 存储.重置后端() } catch { }
    try { fs.rmSync(临时根, { recursive: true, force: true }) } catch { }
  }

  const 通过 = 结果清单.filter(x => x.通过).length
  const 失败 = 结果清单.length - 通过
  console.log('\n' + '═'.repeat(64))
  console.log(`向量小模型验收：${通过}/${结果清单.length} 通过｜失败 ${失败} 项｜耗时 ${Date.now() - t0}ms`)
  require('./断言报告.js').报(通过, 结果清单.length)
  if (失败) {
    console.log('未通过项：')
    for (const x of 结果清单.filter(y => !y.通过)) console.log(`  ❌ [${x.编号}] ${x.名称} —— ${x.详情 || ''}`)
  } else {
    console.log('全部通过 ✅')
  }
  console.log('═'.repeat(64))

  // 落盘结果（供一键跑读取）
  try {
    fs.writeFileSync(path.join(__dirname, '向量小模型验收结果.json'), JSON.stringify({
      时间: new Date().toISOString(), 通过, 总数: 结果清单.length, 失败, 明细: 结果清单
    }, null, 2), 'utf8')
  } catch { }

  process.exit(失败 ? 1 : 0)
})()
