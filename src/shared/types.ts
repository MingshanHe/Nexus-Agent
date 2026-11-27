// 主进程、预加载脚本和界面共用的类型。这里不能引用 Node 或 Electron 的模块。

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface McpServerSpec {
  type: 'http' | 'sse' | 'stdio'
  /** http / sse */
  url?: string
  headers?: Record<string, string>
  /** stdio */
  command?: string
  args?: string[]
  env?: Record<string, string>
}

/** 一个 Agent 就是一份配置文件：.nexus/agents/<id>.yaml */
export interface AgentConfig {
  /** 文件名（不含扩展名），也是提交信息和交接单里用的短名 */
  id: string
  name: string
  description?: string
  role?: 'specialist' | 'orchestrator'
  model: string
  effort?: EffortLevel
  /** 相对工作区根目录的路径，或绝对路径；默认是工作区根目录 */
  cwd?: string
  /** 提示词文件，相对 .nexus/ 目录，例如 prompts/mech.md */
  system_prompt?: string
  mcp_servers?: Record<string, McpServerSpec>
  /** 自动放行的调用（Claude Code 权限规则语法）；其余调用都弹审批 */
  allowed_tools?: string[]
  /** 从 Agent 的上下文里移除的工具，或直接拒绝的调用 */
  disallowed_tools?: string[]
  /** 每次都必须人工确认的调用，不能被“本次会话一直允许”覆盖 */
  always_ask?: string[]
  /** 启用的技能；'all' 表示工作区里发现的全部技能 */
  skills?: string[] | 'all'
  /** 读取哪些 Claude Code 设置来源，默认只读工作区（project） */
  setting_sources?: Array<'user' | 'project' | 'local'>
  /** 独占资源名。同名资源一次只跑一个任务，例如 fusion、easyeda */
  resource?: string
  max_turns?: number
  max_budget_usd?: number
  git?: {
    /** 任务结束后自动提交的路径（相对仓库根目录）；不填则提交全部改动 */
    paths?: string[]
    /** 相对工作区的独立仓库目录，例如关联了 Overleaf 的 paper */
    repo?: string
  }
}

export interface AgentDetail {
  config: AgentConfig
  prompt: string
  /** 配置文件解析失败时的错误信息 */
  error?: string
}

export type AgentStatus = 'idle' | 'queued' | 'running' | 'waiting-approval'

export interface McpStatus {
  name: string
  status: string
  error?: string
  toolCount?: number
}

export interface AgentRuntimeState {
  /** 项目文件夹 */
  workspace: string
  agentId: string
  status: AgentStatus
  currentTaskId: string | null
  sessionId: string | null
  queueLength: number
  mcp: McpStatus[]
  model?: string
  apiKeySource?: string
}

export type TaskStatus = 'queued' | 'running' | 'done' | 'error' | 'interrupted'
export type TaskOrigin = 'user' | 'handoff' | 'orchestrator'

export interface TaskRecord {
  id: string
  workspace: string
  agentId: string
  agentName: string
  sessionId: string | null
  prompt: string
  origin: TaskOrigin
  status: TaskStatus
  startedAt: number
  endedAt: number | null
  costUsd: number
  numTurns: number
  durationMs: number
  resultSubtype: string | null
  resultText: string | null
  commitSha: string | null
  error: string | null
}

export type ChatItem =
  | { id: string; kind: 'user'; text: string; ts: number }
  | { id: string; kind: 'assistant'; text: string; ts: number; streaming?: boolean }
  | {
      id: string
      kind: 'tool'
      name: string
      input: unknown
      status: 'running' | 'done' | 'error'
      result?: string
      ts: number
      /** 子 Agent 里发生的调用 */
      nested?: boolean
    }
  | { id: string; kind: 'system'; level: 'info' | 'warn' | 'error'; text: string; ts: number }
  | {
      id: string
      kind: 'result'
      subtype: string
      costUsd: number
      numTurns: number
      durationMs: number
      commitSha?: string | null
      ts: number
    }

export interface QuestionOption {
  label: string
  description?: string
}
export interface Question {
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect?: boolean
}

export interface ApprovalRequest {
  id: string
  /** 发起审批的 Agent 所在的项目文件夹 */
  workspace: string
  agentId: string
  agentName: string
  taskId: string
  kind: 'tool' | 'question'
  toolName: string
  input: Record<string, unknown>
  title?: string
  description?: string
  reason?: string
  /** 是否可以选“本次会话内一直允许” */
  canAlwaysAllow: boolean
  /** 选“一直允许”时会加进放行名单的规则 */
  alwaysAllowRules: string[]
  questions?: Question[]
  createdAt: number
}

