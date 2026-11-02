#!/usr/bin/env node
/**
 * whale-memory-dsh 装机器
 *
 * 默认什么也不改，只做预检。要真装/真卸得显式带参数。
 *
 *   node 适配器/dsh/装.cjs          # 预检（只读，安全）
 *   node 适配器/dsh/装.cjs --装      # 装进 DSH profile
 *   node 适配器/dsh/装.cjs --卸      # 拆掉，恢复原状
 *
 * profile 怎么找：`--profile=<名字或路径>` > 环境变量 DSH_PROFILE > 自动扫 ~/.dsh/profiles/*
 * （只有一个就直接用；有多个就列出来让你指定，绝不默默猜一个）
 *
 * 装什么（两处改动，都先备份）：
 *   ① 把整个插件目录复制到 ~/.dsh/profiles/desktop/node_modules/whale-memory-dsh
 *   ② profile 的 package.json：dependencies 加本包、dsh.profile.bundles 末尾追加本包
 *      —— bundles 顺序决定 patch 叠加顺序，本包必须在 dsh-base 之后，才能把
 *         compaction-basic 节点 disabled 掉
 *
 * 改完必须手动重启 DSH（本项目铁律：不许任何程序替你重启宿主/桌面端）。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const 插件根 = __dirname
const 参数 = process.argv.slice(2)
const 要装 = 参数.includes('--装')
const 要卸 = 参数.includes('--卸')

/** 取 `--键=值` 形式的参数（没有就返回空串） */
function 参数值(键) {
  const 前缀 = '--' + 键 + '='
  const 命中 = 参数.filter((a) => String(a).startsWith(前缀))[0]
  return 命中 ? String(命中).slice(前缀.length).trim() : ''
}

/** 扫 ~/.dsh/profiles 下所有带 package.json 的 profile（不写死 desktop） */
function 扫Profile() {
  const 根 = path.join(os.homedir(), '.dsh', 'profiles')
  try {
    return fs
      .readdirSync(根, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(根, e.name, 'package.json')))
      .map((e) => path.join(根, e.name))
  } catch {
    return []
  }
}

/**
 * 找 DSH profile。
 * 优先级：--profile=<名或路径> > 环境变量 DSH_PROFILE > 自动发现。
 * 自动发现只找到一个就用它；找到多个就列出来让人指定，绝不默默猜。
 * @returns {{路径:string|null, 来源:string, 原因?:string, 候选?:string[]}}
 */
function 找Profile() {
  const 指定 = 参数值('profile') || String(process.env['DSH_PROFILE'] || '').trim()
  const 候选 = 扫Profile()
  if (指定) {
    const 绝对 = path.isAbsolute(指定) ? 指定 : path.join(os.homedir(), '.dsh', 'profiles', 指定)
    if (fs.existsSync(path.join(绝对, 'package.json'))) return { 路径: 绝对, 来源: '指定' }
    return { 路径: null, 来源: '指定', 原因: '指定的 profile 不存在或不含 package.json：' + 绝对, 候选 }
  }
  if (候选.length === 1) return { 路径: 候选[0], 来源: '自动发现' }
  if (候选.length === 0) {
    return {
      路径: null,
      来源: '自动发现',
      原因: '在 ' + path.join(os.homedir(), '.dsh', 'profiles') + ' 下没找到任何含 package.json 的 profile',
      候选: [],
    }
  }
  return {
    路径: null,
    来源: '自动发现',
    原因: '发现 ' + 候选.length + ' 个 profile，请用 --profile=<名字> 指定',
    候选,
  }
}

/**
 * 取环境变量（空白串当没设）
 */
function 环境(键) {
  const 值 = process.env[键]
  return typeof 值 === 'string' && 值.trim() ? 值.trim() : ''
}

/**
 * 算原文表根目录——**与 lib/路径.js 完全同一套规则**（CJS 版手抄，没有第二套逻辑）。
 */
