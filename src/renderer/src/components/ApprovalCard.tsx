import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ApprovalDecision, ApprovalRequest, PermissionMode, Question } from '../../../shared/types'
import { toolLabel } from '../format'

// 审批直接出现在对话里，不再弹窗挡住整个应用：
//   1 允许这一次   2 本次会话内一直允许   3 一直允许并写入配置   Esc 拒绝
// 配置里“每次都要确认”的调用（烧录、写 CAD 等）不响应数字键，必须用鼠标点。

interface Props {
  request: ApprovalRequest
  /** 这个 Agent 还有几个审批在排队（含当前这个） */
  total: number
  /** 输入框里有没写完的字时不抢焦点 */
  stealFocus: boolean
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function DiffBlock({ oldText, newText }: { oldText: string; newText: string }) {
  const removed = oldText === '' ? [] : oldText.split('\n')
  const added = newText === '' ? [] : newText.split('\n')
  return (
    <pre className="code diff">
      {removed.map((line, i) => (
        <span key={`r${i}`} className="diff-line del">
          {`- ${line}\n`}
        </span>
      ))}
      {added.map((line, i) => (
        <span key={`a${i}`} className="diff-line add">
          {`+ ${line}\n`}
        </span>
      ))}
    </pre>
  )
}

export function ToolInput({ name, input }: { name: string; input: Record<string, unknown> }) {
  if (name === 'Bash' || name === 'PowerShell') {
    return (
      <>
        {str(input.description) && <p className="approval-desc">{str(input.description)}</p>}
        <pre className="code command">{str(input.command)}</pre>
      </>
    )
  }
  if (name === 'Edit') {
    return (
      <>
        <div className="mono approval-path">{str(input.file_path)}</div>
        <DiffBlock oldText={str(input.old_string)} newText={str(input.new_string)} />
      </>
    )
  }
  if (name === 'Write') {
    return (
      <>
        <div className="mono approval-path">{str(input.file_path)}</div>
        <DiffBlock oldText="" newText={str(input.content)} />
      </>
    )
  }
  if (name === 'mcp__nexus__dispatch') {
    return (
      <>
        <div className="approval-path">
          派给 <span className="mono">{str(input.agent)}</span>
        </div>
        <pre className="code">{str(input.task)}</pre>
      </>
    )
  }
  return <pre className="code">{JSON.stringify(input, null, 2)}</pre>
}

function Questions({
  questions,
  answers,
  onChange,
}: {
  questions: Question[]
  answers: Record<string, string>
  onChange(question: string, value: string): void
}) {
  return (
    <div className="questions">
      {questions.map((q) => {
        const current = answers[q.question] ?? ''
        const picked = new Set(current.split(', ').filter(Boolean))
        const labels = new Set(q.options.map((o) => o.label))
        const custom = [...picked].filter((value) => !labels.has(value)).join(', ')
        const toggle = (label: string): void => {
          if (!q.multiSelect) {
            onChange(q.question, label)
            return
          }
          const next = new Set(picked)
          if (next.has(label)) next.delete(label)
          else next.add(label)
          onChange(q.question, [...next].join(', '))
        }
        return (
          <fieldset key={q.question} className="question">
            <legend>{q.question}</legend>
            {q.options.map((option) => (
              <label key={option.label} className="option">
                <input
                  type={q.multiSelect ? 'checkbox' : 'radio'}
                  name={q.question}
                  checked={picked.has(option.label)}
                  onChange={() => toggle(option.label)}
                />
                <span>
                  <strong>{option.label}</strong>
                  {option.description && <span className="muted"> — {option.description}</span>}
                </span>
              </label>
            ))}
            <input
              className="input"
              placeholder="或者直接写你的回答"
              value={custom}
              onChange={(event) => {
                const kept = q.multiSelect ? [...picked].filter((value) => labels.has(value)) : []
                const text = event.target.value
                onChange(q.question, [...kept, ...(text ? [text] : [])].join(', '))
              }}
            />
          </fieldset>
        )
      })}
    </div>
  )
}

export function ApprovalCard({ request, total, stealFocus }: Props) {
  const [note, setNote] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  const card = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (stealFocus) card.current?.focus()
    card.current?.scrollIntoView({ block: 'nearest' })
    // 只在这张审批卡出现时做一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id])

  const decide = (behavior: ApprovalDecision['behavior'], planMode?: PermissionMode): void => {
    if (sending) return
    setSending(true)
    void window.nexus.approvals.resolve({
      id: request.id,
      behavior,
      planMode,
      message: note.trim() || undefined,
      answers: request.kind === 'question' ? answers : undefined,
    })
  }

  const isQuestion = request.kind === 'question'
  const isPlan = request.kind === 'plan'
  const questions = request.questions ?? []
  const allAnswered = questions.every((q) => (answers[q.question] ?? '').trim() !== '')
  // “每次都要确认”的调用不给键盘快捷键：这类操作（烧录、写 CAD）值得多看一眼
  const keys = !request.forced

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // 在输入框里打字时，数字键就是数字
    const tag = (event.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (event.key === 'Escape') {
      event.preventDefault()
      decide('deny')
      return
    }
    if (!keys || isQuestion || event.ctrlKey || event.altKey || event.metaKey) return
    if (isPlan) {
      if (event.key === '1') decide('allow', 'acceptEdits')
      else if (event.key === '2') decide('allow', 'default')
      return
    }
    if (event.key === '1' || event.key === 'Enter') decide('allow')
    else if (event.key === '2' && request.canAlwaysAllow) decide('allow_session')
    else if (event.key === '3' && request.canAlwaysAllow) decide('allow_always')
  }

  const k = (label: string): string => (keys ? label : '')

  return (
    <div className={`approval-card${request.forced ? ' forced' : ''}`} ref={card} tabIndex={-1} onKeyDown={onKeyDown} role="group" aria-label="审批">
      <div className="approval-head">
        <strong>
          {isQuestion ? '需要你回答' : isPlan ? '计划写好了，等你批准' : `想调用 ${toolLabel(request.toolName)}`}
        </strong>
        {total > 1 && <span className="muted">后面还有 {total - 1} 个</span>}
      </div>

      {request.title && <p className="approval-title">{request.title}</p>}
      {request.description && <p className="approval-desc">{request.description}</p>}
      {request.reason && <div className="note note-warn">{request.reason}</div>}

      {isQuestion ? (
        <Questions questions={questions} answers={answers} onChange={(question, value) => setAnswers((prev) => ({ ...prev, [question]: value }))} />
      ) : isPlan ? (
        <pre className="code plan">{request.plan}</pre>
      ) : (
        <ToolInput name={request.toolName} input={request.input} />
      )}

      <div className="approval-actions">
        {isQuestion ? (
          <button className="btn primary" disabled={sending || !allAnswered} onClick={() => decide('allow')}>
            提交回答
          </button>
        ) : isPlan ? (
          <>
            <button className="btn primary" disabled={sending} onClick={() => decide('allow', 'acceptEdits')}>
              <kbd>1</kbd> 批准，自动接受编辑
            </button>
            <button className="btn" disabled={sending} onClick={() => decide('allow', 'default')}>
              <kbd>2</kbd> 批准，逐项审批
            </button>
          </>
        ) : (
          <>
            <button className="btn primary" disabled={sending} onClick={() => decide('allow')}>
              {k('1') && <kbd>1</kbd>} 允许这一次
            </button>
            {request.canAlwaysAllow && (
              <>
                <button
                  className="btn"
                  disabled={sending}
                  title={`到退出应用为止，自动放行：${request.alwaysAllowRules.join('、')}`}
                  onClick={() => decide('allow_session')}
                >
                  <kbd>2</kbd> 本次会话一直允许
                </button>
                <button
                  className="btn"
                  disabled={sending}
                  title={`把 ${request.alwaysAllowRules.join('、')} 写进这个 Agent 配置的自动放行名单，以后都不再问`}
                  onClick={() => decide('allow_always')}
                >
                  <kbd>3</kbd> 一直允许（写入配置）
                </button>
              </>
            )}
          </>
        )}
        <input
          className="input approval-note"
          value={note}
          placeholder={isQuestion ? '不回答的原因（可选）' : isPlan ? '告诉它计划哪里要改，回车发送' : '拒绝并告诉它该怎么做，回车发送'}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              decide('deny')
            }
          }}
        />
        <button className="btn danger" disabled={sending} onClick={() => decide('deny')}>
          <kbd>Esc</kbd> {isQuestion ? '不回答' : isPlan ? '继续完善' : '拒绝'}
        </button>
      </div>
      {request.canAlwaysAllow && !isQuestion && !isPlan && (
        <div className="approval-hint muted">
          “一直允许”放行的是：<span className="mono">{request.alwaysAllowRules.join('、')}</span>
        </div>
      )}
      {request.forced && <div className="approval-hint muted">这个调用在配置里被设为每次都要确认，所以没有快捷键，也不能选“一直允许”。</div>}
    </div>
  )
}