export interface ApprovalDecision {
  id: string
  behavior: 'allow' | 'allow_session' | 'deny'
  /** 拒绝时给 Agent 看的说明 */
  message?: string
  /** kind === 'question' 时的回答：问题原文 -> 选项或自由文本 */
  answers?: Record<string, string>
}

export type HandoffStatus = 'open' | 'acknowledged' | 'done'

export interface Handoff {
  /** handoff/ 目录下的文件名 */
  file: string
  title: string
  from: string
  to: string[]
  status: HandoffStatus
  created: string
  files: string[]
  body: string
  mtime: number
}

export interface SessionInfo {
  sessionId: string
  agentId: string
  title: string
  createdAt: number
  lastUsedAt: number
  totalUsd: number
  taskCount: number
  parentSessionId: string | null
  current: boolean
}

export interface CostSummary {
  totalUsd: number
  /** 所有项目本月合计：每月预算上限按这个数算 */
  allProjectsMonthUsd: number
  monthUsd: number
  todayUsd: number
  taskCount: number
  byAgent: Array<{ agentId: string; agentName: string; costUsd: number; tasks: number }>
  byDay: Array<{ day: string; costUsd: number; tasks: number }>
  recent: TaskRecord[]
}

/** 一个项目 = 一个文件夹（共享仓库）+ 它自己的一组 Agent */
export interface ProjectInfo {
  id: string
  name: string
  path: string
  createdAt: number
  overleafGitUrl: string | null
}

export interface ProjectSummary extends ProjectInfo {
  exists: boolean
  agentCount: number
  /** 正在运行或排队的任务数 */
  activeTasks: number
  current: boolean
}

export interface FolderChoice {
  path: string
  /** 文件夹名，作为项目名的默认值 */
  name: string
  /** 这个文件夹里已经有 Agent 配置：会直接作为已有项目打开，不套模板 */
  hasAgents: boolean
}

/** 新建项目时用的模板 */
export type ProjectTemplate = 'robot' | 'blank'

export interface BridgeStatus {
  /** 本机有没有嘉立创EDA 的桥接服务在跑 */
  running: boolean
  port: number | null
  /** 是不是本应用启动的 */
  managed: boolean
  /** 已连接的嘉立创EDA 窗口数 */
  windows: number
  /** 内置技能的版本 */
  skillVersion: string | null
  /** 当前项目里是否已装好技能 */
  installed: boolean
  error?: string
}

export interface AppSettings {
  /** 当前项目的文件夹；没有项目时为 null */
  workspace: string | null
  currentProjectId: string | null
  projects: ProjectInfo[]
  appVersion: string
  hasApiKey: boolean
  /** 'app' = 保存在本应用里；'env' = 来自环境变量 ANTHROPIC_API_KEY */
  apiKeySource: 'app' | 'env' | 'none'
  /** 单任务默认预算上限（美元）；null 表示不限 */
  defaultMaxBudgetUsd: number | null
  /** 单任务默认轮数上限；null 表示不限 */
  defaultMaxTurns: number | null
  /** 每月预算上限（美元）；达到后不再启动新任务。null 表示不限 */
  monthlyBudgetUsd: number | null
  autoCommit: boolean
  /** 当前项目关联的 Overleaf Git 地址 */
  overleafGitUrl: string | null
  /** 需要审批或任务结束时，窗口不在前台就发系统通知 */
  notifications: boolean
}

export type SettingsPatch = Partial<
  Pick<AppSettings, 'defaultMaxBudgetUsd' | 'defaultMaxTurns' | 'monthlyBudgetUsd' | 'autoCommit' | 'notifications'>
>

export interface WorkspaceStatus {
  path: string | null
  exists: boolean
  initialized: boolean
  isGitRepo: boolean
  agentCount: number
}

export interface GitResult {
  ok: boolean
  output: string
}

export type AppEvent =
  | { type: 'agents-changed' }
  | { type: 'settings-changed' }
  | { type: 'agent-state'; state: AgentRuntimeState }
  | { type: 'task-updated'; task: TaskRecord }
  | { type: 'chat'; workspace: string; agentId: string; item: ChatItem }
  | { type: 'chat-delta'; workspace: string; agentId: string; itemId: string; text: string }
  | { type: 'chat-reset'; workspace: string; agentId: string }
  | { type: 'approval-request'; request: ApprovalRequest }
  | { type: 'approval-resolved'; id: string }
  | { type: 'handoffs-changed'; handoffs: Handoff[] }

