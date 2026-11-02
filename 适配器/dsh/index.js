/**
 * 会记得你的鲸鱼 · DSH 压缩接管插件（host 半边）
 *
 * ══════════════════════════════════════════════════════════════
 *  只有一个目标：让 DSH 永远不可能按它自己的标准把历史摘要掉。
 *
 *  做法不是跟官方压缩抢，而是站在官方唯一开放的那个钩子上：
 *  官方注释原话 —— "summarize() is the sole subclass customization hook"；
 *  而 regionDependencies() 里是动态派发 ——
 *      summarize: (input, owner, abort) => this.summarize(input, owner, abort)
 *
 *  所以子类一覆盖：
 *    · 锁（compaction/start–end）、表层替换（surfaceOp replace）、
 *      token 计价、tool-pairing 平衡 —— 全部仍走官方实现（不该我们重写）
 *    · **只有"这条替换消息写什么"换成我们的归档索引**
 *
 *  官方那条 LLM 摘要路径（summarizeWithLlm）在这个类里一次都不会被调用，
 *  因为默认路径从不调父类的摘要实现（唯一入口是用户显式打开的应急阀）。
 * ══════════════════════════════════════════════════════════════
 *
 * 工程约束：
 *   · 本文件是 ESM；内核是 CommonJS —— 桥接在 lib/归档.js 用 createRequire 做，
 *     内核一行都不改（契约：永不把内核改成 ESM）
 *   · 所有宿主 API 调用都包 try/catch，装到 rc 版本上要「少一功能」，不许「整插件崩」
 */

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { 造接管结果 } from './lib/接管.js'

function 安全日志(ctx, 级, 文) {
  try {
    const l = ctx && ctx.logger
    if (!l) return
    if (级 === 'warn' && typeof l.warn === 'function') l.warn(文)
    else if (typeof l.info === 'function') l.info(文)
  } catch {
    /* 日志失败不许影响压缩 */
  }
}

export default class 鲸鱼压缩引擎 extends BasicCompactionEngine {
  /**
   * @param {object} input 官方给的原话回放（{messages, tools?}），即将被遮蔽的那一段
   * @param {object} agent 拥有该会话的 agent
   * @param {AbortSignal} signal
   */
  async summarize(input, agent, signal) {
    // ── 应急阀：只在排查官方 bug 时用，默认永不走这里
    if (process.env['鲸鱼关闭接管'] === '1') {
      安全日志(this.ctx, 'warn', 'compaction: 鲸鱼接管已关闭（鲸鱼关闭接管=1），本次走官方摘要')
      return super.summarize(input, agent, signal)
    }

    let 会话 = 'dsh'
    try {
      const s = agent && agent.session
      会话 = (s && (s.id || s.会话)) || 'dsh'
    } catch {
      /* 取不到会话名就用默认名，不崩 */
    }

    const 结果 = 造接管结果({ 消息们: input && input.messages, 会话 })
    const 报 = 结果.报告
    安全日志(
      this.ctx,
      报.重复 || 报.归档.ok ? 'info' : 'warn',
      'compaction(鲸鱼接管): ' +
        (报.重复 ? '重复段未重写' : 报.归档.ok ? '已归档 ' + 报.句数 + ' 句/' + 报.字数 + ' 字' : '归档失败：' + 报.归档.错误) +
        '，索引 ' +
        报.索引字符 +
        ' 字（无模型摘要）'
    )

    return {
      summary: 结果.summary,
      rawOutput: 结果.rawOutput,
      llmStreamCall: 结果.llmStreamCall,
      provider: 结果.provider,
      model: 结果.model,
    }
  }
}
