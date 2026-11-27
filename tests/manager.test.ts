import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAgent, saveAgent } from '../src/main/agents/config'
import { AgentManager, type ManagerDeps, type ManagerSettings } from '../src/main/agents/manager'
import { buildOptions, childEnv, type QueryFn, type QueryLike } from '../src/main/agents/runner'
import { git } from '../src/main/git/git'
import { Store } from '../src/main/store/db'
import { scaffoldWorkspace } from '../src/main/workspace/scaffold'
import type { AppEvent, ApprovalRequest, ChatItem, TaskRecord } from '../src/shared/types'

// 用假的 query() 驱动调度核心：不启动 Claude Code，也不调用 API。

process.env.GIT_AUTHOR_NAME = 'Nexus Test'
process.env.GIT_AUTHOR_EMAIL = 'test@example.invalid'
process.env.GIT_COMMITTER_NAME = 'Nexus Test'
process.env.GIT_COMMITTER_EMAIL = 'test@example.invalid'

const DEFAULTS = path.resolve('resources/defaults')

interface ScriptContext {
  options: Options
  /** 等下一条用户消息（第一条是任务本身，之后是追加的指令） */
  nextUserText(): Promise<string | null>
  interrupted: Promise<void>
}
type Script = (ctx: ScriptContext) => AsyncGenerator<Record<string, unknown>>

function fakeQuery(script: Script, calls: Options[] = [], modeLog: string[] = []): QueryFn {
  return ({ prompt, options }) => {
    calls.push(options ?? {})
    const input = prompt[Symbol.asyncIterator]()
    let interrupt: () => void = () => undefined
    const interrupted = new Promise<void>((resolve) => {
      interrupt = resolve
    })
    const generator = script({
      options: options ?? {},
      interrupted,
      nextUserText: async () => {
        const next = await input.next()
        if (next.done) return null
        return String((next.value as SDKUserMessage).message.content)
      },
    }) as unknown as AsyncGenerator<SDKMessage>
    return Object.assign(generator, {
      interrupt: async () => {
        interrupt()
      },
      setPermissionMode: async (mode: string) => {
        if (mode === 'auto' && modeLog.includes('no-auto')) throw new Error('auto mode unavailable')
        modeLog.push(mode)
        return { mode }
      },
    }) as QueryLike
  }
}

const init = (sessionId: string, mcp: Array<{ name: string; status: string }> = []) => ({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  mcp_servers: mcp,
  model: 'claude-test',
  apiKeySource: 'ANTHROPIC_API_KEY',
})
const say = (sessionId: string, text: string, id = 'msg1') => ({
  type: 'assistant',
  session_id: sessionId,
  parent_tool_use_id: null,
  message: { id, content: [{ type: 'text', text }] },
})
const result = (sessionId: string, total: number, extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '做完了',
  total_cost_usd: total,
  num_turns: 2,
  duration_ms: 1200,
  session_id: sessionId,
  queued_turn_count: 0,
  ...extra,
})

let tmp: string
let workspace: string
let store: Store
let events: AppEvent[]
let settings: ManagerSettings

function makeManager(queryFn: QueryFn, extra: Partial<ManagerDeps> = {}): AgentManager {
  return new AgentManager({
    store,
    getSettings: () => settings,
    emit: (event) => events.push(event),
    queryFn,
    ...extra,
  })
}

