import type { AgentStatus, TaskStatus } from '../../shared/types'

export function usd(value: number): string {
  if (value === 0) return '$0.00'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

export function dateTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  idle: '空闲',
  queued: '排队中',
  running: '运行中',
  'waiting-approval': '等待审批',
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '运行中',
  done: '完成',
  error: '出错',
  interrupted: '已中断',
}

export const MCP_STATUS_LABEL: Record<string, string> = {
  connected: '已连接',
  pending: '连接中',
  failed: '连接失败',
  'needs-auth': '需要认证',
  disabled: '已停用',
  reachable: '端口可达',
  unreachable: '端口不通',
  stdio: '任务启动时连接',
}

/** Agent 的首字，作为侧边栏里的标记 */
export function agentGlyph(name: string): string {
  return [...name.trim()][0] ?? '?'
}

/** 一次工具调用的一行摘要 */
export function toolSummary(name: string, input: unknown): string {
  const data = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const pick = (key: string): string | null => (typeof data[key] === 'string' ? (data[key] as string) : null)
  const summary =
    pick('command') ??
    pick('file_path') ??
    pick('notebook_path') ??
    pick('pattern') ??
    pick('query') ??
    pick('url') ??
    pick('description') ??
    pick('task') ??
    pick('prompt')
  if (summary) return summary.replace(/\s+/g, ' ')
  const text = JSON.stringify(data)
  return text === '{}' ? '' : text
}

/** mcp__fusion__fusion_mcp_read -> fusion · fusion_mcp_read */
export function toolLabel(name: string): string {
  const match = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name)
  return match ? `${match[1]} · ${match[2]}` : name
}
