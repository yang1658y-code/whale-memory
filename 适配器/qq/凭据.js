'use strict'
/**
 * QQ 凭据层 · 只做三件事：找到、校验、脱敏。
 *
 * 取法优先级：环境变量 > 配置/qq.json
 * 环境变量：QQ_BOT_APPID / QQ_BOT_SECRET（兼容 QQ_APP_ID / QQ_APP_SECRET）
 *
 * 三条铁规矩：
 *   ① 密钥绝不进日志——任何要打出来的地方一律过 脱敏()
 *   ② 密钥绝不入库——附加字段白名单本来就挡着，这里再声明一次
 *   ③ 密钥绝不提交——配置/qq.json 已在 .gitignore 里
 *
 * 零依赖：只用 Node 标准库。
 */
const fs = require('fs')
const path = require('path')

const 根目录 = path.join(__dirname, '..', '..')
const 配置路径 = path.join(根目录, '配置', 'qq.json')

/**
 * 脱敏：abcdefgh12345678 → abcd****678（示例是编的 —— 2026-11-02 这里曾把真密钥写进注释，差一点随 MIT 仓发出去）
 * 太短的（<8）直接全遮，避免露出半截反而好猜。
 */
function 脱敏(v, 头 = 4, 尾 = 3) {
  const s = String(v == null ? '' : v)
  if (!s) return '(空)'
  if (s.length <= 头 + 尾) return '*'.repeat(s.length)
  return s.slice(0, 头) + '*'.repeat(4) + s.slice(-尾)
}

function 读配置(选项 = {}) {
  const 路径 = 选项.配置路径 || 配置路径
  if (!fs.existsSync(路径)) return null
  try {
    const 原始 = fs.readFileSync(路径, 'utf8')
    const j = JSON.parse(原始)
    return { appId: j.appId || j.app_id || j.APPID || null, appSecret: j.appSecret || j.secret || j.app_secret || null }
  } catch (e) {
    return { 错误: '配置文件解析失败（' + 路径 + '）：' + String((e && e.message) || e) }
  }
}

/**
 * 取凭据。找不到任何一份 → 返回 {ok:false, 问题:[...]}，由调用方决定怎么提示。
 * 永不抛错——凭据缺失不该炸掉宿主。
 */
function 取凭据(选项 = {}) {
  // 来源名必须跟着 配置路径 变：沙盘跑出来的日志如果还写“来源 配置/qq.json”，
  // 看日志的人会以为进了真凭据——日志呷人比代码写错更难查。
  const 配置名 = 选项.配置路径 ? String(选项.配置路径) : '配置/qq.json'
  const 环境 = 选项.环境 || process.env
  let appId = 环境.QQ_BOT_APPID || 环境.QQ_APP_ID || null
  let appSecret = 环境.QQ_BOT_SECRET || 环境.QQ_APP_SECRET || null
  let 来源 = appId && appSecret ? '环境变量' : null

  if (!appId || !appSecret) {
    const c = 读配置(选项)
    if (c && c.错误) return { ok: false, 问题: [c.错误], 来源: 配置名 }
    if (c) {
      let 用配置 = false
      if (!appId && c.appId) { appId = c.appId; 用配置 = true }
      if (!appSecret && c.appSecret) { appSecret = c.appSecret; 用配置 = true }
      if (用配置) 来源 = 来源 ? 来源 + '+' + 配置名 : 配置名
    }
  }

  const 问题 = []
  if (!appId) 问题.push('缺 AppID（环境变量 QQ_BOT_APPID 或 ' + 配置名 + ' 的 appId）')
  if (!appSecret) 问题.push('缺 AppSecret（环境变量 QQ_BOT_SECRET 或 ' + 配置名 + ' 的 appSecret）')
  const 纯数字 = /^\d{5,}$/.test(String(appId || ''))
  if (appId && !纯数字) 问题.push('AppID 应为一串纯数字，当前看起来不像（长度 ' + String(appId).length + '）')

  return {
    ok: 问题.length === 0,
    appId: appId || null,
    appSecret: appSecret || null,
    来源: 来源 || '无',
    问题,
    脱敏: { appId: appId || null, appSecret: 脱敏(appSecret) }
  }
}

/** 给日志用的一行摘要，绝不带明文密钥 */
function 摘要(c) {
  if (!c || !c.ok) return '凭据不可用：' + ((c && c.问题 && c.问题.join('；')) || '未知')
  return '凭据就绪（来源 ' + c.来源 + '）AppID ' + c.appId + ' · Secret ' + 脱敏(c.appSecret)
}

/** 把配置写成文件（首次引导用）。默认不覆盖已有文件。 */
function 写配置(appId, appSecret, 选项 = {}) {
  if (!appId || !appSecret) return { ok: false, 原因: '参数不全' }
  const 路径 = 选项.配置路径 || 配置路径   // ← 可指定：验收/沙盘要写到隔离路径，绝不碰真配置
  if (fs.existsSync(路径) && !选项.覆盖) return { ok: false, 原因: '配置已存在，未覆盖' }
  fs.mkdirSync(path.dirname(路径), { recursive: true })
  fs.writeFileSync(路径, JSON.stringify({ appId: String(appId), appSecret: String(appSecret) }, null, 2) + '\n', 'utf8')
  return { ok: true, 路径 }
}

module.exports = { 取凭据, 校验: 取凭据, 脱敏, 摘要, 写配置, 配置路径, 根目录 }