function tasks(): TaskRecord[] {
  const latest = new Map<string, TaskRecord>()
  for (const event of events) if (event.type === 'task-updated') latest.set(event.task.id, event.task)
  return [...latest.values()]
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 8000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const finished = (count: number) => (): boolean =>
  tasks().filter((t) => t.status !== 'queued' && t.status !== 'running').length >= count

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mgr-'))
  workspace = path.join(tmp, 'robot')
  await scaffoldWorkspace(workspace, DEFAULTS)
  await git(workspace, ['add', '-A'])
  await git(workspace, ['commit', '-m', 'init'])
  store = new Store(path.join(tmp, 'nexus.db'))
  events = []
  settings = { apiKey: 'test-key', defaultMaxBudgetUsd: null, defaultMaxTurns: null, monthlyBudgetUsd: null, autoCommit: true }
})
afterEach(() => {
  store.close()
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('配置到 SDK 参数的翻译', () => {
  it('工具隔离、审批模式和上限都按配置传给 SDK', async () => {
    const calls: Options[] = []
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        await ctx.nextUserText()
        yield init('s1')
        yield result('s1', 0.1)
      }, calls),
    )
    settings.defaultMaxBudgetUsd = 5
    expect(manager.submit(workspace, 'mech', '量一下支架孔距', 'user')).toMatchObject({ ok: true, mode: 'started' })
    await until(finished(1), '任务结束')

    const options = calls[0]
    expect(options.cwd).toBe(workspace)
    expect(options.model).toBe('claude-opus-5-5')
    expect(options.permissionMode).toBe('default')
    expect(options.strictMcpConfig).toBe(true)
    expect(options.settingSources).toEqual(['project'])
    expect(options.mcpServers).toEqual({ fusion: { type: 'http', url: 'http://127.0.0.1:27182/mcp', headers: undefined } })
    expect(options.allowedTools).toEqual(expect.arrayContaining(['Read', 'mcp__fusion__fusion_mcp_read', 'Edit(/mech/**)']))
    expect(options.settings).toEqual({ permissions: { ask: ['mcp__fusion__fusion_mcp_execute', 'mcp__fusion__fusion_mcp_update'] } })
    expect(options.maxBudgetUsd).toBe(5)
    expect(options.resume).toBeUndefined()
    expect(options.env?.ANTHROPIC_API_KEY).toBe('test-key')
    expect(typeof options.canUseTool).toBe('function')
    const prompt = options.systemPrompt as { type: string; preset: string; append: string }
    expect(prompt).toMatchObject({ type: 'preset', preset: 'claude_code' })
    expect(prompt.append).toContain('机械 Agent')
    expect(prompt.append).toContain('spec/interfaces.md')
  })

  it('电子 Agent 读用户级技能；总控只在有工厂函数时才拿到 dispatch 服务', () => {
    const base = {
      cwd: workspace,
      systemPromptAppend: '',
      prompt: 'x',
      sessionAllowed: ['Bash(pio run)'],
      queryFn: fakeQuery(async function* () {}),
    }
    const extras = {
      canUseTool: async () => ({ behavior: 'deny' as const, message: '' }),
      preToolUse: async () => ({}),
      abortController: new AbortController(),
      stderr: () => undefined,
    }
    const elec = buildOptions(
      { ...base, agent: { id: 'elec', name: '电子', model: 'm', setting_sources: ['user', 'project'], skills: ['easyeda-api'], allowed_tools: ['Read'] }, resume: 's9', fork: true },
      extras,
    )
    expect(elec.settingSources).toEqual(['user', 'project'])
    expect(elec.skills).toEqual(['easyeda-api'])
    expect(elec.allowedTools).toEqual(['Read', 'Bash(pio run)'])
    expect(elec.resume).toBe('s9')
    expect(elec.forkSession).toBe(true)
    expect(elec.settings).toBeUndefined()
    expect(elec.mcpServers).toEqual({})
  })
})

describe('子进程环境变量', () => {
  it('不继承宿主 Claude Code 会话的身份和网关，只用这里配置的 Key', () => {
    const env = childEnv(
      {
        PATH: 'x',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'desktop',
        CLAUDE_CODE_SESSION_ID: 'host',
        CLAUDE_AGENT_SDK_VERSION: '0',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234',
        ANTHROPIC_AUTH_TOKEN: 'host-token',
        ANTHROPIC_API_KEY: 'from-env',
      },
      'from-app',
    )
    expect(env).toEqual({ PATH: 'x', ANTHROPIC_API_KEY: 'from-app', CLAUDE_AGENT_SDK_CLIENT_APP: 'nexus-agent/0.1.0' })
    // 正常启动时，用户自己配的网关地址保留
    const plain = childEnv({ PATH: 'x', ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_API_KEY: 'from-env' }, null)
    expect(plain).toMatchObject({ ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_API_KEY: 'from-env' })
  })
})