function 算原文表根() {
  if (环境('鲸鱼原文表')) return path.resolve(环境('鲸鱼原文表'))
  if (环境('原文回溯根目录')) return path.resolve(环境('原文回溯根目录'))
  if (环境('鲸鱼数据目录')) return path.resolve(环境('鲸鱼数据目录'), '原文回溯')
  if (os.homedir()) return path.join(os.homedir(), '.dsh', 'whale-memory', '原文回溯')
  return path.join(插件根, '数据', '原文回溯')
}

/** 数一个目录里有多少张原文表 */
function 数原文表(目录) {
  try {
    return fs.readdirSync(目录).filter((f) => f.endsWith('.jsonl')).length
  } catch {
    return 0
  }
}

/** 老数据可能的落脚点（只用于装机时“一次性搬家”，只复制不删） */
function 旧数据候选() {
  const 列 = [
    path.join(插件根, '..', '..', '数据', '原文回溯'), // 开发布局：适配器/dsh → 项目/数据/原文回溯
    path.join(插件根, '数据', '原文回溯'),
  ]
  if (环境('鲸鱼数据目录')) 列.push(path.resolve(环境('鲸鱼数据目录'), '原文回溯'))
  return 列
}

function 读JSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function 备份(p, 标) {
  const 目标 = p + '.bak.鲸鱼' + 标
  if (!fs.existsSync(目标)) fs.copyFileSync(p, 目标)
  return 目标
}

/** 递归复制目录（跳过备份与装机脚本本身） */
function 复制目录(源, 目标) {
  fs.mkdirSync(目标, { recursive: true })
  for (const e of fs.readdirSync(源, { withFileTypes: true })) {
    if (e.name.endsWith('.bak') || e.name === '装.cjs') continue
    const s = path.join(源, e.name)
    const t = path.join(目标, e.name)
    if (e.isDirectory()) 复制目录(s, t)
    else fs.copyFileSync(s, t)
  }
}

function 递归删(目标) {
  if (!fs.existsSync(目标)) return
  fs.rmSync(目标, { recursive: true, force: true })
}

/** 删掉一个软链接/junction 本身，**绝不跟进去删里面的东西** */
function 拆链接(p) {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p)
  } catch {
    /* 不存在 / 无权限 → 当作不存在 */
  }
}

/** 把一个目录里的文件复制到另一个目录（不递徃子目录、目标已存在则跳过） */
function 复制文件们(源, 目标) {
  if (!fs.existsSync(源)) return 0
  fs.mkdirSync(目标, { recursive: true })
  let n = 0
  for (const e of fs.readdirSync(源, { withFileTypes: true })) {
    if (!e.isFile()) continue
    const t = path.join(目标, e.name)
    if (fs.existsSync(t)) continue
    fs.copyFileSync(path.join(源, e.name), t)
    n += 1
  }
  return n
}

/**
 * 把内核的「数据」目录接到用户数据根（
 *   内核的数据路径写死在 `<包>/数据/`：向量库.jsonl + 提话冷却.json。
 *   那就在包里放一个 **junction** 指向 `~/.dsh/whale-memory/内核数据`：
 *   内核代码一行不改，但数据住的房间不在 node_modules 里——升级/重装不会丢。
 *   建不了链接（权限/文件系统）就退成普通目录并把现有数据复制进去，同时明确告警。
 * @returns {{模式:string, 位置:string}}
 */
function 绑定内核数据(目标包目录) {
  const 链接 = path.join(目标包目录, '数据')
  const 家 = os.homedir() ? path.join(os.homedir(), '.dsh', 'whale-memory', '内核数据') : ''
  if (!家) return { 模式: '拿不到家目录', 位置: 链接 }
  fs.mkdirSync(家, { recursive: true })

  // 老装机/旧版留下的实体目录 → 内容并过去，再换链接（只复制不删）
  let 已并 = 0
  if (fs.existsSync(链接) && !fs.lstatSync(链接).isSymbolicLink()) {
    已并 = 复制文件们(链接, 家)
    递归删(链接)
  }
  if (已并 > 0) console.log('  已把包内旧数据 ' + 已并 + ' 个文件并入用户数据根')

  if (!fs.existsSync(链接)) {
    try {
      fs.symlinkSync(家, 链接, 'junction')
      return { 模式: 'junction（数据不在包内）', 位置: 家 }
    } catch (e) {
      fs.mkdirSync(链接, { recursive: true })
      const n = 复制文件们(家, 链接)
      return { 模式: '普通目录（建链接失败：' + String((e && e.message) || e) + '，已复制 ' + n + ' 个文件，升级后需重跑本脚本）', 位置: 链接 }
    }
  }
  return { 模式: 'junction（已存在）', 位置: 家 }
}

