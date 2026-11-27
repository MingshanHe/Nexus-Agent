import { randomUUID } from 'node:crypto'
import type {
  CanUseTool,
  HookCallback,
  McpServerConfig,
  Options,
  PermissionRuleValue,
  PermissionUpdate,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentConfig,
  ApprovalDecision,
  ApprovalRequest,
  ChatItem,
  McpStatus,
  Question,
} from '../../shared/types'
import { firstMatch, formatRule } from './permissions'

// 一个任务 = 一次 query() 调用。每个 Agent 是独立会话（不是别人的子 Agent），
// 下一个任务用 resume 接着同一个会话往下聊，所以单任务的预算和轮数上限可以直接交给 SDK。

export const APP_USER_AGENT = 'nexus-agent/0.1.0'
const MAX_RESULT_CHARS = 6000

/** query() 返回值里我们用到的部分；测试里用假的实现替换。 */
export interface QueryLike extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>
}
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => QueryLike

export type ApprovalAsk = Pick<
  ApprovalRequest,
  'kind' | 'toolName' | 'input' | 'title' | 'description' | 'reason' | 'canAlwaysAllow' | 'alwaysAllowRules' | 'questions'
>

export interface RunCallbacks {
  onChat(item: ChatItem): void
  onDelta(itemId: string, text: string): void
  onInit(info: { sessionId: string; mcp: McpStatus[]; model: string; apiKeySource: string }): void
  requestApproval(ask: ApprovalAsk, signal: AbortSignal): Promise<ApprovalDecision>
  /** 用户选了“本次会话内一直允许”：这些规则之后的任务也自动放行 */
  onSessionAllow(rules: string[]): void
  /** 每一次工具调用都会经过这里（PreToolUse hook），包括自动放行的 */
  onToolCall?(toolName: string, input: Record<string, unknown>): void
}

export interface RunInput {
  agent: AgentConfig
  cwd: string
  /** 追加到 Claude Code 默认系统提示词后面的内容 */
  systemPromptAppend: string
  prompt: string
  resume?: string | null
  fork?: boolean
  apiKey?: string | null
  /** 本次应用运行期间用户已经选过“一直允许”的规则 */
  sessionAllowed: string[]
  maxTurns?: number | null
  maxBudgetUsd?: number | null
  extraMcpServers?: Record<string, McpServerConfig>
  executablePath?: string
  queryFn: QueryFn
}

export interface RunOutcome {
  sessionId: string | null
  subtype: string
  isError: boolean
  interrupted: boolean
  resultText: string
  /** SDK 报告的累计花费（恢复的会话里包含之前的任务） */
  reportedTotalUsd: number
  numTurns: number
  durationMs: number
  error: string | null
}

export interface TaskHandle {
  done: Promise<RunOutcome>
  /** 任务进行中追加一条指令；任务已经收尾时返回 false */
  send(text: string): boolean
  interrupt(): void
}

/** 可以随时往里塞消息的异步队列，作为 query() 的流式输入。 */
export class InputQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  get isClosed(): boolean {
    return this.closed
  }

  push(item: T): boolean {
    if (this.closed) return false
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: item, done: false })
    else this.items.push(item)
    return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift() as T, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
}

export function toSdkMcpServers(agent: AgentConfig): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {}
  for (const [name, spec] of Object.entries(agent.mcp_servers ?? {})) {
    if (spec.type === 'stdio') {
      servers[name] = { type: 'stdio', command: spec.command ?? '', args: spec.args, env: spec.env }
    } else {
      servers[name] = { type: spec.type, url: spec.url ?? '', headers: spec.headers }
    }
  }
  return servers
}

/**
 * 给 Claude Code 子进程的环境变量。
 * 如果本应用是从另一个 Claude Code 会话里启动的（例如在它的终端里跑 npm run dev），
 * 环境里会带着那个会话的身份和网关地址；原样传下去，任务就会记在那个会话的账上，
 * 而不是用这里配置的 API Key。所以这些变量一律不继承。
 */
export function childEnv(
  base: Record<string, string | undefined>,
  apiKey: string | null | undefined,
): Record<string, string | undefined> {
  const insideClaudeCode = Boolean(base.CLAUDECODE || base.CLAUDE_CODE_ENTRYPOINT)
  const hostOnly = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS']
  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(base)) {
    if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW_)/.test(key)) continue
    if (insideClaudeCode && hostOnly.includes(key)) continue
    env[key] = value
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = APP_USER_AGENT
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey
  return env
}