describe('任务生命周期', () => {
  it('流式回复、工具调用、入库、自动提交', async () => {
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        await ctx.nextUserText()
        yield init('s1', [{ name: 'fusion', status: 'connected' }])
        yield { type: 'stream_event', session_id: 's1', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg1' } } }
        yield { type: 'stream_event', session_id: 's1', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } }
        yield { type: 'stream_event', session_id: 's1', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我先' } } }
        yield { type: 'stream_event', session_id: 's1', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '写笔记' } } }
        yield say('s1', '我先写笔记')
        yield {
          type: 'assistant',
          session_id: 's1',
          parent_tool_use_id: null,
          message: { id: 'msg1', content: [{ type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: 'mech/bracket.md', content: '# 支架' } }] },
        }
        fs.writeFileSync(path.join(workspace, 'mech/bracket.md'), '# 支架\n')
        fs.writeFileSync(path.join(workspace, 'elec/stray.md'), '别的 Agent 的改动\n')
        yield { type: 'user', session_id: 's1', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } }
        yield result('s1', 0.42)
      }),
    )
    manager.submit(workspace, 'mech', '画一个支架并记笔记', 'user')
    await until(finished(1), '任务结束')

    const [task] = tasks()
    expect(task).toMatchObject({ status: 'done', sessionId: 's1', numTurns: 2, resultText: '做完了', agentId: 'mech' })
    expect(task.costUsd).toBeCloseTo(0.42)
    expect(task.commitSha).toMatch(/^[0-9a-f]{7,}$/)
    expect(store.getTask(task.id)?.status).toBe('done')
    expect(store.getCurrentSession(workspace, 'mech')).toBe('s1')

    const transcript = await manager.transcript(workspace, 'mech')
    const kinds = transcript.map((i) => i.kind)
    expect(kinds).toEqual(['user', 'assistant', 'tool', 'result'])
    const assistant = transcript[1] as Extract<ChatItem, { kind: 'assistant' }>
    expect(assistant).toMatchObject({ text: '我先写笔记', streaming: false })
    expect(transcript[2]).toMatchObject({ kind: 'tool', name: 'Write', status: 'done', result: 'ok' })
    // 流式增量和最终消息落在同一个条目上
    const deltas = events.filter((e) => e.type === 'chat-delta')
    expect(deltas).toHaveLength(2)
    expect(deltas.every((e) => e.type === 'chat-delta' && e.itemId === assistant.id)).toBe(true)

    const log = await git(workspace, ['log', '-1', '--format=%s', '--name-only'])
    expect(log.output).toContain('[mech] 画一个支架并记笔记')
    expect(log.output).toContain('mech/bracket.md')
    // 机械 Agent 的提交不带走别人目录里的改动
    expect(log.output).not.toContain('elec/stray.md')

    const state = manager.states(workspace).find((s) => s.agentId === 'mech')
    expect(state).toMatchObject({ status: 'idle', sessionId: 's1', mcp: [{ name: 'fusion', status: 'connected' }] })
  })

  it('下一个任务恢复同一个会话，花费按累计值的差计算', async () => {
    const calls: Options[] = []
    let total = 0
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        await ctx.nextUserText()
        yield init('s1')
        total += 0.3
        yield result('s1', total)
      }, calls),
    )
    manager.submit(workspace, 'paper', '写相关工作', 'user')
    await until(finished(1), '第一个任务')
    manager.submit(workspace, 'paper', '补一段', 'user')
    await until(finished(2), '第二个任务')

    expect(calls[1].resume).toBe('s1')
    const costs = tasks().map((t) => t.costUsd)
    expect(costs[0]).toBeCloseTo(0.3)
    expect(costs[1]).toBeCloseTo(0.3)
    expect(store.costSummary(workspace).totalUsd).toBeCloseTo(0.6)

    manager.newSession(workspace, 'paper')
    manager.submit(workspace, 'paper', '另起一个话题', 'user')
    await until(finished(3), '第三个任务')
    expect(calls[2].resume).toBeUndefined()
  })

  it('分叉：恢复时带 forkSession，新会话记住父会话', async () => {
    const calls: Options[] = []
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        await ctx.nextUserText()
        const forked = ctx.options.forkSession === true
        yield init(forked ? 's1-fork' : 's1')
        yield result(forked ? 's1-fork' : 's1', forked ? 0.5 : 0.2)
      }, calls),
    )
    manager.submit(workspace, 'paper', '第一版', 'user')
    await until(finished(1), '第一个任务')
    await manager.resumeSession(workspace, 'paper', 's1', true)
    manager.submit(workspace, 'paper', '换个写法重试', 'user')
    await until(finished(2), '分叉后的任务')

    expect(calls[1]).toMatchObject({ resume: 's1', forkSession: true })
    const sessions = store.listSessions(workspace, 'paper')
    expect(sessions.find((s) => s.sessionId === 's1-fork')).toMatchObject({ parentSessionId: 's1', current: true })
    // 分叉接着父会话的累计值往上报：0.5 - 0.2
    expect(tasks()[1].costUsd).toBeCloseTo(0.3)
  })

  it('出错和超预算的结果如实记录', async () => {
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        await ctx.nextUserText()
        yield init('s1')
        yield result('s1', 2, { subtype: 'error_max_budget_usd', is_error: true, result: undefined })
      }),
    )
    manager.submit(workspace, 'firmware', '重构整个固件', 'user')
    await until(finished(1), '任务结束')
    const [task] = tasks()
    expect(task.status).toBe('error')
    expect(task.error).toContain('预算上限')
    expect(task.costUsd).toBeCloseTo(2)
  })

  it('Key 无效：结果是 subtype=success 但 is_error=true，按出错记录并带上原因', async () => {
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        await ctx.nextUserText()
        yield init('s1')
        yield { ...say('s1', 'Invalid API key · Fix external API key'), error: 'authentication_failed' }
        yield result('s1', 0, { is_error: true, result: 'Invalid API key · Fix external API key' })
      }),
    )
    manager.submit(workspace, 'paper', '写摘要', 'user')
    await until(finished(1), '任务结束')
    expect(tasks()[0]).toMatchObject({ status: 'error', error: 'Invalid API key · Fix external API key', costUsd: 0 })
    const notes = (await manager.transcript(workspace, 'paper')).flatMap((i) => (i.kind === 'system' ? [i.text] : []))
    expect(notes.some((text) => text.includes('API Key 无效'))).toBe(true)
  })

  it('进程没返回结果就退出：标成出错，不会卡住', async () => {
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        await ctx.nextUserText()
        throw new Error('spawn claude ENOENT')
      }),
    )
    manager.submit(workspace, 'firmware', '编译', 'user')
    await until(finished(1), '任务结束')
    expect(tasks()[0]).toMatchObject({ status: 'error' })
    expect(tasks()[0].error).toContain('ENOENT')
    expect(manager.states(workspace).find((s) => s.agentId === 'firmware')?.status).toBe('idle')
  })
})

