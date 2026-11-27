import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentConfig,
  AgentRuntimeState,
  AppEvent,
  ApprovalDecision,
  ApprovalRequest,
  ChatItem,
  McpStatus,
  StartTaskResult,
  TaskOrigin,
  TaskRecord,
} from '../../shared/types'
import { autoCommit, commitMessage, isRepoRoot } from '../git/git'
import { taskCostFromReported, type Store } from '../store/db'
import { getAgent, listAgents, resolveAgentCwd } from './config'
import { startTask, type ApprovalAsk, type QueryFn, type RunOutcome, type TaskHandle } from './runner'

// 调度核心：谁在跑、谁在排队、谁在等审批。保持薄——Agent 循环、工具、会话都是 SDK 的。

const MAX_TRANSCRIPT_ITEMS = 3000

export interface ManagerSettings {
  apiKey: string | null
  defaultMaxBudgetUsd: number | null
  defaultMaxTurns: number | null
  monthlyBudgetUsd: number | null
  autoCommit: boolean
}

export interface ManagerDeps {
  store: Store
  getWorkspace(): string | null
  getSettings(): ManagerSettings
  emit(event: AppEvent): void
  queryFn: QueryFn
  executablePath?: string
  /** 从 SDK 的本机会话记录里读历史消息 */
  loadHistory?(sessionId: string, cwd: string): Promise<ChatItem[]>
  /** 总控 Agent 的自定义工具（dispatch 等） */
  orchestratorServer?(manager: AgentManager, orchestratorId: string): McpServerConfig
  /** 每次工具调用的审计记录 */
  audit?(entry: { ts: number; agentId: string; taskId: string; tool: string; input: unknown }): void
}

interface QueuedTask {
  task: TaskRecord
  settle(task: TaskRecord): void
}

interface Runtime {
  agentId: string
  status: AgentRuntimeState['status']
  current: TaskRecord | null
  handle: TaskHandle | null
  sessionId: string | null
  forkNext: boolean
  transcript: ChatItem[]
  transcriptLoaded: boolean
  mcp: McpStatus[]
  model?: string
  apiKeySource?: string
  sessionAllowed: Set<string>
  queue: QueuedTask[]
  /** 正在跑的任务占用的独占资源 */
  holding: string | null
}

interface PendingApproval {
  request: ApprovalRequest
  resolve(decision: ApprovalDecision): void
}

function titleOf(prompt: string): string {
  const line = prompt.replace(/\s+/g, ' ').trim()
  return line.length > 60 ? `${line.slice(0, 60)}…` : line || '新会话'
}

export class AgentManager {
  private runtimes = new Map<string, Runtime>()
  private approvals = new Map<string, PendingApproval>()

  constructor(private deps: ManagerDeps) {}

  // ---------- 状态 ----------

  private runtime(agentId: string): Runtime {
    let rt = this.runtimes.get(agentId)
    if (!rt) {
      const workspace = this.deps.getWorkspace()
      rt = {
        agentId,
        status: 'idle',
        current: null,
        handle: null,
        sessionId: workspace ? this.deps.store.getCurrentSession(workspace, agentId) : null,
        forkNext: false,
        transcript: [],
        transcriptLoaded: false,
        mcp: [],
        sessionAllowed: new Set(),
        queue: [],
        holding: null,
      }
      this.runtimes.set(agentId, rt)
    }
    return rt
  }

  private stateOf(rt: Runtime): AgentRuntimeState {
    return {
      agentId: rt.agentId,
      status: rt.status,
      currentTaskId: rt.current?.id ?? null,
      sessionId: rt.sessionId,
      queueLength: rt.queue.length,
      mcp: rt.mcp,
      model: rt.model,
      apiKeySource: rt.apiKeySource,
    }
  }

  private emitState(rt: Runtime): void {
    this.deps.emit({ type: 'agent-state', state: this.stateOf(rt) })
  }

  states(): AgentRuntimeState[] {
    const workspace = this.deps.getWorkspace()
    if (!workspace) return []
    return listAgents(workspace).map((detail) => this.stateOf(this.runtime(detail.config.id)))
  }

  isBusy(): boolean {
    return [...this.runtimes.values()].some((rt) => rt.handle !== null || rt.queue.length > 0)
  }

