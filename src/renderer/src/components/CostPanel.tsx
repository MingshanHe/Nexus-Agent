import { useEffect, useState } from 'react'
import type { AppSettings, CostSummary } from '../../../shared/types'
import { dateTime, TASK_STATUS_LABEL, usd } from '../format'

// 成本：按任务、按 Agent、按天统计。数字来自 SDK 结果消息里的 total_cost_usd，是估算值，不是账单。

interface Props {
  taskVersion: number
  settings: AppSettings
}

function dayKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 最近 30 天，没有花费的日子补零，时间轴才是连续的 */
function last30Days(byDay: CostSummary['byDay']): Array<{ day: string; costUsd: number; tasks: number }> {
  const map = new Map(byDay.map((d) => [d.day, d]))
  const days: Array<{ day: string; costUsd: number; tasks: number }> = []
  const today = new Date()
  for (let i = 29; i >= 0; i--) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    const key = dayKey(date)
    days.push(map.get(key) ?? { day: key, costUsd: 0, tasks: 0 })
  }
  return days
}

function DailyChart({ byDay }: { byDay: CostSummary['byDay'] }) {
  const days = last30Days(byDay)
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(...days.map((d) => d.costUsd), 0.01)
  const active = hover === null ? null : days[hover]
  return (
    <figure className="chart">
      <figcaption>
        <strong>每天花费</strong>
        <span className="muted">
          {active ? `${active.day} · ${usd(active.costUsd)} · ${active.tasks} 个任务` : '最近 30 天，美元'}
        </span>
      </figcaption>
      <div className="bars" role="img" aria-label="最近 30 天每天的花费，明细见下方任务表">
        <span className="bars-max">{usd(max)}</span>
        {days.map((d, index) => (
          <div
            key={d.day}
            className={`bar-slot${hover === index ? ' active' : ''}`}
            onMouseEnter={() => setHover(index)}
            onMouseLeave={() => setHover(null)}
          >
            <div className="bar" style={{ height: `${(d.costUsd / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="bars-axis muted">
        <span>{days[0].day.slice(5)}</span>
        <span>{days[14].day.slice(5)}</span>
        <span>{days[29].day.slice(5)}</span>
      </div>
    </figure>
  )
}

export function CostPanel({ taskVersion, settings }: Props) {
  const [summary, setSummary] = useState<CostSummary | null>(null)

  useEffect(() => {
    void window.nexus.costs.summary().then(setSummary)
  }, [taskVersion])

  if (!summary) return <section className="page muted pad">读取中…</section>

  const budget = settings.monthlyBudgetUsd
  // 每月上限管的是整个 API 账户，所以进度按所有项目的合计算
  const share = budget ? Math.min(1, summary.allProjectsMonthUsd / budget) : 0
  const maxAgent = Math.max(...summary.byAgent.map((a) => a.costUsd), 0.01)

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>成本</h1>
          <p className="muted">
            当前项目的花费。按量计费，和 Claude 订阅分开结算；这里是按 SDK 报告的用量估算的，以 Console 账单为准。
          </p>
        </div>
      </header>

      <div className="tiles">
        <div className="tile">
          <div className="tile-label">今天</div>
          <div className="tile-value">{usd(summary.todayUsd)}</div>
        </div>
        <div className="tile">
          <div className="tile-label">本月</div>
          <div className="tile-value">{usd(summary.monthUsd)}</div>
          {budget !== null && (
            <>
              <div className="meter" role="img" aria-label={`本月预算已用 ${Math.round(share * 100)}%`}>
                <div className={`meter-fill${share >= 1 ? ' over' : share >= 0.8 ? ' near' : ''}`} style={{ width: `${share * 100}%` }} />
              </div>
              <div className="tile-sub muted">
                所有项目合计 {usd(summary.allProjectsMonthUsd)} / 预算 {usd(budget)}，已用 {Math.round(share * 100)}%
                {share >= 1 ? '：已达上限，新任务不会启动' : ''}
              </div>
            </>
          )}
          {budget === null && (
            <div className="tile-sub muted">所有项目合计 {usd(summary.allProjectsMonthUsd)}，没有设每月上限</div>
          )}
        </div>
        <div className="tile">
          <div className="tile-label">累计</div>
          <div className="tile-value">{usd(summary.totalUsd)}</div>
        </div>
        <div className="tile">
          <div className="tile-label">任务数</div>
          <div className="tile-value">{summary.taskCount}</div>
        </div>
      </div>

      <div className="split">
        <div className="panel">
          <DailyChart byDay={summary.byDay} />
        </div>
        <div className="panel">
          <div className="panel-title">
            <strong>按 Agent</strong>
            <span className="muted">累计，美元</span>
          </div>
          {summary.byAgent.length === 0 && <div className="muted">还没有任务。</div>}
          <div className="hbars">
            {summary.byAgent.map((agent) => (
              <div className="hbar-row" key={agent.agentId} title={`${agent.agentName}：${usd(agent.costUsd)}，${agent.tasks} 个任务`}>
                <span className="hbar-label">{agent.agentName}</span>
                <span className="hbar-track">
                  <span className="hbar" style={{ width: `${(agent.costUsd / maxAgent) * 100}%` }} />
                </span>
                <span className="hbar-value">{usd(agent.costUsd)}</span>
                <span className="hbar-count muted">{agent.tasks} 个任务</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <strong>最近的任务</strong>
          <span className="muted">最多 50 条</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>时间</th>
              <th>Agent</th>
              <th>任务</th>
              <th>状态</th>
              <th className="num">轮数</th>
              <th className="num">花费</th>
              <th>提交</th>
            </tr>
          </thead>
          <tbody>
            {summary.recent.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  还没有任务。
                </td>
              </tr>
            )}
            {summary.recent.map((task) => (
              <tr key={task.id}>
                <td className="nowrap">{dateTime(task.startedAt)}</td>
                <td className="nowrap">{task.agentName}</td>
                <td className="ellipsis" title={task.prompt}>
                  {task.prompt}
                </td>
                <td className="nowrap">
                  <span className={`state state-${task.status}`}>{TASK_STATUS_LABEL[task.status]}</span>
                </td>
                <td className="num">{task.numTurns}</td>
                <td className="num">{usd(task.costUsd)}</td>
                <td className="mono">{task.commitSha ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
