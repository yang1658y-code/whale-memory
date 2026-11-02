/**
 * 会记得你的鲸鱼 · L2 向量层 · 随包小模型
 * ────────────────────────────────────────────────────────────────
 * 干什么：把一段中文变成 512 维稠密向量（bge-small-zh-v1.5，int8 量化，纯 WASM 推理）。
 *
 * 【为什么不 require('onnxruntime-web')】
 *   npm 包 `onnxruntime-web` 装下来全平台 138MB（含 webgpu/jsep/asyncify 四套 wasm）。
 *   我们只需要 CPU 那一套：ort.min.js + ort-wasm-simd-threaded.{mjs,wasm} ≈ 16MB。
 *   所以运行集被裁进 `第三方/onnxruntime-web/`，这里按绝对路径加载——
 *   路径由 选项.第三方目录 指定，用户想换新版覆盖那三个文件即可，不用动本文件。
 *
 * 【手写分词器，不用 transformers.js】
 *   transformers.js 在 Node 下会拉 onnxruntime-node（原生二进制，多平台 287MB），
 *   正是需求单「装到任何机器都能跑」这条要避开的东西。分词规则只有两条：
 *   BertNormalizer(clean + 中文逐字 + 不转小写) → BertPreTokenizer → WordPiece。
 *   tokenizer.json 是唯一事实源，本文件不含任何写死词表。
 *
 * 【对外契约】
 *   创建嵌入器(选项) → { embed(文本), embed批(文本们), 维度, 模型ID, 信息, 关闭() }
 *   embed(文本) 返回 L2 归一后的 Float64 普通数组（与 设embed(fn) 的期望完全一致）。
 *   认 bge 官方口径：取 last_hidden_state 的 [CLS] 位（首 token），不是 mean pooling。
 *
 * 【断依赖】
 *   模型缺失 / wasm 缺失 / 推理失败 → 一律抛错，由 向量后端.js 决定落哪一级兜底。
 *   本文件自己不降级、不吞错——吞错会让人以为向量在跑，其实跑的是哈希。
 */

const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const 参数 = require('./参数.js')

const 模型ID = 'bge-small-zh-v1.5'
const 维度 = 512
const 最长token = 512
const 默认模型目录 = path.join(__dirname, '..', '模型', 'bge-small-zh-v1.5')
const 默认第三方目录 = path.join(__dirname, '..', '第三方', 'onnxruntime-web')

// ═══════════════════════ 分词器（tokenizer.json 驱动） ═══════════════════════

/**
 * 建分词器(模型目录) → { 编码(文本, 最长) → {tokens, ids}, 配置 }
 * 纯同步、纯本地，不碰网络。
 */