  /** 换工作区或退出前：停掉所有任务，丢掉内存里的状态。 */
  async reset(): Promise<void> {
    const running: Promise<unknown>[] = []
    for (const rt of this.runtimes.values()) {
      for (const queued of rt.queue.splice(0)) this.finishWithoutRunning(queued, '工作区已切换，任务取消。')
      if (rt.handle) {
        rt.handle.interrupt()
        rt.handle.interrupt() // 第二次调用直接结束进程
        running.push(rt.handle.done.catch(() => undefined))
      }
    }
    for (const pending of [...this.approvals.values()]) {
      pending.resolve({ id: pending.request.id, behavior: 'deny', message: '应用正在关闭或切换工作区。' })
    }
    await Promise.race([Promise.all(running), new Promise((resolve) => setTimeout(resolve, 5000))])
    this.runtimes.clear()
    this.approvals.clear()
  }

  // ---------- 对话记录 ----------

  private pushChat(rt: Runtime, item: ChatItem): void {
    const index = rt.transcript.findIndex((existing) => existing.id === item.id)
    if (index >= 0) rt.transcript[index] = item
    else {
      rt.transcript.push(item)
      if (rt.transcript.length > MAX_TRANSCRIPT_ITEMS) rt.transcript.splice(0, rt.transcript.length - MAX_TRANSCRIPT_ITEMS)
    }
    this.deps.emit({ type: 'chat', agentId: rt.agentId, item })
  }

  private appendDelta(rt: Runtime, itemId: string, text: string): void {
    const item = rt.transcript.find((existing) => existing.id === itemId)
    if (item && item.kind === 'assistant') item.text += text
    this.deps.emit({ type: 'chat-delta', agentId: rt.agentId, itemId, text })
  }

  private note(rt: Runtime, level: 'info' | 'warn' | 'error', text: string): void {
    this.pushChat(rt, { id: randomUUID(), kind: 'system', level, text, ts: Date.now() })
  }

  async transcript(agentId: string): Promise<ChatItem[]> {
    const rt = this.runtime(agentId)
    const workspace = this.deps.getWorkspace()
    if (!rt.transcriptLoaded && rt.transcript.length === 0 && rt.sessionId && workspace && this.deps.loadHistory) {
      rt.transcriptLoaded = true
      const detail = getAgent(workspace, agentId)
      const cwd = detail && !detail.error ? resolveAgentCwd(workspace, detail.config) : workspace
      try {
        const history = await this.deps.loadHistory(rt.sessionId, cwd)
        // 加载期间可能已经有新消息进来了，历史放在前面
        rt.transcript = [...history, ...rt.transcript]
      } catch {
        // 历史读不到不影响继续对话：resume 仍然由 SDK 处理
      }
    }
    rt.transcriptLoaded = true
    return rt.transcript
  }

  // ---------- 会话 ----------

  newSession(agentId: string): void {
    const rt = this.runtime(agentId)
    if (rt.handle) throw new Error('任务进行中，不能切换会话。先等它结束或中断它。')
    rt.sessionId = null
    rt.forkNext = false
    rt.transcript = []
    rt.transcriptLoaded = true
    rt.mcp = []
    const workspace = this.deps.getWorkspace()
    if (workspace) this.deps.store.setCurrentSession(workspace, agentId, null)
    this.deps.emit({ type: 'chat-reset', agentId })
    this.emitState(rt)
  }

  async resumeSession(agentId: string, sessionId: string, fork: boolean): Promise<void> {
    const rt = this.runtime(agentId)
    if (rt.handle) throw new Error('任务进行中，不能切换会话。先等它结束或中断它。')
    const workspace = this.deps.getWorkspace()
    if (!workspace) throw new Error('还没有选择工作区。')
    rt.sessionId = sessionId
    rt.forkNext = fork
    rt.transcript = []
    rt.transcriptLoaded = false
    this.deps.store.setCurrentSession(workspace, agentId, sessionId)
    await this.transcript(agentId)
    if (fork) this.note(rt, 'info', '已从这个会话分叉：下一条指令会在新分支里继续，原会话保持不变。')
    this.deps.emit({ type: 'chat-reset', agentId })
    this.emitState(rt)
  }

  // ---------- 任务 ----------