describe('审批', () => {
  const approvals = (): ApprovalRequest[] =>
    events.flatMap((e) => (e.type === 'approval-request' ? [e.request] : []))

  it('没放行的调用等人批；拒绝的说明传回给 Agent；“一直允许”带到下一个任务', async () => {
    const calls: Options[] = []
    const outcomes: unknown[] = []
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        const text = await ctx.nextUserText()
        yield init('s1')
        if (text === '第一步') {
          const signal = new AbortController().signal
          outcomes.push(
            await ctx.options.canUseTool?.('Bash', { command: 'pio run -e esp32dev -t upload' }, { signal, toolUseID: 'a', requestId: 'r1' }),
          )
          outcomes.push(
            await ctx.options.canUseTool?.('Bash', { command: 'pio test -e esp32dev' }, {
              signal,
              toolUseID: 'b',
              requestId: 'r2',
              suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pio test:*' }], behavior: 'allow', destination: 'localSettings' }],
            }),
          )
        }
        yield result('s1', 0.1)
      }, calls),
    )

    manager.submit(workspace, 'firmware', '第一步', 'user')
    await until(() => approvals().length === 1, '第一个审批')
    const upload = approvals()[0]
    // 烧录命中 always_ask：不能选“一直允许”
    expect(upload).toMatchObject({ agentId: 'firmware', toolName: 'Bash', kind: 'tool', canAlwaysAllow: false })
    expect(upload.reason).toContain('每次确认')
    expect(manager.states(workspace).find((s) => s.agentId === 'firmware')?.status).toBe('waiting-approval')
    expect(manager.pendingApprovals()).toHaveLength(1)
    manager.resolveApproval({ id: upload.id, behavior: 'deny', message: '板子还没接电源' })

    await until(() => approvals().length === 2, '第二个审批')
    const test = approvals()[1]
    expect(test).toMatchObject({ canAlwaysAllow: true, alwaysAllowRules: ['Bash(pio test:*)'] })
    manager.resolveApproval({ id: test.id, behavior: 'allow_session' })
    await until(finished(1), '任务结束')

    expect(outcomes[0]).toEqual({ behavior: 'deny', message: '板子还没接电源' })
    expect(outcomes[1]).toMatchObject({
      behavior: 'allow',
      updatedInput: { command: 'pio test -e esp32dev' },
      updatedPermissions: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'pio test:*' }] }],
    })
    expect(manager.pendingApprovals()).toHaveLength(0)

    manager.submit(workspace, 'firmware', '第二步', 'user')
    await until(finished(2), '第二个任务')
    expect(calls[1].allowedTools).toContain('Bash(pio test:*)')
    expect(calls[0].allowedTools).not.toContain('Bash(pio test:*)')
  })

  it('PreToolUse hook 对命中 always_ask 的调用要求确认，其余放过', async () => {
    let hookResults: unknown[] = []
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        await ctx.nextUserText()
        yield init('s1')
        const hook = ctx.options.hooks?.PreToolUse?.[0].hooks[0]
        const call = (tool_name: string, tool_input: unknown) =>
          hook?.({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'x', session_id: 's1', transcript_path: '', cwd: workspace } as never, 'x', { signal: new AbortController().signal })
        hookResults = [
          await call('mcp__fusion__fusion_mcp_update', { script: 'x' }),
          await call('mcp__fusion__fusion_mcp_read', {}),
        ]
        yield result('s1', 0.1)
      }),
    )
    manager.submit(workspace, 'mech', '改一个尺寸', 'user')
    await until(finished(1), '任务结束')
    expect(hookResults[0]).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } })
    expect(hookResults[1]).toEqual({})
  })

  it('AskUserQuestion：把用户的回答按 SDK 要求的格式交回去', async () => {
    let answer: unknown
    const questions = [{ question: '用哪个引脚？', header: '引脚', options: [{ label: 'GPIO4' }, { label: 'GPIO5' }], multiSelect: false }]
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        await ctx.nextUserText()
        yield init('s1')
        answer = await ctx.options.canUseTool?.('AskUserQuestion', { questions }, { signal: new AbortController().signal, toolUseID: 'q', requestId: 'r' })
        yield result('s1', 0.1)
      }),
    )
    manager.submit(workspace, 'elec', '给 IMU 分配中断引脚', 'user')
    await until(() => approvals().length === 1, '问题')
    expect(approvals()[0]).toMatchObject({ kind: 'question', canAlwaysAllow: false, questions })
    manager.resolveApproval({ id: approvals()[0].id, behavior: 'allow', answers: { '用哪个引脚？': 'GPIO5' } })
    await until(finished(1), '任务结束')
    expect(answer).toEqual({ behavior: 'allow', updatedInput: { questions, answers: { '用哪个引脚？': 'GPIO5' } } })
  })
})