function 建分词器(目录) {
  const 文件 = path.join(目录, 'tokenizer.json')
  const tk = JSON.parse(fs.readFileSync(文件, 'utf8'))
  const 词表 = (tk.model && tk.model.vocab) || {}
  if (!Object.keys(词表).length) throw new Error('tokenizer.json 里没有 vocab：' + 文件)

  const 配置 = {
    小写: !!(tk.normalizer && tk.normalizer.lowercase),
    处理中文: !!(tk.normalizer && tk.normalizer.handle_chinese_chars !== false),
    清理文本: !!(tk.normalizer && tk.normalizer.clean_text !== false),
    前缀: (tk.model && tk.model.continuing_subword_prefix) || '##',
    未知: (tk.model && tk.model.unk_token) || '[UNK]',
    最长字: (tk.model && tk.model.max_input_chars_per_word) || 100,
    CLS: 词表['[CLS]'],
    SEP: 词表['[SEP]'],
    PAD: 词表['[PAD]']
  }
  for (const k of ['CLS', 'SEP', 'PAD']) {
    if (配置[k] === undefined) throw new Error('tokenizer.json 缺特殊词 ' + k)
  }

  const 是空白 = c => c === ' ' || c === '\t' || c === '\n' || c === '\r'
  const 是控制 = c => {
    const n = c.codePointAt(0)
    if (n === 0 || n === 0xfffd) return true
    if (n >= 1 && n <= 8) return true
    if (n >= 0x0b && n <= 0x0c) return true
    if (n >= 0x0e && n <= 0x1f) return true
    if (n >= 0x7f && n <= 0x9f) return true
    return false
  }
  // BertNormalizer 的「中文」范围：CJK 表意 + 假名 + 谚文
  const 是中文字 = c => {
    const n = c.codePointAt(0)
    return (n >= 0x4e00 && n <= 0x9fff) || (n >= 0x3400 && n <= 0x4dbf) ||
      (n >= 0x20000 && n <= 0x2a6df) || (n >= 0x2a700 && n <= 0x2b73f) ||
      (n >= 0x2b740 && n <= 0x2b81f) || (n >= 0x2b820 && n <= 0x2ceaf) ||
      (n >= 0xf900 && n <= 0xfaff) || (n >= 0x2f800 && n <= 0x2fa1f) ||
      (n >= 0x3040 && n <= 0x309f) || (n >= 0x30a0 && n <= 0x30ff) ||
      (n >= 0x31f0 && n <= 0x31ff) || (n >= 0xac00 && n <= 0xd7af)
    }

  // 标点 / 符号：BertPreTokenizer 会把它们切成独立 token
  // 注意全角标点（，。？！）也在这里被切开——它们本来就在词表里有独立 id
  const 是标点 = c => {
    if (是空白(c)) return false
    const n = c.codePointAt(0)
    if (n < 128) return !/[0-9a-zA-Z]/.test(c)
    return /[\p{P}\p{S}]/u.test(c)
  }

  /** BertNormalizer：去控制符 / 空白归一 / 中文逐字加空格 / 可选小写 */
  function 归一(文本) {
    const 出 = []
    for (const c of String(文本 == null ? '' : 文本)) {
      if (配置.清理文本 && 是控制(c)) continue
      if (是空白(c)) { 出.push(' '); continue }
      if (配置.处理中文 && 是中文字(c)) { 出.push(' ' + c + ' '); continue }
      出.push(c)
    }
    let s = 出.join('').replace(/\s+/g, ' ').trim()
    if (配置.小写) s = s.toLowerCase()
    return s
  }

  /** BertPreTokenizer：空白切词 + 标点独立 */
  function 预切(文本) {
    const 出 = []
    for (const 段 of 文本.split(' ')) {
      if (!段) continue
      let 当前 = ''
      for (const c of 段) {
        if (是标点(c)) {
          if (当前) { 出.push(当前); 当前 = '' }
          出.push(c)
        } else 当前 += c
      }
      if (当前) 出.push(当前)
    }
    return 出
  }

  /** WordPiece：最长优先匹配，续接词带 ## 前缀，匹配不到落 [UNK] */
  function wordpiece(词) {
    const 字们 = Array.from(词)
    if (字们.length > 配置.最长字) return [配置.未知]
    const 出 = []
    let 起 = 0
    while (起 < 字们.length) {
      let 尾 = 字们.length
      let 中 = null
      while (起 < 尾) {
        let 片 = 字们.slice(起, 尾).join('')
        if (起 > 0) 片 = 配置.前缀 + 片
        if (词表[片] !== undefined) { 中 = 片; break }
        尾--
      }
      if (中 === null) return [配置.未知]
      出.push(中)
      起 = 尾
    }
    return 出
  }

  /**
   * 编码(文本, 最长=512) → {tokens, ids}
   * 头尾各加 [CLS] / [SEP]，总长截到 最长。
   */
  function 编码(文本, 最长) {
    if (!Number.isFinite(Number(最长))) 最长 = 参数.取整('向量小模型.最长token', 最长token)
    const 词们 = 预切(归一(文本))
    const tok = []
    for (const w of 词们) for (const t of wordpiece(w)) tok.push(t)
    const 截断 = tok.slice(0, Math.max(0, 最长 - 2))
    const tokens = ['[CLS]'].concat(截断).concat(['[SEP]'])
    const ids = tokens.map(t => (词表[t] !== undefined ? 词表[t] : 配置.未知))
    return { tokens, ids }
  }

  return { 编码, 配置, 词表大小: Object.keys(词表).length, 归一, 预切, wordpiece }
}

// ═══════════════════════ 模型文件检查 ═══════════════════════

/**
 * 检查模型(目录, 第三方目录) → { ok, 缺[], 大小MB }
 * 只查文件在不在、大小不为 0。不解析 onnx。
 */
function 检查模型(目录 = 默认模型目录, 第三方目录 = 默认第三方目录) {
  const 必查 = [
    path.join(目录, 'config.json'),
    path.join(目录, 'tokenizer.json'),
    path.join(目录, 'onnx', 'model_quantized.onnx'),
    path.join(第三方目录, 'ort.min.js'),
    path.join(第三方目录, 'ort-wasm-simd-threaded.mjs'),
    path.join(第三方目录, 'ort-wasm-simd-threaded.wasm')
  ]
  const 缺 = []
  let 字节 = 0
  for (const p of 必查) {
    try {
      const st = fs.statSync(p)
      if (!st.size) 缺.push(path.basename(p) + '（0 字节）')
      else 字节 += st.size
    } catch { 缺.push(path.basename(p) + '（缺失）') }
  }
  return { ok: 缺.length === 0, 缺, 大小MB: +(字节 / 1048576).toFixed(2) }
}

// ═══════════════════════ 嵌入器 ═══════════════════════