  /** 界面和交接看板用：提交任务后立刻返回。 */
  submit(agentId: string, prompt: string, origin: TaskOrigin): StartTaskResult {
    try {
      const { mode, task } = this.enqueue(agentId, prompt, origin)
      return { ok: true, mode, taskId: task.id }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 总控 Agent 的 dispatch 用：等任务跑完再返回。 */
  submitAndWait(agentId: string, prompt: string, origin: TaskOrigin): Promise<TaskRecord> {
    return new Promise((resolve, reject) => {
      try {
        this.enqueue(agentId, prompt, origin, resolve)
      } catch (error) {
        reject(error)
      }
    })
  }

  private enqueue(
    agentId: string,
    prompt: string,
    origin: TaskOrigin,
    settle: (task: TaskRecord) => void = () => undefined,
  ): { mode: NonNullable<StartTaskResult['mode']>; task: TaskRecord } {
    const text = prompt.trim()
    if (!text) throw new Error('任务内容不能为空。')
    const workspace = this.deps.getWorkspace()
    if (!workspace) throw new Error('还没有选择工作区。')
    const detail = getAgent(workspace, agentId)
    if (!detail) throw new Error(`找不到 Agent：${agentId}`)
    if (detail.error) throw new Error(`Agent「${agentId}」的配置文件有错误：${detail.error}`)

    const settings = this.deps.getSettings()
    if (!settings.apiKey) throw new Error('还没有配置 Claude API Key。请先到“设置”里填写。')
    if (settings.monthlyBudgetUsd !== null) {
      const now = new Date()
      const spent = this.deps.store.costSince(workspace, new Date(now.getFullYear(), now.getMonth(), 1).getTime())
      if (spent >= settings.monthlyBudgetUsd) {
        throw new Error(
          `本月已花费 $${spent.toFixed(2)}，达到每月预算上限 $${settings.monthlyBudgetUsd.toFixed(2)}。可以在“设置”里调整上限。`,
        )
      }
    }

    const rt = this.runtime(agentId)
    // 任务进行中：用户的新指令直接追加进当前任务
    if (rt.handle && rt.current && origin === 'user' && rt.handle.send(text)) {
      this.pushChat(rt, { id: randomUUID(), kind: 'user', text, ts: Date.now() })
      return { mode: 'appended', task: rt.current }
    }

    const task: TaskRecord = {
      id: randomUUID(),
      workspace,
      agentId,
      agentName: detail.config.name,
      sessionId: null,
      prompt: text,
      origin,
      status: 'queued',
      startedAt: Date.now(),
      endedAt: null,
      costUsd: 0,
      numTurns: 0,
      durationMs: 0,
      resultSubtype: null,
      resultText: null,
      commitSha: null,
      error: null,
    }
    this.deps.store.upsertTask(task)
    rt.queue.push({ task, settle })
    const startsNow = !rt.handle && rt.queue.length === 1 && this.resourceFree(detail.config, agentId)
    this.deps.emit({ type: 'task-updated', task })
    this.pump()
    return { mode: startsNow ? 'started' : 'queued', task }
  }

  /** Fusion 和嘉立创EDA 各自一次只跑一个任务：同名独占资源同一时间只给一个 Agent。 */
  private resourceFree(config: AgentConfig, agentId: string): boolean {
    if (!config.resource) return true
    for (const other of this.runtimes.values()) {
      if (other.agentId !== agentId && other.holding === config.resource) return false
    }
    return true
  }

  private pump(): void {
    const workspace = this.deps.getWorkspace()
    if (!workspace) return
    for (const rt of this.runtimes.values()) {
      if (rt.handle || rt.queue.length === 0) continue
      const detail = getAgent(workspace, rt.agentId)
      if (!detail || detail.error) {
        for (const queued of rt.queue.splice(0)) this.finishWithoutRunning(queued, 'Agent 配置不可用，任务取消。')
        continue
      }
      if (!this.resourceFree(detail.config, rt.agentId)) {
        if (rt.status !== 'queued') {
          rt.status = 'queued'
          this.emitState(rt)
        }
        continue
      }
      const next = rt.queue.shift() as QueuedTask
      void this.run(rt, detail.config, detail.prompt, workspace, next)
    }
  }

  private finishWithoutRunning(queued: QueuedTask, reason: string): void {
    const task: TaskRecord = { ...queued.task, status: 'interrupted', endedAt: Date.now(), error: reason }
    this.deps.store.upsertTask(task)
    this.deps.emit({ type: 'task-updated', task })
    queued.settle(task)
  }

  private async run(rt: Runtime, config: AgentConfig, promptFile: string, workspace: string, queued: QueuedTask): Promise<void> {
    const settings = this.deps.getSettings()
    const cwd = resolveAgentCwd(workspace, config)
    const task: TaskRecord = { ...queued.task, status: 'running', startedAt: Date.now(), agentName: config.name }
    const resume = rt.sessionId
    const fork = Boolean(resume) && rt.forkNext

    rt.current = task
    rt.status = 'running'
    rt.holding = config.resource ?? null
    this.deps.store.upsertTask(task)
    this.deps.emit({ type: 'task-updated', task })
    this.pushChat(rt, { id: randomUUID(), kind: 'user', text: task.prompt, ts: Date.now() })
    if (task.origin !== 'user') {
      this.note(rt, 'info', task.origin === 'handoff' ? '这个任务来自交接看板。' : '这个任务由总控 Agent 派发。')
    }

    let outcome: RunOutcome
    try {
      const handle = startTask(
        {
          agent: config,
          cwd,
          systemPromptAppend: this.systemPrompt(config, promptFile),
          prompt: task.prompt,
          resume,
          fork,
          apiKey: settings.apiKey,
          sessionAllowed: [...rt.sessionAllowed],
          maxTurns: config.max_turns ?? settings.defaultMaxTurns,
          maxBudgetUsd: config.max_budget_usd ?? settings.defaultMaxBudgetUsd,
          extraMcpServers:
            config.role === 'orchestrator' && this.deps.orchestratorServer
              ? { nexus: this.deps.orchestratorServer(this, config.id) }
              : undefined,
          executablePath: this.deps.executablePath,
          queryFn: this.deps.queryFn,
        },
        {
          onChat: (item) => this.pushChat(rt, item),
          onDelta: (itemId, text) => this.appendDelta(rt, itemId, text),
          onInit: (info) => {
            rt.sessionId = info.sessionId
            rt.forkNext = false
            rt.mcp = info.mcp
            rt.model = info.model
            rt.apiKeySource = info.apiKeySource
            task.sessionId = info.sessionId
            this.deps.store.touchSession({
              sessionId: info.sessionId,
              workspace,
              agentId: config.id,
              title: titleOf(task.prompt),
              parentSessionId: fork && resume !== info.sessionId ? resume : null,
            })
            this.deps.store.setCurrentSession(workspace, config.id, info.sessionId)
            this.deps.store.upsertTask(task)
            this.emitState(rt)
          },
          requestApproval: (ask, signal) => this.requestApproval(rt, config, task, ask, signal),
          onSessionAllow: (rules) => {
            for (const rule of rules) rt.sessionAllowed.add(rule)
          },
          onToolCall: (tool, input) => {
            this.deps.audit?.({ ts: Date.now(), agentId: config.id, taskId: task.id, tool, input })
          },
        },
      )
      rt.handle = handle
      this.emitState(rt)
      outcome = await handle.done
    } catch (error) {
      outcome = {
        sessionId: rt.sessionId,
        subtype: 'error_start',
        isError: true,
        interrupted: false,
        resultText: '',
        reportedTotalUsd: 0,
        numTurns: 0,
        durationMs: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }

    // 花费：SDK 报的是会话累计值，减去这个会话上次的累计值才是本次任务的
    let costUsd = 0
    if (outcome.sessionId && outcome.reportedTotalUsd > 0) {
      const baseline = this.deps.store.sessionReportedTotal(outcome.sessionId)
      costUsd = taskCostFromReported(outcome.reportedTotalUsd, baseline)
      this.deps.store.setSessionReportedTotal(outcome.sessionId, outcome.reportedTotalUsd)
    }

    let commitSha: string | null = null
    if (settings.autoCommit) {
      commitSha = await this.commit(rt, config, workspace, task, outcome.sessionId)
    }

    const finished: TaskRecord = {
      ...task,
      sessionId: outcome.sessionId ?? task.sessionId,
      status: outcome.interrupted ? 'interrupted' : outcome.isError ? 'error' : 'done',
      endedAt: Date.now(),
      costUsd,
      numTurns: outcome.numTurns,
      durationMs: outcome.durationMs || Date.now() - task.startedAt,
      resultSubtype: outcome.subtype,
      resultText: outcome.resultText || null,
      commitSha,
      error: outcome.error,
    }
    this.deps.store.upsertTask(finished)
    if (outcome.error) this.note(rt, outcome.interrupted ? 'warn' : 'error', outcome.error)
    this.pushChat(rt, {
      id: randomUUID(),
      kind: 'result',
      subtype: finished.status,
      costUsd,
      numTurns: finished.numTurns,
      durationMs: finished.durationMs,
      commitSha,
      ts: Date.now(),
    })

    rt.handle = null
    rt.current = null
    rt.holding = null
    rt.status = 'idle'
    this.deps.emit({ type: 'task-updated', task: finished })
    this.emitState(rt)
    queued.settle(finished)
    this.pump()
  }

  private systemPrompt(config: AgentConfig, promptFile: string): string {
    return [
      `你是「${config.name}」（id：${config.id}），一个多 Agent 研发项目里的专业 Agent，由本机的管理软件 Nexus Agent 启动。`,
      '当前工作目录是所有 Agent 共享的项目仓库，项目总览和协作规则见仓库根目录的 CLAUDE.md。',
      '需要人审批的操作会弹窗给用户确认；被拒绝时读用户给的说明，换一种做法或停下来问，不要绕过。',
      '',
      promptFile.trim(),
    ].join('\n')
  }

  private async commit(
    rt: Runtime,
    config: AgentConfig,
    workspace: string,
    task: TaskRecord,
    sessionId: string | null,
  ): Promise<string | null> {
    const message = commitMessage({
      agentId: config.id,
      agentName: config.name,
      prompt: task.prompt,
      taskId: task.id,
      sessionId,
    })
    let sha: string | null = null
    try {
      // 独立仓库（例如关联了 Overleaf 的 paper/）先各自提交
      if (config.git?.repo) {
        const nested = path.resolve(workspace, config.git.repo)
        if (await isRepoRoot(nested)) {
          const result = await autoCommit({ repoDir: nested, message })
          if (result.committed) sha = result.sha
          else if (result.detail.includes('失败')) this.note(rt, 'warn', `${config.git.repo}：${result.detail}`)
        }
      }
      const result = await autoCommit({ repoDir: workspace, paths: config.git?.paths, message })
      if (result.committed) sha = result.sha ?? sha
      else if (result.detail.includes('失败')) this.note(rt, 'warn', result.detail)
    } catch (error) {
      this.note(rt, 'warn', `自动提交出错：${error instanceof Error ? error.message : String(error)}`)
    }
    return sha
  }

  interrupt(agentId: string): void {
    const rt = this.runtime(agentId)
    for (const pending of [...this.approvals.values()]) {
      if (pending.request.agentId === agentId) {
        pending.resolve({ id: pending.request.id, behavior: 'deny', message: '用户中断了任务。' })
      }
    }
    rt.handle?.interrupt()
  }

  // ---------- 审批 ----------

  private requestApproval(
    rt: Runtime,
    config: AgentConfig,
    task: TaskRecord,
    ask: ApprovalAsk,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    const request: ApprovalRequest = {
      ...ask,
      id: randomUUID(),
      agentId: config.id,
      agentName: config.name,
      taskId: task.id,
      createdAt: Date.now(),
    }
    return new Promise((resolve) => {
      const finish = (decision: ApprovalDecision): void => {
        if (!this.approvals.delete(request.id)) return
        signal.removeEventListener('abort', onAbort)
        this.deps.emit({ type: 'approval-resolved', id: request.id })
        const stillWaiting = [...this.approvals.values()].some((p) => p.request.agentId === config.id)
        if (!stillWaiting && rt.handle) {
          rt.status = 'running'
          this.emitState(rt)
        }
        resolve(decision)
      }
      const onAbort = (): void => finish({ id: request.id, behavior: 'deny', message: '请求已取消。' })
      this.approvals.set(request.id, { request, resolve: finish })
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      rt.status = 'waiting-approval'
      this.emitState(rt)
      this.deps.emit({ type: 'approval-request', request })
    })
  }

  pendingApprovals(): ApprovalRequest[] {
    return [...this.approvals.values()].map((p) => p.request).sort((a, b) => a.createdAt - b.createdAt)
  }

  resolveApproval(decision: ApprovalDecision): void {
    this.approvals.get(decision.id)?.resolve(decision)
  }
}