export interface StartTaskResult {
  ok: boolean
  taskId?: string
  /** 'started' 新任务；'queued' 排队；'appended' 追加到正在跑的任务 */
  mode?: 'started' | 'queued' | 'appended'
  error?: string
}

/** 预加载脚本暴露给界面的接口（window.nexus） */
export interface NexusApi {
  settings: {
    get(): Promise<AppSettings>
    update(patch: SettingsPatch): Promise<AppSettings>
    setApiKey(key: string): Promise<AppSettings>
    clearApiKey(): Promise<AppSettings>
  }
  projects: {
    list(): Promise<ProjectSummary[]>
    /** 弹出系统的文件夹选择框；取消时返回 null */
    chooseFolder(): Promise<FolderChoice | null>
    /** 新建项目，或把已有文件夹加进来；创建后切换过去 */
    create(input: { name: string; path: string; template: ProjectTemplate }): Promise<AppSettings>
    open(id: string): Promise<AppSettings>
    rename(id: string, name: string): Promise<AppSettings>
    /** 只从列表里移除，不删除磁盘上的文件 */
    remove(id: string): Promise<AppSettings>
    reveal(id: string): Promise<void>
  }
  workspace: {
    status(): Promise<WorkspaceStatus>
    scaffold(template: ProjectTemplate): Promise<{ created: string[]; skipped: number }>
    exportClaudeAgents(): Promise<{ written: string[] }>
    openInExplorer(): Promise<void>
  }
  agents: {
    list(): Promise<AgentDetail[]>
    /** 自带的 Agent 模板（机械、电子、嵌入式、论文、总控） */
    templates(): Promise<AgentDetail[]>
    save(detail: { config: AgentConfig; prompt: string }): Promise<AgentDetail>
    remove(id: string): Promise<void>
    duplicate(id: string, newId: string): Promise<AgentDetail>
    states(): Promise<AgentRuntimeState[]>
    probeMcp(id: string): Promise<McpStatus[]>
  }
  tasks: {
    start(agentId: string, prompt: string): Promise<StartTaskResult>
    interrupt(agentId: string): Promise<void>
    transcript(agentId: string): Promise<ChatItem[]>
    newSession(agentId: string): Promise<void>
  }
  sessions: {
    list(agentId: string): Promise<SessionInfo[]>
    resume(agentId: string, sessionId: string, fork: boolean): Promise<void>
  }
  approvals: {
    pending(): Promise<ApprovalRequest[]>
    resolve(decision: ApprovalDecision): Promise<void>
  }
  handoffs: {
    list(): Promise<Handoff[]>
    dispatch(file: string, agentId: string): Promise<StartTaskResult>
    setStatus(file: string, status: HandoffStatus): Promise<void>
    create(input: { from: string; to: string[]; title: string; body: string; files: string[] }): Promise<Handoff>
  }
  costs: {
    summary(): Promise<CostSummary>
  }
  eda: {
    status(): Promise<BridgeStatus>
    startBridge(): Promise<BridgeStatus>
    stopBridge(): Promise<BridgeStatus>
    /** 把内置的 EasyEDA API Skill 装进（或更新到）当前项目 */
    installSkill(): Promise<BridgeStatus>
  }
  overleaf: {
    link(url: string): Promise<GitResult>
    pull(): Promise<GitResult>
    push(): Promise<GitResult>
  }
  onEvent(listener: (event: AppEvent) => void): () => void
}

/** window.nexus 上每个分组的方法名；预加载脚本按它生成转发函数，主进程按它注册处理函数。 */
export const API_METHODS = {
  settings: ['get', 'update', 'setApiKey', 'clearApiKey'],
  projects: ['list', 'chooseFolder', 'create', 'open', 'rename', 'remove', 'reveal'],
  workspace: ['status', 'scaffold', 'exportClaudeAgents', 'openInExplorer'],
  agents: ['list', 'templates', 'save', 'remove', 'duplicate', 'states', 'probeMcp'],
  tasks: ['start', 'interrupt', 'transcript', 'newSession'],
  sessions: ['list', 'resume'],
  approvals: ['pending', 'resolve'],
  handoffs: ['list', 'dispatch', 'setStatus', 'create'],
  costs: ['summary'],
  eda: ['status', 'startBridge', 'stopBridge', 'installSkill'],
  overleaf: ['link', 'pull', 'push'],
} as const satisfies { [G in Exclude<keyof NexusApi, 'onEvent'>]: ReadonlyArray<keyof NexusApi[G]> }

export const EVENT_CHANNEL = 'nexus:event'
export function channelName(group: string, method: string): string {
  return `nexus:${group}.${method}`
}
