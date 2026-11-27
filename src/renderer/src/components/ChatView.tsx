import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { AgentDetail, AgentRuntimeState, BridgeStatus, ChatItem, McpStatus, SessionInfo } from '../../../shared/types'
import {
  AGENT_STATUS_LABEL,
  dateTime,
  duration,
  MCP_STATUS_LABEL,
  TASK_STATUS_LABEL,
  toolLabel,
  toolSummary,
  usd,
} from '../format'
import { errorText } from '../store'

interface Props {
  detail: AgentDetail
  runtime: AgentRuntimeState | undefined
  /** null 表示还在向主进程取 */
  items: ChatItem[] | null
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

// ---------- 对话条目 ----------

function ToolCard({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const summary = toolSummary(item.name, item.input)
  const statusText = item.status === 'running' ? '运行中' : item.status === 'error' ? '失败' : '完成'
  return (
    <div className={`tool tool-${item.status}${item.nested ? ' nested' : ''}`}>
      <button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool-caret">{open ? '▾' : '▸'}</span>
        <span className="tool-name">{toolLabel(item.name)}</span>
        <span className="tool-summary">{summary}</span>
        <span className="tool-status">
          {item.status === 'running' && <i className="spinner" />}
          {statusText}
        </span>
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-section">参数</div>
          <pre className="code">{JSON.stringify(item.input, null, 2)}</pre>
          {item.result !== undefined && (
            <>
              <div className="tool-section">结果</div>
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

export function ChatView({ detail, runtime, items, taskVersion, hasApiKey, onEdit, onOpenSettings }: Props) {
  const { config, error: configError } = detail
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState('')
  const [history, setHistory] = useState(false)
  const [probe, setProbe] = useState<McpStatus[] | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const status = runtime?.status ?? 'idle'
  const busy = status === 'running' || status === 'waiting-approval'

  // 没在看旧消息时，新内容进来就跟到底部
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items])

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

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text) return
    setNotice('')
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
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send()
    }
  }

  const newSession = async (): Promise<void> => {
    try {
      await window.nexus.tasks.newSession(config.id)
      setNotice('')
    } catch (e) {
      setNotice(errorText(e))
    }
  }

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
            <span
              key={server.name}
              className={`pill mcp mcp-${server.status}`}
              title={server.error ?? `MCP 服务 ${server.name}`}
            >
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
                没有自动放行的调用会弹窗让你审批。任务结束后自动提交一次 Git，提交信息以 [{config.id}] 开头。
              </p>
            </div>
          )}
          {items?.map((item) => <Item key={item.id} item={item} />)}
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
        <div className="composer-row">
          <textarea
            value={draft}
            rows={3}
            placeholder={busy ? '任务进行中：这里输入的内容会作为追加指令发给它（Enter 发送）' : '描述要做的事（Enter 发送，Shift+Enter 换行）'}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={Boolean(configError)}
          />
          <div className="composer-buttons">
            <button className="btn primary" disabled={!draft.trim() || Boolean(configError)} onClick={() => void send()}>
              {busy ? '追加' : '发送'}
            </button>
            {busy && (
              <button className="btn danger" onClick={() => void window.nexus.tasks.interrupt(config.id)}>
                中断
              </button>
            )}
          </div>
        </div>
      </footer>
    </section>
  )
}
