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
// 每个项目（文件夹）有自己的一组 Agent；不同项目的任务可以同时跑，
// 但独占资源（Fusion、嘉立创EDA 各只有一个正在打开的会话）在所有项目之间互斥。

const MAX_TRANSCRIPT_ITEMS = 3000

export interface ManagerSettings {
  apiKey: string | null
  defaultMaxBudgetUsd: number | null
  defaultMaxTurns: number | null
  monthlyBudgetUsd: number | null
  autoCommit: boolean
}

export interface TaskNote {
  level: 'info' | 'warn' | 'error'
  text: string
}

export interface ManagerDeps {
  store: Store
  getSettings(): ManagerSettings
  emit(event: AppEvent): void
  queryFn: QueryFn
  executablePath?: string
  /** 从 SDK 的本机会话记录里读历史消息 */
  loadHistory?(sessionId: string, cwd: string): Promise<ChatItem[]>
  /** 总控 Agent 的自定义工具（dispatch 等） */
  orchestratorServer?(manager: AgentManager, workspace: string, orchestratorId: string): McpServerConfig
  /** 任务启动前的准备（例如装好内置技能、拉起桥接服务）；返回要显示在对话里的提示 */
  prepare?(workspace: string, config: AgentConfig): Promise<TaskNote[]>
  /** 每次工具调用的审计记录 */
  audit?(entry: { ts: number; workspace: string; agentId: string; taskId: string; tool: string; input: unknown }): void
}

interface QueuedTask {
  task: TaskRecord
  settle(task: TaskRecord): void
}

