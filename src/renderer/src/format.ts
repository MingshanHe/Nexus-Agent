import type { AgentStatus, PermissionMode, TaskStatus } from '../../shared/types'

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


export const MODE_LABEL: Record<PermissionMode, string> = {
  default: '逐项审批',
  acceptEdits: '自动接受编辑',
  auto: '自动模式',
  plan: '计划模式',
  bypassPermissions: '全部放行',
}

export const MODE_HINT: Record<PermissionMode, string> = {
  default: '没有放行的调用都会问你',
  acceptEdits: '项目里的文件改动和常见文件命令不再问，其余照常审批',
  auto: '由分类器模型逐个判断是否安全，拿不准的才问你（分类器的调用也计费）',
  plan: '只读探索并写出计划，你批准后才开始动手',
  bypassPermissions: '几乎什么都不问就执行；配置里“每次都要确认”的调用仍然会问',
}

/** Shift+Tab 轮换的顺序；“全部放行”不在轮换里，要从下拉框里明确选 */
export const MODE_CYCLE: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'plan']

const COMMAND_HINT: Record<string, string> = {
  clear: '开始一个新会话（旧会话留在“历史会话”里）',
  compact: '压缩上下文：把更早的对话换成摘要',
  context: '查看上下文窗口的占用',
  usage: '查看这个会话的用量',
}

export function commandHint(name: string): string {
  return COMMAND_HINT[name] ?? ''
}