describe('调度', () => {
  it('没有 Key、达到每月上限、配置有错时不启动', async () => {
    const manager = makeManager(fakeQuery(async function* () {}))
    settings.apiKey = null
    expect(manager.submit(workspace, 'mech', 'x', 'user')).toMatchObject({ ok: false })
    settings.apiKey = 'test-key'
    expect(manager.submit(workspace, 'nobody', 'x', 'user').error).toContain('找不到')
    expect(manager.submit(workspace, 'mech', '   ', 'user').ok).toBe(false)

    store.upsertTask({
      id: 'old', workspace, agentId: 'mech', agentName: '机械', sessionId: null, prompt: 'p', origin: 'user', status: 'done',
      startedAt: Date.now(), endedAt: Date.now(), costUsd: 12, numTurns: 1, durationMs: 1, resultSubtype: 'success', resultText: null, commitSha: null, error: null,
    })
    settings.monthlyBudgetUsd = 10
    expect(manager.submit(workspace, 'mech', 'x', 'user').error).toContain('每月预算上限')
    settings.monthlyBudgetUsd = 20
    fs.writeFileSync(path.join(workspace, '.nexus/agents/mech.yaml'), 'name: 机械\n')
    expect(manager.submit(workspace, 'mech', 'x', 'user').error).toContain('配置文件有错误')
    expect(events.filter((e) => e.type === 'task-updated')).toHaveLength(0)
  })

  it('同一个独占资源一次只跑一个任务；互不相干的 Agent 可以同时跑', async () => {
    saveAgent(workspace, { id: 'mech2', name: '机械二号', model: 'm', resource: 'fusion' }, '')
    const running = new Set<string>()
    let peakFusion = 0
    let peakAll = 0
    const release: Record<string, () => void> = {}
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        await ctx.nextUserText()
        const id = /id：(\S+?)）/.exec((ctx.options.systemPrompt as { append: string }).append)?.[1] ?? '?'
        yield init(`s-${id}`)
        running.add(id)
        peakAll = Math.max(peakAll, running.size)
        peakFusion = Math.max(peakFusion, [...running].filter((r) => r.startsWith('mech')).length)
        await new Promise<void>((resolve) => {
          release[id] = resolve
        })
        running.delete(id)
        yield result(`s-${id}`, 0.1)
      }),
    )
    expect(manager.submit(workspace, 'mech', '任务 A', 'user').mode).toBe('started')
    expect(manager.submit(workspace, 'mech2', '任务 B', 'user').mode).toBe('queued')
    expect(manager.submit(workspace, 'paper', '任务 C', 'user').mode).toBe('started')
    await until(() => Boolean(release.mech && release.paper), '两个任务都在跑')
    expect(manager.states(workspace).find((s) => s.agentId === 'mech2')).toMatchObject({ status: 'queued', queueLength: 1 })
    expect(release.mech2).toBeUndefined()

    release.mech()
    await until(() => Boolean(release.mech2), '排队的任务开始')
    release.mech2()
    release.paper()
    await until(finished(3), '全部结束')
    expect(peakFusion).toBe(1)
    expect(peakAll).toBe(2)
  })

  it('任务进行中追加指令；中断后标成已中断', async () => {
    const seen: string[] = []
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        seen.push((await ctx.nextUserText()) ?? '')
        yield init('s1')
        const extra = await Promise.race([ctx.nextUserText(), ctx.interrupted.then(() => 'INTERRUPTED')])
        seen.push(extra ?? '')
        if (extra === 'INTERRUPTED') {
          yield result('s1', 0.05, { subtype: 'error_during_execution', is_error: true })
          return
        }
        yield result('s1', 0.2)
      }),
    )
    manager.submit(workspace, 'paper', '写摘要', 'user')
    await until(() => seen.length === 1 && manager.states(workspace).some((s) => s.agentId === 'paper' && s.status === 'running'), '开始运行')
    expect(manager.submit(workspace, 'paper', '控制在 150 词以内', 'user')).toMatchObject({ ok: true, mode: 'appended' })
    await until(finished(1), '任务结束')
    expect(seen).toEqual(['写摘要', '控制在 150 词以内'])
    expect(tasks()).toHaveLength(1)
    expect((await manager.transcript(workspace, 'paper')).filter((i) => i.kind === 'user')).toHaveLength(2)

    seen.length = 0
    manager.submit(workspace, 'paper', '再写一版', 'user')
    await until(() => seen.length === 1 && manager.states(workspace).some((s) => s.agentId === 'paper' && s.status === 'running'), '第二个任务开始')
    manager.interrupt(workspace, 'paper')
    await until(finished(2), '中断结束')
    expect(tasks()[1].status).toBe('interrupted')
  })

  it('总控派发：等被派的 Agent 做完再返回结果', async () => {
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        await ctx.nextUserText()
        yield init('s-fw')
        yield result('s-fw', 0.3, { result: '引脚已更新，编译通过' })
      }),
    )
    const record = await manager.submitAndWait(workspace, 'firmware', '按交接单更新 IMU 引脚', 'orchestrator')
    expect(record).toMatchObject({ status: 'done', origin: 'orchestrator', resultText: '引脚已更新，编译通过' })
    expect(record.costUsd).toBeCloseTo(0.3)
    await expect(manager.submitAndWait(workspace, 'nobody', 'x', 'orchestrator')).rejects.toThrow()
  })
})

