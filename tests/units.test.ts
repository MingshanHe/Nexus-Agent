import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  duplicateAgent,
  listAgents,
  parseAgentYaml,
  removeAgent,
  saveAgent,
  serializeAgent,
} from '../src/main/agents/config'
import { historyToChat } from '../src/main/agents/history'
import { firstMatch, matchRule, parseRule } from '../src/main/agents/permissions'
import { autoCommit, commitMessage, git } from '../src/main/git/git'
import {
  createHandoff,
  handoffPrompt,
  listHandoffs,
  parseHandoff,
  setHandoffStatus,
} from '../src/main/handoff/handoffs'
import { SettingsStore } from '../src/main/settings'
import { Store, taskCostFromReported } from '../src/main/store/db'
import { exportClaudeAgents, scaffoldWorkspace } from '../src/main/workspace/scaffold'
import type { TaskRecord } from '../src/shared/types'

const DEFAULTS = path.resolve('resources/defaults')

// CI 上没有配置 git 身份
process.env.GIT_AUTHOR_NAME = 'Nexus Test'
process.env.GIT_AUTHOR_EMAIL = 'test@example.invalid'
process.env.GIT_COMMITTER_NAME = 'Nexus Test'
process.env.GIT_COMMITTER_EMAIL = 'test@example.invalid'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('权限规则匹配', () => {
  const cwd = path.resolve('/work/robot')

  it('解析规则', () => {
    expect(parseRule('Read')).toEqual({ tool: 'Read' })
    expect(parseRule('Bash(pio run -e *)')).toEqual({ tool: 'Bash', spec: 'pio run -e *' })
    expect(parseRule(' Edit(/mech/**) ')).toEqual({ tool: 'Edit', spec: '/mech/**' })
  })

  it('路径规则相对工作目录，Edit 规则也管 Write', () => {
    const inside = { file_path: path.join(cwd, 'mech', 'export', 'a.step') }
    const outside = { file_path: path.join(cwd, 'elec', 'pinmap.csv') }
    expect(matchRule('Edit(/mech/**)', 'Edit', inside, cwd)).toBe(true)
    expect(matchRule('Edit(/mech/**)', 'Write', inside, cwd)).toBe(true)
    expect(matchRule('Edit(/mech/**)', 'Edit', outside, cwd)).toBe(false)
    expect(matchRule('Edit(/mech/**)', 'Edit', { file_path: 'mech/notes.md' }, cwd)).toBe(true)
    expect(matchRule('Edit(/mech/**)', 'Read', inside, cwd)).toBe(false)
  })

  it('命令行规则：通配、前缀写法、复合命令', () => {
    expect(matchRule('Bash(*upload*)', 'Bash', { command: 'pio run -e esp32 -t upload' }, cwd)).toBe(true)
    expect(matchRule('Bash(*upload*)', 'Bash', { command: 'pio run -e esp32' }, cwd)).toBe(false)
    expect(matchRule('Bash(pio run:*)', 'Bash', { command: 'pio run -e native' }, cwd)).toBe(true)
    expect(matchRule('Bash(pio pkg *)', 'Bash', { command: 'cd firmware && pio pkg install' }, cwd)).toBe(true)
    expect(matchRule('Bash(*erase*)', 'PowerShell', { command: 'pio run -t erase' }, cwd)).toBe(false)
  })

  it('MCP 工具名通配', () => {
    expect(matchRule('mcp__fusion__*', 'mcp__fusion__fusion_mcp_update', {}, cwd)).toBe(true)
    expect(matchRule('mcp__fusion__fusion_mcp_update', 'mcp__fusion__fusion_mcp_read', {}, cwd)).toBe(false)
    expect(firstMatch(['Bash(*upload*)', 'mcp__fusion__*'], 'mcp__fusion__x', {}, cwd)).toBe('mcp__fusion__*')
    expect(firstMatch(undefined, 'Bash', { command: 'ls' }, cwd)).toBeNull()
  })
})

