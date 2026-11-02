/**
 * 会记得你的鲸鱼 · DSH 记忆注入插件（host 半边）
 *
 * ══════════════════════════════════════════════════════════════
 *  压缩那半边（index.js）管的是「历史怎么退场」；
 *  本文件管的是「历史怎么上场」——两者合起来，记忆才闭环。
 *
 *  挂载点用的是官方明确开放的门（dsh-agent README 原文）：
 *    agent/pre-step — "can reject a proposed step or replace the messages entering it"
 *  即：模型真正收到请求之前，最后一道可以改 messages 的关口。
 *
 *  做法（逐行对嵌官方自己的 installModelSelection，不发明新用法）：
 *    const 决策 = await next()
 *    return { ...决策, messages: [...决策.messages, createUserMessage({...})] }
 *  ——只**追加**一条，绝不改动上下游已有的任何一条消息（保留 id 与冻结语义）。
 *
 *  为什么是「追加」而不是「改写系统提示」：
 *    系统提示每改一次，KV 缓存前缀就废一次；追加一条 user 消息是官方
 *    model-selection 通知用的同一手法，前缀稳定、可被压缩插件正常归档。
 *
 *  三条纪律：
 *    ① 任何失败都不抛错（抛了这一步就废，整轮跟着废）；
 *    ② 内核不在 / 检索挂 / 门控闭嘴 → 静默跳过，不算错误；
 *    ③ 默认每轮只在「有新用户输入」的那一步注入一次，避免每步重复计费。
 * ══════════════════════════════════════════════════════════════
 */

import { Service } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { 造记忆注入, 体检, 归一配置 } from './lib/记忆核心.js'

function 安全日志(ctx, 级, 文) {
  try {
    const l = ctx && ctx.logger
    if (!l) return
    if (级 === 'warn' && typeof l.warn === 'function') l.warn(文)
    else if (级 === 'error' && typeof l.error === 'function') l.error(文)
    else if (typeof l.info === 'function') l.info(文)
  } catch {
    /* 日志失败不许影响对话 */
  }
}

/** 取会话标识：DSH 的 session.id，取不到就落默认名，绝不崩 */
function 取会话名(agent) {
  try {
    const s = agent && agent.session
    return String((s && (s.id || s.会话)) || 'dsh')
  } catch {
    return 'dsh'
  }
}

/** 取当前路由的模型，交给门控降档用 */
function 取当前模型(agent) {
  try {
    const o = agent && agent.options
    if (o && typeof o.provider === 'string' && typeof o.model === 'string' && o.provider && o.model) {
      return o.provider + '/' + o.model
    }
  } catch {
    /* 取不到就交给门控自己判 */
  }
  return undefined
}

/**
 * 记忆注入插件。
 *
 * 配置项（cordis.patch.yml 里 config 下的键）——**英文键为主，中文键仍认**：
 *   enabled / 启用           : boolean  默认 true。总开关，关掉后一步都不碰。
 *   everyTurn / 每轮一次      : boolean  默认 true。只在「这一步有新用户输入」时检索。
 *   maxInjectChars / 最大注入字符 : number 默认 900。注入文本的硬上限。
 *   contextPairs / 上下句数     : number 默认 1。翻原话时带上前后各几句。
 *
 * 为什么要两套键：英文键给 npm 上的陌生用户（照 README 抄就能跑），
 * 中文键是老配置，不删不改——已装的用户升级后行为不变。
 */
export default class 鲸鱼记忆 extends Service {
  static inject = []

  constructor(ctx, config = {}) {
    super(ctx, 'whaleMemory')
    this.配置 = config && typeof config === 'object' ? config : {}
    this.统计 = { 步数: 0, 检索次数: 0, 注入次数: 0, 跳过次数: 0, 异常次数: 0, 最近: null }

    const 卸 = this.注册监听()
    if (typeof 卸 === 'function') {
      try {
        this.ctx.effect(() => 卸, 'whale-memory: agent/pre-step 监听')
      } catch {
        /* effect 不可用时监听仍在，不影响对话 */
      }
    }

    const 起 = this.注册()
    安全日志(
      ctx,
      'info',
      'whale-memory: 记忆注入已挂载（' + (起.就绪 ? '内核检索层可用' : '内核检索层不可用，将静默跳过：' + 起.原因) + '）'
    )
  }

