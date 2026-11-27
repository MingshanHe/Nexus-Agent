import { createSdkMcpServer, tool, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { listHandoffs } from '../handoff/handoffs'
import { listAgents } from './config'
import type { AgentManager } from './manager'

// 总控 Agent 的自定义工具，绑定在它所在的项目上。它自己只读，靠 dispatch(agent, task) 把目标拆给各专业 Agent。
// dispatch 不在总控的自动放行名单里，所以每次派发都会先弹审批。

const TWO_HOURS_MS = 2 * 60 * 60 * 1000

function text(value: string, isError = false) {
  return { content: [{ type: 'text' as const, text: value }], isError }
}

export function createOrchestratorServer(
  manager: AgentManager,
  workspace: string,
  orchestratorId: string,
): McpServerConfig {
  return createSdkMcpServer({
    name: 'nexus',
    version: '0.1.0',
    alwaysLoad: true,
    // 被派发的任务可能跑很久（建模、编译、写章节）
    timeout: TWO_HOURS_MS,
    tools: [
      tool(
        'list_agents',
        '列出当前工作区里的专业 Agent：id、名称、职责、是否空闲。派发任务前先看这个。',
        {},
        async () => {
          const states = new Map(manager.states(workspace).map((s) => [s.agentId, s]))
          const rows = listAgents(workspace)
            .filter((a) => !a.error && a.config.id !== orchestratorId && a.config.role !== 'orchestrator')
            .map((a) => ({
              id: a.config.id,
              name: a.config.name,
              description: a.config.description ?? '',
              status: states.get(a.config.id)?.status ?? 'idle',
              queued: states.get(a.config.id)?.queueLength ?? 0,
            }))
          return text(JSON.stringify(rows, null, 2))
        },
      ),
      tool(
        'list_handoffs',
        '列出 handoff/ 目录里的交接单及其状态（open / acknowledged / done），用来跟踪跨专业的跟进。',
        {},
        async () => {
          const rows = listHandoffs(workspace).map((h) => ({
            file: `handoff/${h.file}`,
            title: h.title,
            from: h.from,
            to: h.to,
            status: h.status,
            created: h.created,
          }))
          return text(JSON.stringify(rows, null, 2))
        },
      ),
      tool(
        'dispatch',
        '把一个任务派给某个专业 Agent，并等它做完后拿回结果。任务说明要自成一体：' +
          '写清目标、相关文件路径、完成标准；对方看不到你的对话。一次只派一件事。',
        {
          agent: z.string().describe('目标 Agent 的 id，来自 list_agents'),
          task: z.string().describe('完整的任务说明'),
        },
        async ({ agent, task }) => {
          if (agent === orchestratorId) return text('不能把任务派给自己。', true)
          const target = listAgents(workspace).find((a) => a.config.id === agent)
          if (!target || target.error) return text(`找不到可用的 Agent：${agent}。先调用 list_agents。`, true)
          if (target.config.role === 'orchestrator') return text('不能把任务派给另一个总控 Agent。', true)
          try {
            const record = await manager.submitAndWait(workspace, agent, task, 'orchestrator')
            const summary = {
              agent,
              status: record.status,
              cost_usd: Number(record.costUsd.toFixed(4)),
              turns: record.numTurns,
              commit: record.commitSha,
              error: record.error,
              result: record.resultText ?? '',
            }
            return text(JSON.stringify(summary, null, 2), record.status !== 'done')
          } catch (error) {
            return text(`派发失败：${error instanceof Error ? error.message : String(error)}`, true)
          }
        },
      ),
    ],
  })
}