describe('Agent 配置文件', () => {
  it('自带的默认配置全部合法，且关键约束在', () => {
    const files = fs.readdirSync(path.join(DEFAULTS, 'agents'))
    expect(files.sort()).toEqual(['elec.yaml', 'firmware.yaml', 'mech.yaml', 'orchestrator.yaml', 'paper.yaml'])
    const byId = Object.fromEntries(
      files.map((file) => {
        const id = file.replace('.yaml', '')
        return [id, parseAgentYaml(id, fs.readFileSync(path.join(DEFAULTS, 'agents', file), 'utf8'))]
      }),
    )
    for (const [id, config] of Object.entries(byId)) {
      expect(fs.existsSync(path.join(DEFAULTS, config.system_prompt ?? `prompts/${id}.md`))).toBe(true)
    }
    // 工具按 Agent 隔离：只有机械挂 Fusion
    expect(byId.mech.mcp_servers?.fusion.url).toBe('http://127.0.0.1:27182/mcp')
    expect(byId.elec.mcp_servers).toBeUndefined()
    expect(byId.paper.mcp_servers).toBeUndefined()
    // CAD 和 EDA 各自一次只跑一个任务
    expect(byId.mech.resource).toBe('fusion')
    expect(byId.elec.resource).toBe('easyeda')
    // 烧录必须每次确认；Fusion 的写操作必须每次确认
    const cwd = path.resolve('/w')
    expect(firstMatch(byId.firmware.always_ask, 'Bash', { command: 'pio run -e esp32dev -t upload' }, cwd)).not.toBeNull()
    expect(firstMatch(byId.firmware.always_ask, 'Bash', { command: 'pio run -e esp32dev' }, cwd)).toBeNull()
    expect(firstMatch(byId.mech.always_ask, 'mcp__fusion__fusion_mcp_update', {}, cwd)).not.toBeNull()
    expect(byId.mech.allowed_tools).toContain('mcp__fusion__fusion_mcp_read')
    // 总控只读，dispatch 不自动放行
    expect(byId.orchestrator.role).toBe('orchestrator')
    expect(byId.orchestrator.disallowed_tools).toEqual(expect.arrayContaining(['Write', 'Edit', 'Bash']))
    expect(byId.orchestrator.allowed_tools).not.toContain('mcp__nexus__dispatch')
  })

  it('拒绝写错的字段', () => {
    expect(() => parseAgentYaml('x', 'name: A\nmodel: m\nallowed_tool: [Read]\n')).toThrow()
    expect(() => parseAgentYaml('x', 'name: A\n')).toThrow()
    expect(() => parseAgentYaml('x', 'name: A\nmodel: m\nmcp_servers:\n  f:\n    type: http\n')).toThrow()
    expect(() => parseAgentYaml('x', '- 1\n- 2\n')).toThrow()
  })

  it('保存、读取、复制、删除', () => {
    const saved = saveAgent(tmp, { id: 'mech', name: '机械', model: 'claude-opus-5-5', allowed_tools: ['Read'], always_ask: [] }, '提示词')
    expect(saved.config.system_prompt).toBe('prompts/mech.md')
    expect(serializeAgent(saved.config)).not.toContain('always_ask')
    const [loaded] = listAgents(tmp)
    expect(loaded.config).toMatchObject({ id: 'mech', name: '机械', allowed_tools: ['Read'] })
    expect(loaded.prompt).toBe('提示词')

    const copy = duplicateAgent(tmp, 'mech', 'mech-2')
    expect(copy.config.system_prompt).toBe('prompts/mech-2.md')
    expect(() => duplicateAgent(tmp, 'mech', 'mech-2')).toThrow()
    expect(() => saveAgent(tmp, { id: 'Bad Id', name: 'x', model: 'm' }, '')).toThrow()
    expect(() => saveAgent(tmp, { id: 'x', name: 'x', model: 'm', system_prompt: '../../outside.md' }, '')).toThrow()

    removeAgent(tmp, 'mech-2')
    expect(listAgents(tmp).map((a) => a.config.id)).toEqual(['mech'])
    expect(fs.existsSync(path.join(tmp, '.nexus/prompts/mech-2.md'))).toBe(false)
    expect(fs.existsSync(path.join(tmp, '.nexus/prompts/mech.md'))).toBe(true)
  })

  it('坏掉的配置文件不影响其他 Agent', () => {
    saveAgent(tmp, { id: 'ok', name: 'OK', model: 'm' }, '')
    fs.writeFileSync(path.join(tmp, '.nexus/agents/broken.yaml'), 'name: [oops\n')
    const agents = listAgents(tmp)
    expect(agents.find((a) => a.config.id === 'broken')?.error).toBeTruthy()
    expect(agents.find((a) => a.config.id === 'ok')?.error).toBeUndefined()
  })
})