  /** 读一次配置的最终值（归一逻辑在核心层 归一配置，本壳不自己算） */
  参数() {
    return 归一配置(this.配置)
  }

  /** 挂载时体检一次，只报能不能用，不报任何用户内容 */
  注册() {
    try {
      const 检 = 体检()
      return { 就绪: 检.检索 === true, 原因: 检.检索 ? '' : '找检索() 返回空（内核目录或 候选映射.js 不在）', 检 }
    } catch (e) {
      return { 就绪: false, 原因: String((e && e.message) || e), 检: null }
    }
  }

  /** 装配：注册 agent/pre-step 监听，返回卸载函数 */
  注册监听() {
    const 参 = this.参数()
    if (!参.启用) {
      安全日志(this.ctx, 'info', 'whale-memory: 启用=false，本次不注册监听')
      return () => {}
    }
    return this.ctx.on('agent/pre-step', async (载荷, next) => {
      // 先让下游（含官方 model-selection 等）把决策做出来，我们只在其后追加
      const 决策 = await next()
      try {
        this.统计.步数 += 1
        if (!决策 || 决策.kind === 'reject') return 决策
        const 信号 = 载荷 && 载荷.signal
        if (信号 && 信号.aborted) return 决策

        const 进 = Array.isArray(载荷 && 载荷.messages) ? 载荷.messages : []
        // 「每轮一次」：本步没有新的用户输入就不检索（省 token、保 KV 前缀）
        if (参.每轮一次 && 进.length === 0) return 决策

        const agent = 载荷 && 载荷.agent
        const 会话 = 取会话名(agent)
        this.统计.检索次数 += 1
        const 结果 = await 造记忆注入({
          消息们: 进,
          会话,
          当前模型: 取当前模型(agent),
          最大字符: 参.最大字符,
          上下句数: 参.上下句数,
        })
        this.统计.最近 = 结果.报告

        if (!结果.注入) {
          this.统计.跳过次数 += 1
          if (结果.报告 && 结果.报告.跳过原因 && 结果.报告.跳过原因.indexOf('异常') >= 0) {
            this.统计.异常次数 += 1
            安全日志(this.ctx, 'warn', 'whale-memory: ' + 结果.报告.跳过原因)
          }
          return 决策
        }

        const 新消息 = createUserMessage({
          content: [{ type: 'text', text: 结果.文本 }],
          source: {
            kind: 'whale-memory',
            form: 'notice',
            summary: 短摘要(结果.报告),
          },
        })

        this.统计.注入次数 += 1
        安全日志(
          this.ctx,
          'info',
          'whale-memory: 注入 1 段原话（' +
            结果.报告.句ID + '，' +
            结果.报告.注入字符 + ' 字，档位 ' + (结果.报告.档位 || '-') + '，理由 ' + (结果.报告.理由 || '-') + '）'
        )

        return { ...决策, messages: [...决策.messages, 新消息] }
      } catch (e) {
        this.统计.异常次数 += 1
        安全日志(this.ctx, 'warn', 'whale-memory: pre-step 异常已吞掉 → ' + String((e && e.message) || e))
        return 决策
      }
    }, { prepend: true })
  }
}

/** source.summary 有 120 字符硬上限（官方 boundContextSummary 同口径） */
function 短摘要(报告) {
  const 文 = '记起原话 ' + String((报告 && 报告.句ID) || '') + '，' + String((报告 && 报告.注入字符) || 0) + ' 字'
  return 文.length <= 120 ? 文 : 文.slice(0, 119) + '…'
}
