import { useState } from 'react'
import type { ApprovalDecision, ApprovalRequest, Question } from '../../../shared/types'
import { toolLabel } from '../format'

// 审批是这套软件最重要的界面：显示是谁、要调用什么、参数是什么，由人决定批准、拒绝或本次会话内一直允许。
// 没有“一键批准”的快捷键，避免手滑。

interface Props {
  request: ApprovalRequest
  position: number
  total: number
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function ToolInput({ name, input }: { name: string; input: Record<string, unknown> }) {
  if (name === 'Bash' || name === 'PowerShell') {
    return (
      <>
        {str(input.description) && <p className="approval-desc">{str(input.description)}</p>}
        <div className="field-label">命令</div>
        <pre className="code command">{str(input.command)}</pre>
      </>
    )
  }
  if (name === 'Edit') {
    return (
      <>
        <div className="field-label">文件</div>
        <pre className="code">{str(input.file_path)}</pre>
        <div className="field-label">删除</div>
        <pre className="code diff-del">{str(input.old_string) || '（空）'}</pre>
        <div className="field-label">改为</div>
        <pre className="code diff-add">{str(input.new_string) || '（空）'}</pre>
      </>
    )
  }
  if (name === 'Write') {
    return (
      <>
        <div className="field-label">文件</div>
        <pre className="code">{str(input.file_path)}</pre>
        <div className="field-label">内容</div>
        <pre className="code diff-add">{str(input.content)}</pre>
      </>
    )
  }
  if (name === 'mcp__nexus__dispatch') {
    return (
      <>
        <div className="field-label">派给</div>
        <pre className="code">{str(input.agent)}</pre>
        <div className="field-label">任务说明</div>
        <pre className="code">{str(input.task)}</pre>
      </>
    )
  }
  return (
    <>
      <div className="field-label">参数</div>
      <pre className="code">{JSON.stringify(input, null, 2)}</pre>
    </>
  )
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

export function ApprovalDialog({ request, position, total }: Props) {
  const [note, setNote] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)

  const decide = (behavior: ApprovalDecision['behavior']): void => {
    if (sending) return
    setSending(true)
    void window.nexus.approvals.resolve({
      id: request.id,
      behavior,
      message: note.trim() || undefined,
      answers: request.kind === 'question' ? answers : undefined,
    })
  }

  const isQuestion = request.kind === 'question'
  const questions = request.questions ?? []
  const allAnswered = questions.every((q) => (answers[q.question] ?? '').trim() !== '')

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="审批">
      <div className="dialog approval">
        <div className="dialog-head">
          <div>
            <div className="eyebrow">
              {isQuestion ? '需要你回答' : '需要你审批'}
              {total > 1 ? `（${position}/${total}）` : ''}
            </div>
            <h2>
              {request.agentName}
              {isQuestion ? ' 有问题要问你' : ` 想调用 ${toolLabel(request.toolName)}`}
            </h2>
          </div>
        </div>

        <div className="dialog-body">
          {request.title && <p className="approval-title">{request.title}</p>}
          {request.description && <p className="approval-desc">{request.description}</p>}
          {request.reason && <div className="note note-warn">{request.reason}</div>}

          {isQuestion ? (
            <Questions
              questions={questions}
              answers={answers}
              onChange={(question, value) => setAnswers((prev) => ({ ...prev, [question]: value }))}
            />
          ) : (
            <ToolInput name={request.toolName} input={request.input} />
          )}

          <div className="field-label">{isQuestion ? '不回答的原因（可选）' : '拒绝时给它的说明（可选）'}</div>
          <input
            className="input"
            value={note}
            placeholder={isQuestion ? '' : '例如：先在副本上做 / 换一个引脚 / 现在不要烧录'}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>

        <div className="dialog-foot">
          <button className="btn danger" disabled={sending} onClick={() => decide('deny')}>
            {isQuestion ? '不回答' : '拒绝'}
          </button>
          <div className="spacer" />
          {!isQuestion && request.canAlwaysAllow && (
            <button
              className="btn"
              disabled={sending}
              title={`之后自动放行：${request.alwaysAllowRules.join('、')}（到退出应用为止）`}
              onClick={() => decide('allow_session')}
            >
              本次会话内一直允许
            </button>
          )}
          <button className="btn primary" disabled={sending || (isQuestion && !allAnswered)} onClick={() => decide('allow')}>
            {isQuestion ? '提交回答' : '允许这一次'}
          </button>
        </div>
        {!isQuestion && request.canAlwaysAllow && (
          <div className="dialog-hint">
            “一直允许”会放行：<span className="mono">{request.alwaysAllowRules.join('、')}</span>，到退出应用为止。
          </div>
        )}
      </div>
    </div>
  )
}