describe('交接单', () => {
  const sample = [
    '---',
    'from: elec',
    'to: [firmware, paper]',
    'status: open',
    'created: 2026-11-27',
    'files: [elec/pinmap.csv]',
    '---',
    '# IMU 的 INT 引脚从 GPIO4 改到 GPIO5',
    '',
    '正文',
  ].join('\n')

  it('解析 front matter 和标题', () => {
    const handoff = parseHandoff('a.md', sample, 1)
    expect(handoff).toMatchObject({
      title: 'IMU 的 INT 引脚从 GPIO4 改到 GPIO5',
      from: 'elec',
      to: ['firmware', 'paper'],
      status: 'open',
      created: '2026-11-27',
      files: ['elec/pinmap.csv'],
    })
    expect(parseHandoff('plain.md', '没有 front matter', 1)).toMatchObject({ title: 'plain', status: 'open', to: [] })
    expect(handoffPrompt(handoff)).toContain('handoff/a.md')
  })

  it('创建、列出、改状态；模板和说明文件不算交接单', () => {
    fs.mkdirSync(path.join(tmp, 'handoff'))
    fs.writeFileSync(path.join(tmp, 'handoff/README.md'), '# 说明')
    fs.writeFileSync(path.join(tmp, 'handoff/_template.md'), sample)
    const created = createHandoff(tmp, { from: 'elec', to: ['firmware'], title: '改了 IMU 引脚', body: '正文', files: ['elec/pinmap.csv'] })
    expect(created.file).toMatch(/^\d{4}-\d{2}-\d{2}-elec-.+\.md$/)
    expect(listHandoffs(tmp).map((h) => h.file)).toEqual([created.file])

    setHandoffStatus(tmp, created.file, 'done')
    const [after] = listHandoffs(tmp)
    expect(after.status).toBe('done')
    expect(after.title).toBe('改了 IMU 引脚')
    expect(after.to).toEqual(['firmware'])
    expect(() => setHandoffStatus(tmp, '../evil.md', 'done')).toThrow()
  })
})

