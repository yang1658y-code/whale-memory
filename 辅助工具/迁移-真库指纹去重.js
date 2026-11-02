'use strict'
/**
 * 迁移-真库指纹去重.js —— 把历史遗留的同内容重复行并成一条
 *
 * 背景：去重哨兵（内核/存储适配器.js）只在「新写入」时生效，
 *       库里已经躺着的老重复不会被自动收拢。本脚本补这一刀。
 *
 * 归并规则（与 合并重复 同口径）：
 *   同角色 + 同内容指纹 → 保留最早那条，出现次数累加，句ID们收齐，最近时间取最大。
 *   原文表一个字不动（事实源只追加），所以被并掉那几行的原话仍然能逐句翻出来。
 *
 * 默认 dry-run（不改盘）。加 --执行 才真写，写前自动备份。
 *
 * 用法：
 *   node 辅助工具/迁移-真库指纹去重.js                 # 预览
 *   node 辅助工具/迁移-真库指纹去重.js --执行           # 真写
 *   node 辅助工具/迁移-真库指纹去重.js --根目录=<路径> --执行
 */

const fs = require('fs')
const path = require('path')
const 适配器 = require('../内核/存储适配器.js')

const 参数 = process.argv.slice(2)
const 执行 = 参数.includes('--执行')
const 根参数 = 参数.find(a => a.startsWith('--根目录='))

const 默认真库根 = 'C:\\Users\\Administrator\\.dsh\\whale-memory\\内核数据'
const 根目录 = 根参数 ? 根参数.slice('--根目录='.length) : (process.env.鲸鱼数据目录 || 默认真库根)

const 选项 = { 根目录 }
const 库路径 = 适配器.库路径(选项)

console.log('库路径：' + 库路径)
if (!fs.existsSync(库路径)) {
  console.log('库不存在，无需迁移。')
  process.exit(0)
}

const 全条 = 适配器.读取向量库(选项)
const 原条数 = 全条.length

// 归并：键 = 指纹；保留首见那条（库里就是时间序，首见即最早）
const 表 = new Map()
const 序 = []
let 并掉 = 0
for (const o of 全条) {
  const 键 = o.指纹 || 适配器.内容指纹(o.role, o.content)
  if (!表.has(键)) {
    const 副 = {
      原: o,
      出现次数: Number.isFinite(Number(o.出现次数)) ? Number(o.出现次数) : 1,
      首次时间: Number.isFinite(Number(o.首次时间)) ? Number(o.首次时间) : o.time,
      最近时间: Number.isFinite(Number(o.最近时间)) ? Number(o.最近时间) : o.time,
      句ID们: Array.isArray(o.句ID们) && o.句ID们.length ? o.句ID们.slice() : (o.句ID ? [o.句ID] : [])
    }
    表.set(键, 副)
    序.push(键)
    continue
  }
  并掉++
  const 副 = 表.get(键)
  副.出现次数 += Number.isFinite(Number(o.出现次数)) ? Number(o.出现次数) : 1
  副.首次时间 = Math.min(副.首次时间 || o.time, Number.isFinite(Number(o.首次时间)) ? Number(o.首次时间) : o.time)
  副.最近时间 = Math.max(副.最近时间 || o.time, Number.isFinite(Number(o.最近时间)) ? Number(o.最近时间) : o.time)
  for (const x of (Array.isArray(o.句ID们) && o.句ID们.length ? o.句ID们 : (o.句ID ? [o.句ID] : []))) {
    if (x && !副.句ID们.includes(x)) 副.句ID们.push(x)
  }
  console.log('  并掉：' + o.id + ' ← ' + String(o.content).slice(0, 24))
}

const 新条 = 序.map(k => {
  const 副 = 表.get(k)
  return Object.assign({}, 副.原, {
    指纹: k,
    出现次数: 副.出现次数,
    首次时间: 副.首次时间,
    最近时间: 副.最近时间,
    句ID们: 副.句ID们,
    句ID: 副.原.句ID || 副.句ID们[0] || null
  })
})

console.log('')
console.log('原条数 ' + 原条数 + ' → 迁移后 ' + 新条.length + '（并掉 ' + 并掉 + ' 条）')
for (const o of 新条) {
  console.log('  ' + o.id + ' | ' + o.role + ' | 出现' + o.出现次数 + '次 | 句ID' + (o.句ID们 || []).length + '个 | ' + String(o.content).slice(0, 30))
}

if (!执行) {
  console.log('')
  console.log('（预览模式，未改盘。确认无误后加 --执行）')
  process.exit(0)
}

const 备份 = 库路径 + '.bak-去重迁移-' + Date.now()
fs.copyFileSync(库路径, 备份)
console.log('')
console.log('已备份 → ' + 备份)

const 写 = 适配器.写入向量库(新条, 选项)
if (!写.ok) {
  console.log('❌ 写回失败：' + 写.原因 + '（原库未动，备份在 ' + 备份 + '）')
  process.exit(1)
}
const 校验 = 适配器.健康自检(选项)
console.log('✅ 写回成功：' + 校验.条数 + ' 条 / 坏行 ' + 校验.坏行数 + ' / 带句ID ' + 校验.带句ID数)
process.exit(0)
