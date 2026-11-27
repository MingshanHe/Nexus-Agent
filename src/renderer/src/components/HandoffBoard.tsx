import { useState } from 'react'
import type { AgentDetail, Handoff, HandoffStatus } from '../../../shared/types'
import { errorText } from '../store'

// 交接看板：handoff/ 目录里的交接单按状态分三列。新交接单显示为待办，点一下就派给接收方跟进。

interface Props {
  handoffs: Handoff[]
  agents: AgentDetail[]
  onOpenAgent(agentId: string): void
}

const COLUMNS: Array<{ status: HandoffStatus; title: string; hint: string }> = [
  { status: 'open', title: '待跟进', hint: '新交接单，还没有人接手' },
  { status: 'acknowledged', title: '已派发', hint: '已经派给接收方，等它做完' },
  { status: 'done', title: '已完成', hint: '所有接收方都跟进完了' },
]

function Card({ handoff, agents, onOpenAgent }: { handoff: Handoff; agents: AgentDetail[]; onOpenAgent(id: string): void }) {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const specialists = agents.filter((a) => !a.error && a.config.role !== 'orchestrator')
  const nameOf = (id: string): string => agents.find((a) => a.config.id === id)?.config.name ?? id
  // 交接单写了接收方就按它来；没写（或写的不是已有 Agent）就列出全部专业 Agent
  const named = handoff.to.filter((id) => specialists.some((a) => a.config.id === id))
  const targets = named.length > 0 ? named : specialists.map((a) => a.config.id)

  const dispatch = async (agentId: string): Promise<void> => {
    setMessage('')
    try {
      const result = await window.nexus.handoffs.dispatch(handoff.file, agentId)
      if (!result.ok) setMessage(result.error ?? '没有派发成功。')
      else onOpenAgent(agentId)
    } catch (e) {
      setMessage(errorText(e))
    }
  }

  const setStatus = async (status: HandoffStatus): Promise<void> => {
    try {
      await window.nexus.handoffs.setStatus(handoff.file, status)
    } catch (e) {
      setMessage(errorText(e))
    }
  }

  return (
    <article className="card">
      <button className="card-title" onClick={() => setOpen(!open)} aria-expanded={open}>
        {handoff.title}
      </button>
      <div className="card-meta">
        <span>{handoff.from ? nameOf(handoff.from) : '未注明'}</span>
        <span aria-hidden="true">→</span>
        <span>{handoff.to.length ? handoff.to.map(nameOf).join('、') : '未注明'}</span>
        <span className="muted">· {handoff.created}</span>
      </div>
      {handoff.files.length > 0 && (
        <div className="card-files">
          {handoff.files.map((file) => (
            <code key={file}>{file}</code>
          ))}
        </div>
      )}
      {open && <pre className="code card-body">{handoff.body}</pre>}
      {message && <div className="note note-error">{message}</div>}
      <div className="card-actions">
        {handoff.status !== 'done' &&
          targets.map((id) => (
            <button key={id} className="btn small primary" onClick={() => void dispatch(id)}>
              派给{nameOf(id)}
            </button>
          ))}
        {handoff.status !== 'done' ? (
          <button className="btn small" onClick={() => void setStatus('done')}>
            标记完成
          </button>
        ) : (
          <button className="btn small" onClick={() => void setStatus('open')}>
            重新打开
          </button>
        )}
        <span className="muted mono card-file">handoff/{handoff.file}</span>
      </div>
    </article>
  )
}

function NewHandoff({ agents, onDone }: { agents: AgentDetail[]; onDone(): void }) {
  const specialists = agents.filter((a) => !a.error && a.config.role !== 'orchestrator')
  const [from, setFrom] = useState('me')
  const [to, setTo] = useState<string[]>([])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('## 改了什么\n\n\n## 谁需要跟进，做什么\n\n\n## 跟进记录\n')
  const [files, setFiles] = useState('')
  const [error, setError] = useState('')

  const create = async (): Promise<void> => {
    if (!title.trim() || to.length === 0) {
      setError('标题和接收方都要填。')
      return
    }
    try {
      await window.nexus.handoffs.create({
        from,
        to,
        title: title.trim(),
        body,
        files: files
          .split(/[,，\s]+/)
          .map((f) => f.trim())
          .filter(Boolean),
      })
      onDone()
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <div className="panel new-handoff">
      {error && <div className="note note-error">{error}</div>}
      <div className="form-row">
        <label>
          <span className="field-label">发起方</span>
          <select className="input" value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="me">我自己</option>
            {specialists.map((a) => (
              <option key={a.config.id} value={a.config.id}>
                {a.config.name}
              </option>
            ))}
          </select>
        </label>
        <div>
          <span className="field-label">接收方</span>
          <div className="checks">
            {specialists.map((a) => (
              <label key={a.config.id} className="check">
                <input
                  type="checkbox"
                  checked={to.includes(a.config.id)}
                  onChange={(e) =>
                    setTo((prev) => (e.target.checked ? [...prev, a.config.id] : prev.filter((id) => id !== a.config.id)))
                  }
                />
                <span>{a.config.name}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
      <label>
        <span className="field-label">一句话说清改了什么</span>
        <input className="input" value={title} placeholder="例如：IMU 的 INT 引脚从 GPIO4 改到 GPIO5" onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        <span className="field-label">涉及的文件（逗号分隔）</span>
        <input className="input mono" value={files} placeholder="elec/pinmap.csv, spec/interfaces.md" onChange={(e) => setFiles(e.target.value)} />
      </label>
      <label>
        <span className="field-label">正文</span>
        <textarea className="input mono" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="form-actions">
        <button className="btn ghost" onClick={onDone}>
          取消
        </button>
        <button className="btn primary" onClick={() => void create()}>
          创建交接单
        </button>
      </div>
    </div>
  )
}

export function HandoffBoard({ handoffs, agents, onOpenAgent }: Props) {
  const [creating, setCreating] = useState(false)
  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>交接看板</h1>
          <p className="muted">
            交接走文件，不走聊天。谁改了影响别人的东西，就在 handoff/ 写一张交接单；这里监视那个目录。
          </p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          新建交接单
        </button>
      </header>
      {creating && <NewHandoff agents={agents} onDone={() => setCreating(false)} />}
      <div className="board">
        {COLUMNS.map((column) => {
          const cards = handoffs.filter((h) => h.status === column.status)
          return (
            <div key={column.status} className={`column column-${column.status}`}>
              <div className="column-head">
                <strong>{column.title}</strong>
                <span className="count">{cards.length}</span>
              </div>
              <div className="column-hint muted">{column.hint}</div>
              {cards.length === 0 && <div className="column-empty muted">没有交接单</div>}
              {cards.map((handoff) => (
                <Card key={handoff.file} handoff={handoff} agents={agents} onOpenAgent={onOpenAgent} />
              ))}
            </div>
          )
        })}
      </div>
    </section>
  )
}