/** 把 Agent 的配置文件翻译成 SDK 参数。 */
export function buildOptions(
  input: RunInput,
  extras: { canUseTool: CanUseTool; preToolUse: HookCallback; abortController: AbortController; stderr: (data: string) => void },
): Options {
  const { agent } = input
  const env = childEnv(process.env, input.apiKey)

  const options: Options = {
    cwd: input.cwd,
    model: agent.model,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: input.systemPromptAppend },
    // 只读工作区自己的 CLAUDE.md 和技能；用户全局设置默认不带进来
    settingSources: agent.setting_sources ?? ['project'],
    // 工具按 Agent 隔离：只挂这份配置里写的 MCP 服务，忽略 .mcp.json 和全局配置
    strictMcpConfig: true,
    mcpServers: { ...toSdkMcpServers(agent), ...(input.extraMcpServers ?? {}) },
    allowedTools: [...new Set([...(agent.allowed_tools ?? []), ...input.sessionAllowed])],
    disallowedTools: agent.disallowed_tools ?? [],
    // 明确用 default：没自动放行的调用全部进 canUseTool，由人审批
    permissionMode: 'default',
    canUseTool: extras.canUseTool,
    hooks: { PreToolUse: [{ hooks: [extras.preToolUse] }] },
    includePartialMessages: true,
    abortController: extras.abortController,
    stderr: extras.stderr,
    env,
  }
  if (agent.always_ask?.length) {
    // ask 规则排在放行规则之前：命中就一定弹审批
    options.settings = { permissions: { ask: agent.always_ask } }
  }
  if (agent.effort) options.effort = agent.effort
  if (agent.skills) options.skills = agent.skills
  if (input.maxTurns) options.maxTurns = input.maxTurns
  if (input.maxBudgetUsd) options.maxBudgetUsd = input.maxBudgetUsd
  if (input.resume) {
    options.resume = input.resume
    if (input.fork) options.forkSession = true
  }
  if (input.executablePath) options.pathToClaudeCodeExecutable = input.executablePath
  return options
}