describe('多个项目', () => {
  let second: string
  beforeEach(async () => {
    second = path.join(tmp, 'glider')
    await scaffoldWorkspace(second, DEFAULTS, 'blank')
    saveAgent(second, { id: 'mech', name: '滑翔机机械', model: 'm', resource: 'fusion' }, '另一个项目的机械 Agent')
    saveAgent(second, { id: 'notes', name: '笔记', model: 'm' }, '')
  })

  it('各项目有自己的 Agent、会话和对话记录，事件带着项目路径', async () => {
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        await ctx.nextUserText()
        const session = ctx.options.cwd === second ? 's-glider' : 's-robot'
        yield init(session)
        yield say(session, ctx.options.cwd === second ? '滑翔机' : '机器人')
        yield result(session, 0.2)
      }),
    )
    expect(manager.states(second).map((s) => s.agentId)).toEqual(['mech', 'notes'])
    expect(manager.states(workspace).map((s) => s.agentId)).toContain('firmware')
    manager.submit(workspace, 'mech', '画机器人支架', 'user')
    await until(finished(1), '第一个项目的任务')
    manager.submit(second, 'mech', '画机翼', 'user')
    await until(finished(2), '第二个项目的任务')

    expect(store.getCurrentSession(workspace, 'mech')).toBe('s-robot')
    expect(store.getCurrentSession(second, 'mech')).toBe('s-glider')
    const robot = (await manager.transcript(workspace, 'mech')).flatMap((i) => (i.kind === 'assistant' ? [i.text] : []))
    const glider = (await manager.transcript(second, 'mech')).flatMap((i) => (i.kind === 'assistant' ? [i.text] : []))
    expect(robot).toEqual(['机器人'])
    expect(glider).toEqual(['滑翔机'])
    const chats = events.flatMap((e) => (e.type === 'chat' ? [e.workspace] : []))
    expect(new Set(chats)).toEqual(new Set([workspace, second]))
    expect(store.costSummary(workspace).totalUsd).toBeCloseTo(0.2)
    expect(store.costSummary(second).totalUsd).toBeCloseTo(0.2)
    expect(store.costSummary(second).allProjectsMonthUsd).toBeCloseTo(0.4)
    expect(tasks().map((t) => t.workspace)).toEqual([workspace, second])
  })

  it('不同项目可以同时跑，但 Fusion 这样的独占资源跨项目也只给一个', async () => {
    const release: Record<string, () => void> = {}
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        await ctx.nextUserText()
        const id = /id：(\S+?)）/.exec((ctx.options.systemPrompt as { append: string }).append)?.[1] ?? '?'
        const key = `${ctx.options.cwd === second ? 'glider' : 'robot'}:${id}`
        yield init(`s-${key}`)
        await new Promise<void>((resolve) => {
          release[key] = resolve
        })
        yield result(`s-${key}`, 0.1)
      }),
    )
    expect(manager.submit(workspace, 'mech', 'A', 'user').mode).toBe('started')
    expect(manager.submit(second, 'mech', 'B', 'user').mode).toBe('queued')
    expect(manager.submit(second, 'notes', 'C', 'user').mode).toBe('started')
    await until(() => Boolean(release['robot:mech'] && release['glider:notes']), '两个项目各有任务在跑')
    expect(release['glider:mech']).toBeUndefined()
    expect(manager.activeTasks()).toBe(3)
    expect(manager.activeTasks(second)).toBe(2)
    expect(manager.isBusy(workspace)).toBe(true)

    release['robot:mech']()
    await until(() => Boolean(release['glider:mech']), '排队的任务拿到 Fusion')
    release['glider:mech']()
    release['glider:notes']()
    await until(finished(3), '全部结束')
    expect(manager.isBusy()).toBe(false)
  })

  it('每月预算上限按所有项目的合计算', () => {
    const manager = makeManager(fakeQuery(async function* () {}))
    store.upsertTask({
      id: 'old', workspace: second, agentId: 'mech', agentName: '机械', sessionId: null, prompt: 'p', origin: 'user', status: 'done',
      startedAt: Date.now(), endedAt: Date.now(), costUsd: 12, numTurns: 1, durationMs: 1, resultSubtype: 'success', resultText: null, commitSha: null, error: null,
    })
    settings.monthlyBudgetUsd = 10
    expect(manager.submit(workspace, 'mech', 'x', 'user').error).toContain('每月预算上限')
  })

  it('任务启动前的准备：提示显示在对话里，准备出错也不挡任务', async () => {
    const seen: string[] = []
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        await ctx.nextUserText()
        yield init('s1')
        yield result('s1', 0.1)
      }),
      {
        prepare: async (dir, config) => {
          seen.push(`${dir === workspace ? 'robot' : 'other'}:${config.id}`)
          if (config.id === 'paper') throw new Error('磁盘满了')
          return [{ level: 'info', text: '已把内置的技能装进这个项目。' }]
        },
      },
    )
    manager.submit(workspace, 'elec', '查一颗电感', 'user')
    manager.submit(workspace, 'paper', '写摘要', 'user')
    await until(finished(2), '两个任务结束')
    expect(seen.sort()).toEqual(['robot:elec', 'robot:paper'])
    const elecNotes = (await manager.transcript(workspace, 'elec')).flatMap((i) => (i.kind === 'system' ? [i.text] : []))
    const paperNotes = (await manager.transcript(workspace, 'paper')).flatMap((i) => (i.kind === 'system' ? [i.text] : []))
    expect(elecNotes).toContain('已把内置的技能装进这个项目。')
    expect(paperNotes.some((text) => text.includes('磁盘满了'))).toBe(true)
    expect(tasks().every((t) => t.status === 'done')).toBe(true)
  })
})