describe('任务与成本存储', () => {
  const task = (over: Partial<TaskRecord>): TaskRecord => ({
    id: 't1',
    workspace: 'ws',
    agentId: 'mech',
    agentName: '机械',
    sessionId: 's1',
    prompt: '画支架',
    origin: 'user',
    status: 'done',
    startedAt: Date.now(),
    endedAt: Date.now(),
    costUsd: 1,
    numTurns: 3,
    durationMs: 1000,
    resultSubtype: 'success',
    resultText: 'ok',
    commitSha: null,
    error: null,
    ...over,
  })

  it('恢复的会话里，任务花费是累计值的差', () => {
    expect(taskCostFromReported(0.5, 0)).toBeCloseTo(0.5)
    expect(taskCostFromReported(1.25, 0.5)).toBeCloseTo(0.75)
    expect(taskCostFromReported(0.2, 0.5)).toBeCloseTo(0.2) // 累计值被清零过
    expect(taskCostFromReported(0, 0.5)).toBe(0)
  })

  it('按 Agent 和按天汇总；重启后没跑完的任务标成已中断', () => {
    const file = path.join(tmp, 'nexus.db')
    let store = new Store(file)
    store.upsertTask(task({ id: 'a', costUsd: 1 }))
    store.upsertTask(task({ id: 'b', agentId: 'paper', agentName: '论文', costUsd: 0.25, sessionId: 's2' }))
    store.upsertTask(task({ id: 'c', status: 'running', costUsd: 0, endedAt: null }))
    store.upsertTask(task({ id: 'd', workspace: 'other', costUsd: 9 }))
    const summary = store.costSummary('ws')
    expect(summary.totalUsd).toBeCloseTo(1.25)
    expect(summary.todayUsd).toBeCloseTo(1.25)
    expect(summary.byAgent[0]).toMatchObject({ agentId: 'mech', costUsd: 1, tasks: 2 })
    expect(summary.byDay).toHaveLength(1)
    expect(summary.recent).toHaveLength(3)
    store.close()

    store = new Store(file)
    expect(store.getTask('c')?.status).toBe('interrupted')
    store.close()
  })

  it('会话归属、当前会话、分叉继承基线', () => {
    const store = new Store(path.join(tmp, 'nexus.db'))
    store.touchSession({ sessionId: 's1', workspace: 'ws', agentId: 'mech', title: '画支架' })
    store.setSessionReportedTotal('s1', 0.8)
    store.touchSession({ sessionId: 's1-fork', workspace: 'ws', agentId: 'mech', title: '重试', parentSessionId: 's1' })
    expect(store.sessionReportedTotal('s1-fork')).toBeCloseTo(0.8)
    store.setCurrentSession('ws', 'mech', 's1-fork')
    expect(store.getCurrentSession('ws', 'mech')).toBe('s1-fork')
    store.upsertTask(task({ id: 'a', sessionId: 's1', costUsd: 0.8 }))
    const sessions = store.listSessions('ws', 'mech')
    expect(sessions).toHaveLength(2)
    expect(sessions.find((s) => s.sessionId === 's1')).toMatchObject({ taskCount: 1, totalUsd: 0.8, current: false })
    expect(sessions.find((s) => s.sessionId === 's1-fork')).toMatchObject({ parentSessionId: 's1', current: true })
    store.close()
  })
})

describe('Git 自动提交', () => {
  it('只提交指定路径，提交信息带 Agent 名；没有改动时不提交', async () => {
    await git(tmp, ['init'])
    fs.mkdirSync(path.join(tmp, 'mech'))
    fs.mkdirSync(path.join(tmp, 'elec'))
    fs.writeFileSync(path.join(tmp, 'mech/a.md'), 'a')
    fs.writeFileSync(path.join(tmp, 'elec/b.md'), 'b')
    const message = commitMessage({ agentId: 'mech', agentName: '机械 Agent', prompt: '画一个\n支架', taskId: 't1', sessionId: 's1' })
    expect(message.split('\n')[0]).toBe('[mech] 画一个 支架')

    const first = await autoCommit({ repoDir: tmp, paths: ['mech', 'handoff'], message })
    expect(first.committed).toBe(true)
    expect(first.sha).toMatch(/^[0-9a-f]{7,}$/)
    const log = await git(tmp, ['log', '--format=%s', '--name-only'])
    expect(log.output).toContain('[mech] 画一个 支架')
    expect(log.output).toContain('mech/a.md')
    expect(log.output).not.toContain('elec/b.md')

    const again = await autoCommit({ repoDir: tmp, paths: ['mech'], message })
    expect(again.committed).toBe(false)

    // 被忽略的路径不会让整次提交失败
    fs.writeFileSync(path.join(tmp, '.gitignore'), '/paper/\n')
    fs.mkdirSync(path.join(tmp, 'paper'))
    fs.writeFileSync(path.join(tmp, 'paper/main.tex'), 'x')
    fs.writeFileSync(path.join(tmp, 'mech/a.md'), 'a2')
    const mixed = await autoCommit({ repoDir: tmp, paths: ['paper', 'mech'], message })
    expect(mixed.committed).toBe(true)

    const all = await autoCommit({ repoDir: tmp, message: '[elec] 其余' })
    expect(all.committed).toBe(true)
    expect((await git(tmp, ['status', '--porcelain'])).output).toBe('')
  })

  it('不是仓库时跳过', async () => {
    const result = await autoCommit({ repoDir: path.join(tmp, 'nope'), message: 'x' })
    expect(result.committed).toBe(false)
  })
})