/**
 * 创建嵌入器(选项) → Promise<嵌入器>
 *   选项.模型目录    默认 ../模型/bge-small-zh-v1.5
 *   选项.第三方目录  默认 ../第三方/onnxruntime-web
 *   选项.线程数      WASM 线程数，默认 1（多线程要 wasm 里带 threads，且起 worker，不稳）
 *   选项.批大小      一批多少条，默认 8
 *   选项.缓存条数    文本→向量 LRU 上限，默认 800，0 关闭
 *   选项.最长token   默认 512
 *   选项.ort         已加载的 ort 对象（测试缝，省一次 require）
 */
async function 创建嵌入器(选项 = {}) {
  const 模型目录 = 选项.模型目录 || 默认模型目录
  const 第三方目录 = 选项.第三方目录 || 默认第三方目录
  const 线程数 = Number.isFinite(Number(选项.线程数)) ? Number(选项.线程数) : 1
  const 批大小 = Math.max(1, Number(选项.批大小) || 参数.取整('向量小模型.批大小', 8))
  const 缓存上限 = 选项.缓存条数 === 0 ? 0 : (Number(选项.缓存条数) || 参数.取整('向量小模型.缓存条数', 800))
  const 最长 = Number(选项.最长token) || 参数.取整('向量小模型.最长token', 最长token)

  const t0 = Date.now()
  const 检查 = 检查模型(模型目录, 第三方目录)
  if (!检查.ok) {
    const e = new Error('随包小模型文件不全：' + 检查.缺.join('、'))
    e.code = 'MODEL_MISSING'
    throw e
  }

  const 分词器 = 建分词器(模型目录)

  // ort 是模块级单例：wasmPaths 设一次即可，重复设无害
  let ort = 选项.ort
  if (!ort) {
    ort = require(path.join(第三方目录, 'ort.min.js'))
  }
  // 【踩过的坑，必看】第三方目录若被上层 package.json 的 "type": "module" 传染，
  //   ort.min.js 会被 Node 当 ESM 解析 → 导出是个空壳，InferenceSession 是 undefined。
  //   表现是一句毫无线索的 "Cannot read properties of undefined (reading 'create')"，
  //   然后静默降级成 bigram 哈希兜底：用户以为装上了真语义，其实拿到的是词袋。
  //   所以这里宁可炸得响，把根因直接写进错误消息（第三方目录必须自带 package.json）。
  if (!ort || typeof ort.InferenceSession !== 'function') {
    const e = new Error('onnxruntime 运行集加载失败：InferenceSession 缺失。'
      + '多半是 ' + 第三方目录 + ' 缺 package.json（需 {"type":"commonjs"}），'
      + '被上层 type:module 当 ESM 解析，导出成了空壳')
    e.code = 'ORT_BAD_EXPORT'
    throw e
  }
  try {
    ort.env.wasm.numThreads = 线程数
    ort.env.wasm.simd = true
    ort.env.wasm.wasmPaths = {
      wasm: pathToFileURL(path.join(第三方目录, 'ort-wasm-simd-threaded.wasm')).href,
      mjs: pathToFileURL(path.join(第三方目录, 'ort-wasm-simd-threaded.mjs')).href
    }
  } catch { /* env 不可写就按默认来 */ }

  const 模型字节 = fs.readFileSync(path.join(模型目录, 'onnx', 'model_quantized.onnx'))
  const 会话 = await ort.InferenceSession.create(模型字节, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  })
  const 加载毫秒 = Date.now() - t0

  // 输入名按模型实际声明来，不假设：BertModel 可能只有 input_ids/attention_mask
  const 输入们 = Array.from(会话.inputNames || [])
  const 输出名 = (会话.outputNames && 会话.outputNames[0]) || 'last_hidden_state'
  for (const 必需 of ['input_ids', 'attention_mask']) {
    if (!输入们.includes(必需)) throw new Error('模型缺输入 ' + 必需 + '（实际：' + 输入们.join(',') + '）')
  }

  const 缓存 = new Map()
  let 推理次数 = 0
  let 关闭过 = false

  function 取缓存(k) {
    if (!缓存上限) return null
    if (!缓存.has(k)) return null
    const v = 缓存.get(k)
    缓存.delete(k); 缓存.set(k, v) // 触碰即移到队尾（LRU）
    return v
  }
  function 存缓存(k, v) {
    if (!缓存上限) return
    缓存.set(k, v)
    while (缓存.size > 缓存上限) 缓存.delete(缓存.keys().next().value)
  }

  /** 一次前向：文本们 → 向量们（等长 padding，mask 掉填充位） */
  async function 前向(文本们) {
    const 编码们 = 文本们.map(t => 分词器.编码(t, 最长))
    const 最长长 = 编码们.reduce((m, e) => Math.max(m, e.ids.length), 0)
    const 批 = 编码们.length
    const ids = new BigInt64Array(批 * 最长长)
    const mask = new BigInt64Array(批 * 最长长)
    const seg = new BigInt64Array(批 * 最长长)
    for (let b = 0; b < 批; b++) {
      const e = 编码们[b]
      for (let i = 0; i < 最长长; i++) {
        const 位 = b * 最长长 + i
        if (i < e.ids.length) {
          ids[位] = BigInt(e.ids[i])
          mask[位] = 1n
          seg[位] = 0n
        } else {
          ids[位] = 0n // [PAD]
          mask[位] = 0n
          seg[位] = 0n
        }
      }
    }
    const 输入 = { input_ids: new ort.Tensor('int64', ids, [批, 最长长]) }
    if (输入们.includes('attention_mask')) 输入.attention_mask = new ort.Tensor('int64', mask, [批, 最长长])
    if (输入们.includes('token_type_ids')) 输入.token_type_ids = new ort.Tensor('int64', seg, [批, 最长长])

    推理次数++
    const 出 = await 会话.run(输入)
    const 张 = 出[输出名]
    const dim = 张.dims[2]
    const 结果 = []
    for (let b = 0; b < 批; b++) {
      // bge 官方口径：取第 0 个 token（[CLS]）的隐状态做句向量
      const 偏移 = b * 最长长 * dim
      const v = new Array(dim)
      let 平方和 = 0
      for (let i = 0; i < dim; i++) {
        const x = Number(张.data[偏移 + i])
        v[i] = x
        平方和 += x * x
      }
      const 模 = Math.sqrt(平方和) || 1
      for (let i = 0; i < dim; i++) v[i] = +(v[i] / 模).toFixed(6)
      结果.push(v)
    }
    return 结果
  }

  /** embed(文本) → number[]（单条；给 设embed(fn) 直接用） */
  async function embed(文本) {
    const 串 = String(文本 == null ? '' : 文本)
    if (!串.trim()) return 数组0维()
    const 命中 = 取缓存(串)
    if (命中) return 命中.slice()
    if (关闭过) throw new Error('嵌入器已关闭')
    const [v] = await 前向([串])
    存缓存(串, v)
    return v.slice()
  }

  /** embed批(文本们, 选项) → number[][]（按批大小切，命中缓存的直接取） */
  async function embed批(文本们, 选项2 = {}) {
    const 列 = Array.isArray(文本们) ? 文本们.map(t => String(t == null ? '' : t)) : []
    if (!列.length) return []
    if (关闭过) throw new Error('嵌入器已关闭')
    const 出 = new Array(列.length)
    const 待算位 = []
    const 待算集 = new Map() // 文本 → [位置...]（同一句只算一次）
    for (let i = 0; i < 列.length; i++) {
      const 串 = 列[i]
      if (!串.trim()) { 出[i] = 数组0维(); continue }
      const 命中 = 取缓存(串)
      if (命中) { 出[i] = 命中.slice(); continue }
      if (!待算集.has(串)) 待算集.set(串, [])
      待算集.get(串).push(i)
      待算位.push(串)
    }
    const 唯一 = Array.from(待算集.keys())
    const 大小 = Math.max(1, Number(选项2.批大小) || 批大小)
    for (let p = 0; p < 唯一.length; p += 大小) {
      const 片 = 唯一.slice(p, p + 大小)
      const 向量们 = await 前向(片)
      for (let k = 0; k < 片.length; k++) {
        存缓存(片[k], 向量们[k])
        for (const i of 待算集.get(片[k])) 出[i] = 向量们[k].slice()
      }
    }
    return 出
  }

  function 数组0维() {
    return new Array(维度).fill(0)
  }

  function 关闭() {
    关闭过 = true
    缓存.clear()
  }

  // 把批量接口和元信息挂在 embed 函数身上：存储适配器只拿得到这个函数，
  // 但 embed批 / 模型ID / 维度 必须跟着它走（否则重算向量库时逐条推理，慢 10 倍）。
  embed.embed批 = embed批
  embed.模型ID = 模型ID
  embed.维度 = 维度

  return {
    embed, embed批, 关闭,
    维度, 模型ID,
    信息: {
      模型: 'Xenova/bge-small-zh-v1.5 onnx int8（原权重 BAAI/bge-small-zh-v1.5）',
      模型目录, 第三方目录,
      运行后端: 'onnxruntime-web 纯 WASM（无原生二进制）',
      线程数, 批大小, 最长token: 最长,
      池化: 'CLS + L2 归一',
      词表大小: 分词器.词表大小,
      模型体积MB: 检查.大小MB,
      加载毫秒,
      get 推理次数() { return 推理次数 }
    }
  }
}

module.exports = {
  模型ID, 维度, 最长token,
  默认模型目录, 默认第三方目录,
  建分词器, 检查模型, 创建嵌入器
}