describe('权限模式（和 Claude Code 一致）', () => {
  const approvals = (): ApprovalRequest[] => events.flatMap((e) => (e.type === 'approval-request' ? [e.request] : []))
  const modeOf = (manager: AgentManager, id: string): string | undefined => manager.states(workspace).find((s) => s.agentId === id)?.permissionMode

  it('默认逐项审批；切换后的模式传给 SDK；配置文件里可以写默认模式', async () => {
    const calls: Options[] = []
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        await ctx.nextUserText()
        yield { ...init('s1'), permissionMode: ctx.options.permissionMode, slash_commands: ['compact', 'context', 'usage', 'verify'] }
        yield result('s1', 0.1)
      }, calls),
    )
    expect(modeOf(manager, 'paper')).toBe('default')
    manager.submit(workspace, 'paper', '第一件事', 'user')
    await until(finished(1), '第一个任务')
    expect(calls[0].permissionMode).toBe('default')
    expect(calls[0].allowDangerouslySkipPermissions).toBeUndefined()
    expect(manager.states(workspace).find((s) => s.agentId === 'paper')?.slashCommands).toContain('verify')

    expect(await manager.setMode(workspace, 'paper', 'acceptEdits')).toBe('acceptEdits')
    manager.submit(workspace, 'paper', '第二件事', 'user')
    await until(finished(2), '第二个任务')
    expect(calls[1].permissionMode).toBe('acceptEdits')

    await manager.setMode(workspace, 'paper', 'bypassPermissions')
    manager.submit(workspace, 'paper', '第三件事', 'user')
    await until(finished(3), '第三个任务')
    expect(calls[2]).toMatchObject({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true })
    // 全部放行时，“每次都要确认”的规则仍然交给 SDK 的 ask 规则
    expect(calls[2].settings).toEqual({ permissions: { ask: ['Bash(*git push*)', 'PowerShell(*git push*)'] } })

    const firmware = getAgent(workspace, 'firmware')
    saveAgent(workspace, { ...(firmware?.config ?? { id: 'firmware', name: '', model: '' }), permission_mode: 'plan' }, firmware?.prompt ?? '')
    expect(modeOf(manager, 'firmware')).toBe('plan')
    manager.submit(workspace, 'firmware', '重构驱动', 'user')
    await until(finished(4), '第四个任务')
    expect(calls[3].permissionMode).toBe('plan')
  })

  it('任务进行中切换模式立刻生效；中途不能切进全部放行，留到下一个任务', async () => {
    const modeLog: string[] = []
    let release: () => void = () => undefined
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        await ctx.nextUserText()
        yield init('s1')
        await new Promise<void>((resolve) => {
          release = resolve
        })
        yield result('s1', 0.1)
      }, [], modeLog),
    )
    manager.submit(workspace, 'firmware', '改驱动', 'user')
    await until(() => manager.states(workspace).some((s) => s.agentId === 'firmware' && s.runningSince !== null && s.sessionId === 's1'), '开始运行')
    expect(await manager.setMode(workspace, 'firmware', 'acceptEdits')).toBe('acceptEdits')
    expect(modeLog).toEqual(['acceptEdits'])

    expect(await manager.setMode(workspace, 'firmware', 'bypassPermissions')).toBe('bypassPermissions')
    expect(modeLog).toEqual(['acceptEdits'])
    const notes = (await manager.transcript(workspace, 'firmware')).flatMap((i) => (i.kind === 'system' ? [i.text] : []))
    expect(notes.some((text) => text.includes('下一个任务'))).toBe(true)
    release()
    await until(finished(1), '任务结束')
  })

  it('要了自动模式但会话没拿到：界面如实显示回退后的模式', async () => {
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        await ctx.nextUserText()
        yield { ...init('s1'), permissionMode: 'default' }
        yield result('s1', 0.1)
      }),
    )
    await manager.setMode(workspace, 'paper', 'auto')
    manager.submit(workspace, 'paper', '写一段', 'user')
    await until(finished(1), '任务结束')
    expect(modeOf(manager, 'paper')).toBe('default')
    const notes = (await manager.transcript(workspace, 'paper')).flatMap((i) => (i.kind === 'system' ? [i.text] : []))
    expect(notes.some((text) => text.includes('自动模式') && text.includes('不可用'))).toBe(true)
  })

  it('计划模式：计划交给用户批准，批准后切到选定的模式；不批准就把意见传回去', async () => {
    const outcomes: unknown[] = []
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        await ctx.nextUserText()
        yield init('s1')
        const signal = new AbortController().signal
        outcomes.push(await ctx.options.canUseTool?.('ExitPlanMode', { plan: '1. 改引脚\n2. 编译' }, { signal, toolUseID: 'p1', requestId: 'r1' }))
        outcomes.push(await ctx.options.canUseTool?.('ExitPlanMode', { plan: '1. 改引脚\n2. 编译\n3. 写交接单' }, { signal, toolUseID: 'p2', requestId: 'r2' }))
        yield result('s1', 0.1)
      }),
    )
    await manager.setMode(workspace, 'firmware', 'plan')
    manager.submit(workspace, 'firmware', '按交接单改 IMU 引脚', 'user')
    await until(() => approvals().length === 1, '第一版计划')
    expect(approvals()[0]).toMatchObject({ kind: 'plan', plan: '1. 改引脚\n2. 编译', canAlwaysAllow: false })
    manager.resolveApproval({ id: approvals()[0].id, behavior: 'deny', message: '还要写交接单' })
    await until(() => approvals().length === 2, '第二版计划')
    manager.resolveApproval({ id: approvals()[1].id, behavior: 'allow', planMode: 'acceptEdits' })
    await until(finished(1), '任务结束')

    expect(outcomes[0]).toEqual({ behavior: 'deny', message: '还要写交接单' })
    expect(outcomes[1]).toMatchObject({
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    })
    expect(modeOf(manager, 'firmware')).toBe('acceptEdits')
  })

  it('“一直允许并写入配置”：规则进了配置文件，下一个任务也自动放行；强制确认的调用标记为 forced', async () => {
    const calls: Options[] = []
    const manager = makeManager(
      fakeQuery(async function* (ctx) {
        const text = await ctx.nextUserText()
        yield init('s1')
        if (text === '跑测试') {
          const signal = new AbortController().signal
          await ctx.options.canUseTool?.('Bash', { command: 'pio test -e esp32dev' }, {
            signal,
            toolUseID: 'a',
            requestId: 'r1',
            suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pio test:*' }], behavior: 'allow', destination: 'localSettings' }],
          })
          await ctx.options.canUseTool?.('Bash', { command: 'pio run -t upload' }, { signal, toolUseID: 'b', requestId: 'r2' })
        }
        yield result('s1', 0.1)
      }, calls),
    )
    manager.submit(workspace, 'firmware', '跑测试', 'user')
    await until(() => approvals().length === 1, '第一个审批')
    expect(approvals()[0]).toMatchObject({ forced: false, canAlwaysAllow: true })
    manager.resolveApproval({ id: approvals()[0].id, behavior: 'allow_always' })
    await until(() => approvals().length === 2, '第二个审批')
    expect(approvals()[1]).toMatchObject({ forced: true, canAlwaysAllow: false })
    // 强制确认的调用即使选了“一直允许”也只放行这一次
    manager.resolveApproval({ id: approvals()[1].id, behavior: 'allow_always' })
    await until(finished(1), '任务结束')

    const saved = getAgent(workspace, 'firmware')?.config.allowed_tools ?? []
    expect(saved).toContain('Bash(pio test:*)')
    expect(saved.filter((rule) => rule.includes('upload'))).toEqual([])
    expect(events.some((e) => e.type === 'agents-changed')).toBe(true)
    manager.submit(workspace, 'firmware', '再来一次', 'user')
    await until(finished(2), '第二个任务')
    expect(calls[1].allowedTools).toContain('Bash(pio test:*)')
  })
})