describe('工作区模板', () => {
  it('初始化不覆盖已有文件，并生成四个专业 Agent 加总控', async () => {
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '我自己的')
    const first = await scaffoldWorkspace(tmp, DEFAULTS)
    expect(fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf8')).toBe('我自己的')
    for (const file of ['spec/interfaces.md', 'handoff/_template.md', 'elec/pinmap.csv', '.gitignore', '.nexus/agents/mech.yaml', '.nexus/prompts/paper.md']) {
      expect(fs.existsSync(path.join(tmp, file)), file).toBe(true)
    }
    expect(fs.existsSync(path.join(tmp, '.git'))).toBe(true)
    expect(first.skipped).toBe(1)
    const agents = listAgents(tmp)
    expect(agents.map((a) => a.config.id)).toEqual(['elec', 'firmware', 'mech', 'paper', 'orchestrator'])
    expect(agents.every((a) => !a.error && a.prompt.length > 100)).toBe(true)
    expect(listHandoffs(tmp)).toEqual([])

    const second = await scaffoldWorkspace(tmp, DEFAULTS)
    expect(second.created).toEqual([])

    const exported = exportClaudeAgents(tmp)
    expect(exported.written.sort()).toEqual(['.claude/agents/elec.md', '.claude/agents/firmware.md', '.claude/agents/mech.md', '.claude/agents/paper.md'])
    expect(fs.readFileSync(path.join(tmp, '.claude/agents/mech.md'), 'utf8')).toMatch(/^---\nname: mech\n/)
  })
})

describe('设置', () => {
  const box = (available = true) => ({
    available: async () => available,
    encrypt: async (plain: string) => Buffer.from(plain).toString('base64'),
    decrypt: async (cipher: string) => Buffer.from(cipher, 'base64').toString(),
  })

  it('Key 不以明文落盘，也不出现在给界面的视图里', async () => {
    const file = path.join(tmp, 'settings.json')
    const saved = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const settings = new SettingsStore(file, box())
      await settings.init()
      expect(settings.view()).toMatchObject({ hasApiKey: false, apiKeySource: 'none', autoCommit: true, monthlyBudgetUsd: null })
      await settings.setApiKey('  test-key-value  ')
      expect(settings.apiKey()).toBe('test-key-value')
      expect(fs.readFileSync(file, 'utf8')).not.toContain('test-key-value')
      expect(JSON.stringify(settings.view())).not.toContain('test-key-value')
      settings.update({ monthlyBudgetUsd: 50, defaultMaxTurns: 40.7, defaultMaxBudgetUsd: -1 })

      const reloaded = new SettingsStore(file, box())
      await reloaded.init()
      expect(reloaded.apiKey()).toBe('test-key-value')
      expect(reloaded.view()).toMatchObject({ apiKeySource: 'app', monthlyBudgetUsd: 50, defaultMaxTurns: 40, defaultMaxBudgetUsd: null })
      reloaded.clearApiKey()
      expect(reloaded.apiKey()).toBeNull()

      await expect(new SettingsStore(path.join(tmp, 'b.json'), box(false)).setApiKey('k')).rejects.toThrow()
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
    }
  })
})

describe('历史会话转换', () => {
  it('还原用户消息、回复和工具调用，跳过注入的提示', () => {
    const items = historyToChat([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: '画一个支架' }, parent_tool_use_id: null },
      { type: 'user', uuid: 'u0', message: { role: 'user', content: '<system-reminder>x</system-reminder>' }, parent_tool_use_id: null },
      {
        type: 'assistant',
        uuid: 'a1',
        message: { content: [{ type: 'text', text: '好的' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a' } }] },
        parent_tool_use_id: null,
      },
      {
        type: 'user',
        uuid: 'u2',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: '内容' }] }] },
        parent_tool_use_id: null,
      },
    ])
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool'])
    expect(items[2]).toMatchObject({ kind: 'tool', name: 'Read', status: 'done', result: '内容' })
  })
})