interface Runtime {
  workspace: string
  agentId: string
  status: AgentRuntimeState['status']
  current: TaskRecord | null
  handle: TaskHandle | null
  /** 任务已经出队、还在做启动前的准备 */
  starting: boolean
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

function sameDir(a: string, b: string): boolean {
  const left = path.resolve(a)
  const right = path.resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export class AgentManager {
  private runtimes = new Map<string, Runtime>()
  private approvals = new Map<string, PendingApproval>()

  constructor(private deps: ManagerDeps) {}

  // ---------- 状态 ----------

  private runtime(workspace: string, agentId: string): Runtime {
    const key = `${path.resolve(workspace).toLowerCase()}\n${agentId}`
    let rt = this.runtimes.get(key)
    if (!rt) {
      rt = {
        workspace,
        agentId,
        status: 'idle',
        current: null,
        handle: null,
        starting: false,
        sessionId: this.deps.store.getCurrentSession(workspace, agentId),
        forkNext: false,
        transcript: [],
        transcriptLoaded: false,
        mcp: [],
        sessionAllowed: new Set(),
        queue: [],
        holding: null,
      }
      this.runtimes.set(key, rt)
    }
    return rt
  }

  private stateOf(rt: Runtime): AgentRuntimeState {
    return {
      workspace: rt.workspace,
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

  states(workspace: string): AgentRuntimeState[] {
    return listAgents(workspace).map((detail) => this.stateOf(this.runtime(workspace, detail.config.id)))
  }

  /** 正在运行、准备中或排队的任务数；不传项目就是全部项目。 */
  activeTasks(workspace?: string): number {
    let count = 0
    for (const rt of this.runtimes.values()) {
      if (workspace && !sameDir(rt.workspace, workspace)) continue
      count += rt.queue.length + (rt.handle || rt.starting ? 1 : 0)
    }
    return count
  }

  isBusy(workspace?: string): boolean {
    return this.activeTasks(workspace) > 0
  }

  /** 退出前：停掉所有任务，丢掉内存里的状态。 */
  async reset(): Promise<void> {
    const running: Promise<unknown>[] = []
    for (const rt of this.runtimes.values()) {
      for (const queued of rt.queue.splice(0)) this.finishWithoutRunning(queued, '应用正在关闭，任务取消。')
      if (rt.handle) {
        rt.handle.interrupt()
        rt.handle.interrupt() // 第二次调用直接结束进程
        running.push(rt.handle.done.catch(() => undefined))
      }
    }
    for (const pending of [...this.approvals.values()]) {
      pending.resolve({ id: pending.request.id, behavior: 'deny', message: '应用正在关闭。' })
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
    this.deps.emit({ type: 'chat', workspace: rt.workspace, agentId: rt.agentId, item })
  }

  private appendDelta(rt: Runtime, itemId: string, text: string): void {
    const item = rt.transcript.find((existing) => existing.id === itemId)
    if (item && item.kind === 'assistant') item.text += text
    this.deps.emit({ type: 'chat-delta', workspace: rt.workspace, agentId: rt.agentId, itemId, text })
  }

  private note(rt: Runtime, level: 'info' | 'warn' | 'error', text: string): void {
    this.pushChat(rt, { id: randomUUID(), kind: 'system', level, text, ts: Date.now() })
  }

  async transcript(workspace: string, agentId: string): Promise<ChatItem[]> {
    const rt = this.runtime(workspace, agentId)
    if (!rt.transcriptLoaded && rt.transcript.length === 0 && rt.sessionId && this.deps.loadHistory) {
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

  newSession(workspace: string, agentId: string): void {
    const rt = this.runtime(workspace, agentId)
    if (rt.handle || rt.starting) throw new Error('任务进行中，不能切换会话。先等它结束或中断它。')
    rt.sessionId = null
    rt.forkNext = false
    rt.transcript = []
    rt.transcriptLoaded = true
    rt.mcp = []
    this.deps.store.setCurrentSession(workspace, agentId, null)
    this.deps.emit({ type: 'chat-reset', workspace, agentId })
    this.emitState(rt)
  }

  async resumeSession(workspace: string, agentId: string, sessionId: string, fork: boolean): Promise<void> {
    const rt = this.runtime(workspace, agentId)
    if (rt.handle || rt.starting) throw new Error('任务进行中，不能切换会话。先等它结束或中断它。')
    rt.sessionId = sessionId
    rt.forkNext = fork
    rt.transcript = []
    rt.transcriptLoaded = false
    this.deps.store.setCurrentSession(workspace, agentId, sessionId)
    await this.transcript(workspace, agentId)
    if (fork) this.note(rt, 'info', '已从这个会话分叉：下一条指令会在新分支里继续，原会话保持不变。')
    this.deps.emit({ type: 'chat-reset', workspace, agentId })
    this.emitState(rt)
  }

  // ---------- 任务 ----------

  /** 界面和交接看板用：提交任务后立刻返回。 */
  submit(workspace: string, agentId: string, prompt: string, origin: TaskOrigin): StartTaskResult {
    try {
      const { mode, task } = this.enqueue(workspace, agentId, prompt, origin)
      return { ok: true, mode, taskId: task.id }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 总控 Agent 的 dispatch 用：等任务跑完再返回。 */
  submitAndWait(workspace: string, agentId: string, prompt: string, origin: TaskOrigin): Promise<TaskRecord> {
    return new Promise((resolve, reject) => {
      try {
        this.enqueue(workspace, agentId, prompt, origin, resolve)
      } catch (error) {
        reject(error)
      }
    })
  }

  private enqueue(
    workspace: string,
    agentId: string,
    prompt: string,
    origin: TaskOrigin,
    settle: (task: TaskRecord) => void = () => undefined,
  ): { mode: NonNullable<StartTaskResult['mode']>; task: TaskRecord } {
    const text = prompt.trim()
    if (!text) throw new Error('任务内容不能为空。')
    if (!workspace) throw new Error('还没有打开项目。')
    const detail = getAgent(workspace, agentId)
    if (!detail) throw new Error(`找不到 Agent：${agentId}`)
    if (detail.error) throw new Error(`Agent「${agentId}」的配置文件有错误：${detail.error}`)

    const settings = this.deps.getSettings()
    if (!settings.apiKey) throw new Error('还没有配置 Claude API Key。请先到“设置”里填写。')
    if (settings.monthlyBudgetUsd !== null) {
      // 每月上限管的是整个 API 账户，所以把所有项目的花费加在一起算
      const now = new Date()
      const spent = this.deps.store.costSince(null, new Date(now.getFullYear(), now.getMonth(), 1).getTime())
      if (spent >= settings.monthlyBudgetUsd) {
        throw new Error(
          `本月已花费 $${spent.toFixed(2)}，达到每月预算上限 $${settings.monthlyBudgetUsd.toFixed(2)}。可以在“设置”里调整上限。`,
        )
      }
    }

    const rt = this.runtime(workspace, agentId)
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
    const startsNow = !rt.handle && !rt.starting && rt.queue.length === 1 && this.resourceFree(detail.config, rt)
    this.deps.emit({ type: 'task-updated', task })
    this.pump()
    return { mode: startsNow ? 'started' : 'queued', task }
  }

  /** Fusion 和嘉立创EDA 各自一次只跑一个任务：同名独占资源同一时间只给一个 Agent，跨项目也一样。 */
  private resourceFree(config: AgentConfig, self: Runtime): boolean {
    if (!config.resource) return true
    for (const other of this.runtimes.values()) {
      if (other !== self && other.holding === config.resource) return false
    }
    return true
  }

  private pump(): void {
    for (const rt of this.runtimes.values()) {
      if (rt.handle || rt.starting || rt.queue.length === 0) continue
      const detail = getAgent(rt.workspace, rt.agentId)
      if (!detail || detail.error) {
        for (const queued of rt.queue.splice(0)) this.finishWithoutRunning(queued, 'Agent 配置不可用，任务取消。')
        continue
      }
      if (!this.resourceFree(detail.config, rt)) {
        if (rt.status !== 'queued') {
          rt.status = 'queued'
          this.emitState(rt)
        }
        continue
      }
      const next = rt.queue.shift() as QueuedTask
      void this.run(rt, detail.config, detail.prompt, next)
    }
  }

  private finishWithoutRunning(queued: QueuedTask, reason: string): void {
    const task: TaskRecord = { ...queued.task, status: 'interrupted', endedAt: Date.now(), error: reason }
    this.deps.store.upsertTask(task)
    this.deps.emit({ type: 'task-updated', task })
    queued.settle(task)
  }

  private async run(rt: Runtime, config: AgentConfig, promptFile: string, queued: QueuedTask): Promise<void> {
    const workspace = rt.workspace
    const settings = this.deps.getSettings()
    const cwd = resolveAgentCwd(workspace, config)
    const task: TaskRecord = { ...queued.task, status: 'running', startedAt: Date.now(), agentName: config.name }
    const resume = rt.sessionId
    const fork = Boolean(resume) && rt.forkNext

    rt.current = task
    rt.starting = true
    rt.status = 'running'
    rt.holding = config.resource ?? null
    this.deps.store.upsertTask(task)
    this.deps.emit({ type: 'task-updated', task })
    this.emitState(rt)
    this.pushChat(rt, { id: randomUUID(), kind: 'user', text: task.prompt, ts: Date.now() })
    if (task.origin !== 'user') {
      this.note(rt, 'info', task.origin === 'handoff' ? '这个任务来自交接看板。' : '这个任务由总控 Agent 派发。')
    }

    let outcome: RunOutcome
    try {
      if (this.deps.prepare) {
        try {
          for (const note of await this.deps.prepare(workspace, config)) this.note(rt, note.level, note.text)
        } catch (error) {
          this.note(rt, 'warn', `任务启动前的准备没有完成：${error instanceof Error ? error.message : String(error)}`)
        }
      }
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
              ? { nexus: this.deps.orchestratorServer(this, workspace, config.id) }
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
            this.deps.audit?.({ ts: Date.now(), workspace, agentId: config.id, taskId: task.id, tool, input })
          },
        },
      )
      rt.handle = handle
      rt.starting = false
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
      commitSha = await this.commit(rt, config, task, outcome.sessionId)
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
    rt.starting = false
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

  private async commit(rt: Runtime, config: AgentConfig, task: TaskRecord, sessionId: string | null): Promise<string | null> {
    const workspace = rt.workspace
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

  interrupt(workspace: string, agentId: string): void {
    const rt = this.runtime(workspace, agentId)
    for (const pending of [...this.approvals.values()]) {
      if (pending.request.agentId === agentId && sameDir(pending.request.workspace, workspace)) {
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
      workspace: rt.workspace,
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
        const stillWaiting = [...this.approvals.values()].some(
          (p) => p.request.agentId === config.id && sameDir(p.request.workspace, rt.workspace),
        )
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