function clip(text: string, limit = MAX_RESULT_CHARS): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字符）` : text
}

/** tool_result 的内容可能是字符串，也可能是内容块数组。 */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return clip(content)
  if (Array.isArray(content)) {
    const parts = content.map((block) => {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string') return b.text
        if (typeof b.type === 'string') return `[${b.type}]`
      }
      return String(block)
    })
    return clip(parts.join('\n'))
  }
  if (content === undefined || content === null) return ''
  return clip(JSON.stringify(content))
}

const ASSISTANT_ERRORS: Record<string, string> = {
  authentication_failed: 'API Key 无效或已失效，请在“设置”里重新填写。',
  billing_error: 'Claude API 账户的余额或账单有问题，请到 Console 检查。',
  rate_limit: '触发了 API 速率限制，稍后会自动重试。',
  overloaded: 'Claude API 当前过载，稍后会自动重试。',
  invalid_request: '请求被 API 拒绝（invalid_request）。',
  model_not_found: '找不到这个模型，请检查 Agent 配置里的 model。',
  server_error: 'Claude API 服务端错误。',
  max_output_tokens: '单次回复达到了输出上限。',
}

const RESULT_LABELS: Record<string, string> = {
  error_max_turns: '达到了轮数上限，任务停止。',
  error_max_budget_usd: '达到了单任务预算上限，任务停止。',
  error_during_execution: '任务执行中出错或被中断。',
}

type Loose = Record<string, any>

export function startTask(input: RunInput, cb: RunCallbacks): TaskHandle {
  const { agent, cwd } = input
  const abortController = new AbortController()
  const queue = new InputQueue<SDKUserMessage>()
  const stderrTail: string[] = []
  const tools = new Map<string, Extract<ChatItem, { kind: 'tool' }>>()
  /** 流式文本块：API 消息 id -> 还没被完整消息确认的界面条目 id（按出现顺序） */
  const liveText = new Map<string, string[]>()
  let streamingMessageId = ''
  const streamIndexToItem = new Map<number, string>()

  let sessionId: string | null = input.resume && !input.fork ? input.resume : null
  let lastResult: Loose | null = null
  let interrupted = false
  let query: QueryLike | null = null

  const system = (level: 'info' | 'warn' | 'error', text: string): void => {
    cb.onChat({ id: randomUUID(), kind: 'system', level, text, ts: Date.now() })
  }

  const canUseTool: CanUseTool = async (toolName, toolInput, opts) => {
    if (toolName === 'AskUserQuestion') {
      const questions = (Array.isArray(toolInput.questions) ? toolInput.questions : []) as Question[]
      const decision = await cb.requestApproval(
        { kind: 'question', toolName, input: toolInput, questions, canAlwaysAllow: false, alwaysAllowRules: [] },
        opts.signal,
      )
      if (decision.behavior === 'deny') {
        return { behavior: 'deny', message: decision.message || '用户没有回答这个问题。' }
      }
      return { behavior: 'allow', updatedInput: { questions: toolInput.questions, answers: decision.answers ?? {} } }
    }

    const forcedRule = opts.matchedAskRule
      ? formatRule(opts.matchedAskRule)
      : firstMatch(agent.always_ask, toolName, toolInput, cwd)
    const suggested: PermissionRuleValue[] = []
    for (const suggestion of opts.suggestions ?? []) {
      if (suggestion.type === 'addRules' && suggestion.behavior === 'allow') suggested.push(...suggestion.rules)
    }
    // 没有现成建议时，非命令行工具可以按工具名整体放行；命令行不做这种泛化
    const rules: PermissionRuleValue[] =
      suggested.length > 0 ? suggested : toolName === 'Bash' || toolName === 'PowerShell' ? [] : [{ toolName }]
    const canAlwaysAllow = !forcedRule && !opts.suppressAlwaysAllowRule && rules.length > 0

    const decision = await cb.requestApproval(
      {
        kind: 'tool',
        toolName,
        input: toolInput,
        title: opts.title,
        description: opts.description,
        reason: forcedRule ? `配置要求每次确认（${forcedRule}）` : opts.decisionReason,
        canAlwaysAllow,
        alwaysAllowRules: canAlwaysAllow ? rules.map(formatRule) : [],
      },
      opts.signal,
    )

    if (decision.behavior === 'deny') {
      return { behavior: 'deny', message: decision.message?.trim() || '用户拒绝了这次操作。' }
    }
    if (decision.behavior === 'allow_session' && canAlwaysAllow) {
      cb.onSessionAllow(rules.map(formatRule))
      const update: PermissionUpdate = { type: 'addRules', rules, behavior: 'allow', destination: 'session' }
      return { behavior: 'allow', updatedInput: toolInput, updatedPermissions: [update] }
    }
    return { behavior: 'allow', updatedInput: toolInput }
  }

  // 必须每次都执行的检查放在 PreToolUse hook：它对自动放行的调用同样生效。
  const preToolUse: HookCallback = async (hookInput) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return {}
    const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>
    cb.onToolCall?.(hookInput.tool_name, toolInput)
    const rule = firstMatch(agent.always_ask, hookInput.tool_name, toolInput, cwd)
    if (rule) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: `配置要求每次确认（${rule}）`,
        },
      }
    }
    return {}
  }

  const handleAssistant = (msg: Loose): void => {
    const nested = msg.parent_tool_use_id !== null && msg.parent_tool_use_id !== undefined
    const messageId: string = msg.message?.id ?? ''
    const blocks: Loose[] = Array.isArray(msg.message?.content) ? msg.message.content : []
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        if (nested || block.text.trim() === '') continue
        const pending = liveText.get(messageId)
        const id = pending?.shift() ?? randomUUID()
        cb.onChat({ id, kind: 'assistant', text: block.text, ts: Date.now(), streaming: false })
      } else if (block.type === 'tool_use' && typeof block.id === 'string') {
        const item: Extract<ChatItem, { kind: 'tool' }> = {
          id: block.id,
          kind: 'tool',
          name: String(block.name),
          input: block.input,
          status: 'running',
          ts: Date.now(),
          ...(nested ? { nested: true } : {}),
        }
        tools.set(block.id, item)
        cb.onChat(item)
      }
    }
    if (typeof msg.error === 'string' && !nested) {
      system('error', ASSISTANT_ERRORS[msg.error] ?? `模型调用出错：${msg.error}`)
    }
  }

  const handleUser = (msg: Loose): void => {
    const content = msg.message?.content
    if (!Array.isArray(content)) return
    for (const block of content as Loose[]) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const existing = tools.get(block.tool_use_id)
      if (!existing) continue
      const updated = {
        ...existing,
        status: block.is_error ? ('error' as const) : ('done' as const),
        result: toolResultText(block.content),
      }
      tools.set(block.tool_use_id, updated)
      cb.onChat(updated)
    }
  }

  const handleStreamEvent = (msg: Loose): void => {
    if (msg.parent_tool_use_id) return
    const event: Loose = msg.event ?? {}
    if (event.type === 'message_start') {
      streamingMessageId = event.message?.id ?? ''
      streamIndexToItem.clear()
    } else if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
      const id = randomUUID()
      streamIndexToItem.set(event.index, id)
      const pending = liveText.get(streamingMessageId) ?? []
      pending.push(id)
      liveText.set(streamingMessageId, pending)
      cb.onChat({ id, kind: 'assistant', text: '', ts: Date.now(), streaming: true })
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      const id = streamIndexToItem.get(event.index)
      if (id && typeof event.delta.text === 'string') cb.onDelta(id, event.delta.text)
    }
  }

  const handleSystem = (msg: Loose): void => {
    if (msg.subtype === 'init') {
      sessionId = msg.session_id ?? sessionId
      const mcp: McpStatus[] = (msg.mcp_servers ?? []).map((s: Loose) => ({ name: String(s.name), status: String(s.status) }))
      cb.onInit({
        sessionId: String(msg.session_id),
        mcp,
        model: String(msg.model ?? agent.model),
        apiKeySource: String(msg.apiKeySource ?? 'none'),
      })
      for (const server of mcp) {
        if (server.status !== 'connected' && server.status !== 'pending') {
          system('warn', `MCP 服务「${server.name}」没有连上（${server.status}）。相关工具在这次任务里不可用。`)
        }
      }
    } else if (msg.subtype === 'status' && msg.status === 'compacting') {
      system('info', '对话太长，正在压缩上下文…')
    } else if (msg.subtype === 'api_retry') {
      system('warn', `API 调用失败（${msg.error ?? '未知'}），第 ${msg.attempt}/${msg.max_retries} 次重试…`)
    }
  }

  const handle = (msg: SDKMessage): void => {
    const loose = msg as Loose
    if (typeof loose.session_id === 'string' && loose.session_id) sessionId = loose.session_id
    switch (msg.type) {
      case 'system':
        handleSystem(loose)
        break
      case 'assistant':
        handleAssistant(loose)
        break
      case 'user':
        handleUser(loose)
        break
      case 'stream_event':
        handleStreamEvent(loose)
        break
      case 'result':
        lastResult = loose
        // 没有排队中的追加指令了：关掉输入流，query() 随之结束
        if ((loose.queued_turn_count ?? 0) === 0) queue.close()
        break
      default:
        break
    }
  }

  const run = async (): Promise<RunOutcome> => {
    let thrown: string | null = null
    try {
      const options = buildOptions(input, {
        canUseTool,
        preToolUse,
        abortController,
        stderr: (data) => {
          stderrTail.push(data.trimEnd())
          if (stderrTail.length > 30) stderrTail.shift()
        },
      })
      queue.push(userMessage(input.prompt))
      query = input.queryFn({ prompt: queue, options })
      for await (const msg of query) handle(msg)
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error)
    } finally {
      queue.close()
    }

    // 没等到完整结果就结束的工具调用，不能一直显示“运行中”
    for (const item of tools.values()) {
      if (item.status === 'running') cb.onChat({ ...item, status: 'error', result: item.result ?? '（任务结束时这次调用还没有返回）' })
    }

    const result = lastResult as Loose | null
    if (result) {
      const subtype = String(result.subtype ?? 'success')
      const isError = Boolean(result.is_error) || subtype !== 'success'
      const errors: string[] = Array.isArray(result.errors) ? result.errors.map(String) : []
      const resultText = typeof result.result === 'string' ? result.result : ''
      // API 层面的失败（例如 Key 无效）会以 subtype=success、is_error=true 的结果出现，说明在 result 文本里
      const label = subtype === 'success' ? resultText || 'API 调用失败。' : (RESULT_LABELS[subtype] ?? subtype)
      return {
        sessionId,
        subtype,
        isError,
        interrupted,
        resultText,
        reportedTotalUsd: Number(result.total_cost_usd ?? 0),
        numTurns: Number(result.num_turns ?? 0),
        durationMs: Number(result.duration_ms ?? 0),
        error: isError ? [label, ...errors].join(' ') : null,
      }
    }
    const tail = stderrTail.filter(Boolean).slice(-6).join('\n')
    return {
      sessionId,
      subtype: interrupted ? 'interrupted' : 'error_no_result',
      isError: true,
      interrupted,
      resultText: '',
      reportedTotalUsd: 0,
      numTurns: 0,
      durationMs: 0,
      error: interrupted ? '任务已中断。' : [thrown ?? 'Agent 进程没有返回结果就退出了。', tail].filter(Boolean).join('\n'),
    }
  }

  return {
    done: run(),
    send(text: string): boolean {
      return queue.push(userMessage(text))
    },
    interrupt(): void {
      if (interrupted) {
        abortController.abort()
        return
      }
      interrupted = true
      const current = query
      if (!current) {
        abortController.abort()
        return
      }
      current.interrupt().catch(() => abortController.abort())
      // 礼貌中断后 8 秒还没收尾，就直接结束进程
      setTimeout(() => {
        if (!queue.isClosed) abortController.abort()
      }, 8000).unref()
    },
  }
}
