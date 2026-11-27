import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type {
  AgentDetail,
  AgentRuntimeState,
  ApprovalRequest,
  BridgeStatus,
  ChatItem,
  McpStatus,
  PermissionMode,
  SessionInfo,
} from '../../../shared/types'
import { PERMISSION_MODES } from '../../../shared/types'
import {
  AGENT_STATUS_LABEL,
  commandHint,
  dateTime,
  duration,
  MCP_STATUS_LABEL,
  MODE_CYCLE,
  MODE_HINT,
  MODE_LABEL,
  TASK_STATUS_LABEL,
  toolLabel,
  toolSummary,
  usd,
} from '../format'
import { errorText } from '../store'
import { ApprovalCard, DiffBlock } from './ApprovalCard'

interface Props {
  detail: AgentDetail
  runtime: AgentRuntimeState | undefined
  /** null 表示还在向主进程取 */
  items: ChatItem[] | null
  /** 这个 Agent 正在等你处理的审批 */
  approvals: ApprovalRequest[]
  taskVersion: number
  hasApiKey: boolean
  onEdit(): void
  onOpenSettings(): void
}

// ---------- 极简 Markdown：代码块、标题、列表、行内代码、加粗、链接 ----------

function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g
  let last = 0
  let match: RegExpExecArray | null
  let i = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    const key = `${keyBase}-${i++}`
    if (token.startsWith('`')) nodes.push(<code key={key}>{token.slice(1, -1)}</code>)
    else if (token.startsWith('**')) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    else {
      const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (parts) {
        nodes.push(
          <a key={key} href={parts[2]} target="_blank" rel="noreferrer">
            {parts[1]}
          </a>,
        )
      }
    }
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const segments = text.split(/```/)
  segments.forEach((segment, index) => {
    if (index % 2 === 1) {
      const newline = segment.indexOf('\n')
      const code = newline >= 0 ? segment.slice(newline + 1) : segment
      blocks.push(
        <pre key={`c${index}`} className="code">
          {code.replace(/\n$/, '')}
        </pre>,
      )
      return
    }
    // 逐行处理：标题行单独成块，其余连续的行合成一段
    let buffer: string[] = []
    let counter = 0
    const flush = (): void => {
      if (buffer.length === 0) return
      const key = `p${index}-${counter++}`
      const group = buffer
      buffer = []
      blocks.push(
        <p key={key}>
          {group.map((line, l) => (
            <span key={l} className={/^\s*([-*•]|\d+[.)])\s/.test(line) ? 'md-li' : undefined}>
              {inline(line, `${key}-${l}`)}
              {l < group.length - 1 ? '\n' : ''}
            </span>
          ))}
        </p>,
      )
    }
    for (const line of segment.split('\n')) {
      const heading = /^(#{1,4})\s+(.+)$/.exec(line)
      if (heading) {
        flush()
        const key = `h${index}-${counter++}`
        blocks.push(
          <div key={key} className={`md-h md-h${heading[1].length}`}>
            {inline(heading[2], key)}
          </div>,
        )
      } else if (line.trim() === '') {
        flush()
      } else {
        buffer.push(line)
      }
    }
    flush()
  })
  return <div className="md">{blocks}</div>
}

// ---------- 工具调用 ----------

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

function field(input: unknown, key: string): string {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
  return typeof value === 'string' ? value : ''
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length
}

interface Todo {
  content: string
  status: string
}

function todosOf(input: unknown): Todo[] | null {
  const list = input && typeof input === 'object' ? (input as Record<string, unknown>).todos : undefined
  if (!Array.isArray(list)) return null
  return list
    .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === 'object')
    .map((t) => ({ content: String(t.content ?? ''), status: String(t.status ?? 'pending') }))
}

function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false)
  const statusText = item.status === 'running' ? '运行中' : item.status === 'error' ? '失败' : '完成'

  // 待办清单一直展开显示，和 Claude Code 里一样
  const todos = item.name === 'TodoWrite' ? todosOf(item.input) : null
  if (todos) {
    return (
      <div className="todos">
        {todos.map((todo, i) => (
          <div key={i} className={`todo todo-${todo.status}`}>
            <span className="todo-box" aria-hidden="true">
              {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '▸' : ''}
            </span>
            {todo.content}
          </div>
        ))}
      </div>
    )
  }

  const isEdit = item.name === 'Edit'
  const isWrite = item.name === 'Write'
  const isShell = item.name === 'Bash' || item.name === 'PowerShell'
  const oldText = field(item.input, 'old_string')
  const newText = isWrite ? field(item.input, 'content') : field(item.input, 'new_string')
  const summary = isShell ? field(item.input, 'command').replace(/\s+/g, ' ') : toolSummary(item.name, item.input)

  return (
    <div className={`tool tool-${item.status}${item.nested ? ' nested' : ''}`}>
      <button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool-caret">{open ? '▾' : '▸'}</span>
        <span className="tool-name">{isShell ? '$' : toolLabel(item.name)}</span>
        <span className="tool-summary">{summary}</span>
        {(isEdit || isWrite) && (
          <span className="tool-delta">
            <span className="plus">+{lineCount(newText)}</span>
            {isEdit && <span className="minus">−{lineCount(oldText)}</span>}
          </span>
        )}
        <span className="tool-status">
          {item.status === 'running' && <i className="spinner" />}
          {statusText}
        </span>
      </button>
      {/* 失败的调用直接把原因露出来，不用点开 */}
      {!open && item.status === 'error' && item.result && <div className="tool-error-line">{item.result.split('\n')[0]}</div>}
      {open && (
        <div className="tool-body">
          {isEdit || isWrite ? (
            <DiffBlock oldText={oldText} newText={newText} />
          ) : isShell ? (
            <pre className="code command">{field(item.input, 'command')}</pre>
          ) : (
            <pre className="code">{JSON.stringify(item.input, null, 2)}</pre>
          )}
          {item.result !== undefined && (
            <>
              <div className="tool-section">{isShell ? '输出' : '结果'}</div>
              <pre className="code">{item.result || '（空）'}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Item({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return <div className="msg user">{item.text}</div>
    case 'assistant':
      return (
        <div className={`msg assistant${item.streaming ? ' streaming' : ''}`}>
          <Markdown text={item.text} />
          {item.streaming && <i className="cursor" />}
        </div>
      )
    case 'tool':
      return <ToolCard item={item} />
    case 'system':
      return <div className={`note note-${item.level}`}>{item.text}</div>
    case 'result': {
      const status = item.subtype as keyof typeof TASK_STATUS_LABEL
      return (
        <div className={`result result-${item.subtype}`}>
          <span>{TASK_STATUS_LABEL[status] ?? item.subtype}</span>
          <span>{usd(item.costUsd)}</span>
          <span>{item.numTurns} 轮</span>
          <span>{duration(item.durationMs)}</span>
          {item.commitSha && <span className="mono">提交 {item.commitSha}</span>}
        </div>
      )
    }
    default:
      return null
  }
}

// ---------- 历史会话 ----------

function HistoryDrawer({
  agentId,
  busy,
  taskVersion,
  onClose,
}: {
  agentId: string
  busy: boolean
  taskVersion: number
  onClose(): void
}) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.nexus.sessions.list(agentId).then(setSessions)
  }, [agentId, taskVersion])

  const resume = async (sessionId: string, fork: boolean): Promise<void> => {
    try {
      await window.nexus.sessions.resume(agentId, sessionId, fork)
      onClose()
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <div className="drawer">
      <div className="drawer-head">
        <strong>历史会话</strong>
        <button className="btn ghost" onClick={onClose}>
          关闭
        </button>
      </div>
      {error && <div className="note note-error">{error}</div>}
      {busy && <div className="note note-info">任务进行中，结束后才能切换会话。</div>}
      {sessions === null && <div className="muted pad">读取中…</div>}
      {sessions?.length === 0 && <div className="muted pad">这个 Agent 还没有历史会话。</div>}
      <ul className="session-list">
        {sessions?.map((s) => (
          <li key={s.sessionId} className={s.current ? 'current' : ''}>
            <div className="session-title">{s.title}</div>
            <div className="session-meta">
              {dateTime(s.lastUsedAt)} · {s.taskCount} 个任务 · {usd(s.totalUsd)}
              {s.parentSessionId ? ' · 分叉' : ''}
              {s.current ? ' · 当前' : ''}
            </div>
            <div className="session-actions">
              <button className="btn small" disabled={busy || s.current} onClick={() => void resume(s.sessionId, false)}>
                恢复
              </button>
              <button
                className="btn small"
                disabled={busy}
                title="从这个会话分出一个新分支重试，原会话保持不变"
                onClick={() => void resume(s.sessionId, true)}
              >
                分叉
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------- 主视图 ----------

/** 在应用里直接处理、不发给 Agent 的命令 */
const LOCAL_COMMANDS = ['clear']

export function ChatView({ detail, runtime, items, approvals, taskVersion, hasApiKey, onEdit, onOpenSettings }: Props) {
  const { config, error: configError } = detail
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState('')
  const [history, setHistory] = useState(false)
  const [probe, setProbe] = useState<McpStatus[] | null>(null)
  const [menuIndex, setMenuIndex] = useState(0)
  /** 按 ↑ 回看之前发过的指令：-1 表示没在回看 */
  const [recall, setRecall] = useState(-1)
  const [now, setNow] = useState(Date.now())
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)

  const status = runtime?.status ?? 'idle'
  const busy = status === 'running' || status === 'waiting-approval'
  const mode: PermissionMode = runtime?.permissionMode ?? config.permission_mode ?? 'default'
  const approval = approvals[0] ?? null

  // 没在看旧消息时，新内容进来就跟到底部
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items, approval?.id])

  // 还没跑过任务时，先看一下 MCP 端口通不通
  useEffect(() => {
    let cancelled = false
    void window.nexus.agents.probeMcp(config.id).then((result) => {
      if (!cancelled) setProbe(result)
    })
    return () => {
      cancelled = true
    }
  }, [config.id, config.mcp_servers])

  // 运行中每秒走一下表
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [busy])

  const mcp: McpStatus[] = runtime?.mcp.length ? runtime.mcp : (probe ?? [])

  // 用到内置 EasyEDA 技能的 Agent：显示桥接服务和嘉立创EDA 窗口的连接情况
  const usesEda = Array.isArray(config.skills) && config.skills.includes('easyeda-api')
  const [eda, setEda] = useState<BridgeStatus | null>(null)
  useEffect(() => {
    if (!usesEda) return
    let cancelled = false
    const refresh = (): void => {
      void window.nexus.eda.status().then((next) => {
        if (!cancelled) setEda(next)
      })
    }
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [usesEda])

  const edaAction = async (work: () => Promise<BridgeStatus>): Promise<void> => {
    try {
      setEda(await work())
    } catch (e) {
      setNotice(errorText(e))
    }
  }

  // 之前发过的指令，最近的在前
  const sent = useMemo(
    () => (items ?? []).flatMap((item) => (item.kind === 'user' ? [item.text] : [])).reverse(),
    [items],
  )
  const sessionCost = useMemo(
    () => (items ?? []).reduce((sum, item) => sum + (item.kind === 'result' ? item.costUsd : 0), 0),
    [items],
  )

  // 斜杠命令：输入以 / 开头且还没打空格时给出候选
  const commands = useMemo(() => {
    // 会话报上来的列表里技能很多：常用的内置命令排在最前面
    const names = [...LOCAL_COMMANDS, 'compact', 'context', 'usage', ...(runtime?.slashCommands ?? [])]
    return [...new Set(names)]
  }, [runtime?.slashCommands])
  const slash = /^\/([\w:-]*)$/.exec(draft)
  const matches = slash ? commands.filter((name) => name.startsWith(slash[1])).slice(0, 8) : []
  const menuOpen = matches.length > 0
  const picked = matches[Math.min(menuIndex, matches.length - 1)]

  const setMode = async (next: PermissionMode): Promise<void> => {
    if (next === 'bypassPermissions' && mode !== 'bypassPermissions') {
      const ok = window.confirm(
        `把「${config.name}」切到“全部放行”？\n\n它会不经询问直接执行命令和修改文件。配置里“每次都要确认”的调用仍然会问你。建议只在你信得过当前任务、并且改动都能用 Git 回滚的时候用。`,
      )
      if (!ok) return
    }
    try {
      await window.nexus.tasks.setMode(config.id, next)
      setNotice('')
    } catch (e) {
      setNotice(errorText(e))
    }
  }

  const cycleMode = (): void => {
    const index = MODE_CYCLE.indexOf(mode)
    void setMode(MODE_CYCLE[(index + 1) % MODE_CYCLE.length])
  }

  const newSession = async (): Promise<void> => {
    try {
      await window.nexus.tasks.newSession(config.id)
      setNotice('')
    } catch (e) {
      setNotice(errorText(e))
    }
  }

  const send = async (override?: string): Promise<void> => {
    const text = (override ?? draft).trim()
    if (!text) return
    setNotice('')
    setRecall(-1)
    if (text === '/clear') {
      setDraft('')
      await newSession()
      return
    }
    const result = await window.nexus.tasks.start(config.id, text)
    if (!result.ok) {
      setNotice(result.error ?? '任务没有启动。')
      return
    }
    setDraft('')
    stick.current = true
    if (result.mode === 'queued') setNotice('已加入队列，前一个任务结束（或独占的软件空出来）后开始。')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault()
      cycleMode()
      return
    }
    if (menuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setMenuIndex((index) => (Math.min(index, matches.length - 1) + step + matches.length) % matches.length)
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        setDraft(`/${picked}`)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void send(`/${picked}`)
        return
      }
    }
    if (event.key === 'Escape') {
      if (draft) setDraft('')
      else if (busy) void window.nexus.tasks.interrupt(config.id)
      setRecall(-1)
      return
    }
    // ↑ 回看之前发过的指令（输入框为空，或者正在回看时）
    if (event.key === 'ArrowUp' && (draft === '' || recall >= 0) && sent.length > 0) {
      event.preventDefault()
      const next = Math.min(recall + 1, sent.length - 1)
      setRecall(next)
      setDraft(sent[next])
      return
    }
    if (event.key === 'ArrowDown' && recall >= 0) {
      event.preventDefault()
      const next = recall - 1
      setRecall(next)
      setDraft(next >= 0 ? sent[next] : '')
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  const elapsed = runtime?.runningSince ? duration(Math.max(0, now - runtime.runningSince)) : ''

  return (
    <section className="chat">
      <header className="chat-head">
        <div className="chat-title">
          <h1>{config.name}</h1>
          <span className={`pill status-${status}`}>
            <i className="dot" />
            {AGENT_STATUS_LABEL[status]}
          </span>
          {config.model && <span className="pill mono">{runtime?.model ?? config.model}</span>}
          {config.resource && <span className="pill" title="同名独占资源一次只跑一个任务">独占 {config.resource}</span>}
          {mcp.map((server) => (
            <span key={server.name} className={`pill mcp mcp-${server.status}`} title={server.error ?? `MCP 服务 ${server.name}`}>
              <i className="dot" />
              {server.name} {MCP_STATUS_LABEL[server.status] ?? server.status}
            </span>
          ))}
        </div>
        <div className="chat-actions">
          <button className="btn ghost" onClick={() => setHistory(!history)}>
            历史会话
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => void newSession()}>
            新会话
          </button>
          <button className="btn ghost" onClick={onEdit}>
            配置
          </button>
        </div>
      </header>
      {config.description && <div className="chat-desc">{config.description}</div>}
      {usesEda && eda && (
        <div className="eda-bar">
          <span className={`pill ${eda.running ? (eda.windows > 0 ? 'mcp-connected' : 'eda-waiting') : 'mcp-failed'}`}>
            <i className="dot" />
            {eda.running
              ? eda.windows > 0
                ? `已连接 ${eda.windows} 个嘉立创EDA 窗口`
                : '桥接服务已启动，等待嘉立创EDA 连接'
              : '桥接服务未启动'}
          </span>
          {eda.running && <span className="muted">端口 {eda.port}</span>}
          <span className="muted">
            内置技能 {eda.skillVersion ?? '缺失'}
            {eda.installed ? '（已装进项目）' : '（任务启动时自动安装）'}
          </span>
          {eda.error && !eda.running && <span className="muted">{eda.error}</span>}
          <span className="spacer" />
          {!eda.running && (
            <button className="btn small" onClick={() => void edaAction(() => window.nexus.eda.startBridge())}>
              启动桥接服务
            </button>
          )}
          {eda.running && eda.managed && (
            <button className="btn small" disabled={busy} onClick={() => void edaAction(() => window.nexus.eda.stopBridge())}>
              停止
            </button>
          )}
          {!eda.installed && (
            <button className="btn small" onClick={() => void edaAction(() => window.nexus.eda.installSkill())}>
              现在安装技能
            </button>
          )}
        </div>
      )}

      <div className="chat-body">
        <div
          className="transcript"
          ref={scroller}
          onScroll={(event) => {
            const el = event.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
          }}
        >
          {configError && (
            <div className="note note-error">
              配置文件 .nexus/agents/{config.id}.yaml 有错误：{configError}。修好之前这个 Agent 不能运行。
            </div>
          )}
          {items === null && <div className="muted pad">读取对话记录…</div>}
          {items?.length === 0 && !configError && (
            <div className="hint">
              <p>给「{config.name}」派一件事。</p>
              <p className="muted">
                输入框下面可以切换权限模式（Shift+Tab）：逐项审批、自动接受编辑、自动模式、计划模式。输入 / 可以看到可用的命令。
              </p>
            </div>
          )}
          {items?.map((item) => <Item key={item.id} item={item} />)}
          {approval && <ApprovalCard key={approval.id} request={approval} total={approvals.length} stealFocus={draft === ''} />}
          {busy && !approval && (
            <div className="working">
              <i className="spinner" />
              正在工作{elapsed ? ` · ${elapsed}` : ''}
              <span className="muted"> · 按 Esc 中断，也可以直接输入追加指令</span>
            </div>
          )}
        </div>
        {history && (
          <HistoryDrawer agentId={config.id} busy={busy || status === 'queued'} taskVersion={taskVersion} onClose={() => setHistory(false)} />
        )}
      </div>

      <footer className="composer">
        {!hasApiKey && (
          <div className="note note-warn">
            还没有配置 Claude API Key。
            <button className="link" onClick={onOpenSettings}>
              去设置
            </button>
          </div>
        )}
        {notice && <div className="note note-info">{notice}</div>}
        <div className="composer-box">
          {menuOpen && (
            <div className="slash-menu" role="listbox" aria-label="命令">
              {matches.map((name, index) => (
                <button
                  key={name}
                  role="option"
                  aria-selected={name === picked}
                  className={name === picked ? 'active' : ''}
                  onMouseEnter={() => setMenuIndex(index)}
                  onClick={() => {
                    void send(`/${name}`)
                    input.current?.focus()
                  }}
                >
                  <span className="mono">/{name}</span>
                  <span className="muted">{commandHint(name)}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={input}
            value={draft}
            rows={3}
            placeholder={busy ? '任务进行中：输入的内容会作为追加指令发给它' : '描述要做的事，或输入 / 查看命令'}
            onChange={(event) => {
              setDraft(event.target.value)
              setMenuIndex(0)
              if (recall >= 0) setRecall(-1)
            }}
            onKeyDown={onKeyDown}
            disabled={Boolean(configError)}
          />
          <div className="composer-bar">
            <label className={`mode mode-${mode}`} title={`${MODE_HINT[mode]}（Shift+Tab 切换）`}>
              <span className="mode-dot" aria-hidden="true" />
              <select value={mode} aria-label="权限模式" onChange={(event) => void setMode(event.target.value as PermissionMode)}>
                {PERMISSION_MODES.map((value) => (
                  <option key={value} value={value}>
                    {MODE_LABEL[value]}
                  </option>
                ))}
              </select>
            </label>
            <span className="composer-hint muted">{MODE_HINT[mode]}</span>
            <span className="spacer" />
            {sessionCost > 0 && <span className="muted composer-cost">本会话 {usd(sessionCost)}</span>}
            {busy && (
              <button className="btn small danger" onClick={() => void window.nexus.tasks.interrupt(config.id)}>
                中断
              </button>
            )}
            <button className="btn small primary" disabled={!draft.trim() || Boolean(configError)} onClick={() => void send()}>
              {busy ? '追加' : '发送'}
            </button>
          </div>
        </div>
        <div className="keys muted">
          Enter 发送 · Shift+Enter 换行 · Shift+Tab 切换权限模式 · ↑ 上一条指令 · Esc 中断
        </div>
      </footer>
    </section>
  )
}