function 主() {
  const 找 = 找Profile()
  if (!找.路径) {
    console.error('✘ ' + 找.原因)
    if (找.候选 && 找.候选.length > 0) {
      console.error('  发现的 profile：')
      for (const p of 找.候选) console.error('    - ' + path.basename(p) + '    ' + p)
      console.error('  指定：node 装.cjs --装 --profile=<名字>')
    } else {
      console.error('  请确认 DSH 桌面端装过并至少启动过一次。')
    }
    process.exit(2)
  }
  const profile = 找.路径
  const 数据根 = 算原文表根()
  const 包装 = path.join(profile, 'package.json')
  const 目标目录 = path.join(profile, 'node_modules', 'whale-memory-dsh')
  const 清单 = 读JSON(包装)
  const 已装 = fs.existsSync(目标目录)
  const 已登记 = !!(清单.dependencies && 清单.dependencies['whale-memory-dsh'])
  const 已挂bundle = !!(
    清单.dsh &&
    清单.dsh.profile &&
    Array.isArray(清单.dsh.profile.bundles) &&
    清单.dsh.profile.bundles.includes('whale-memory-dsh')
  )

  console.log('=== 预检 ===')
  console.log('profile           :', profile, '（' + 找.来源 + '）')
  console.log('记忆存放位置      :', 数据根, '（现有原文表 ' + 数原文表(数据根) + ' 张）')
  console.log('插件目录存在      :', 已装 ? '是' : '否', 目标目录)
  {
    const 数据位 = path.join(目标目录, '数据')
    const 是链接 = 已装 && (() => { try { return fs.lstatSync(数据位).isSymbolicLink() } catch { return false } })()
    console.log('内核数据目录      :', 已装 ? (是链接 ? '已接用户数据根（junction）' : '仍在包目录内（待重跑装）') : '未装')
    console.log('内核门控配置      :', fs.existsSync(path.join(目标目录, '配置', '门控策略.json')) ? '已带' : (已装 ? '缺（内核会静默回落保守默认）' : '未装'))
  }
  console.log('dependencies 已登记:', 已登记)
  console.log('bundles 已挂载    :', 已挂bundle)
  if (清单.dsh && 清单.dsh.profile && 清单.dsh.profile.bundles) {
    console.log('bundles 现状      :', 清单.dsh.profile.bundles.join(' → '))
  }
  console.log(
    '内核可用          :',
    fs.existsSync(path.join(插件根, '..', '..', '内核', '原文回溯.js')) ? '是（装箱时一并复制）' : '否（只能自带兜底）'
  )

  if (!要装 && !要卸) {
    console.log('\n（只做了预检，什么都没改。要装：node 适配器/dsh/装.cjs --装）')
    return
  }

  if (要装) {
    const b1 = 备份(包装, '装前')
    console.log('\n已备份 profile/package.json →', b1)

    // ① 复制插件（连同内核一起装箱，装到别处也能用内核写原文表）
    //    【先拆链接】先把 数据 那个 junction 拆掉（只删链接，不跟进去），
    //    否则递归删目录时有可能跟进去把用户数据删了。
    拆链接(path.join(目标目录, '数据'))
    if (已装) 递归删(目标目录)
    复制目录(插件根, 目标目录)
    const 内核源 = path.join(插件根, '..', '..', '内核')
    if (fs.existsSync(内核源)) {
      const 内核目标 = path.join(目标目录, '内核')
      复制目录(内核源, 内核目标)
      // 【必需】本包是 "type": "module"，内核是 CommonJS（module.exports + require）。
      // 不写这个文件，内核被当成 ESM 解析，require() 会直接抛 ERR_REQUIRE_ESM，
      // 表现为「内核不可用，静默降级成兜底」——不报错、但也不再写内核原文表。
      const 内核包 = path.join(内核目标, 'package.json')
      if (!fs.existsSync(内核包)) {
        fs.writeFileSync(内核包, JSON.stringify({ type: 'commonjs', private: true }, null, 2) + '\n', 'utf8')
      }
      console.log('已随包复制内核 →', 内核目标, '（已标 type:commonjs）')
    }

    // ①b 内核要读 配置/门控策略.json（路径写死在 <包>/配置/），缺了就会静默回落成
    //    「quiet + 全疑问句」——能跑，但不是用户调过的策略。静态配置，直接带上。
    const 配源 = path.join(插件根, '..', '..', '配置', '门控策略.json')
    const 配目标目录 = path.join(目标目录, '配置')
    if (fs.existsSync(配源)) {
      fs.mkdirSync(配目标目录, { recursive: true })
      fs.copyFileSync(配源, path.join(配目标目录, '门控策略.json'))
      console.log('已随包复制门控配置 →', path.join(配目标目录, '门控策略.json'))
    } else {
      console.log('⚠ 没找到 配置/门控策略.json（内核将用内置保守默认：quiet + 全疑问句）')
    }

    // ①d 随包向量层：模型/（约 23MB 权重）+ 第三方/（约 14MB WASM 运行集）
    //    内核的 向量小模型.js 按相对路径找 <包>/模型 与 <包>/第三方；找不到不会报错，
    //    它会安静地落成 bigram 哈希兜底——用户以为自己装上了真语义，其实拿到的是词袋。
    //    所以这里必须复制，且复制完当场自检报数。
    for (const 目 of ['模型', '第三方']) {
      const 源 = path.join(插件根, '..', '..', 目)
      if (fs.existsSync(源)) {
        const 目标 = path.join(目标目录, 目)
        复制目录(源, 目标)
        console.log('已随包复制' + 目 + ' →', 目标)
      } else {
        console.log('⚠ 没找到 ' + 目 + '/（向量层将静默退化为 bigram 哈希兜底：能用，但只到字面级）')
      }
    }

    // ①d-自检 装完**真跑一次推理**再报数。
    //    【为什么不能只查文件】检查模型() 只看文件在不在、大小对不对。曾有一次
    //    第三方/ort.min.js 被上层 "type":"module" 传染当 ESM 解析，InferenceSession
    //    是 undefined，可文件一个都不缺 —— 只查文件的“自检”会把「装了但只能词袋匹配」
    //    报成「✓ 就绪」。所以这里用子进程隔离真算一句话，维度不对就当场告警。
    try {
      const 自检码 = [
        '(async () => {',
        '  const 小模 = require(' + JSON.stringify(path.join(目标目录, '内核', '向量小模型.js')) + ')',
        '  const 嵌 = await 小模.创建嵌入器({})',
        '  const v = await 嵌.embed("自检：鲸鱼能不能把意思算出来")',
        '  const 模长 = Math.sqrt(v.reduce((a, b) => a + b * b, 0))',
        '  console.log(JSON.stringify({ ok: true, 维: v.length, 模长: +模长.toFixed(4), 模型ID: 小模.模型ID }))',
        '})().catch(e => { console.log(JSON.stringify({ ok: false, 错: String((e && e.message) || e) })) })'
      ].join('\n')
      const 原出 = String(execFileSync(process.execPath, ['-e', 自检码], { encoding: 'utf8', timeout: 180000 }))
      const 行们 = 原出.trim().split('\n').filter(Boolean)
      const 结 = JSON.parse(行们[行们.length - 1])
      if (结.ok && Number(结.维) === 512) {
        console.log('向量层自检        : ✓ 真跑通（512 维，模长 ' + 结.模长 + '，模型 ' + 结.模型ID + '）')
      } else if (结.ok) {
        console.log('向量层自检        : ⚠ 能跑但维度是 ' + 结.维 + '（期望 512）→ 可能挂错了模型')
      } else {
        console.log('向量层自检        : ✗ 跑不起来：' + 结.错 + ' → 会静默落成 bigram 哈希兜底')
      }
    } catch (e) {
      console.log('向量层自检        : ✗ 子进程自检失败：' + String((e && e.message) || e).slice(0, 200))
    }

    // ①c 内核的 数据 目录（向量库.jsonl / 提话冷却.json）——接到用户数据根，升级不丢
    const 数据源目录 = path.join(插件根, '..', '..', '数据')
    const 绑 = 绑定内核数据(目标目录)
    if (fs.existsSync(数据源目录)) {
      const n = 复制文件们(数据源目录, 绑.位置)
      if (n > 0) console.log('已并入内核数据 ' + n + ' 个文件 →', 绑.位置)
    }
    console.log('内核数据目录      :', 绑.模式, '→', 绑.位置)

    // ③ 数据落点：老版本的原文表默认落在包目录/项目目录里，npm update 一次就没。
    //    这里做一次性搬家：复制到用户数据根。**只复制不删源**——源目录可能还有别的东西指着。
    const 目标表数 = 数原文表(数据根)
    if (目标表数 === 0) {
      let 已找 = false
      for (const 源 of 旧数据候选()) {
        if (path.resolve(源) === path.resolve(数据根)) continue
        const n = 数原文表(源)
        if (n === 0) continue
        fs.mkdirSync(数据根, { recursive: true })
        let 搬 = 0
        for (const f of fs.readdirSync(源)) {
          if (!f.endsWith('.jsonl') && !f.endsWith('.json')) continue
          const t = path.join(数据根, f)
          if (!fs.existsSync(t)) {
            fs.copyFileSync(path.join(源, f), t)
            搬 += 1
          }
        }
        console.log('已迁移旧原文表 ' + 搬 + ' 个文件：' + 源 + ' → ' + 数据根 + '（源未删）')
        已找 = true
        break
      }
      if (!已找) console.log('未发现需要迁移的旧原文表（新装用户属正常）')
    } else {
      console.log('记忆已在用户数据根（现有 ' + 目标表数 + ' 张原文表），跳过搬家')
    }

    // ② 登记
    const 新 = 读JSON(包装)
    新.dependencies = 新.dependencies || {}
    新.dependencies['whale-memory-dsh'] = 'file:./node_modules/whale-memory-dsh'
    新.dsh = 新.dsh || {}
    新.dsh.profile = 新.dsh.profile || {}
    新.dsh.profile.bundles = Array.isArray(新.dsh.profile.bundles) ? 新.dsh.profile.bundles : []
    if (!新.dsh.profile.bundles.includes('whale-memory-dsh')) {
      新.dsh.profile.bundles.push('whale-memory-dsh') // 必须追加在最后
    }
    fs.writeFileSync(包装, JSON.stringify(新, null, 2) + '\n', 'utf8')
    console.log('已登记依赖与 bundle：bundles =', 新.dsh.profile.bundles.join(' → '))
    console.log('\n🟢 装完。请**手动重启 DSH 桌面端**，然后在设置里确认插件已加载。')
    console.log('   回滚：node 适配器/dsh/装.cjs --卸')
    return
  }

  if (要卸) {
    const b1 = 备份(包装, '卸前')
    console.log('\n已备份 profile/package.json →', b1)
    // 先拆链接（只删链接本身，用户数据根里的东西一个字节不动）
    拆链接(path.join(目标目录, '数据'))
    递归删(目标目录)
    const 新 = 读JSON(包装)
    if (新.dependencies) delete 新.dependencies['whale-memory-dsh']
    if (新.dsh && 新.dsh.profile && Array.isArray(新.dsh.profile.bundles)) {
      新.dsh.profile.bundles = 新.dsh.profile.bundles.filter((x) => x !== 'whale-memory-dsh')
    }
    fs.writeFileSync(包装, JSON.stringify(新, null, 2) + '\n', 'utf8')
    console.log('已摘除插件与登记。请**手动重启 DSH**。')
    console.log('⚠️ 注意：拆掉后 DSH 会回到官方摘要式压缩——这不是 bug，是拆掉接管后的应有行为。')
  }
}

主()
