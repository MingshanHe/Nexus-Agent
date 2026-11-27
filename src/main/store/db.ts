import { DatabaseSync } from 'node:sqlite'
import type { CostSummary, SessionInfo, TaskRecord } from '../../shared/types'

// 任务和成本存在 SQLite 里（Node 自带的 node:sqlite，不需要编译原生模块）。
// 会话正文不在这里：它由 SDK 记在 ~/.claude/projects/ 下，这里只记“哪个会话属于哪个 Agent”。

type Row = Record<string, unknown>

/**
 * SDK 在恢复或分叉的会话里报告的 total_cost_usd 是接着旧会话累计的，
 * 所以单个任务的花费 = 本次报告的累计值 - 这个会话上次报告的累计值。
 * 如果累计值反而变小了（会话记录里没存旧值，或被 /clear 清零），就按本次报告值算。
 */
export function taskCostFromReported(reportedTotal: number, baseline: number): number {
  if (!Number.isFinite(reportedTotal) || reportedTotal <= 0) return 0
  if (reportedTotal + 1e-9 >= baseline) return Math.max(0, reportedTotal - baseline)
  return reportedTotal
}

function toTask(row: Row): TaskRecord {
  return {
    id: String(row.id),
    workspace: String(row.workspace),
    agentId: String(row.agent_id),
    agentName: String(row.agent_name),
    sessionId: (row.session_id as string | null) ?? null,
    prompt: String(row.prompt),
    origin: row.origin as TaskRecord['origin'],
    status: row.status as TaskRecord['status'],
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    costUsd: Number(row.cost_usd ?? 0),
    numTurns: Number(row.num_turns ?? 0),
    durationMs: Number(row.duration_ms ?? 0),
    resultSubtype: (row.result_subtype as string | null) ?? null,
    resultText: (row.result_text as string | null) ?? null,
    commitSha: (row.commit_sha as string | null) ?? null,
    error: (row.error as string | null) ?? null,
  }
}

export class Store {
  private db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        session_id TEXT,
        prompt TEXT NOT NULL,
        origin TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        cost_usd REAL NOT NULL DEFAULT 0,
        num_turns INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        result_subtype TEXT,
        result_text TEXT,
        commit_sha TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS tasks_by_time ON tasks (workspace, started_at);
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        reported_total_usd REAL NOT NULL DEFAULT 0,
        parent_session_id TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_state (
        workspace TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        current_session_id TEXT,
        PRIMARY KEY (workspace, agent_id)
      );
    `)
    // 上次退出时还没跑完的任务不可能还在跑
    this.db
      .prepare(
        `UPDATE tasks SET status = 'interrupted', ended_at = COALESCE(ended_at, started_at),
         error = COALESCE(error, '应用退出时任务尚未结束')
         WHERE status IN ('running', 'queued')`,
      )
      .run()
  }

  close(): void {
    this.db.close()
  }

  upsertTask(task: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, workspace, agent_id, agent_name, session_id, prompt, origin, status,
           started_at, ended_at, cost_usd, num_turns, duration_ms, result_subtype, result_text, commit_sha, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id, status = excluded.status, ended_at = excluded.ended_at,
           cost_usd = excluded.cost_usd, num_turns = excluded.num_turns, duration_ms = excluded.duration_ms,
           result_subtype = excluded.result_subtype, result_text = excluded.result_text,
           commit_sha = excluded.commit_sha, error = excluded.error`,
      )
      .run(
        task.id,
        task.workspace,
        task.agentId,
        task.agentName,
        task.sessionId,
        task.prompt,
        task.origin,
        task.status,
        task.startedAt,
        task.endedAt,
        task.costUsd,
        task.numTurns,
        task.durationMs,
        task.resultSubtype,
        task.resultText,
        task.commitSha,
        task.error,
      )
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined
    return row ? toTask(row) : null
  }

  /** 记录一个会话属于哪个 Agent；已存在则只更新最近使用时间。 */
  touchSession(input: {
    sessionId: string
    workspace: string
    agentId: string
    title: string
    parentSessionId?: string | null
    now?: number
  }): void {
    const now = input.now ?? Date.now()
    const parent = input.parentSessionId ?? null
    // 分叉出来的会话接着父会话的累计花费往上报，所以基线从父会话继承
    const baseline = parent ? this.sessionReportedTotal(parent) : 0
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, workspace, agent_id, title, created_at, last_used_at, reported_total_usd, parent_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET last_used_at = excluded.last_used_at`,
      )
      .run(input.sessionId, input.workspace, input.agentId, input.title, now, now, baseline, parent)
  }

  sessionReportedTotal(sessionId: string): number {
    const row = this.db
      .prepare('SELECT reported_total_usd FROM sessions WHERE session_id = ?')
      .get(sessionId) as Row | undefined
    return row ? Number(row.reported_total_usd ?? 0) : 0
  }

  setSessionReportedTotal(sessionId: string, total: number): void {
    this.db
      .prepare('UPDATE sessions SET reported_total_usd = ?, last_used_at = ? WHERE session_id = ?')
      .run(total, Date.now(), sessionId)
  }

  listSessions(workspace: string, agentId: string): SessionInfo[] {
    const current = this.getCurrentSession(workspace, agentId)
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.session_id) AS task_count,
                (SELECT COALESCE(SUM(t.cost_usd), 0) FROM tasks t WHERE t.session_id = s.session_id) AS total_usd
         FROM sessions s WHERE s.workspace = ? AND s.agent_id = ? ORDER BY s.last_used_at DESC`,
      )
      .all(workspace, agentId) as Row[]
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      agentId: String(row.agent_id),
      title: String(row.title),
      createdAt: Number(row.created_at),
      lastUsedAt: Number(row.last_used_at),
      totalUsd: Number(row.total_usd ?? 0),
      taskCount: Number(row.task_count ?? 0),
      parentSessionId: (row.parent_session_id as string | null) ?? null,
      current: String(row.session_id) === current,
    }))
  }

  getCurrentSession(workspace: string, agentId: string): string | null {
    const row = this.db
      .prepare('SELECT current_session_id FROM agent_state WHERE workspace = ? AND agent_id = ?')
      .get(workspace, agentId) as Row | undefined
    return (row?.current_session_id as string | null | undefined) ?? null
  }

  setCurrentSession(workspace: string, agentId: string, sessionId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO agent_state (workspace, agent_id, current_session_id) VALUES (?, ?, ?)
         ON CONFLICT(workspace, agent_id) DO UPDATE SET current_session_id = excluded.current_session_id`,
      )
      .run(workspace, agentId, sessionId)
  }

  /** 从 since（毫秒时间戳）起的总花费；workspace 传 null 表示所有项目合计。 */
  costSince(workspace: string | null, since: number): number {
    const row = (
      workspace === null
        ? this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM tasks WHERE started_at >= ?').get(since)
        : this.db
            .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM tasks WHERE workspace = ? AND started_at >= ?')
            .get(workspace, since)
    ) as Row
    return Number(row.total ?? 0)
  }

  costSummary(workspace: string, now = new Date()): CostSummary {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const totals = this.db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total, COUNT(*) AS n FROM tasks WHERE workspace = ?')
      .get(workspace) as Row
    const byAgent = this.db
      .prepare(
        `SELECT agent_id, MAX(agent_name) AS agent_name, COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS n
         FROM tasks WHERE workspace = ? GROUP BY agent_id ORDER BY cost DESC`,
      )
      .all(workspace) as Row[]
    const byDay = this.db
      .prepare(
        `SELECT date(started_at / 1000, 'unixepoch', 'localtime') AS day,
                COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS n
         FROM tasks WHERE workspace = ? AND started_at >= ?
         GROUP BY day ORDER BY day ASC`,
      )
      .all(workspace, now.getTime() - 30 * 86_400_000) as Row[]
    const recent = this.db
      .prepare('SELECT * FROM tasks WHERE workspace = ? ORDER BY started_at DESC LIMIT 50')
      .all(workspace) as Row[]
    return {
      totalUsd: Number(totals.total ?? 0),
      taskCount: Number(totals.n ?? 0),
      allProjectsMonthUsd: this.costSince(null, monthStart),
      monthUsd: this.costSince(workspace, monthStart),
      todayUsd: this.costSince(workspace, dayStart),
      byAgent: byAgent.map((row) => ({
        agentId: String(row.agent_id),
        agentName: String(row.agent_name),
        costUsd: Number(row.cost ?? 0),
        tasks: Number(row.n ?? 0),
      })),
      byDay: byDay.map((row) => ({
        day: String(row.day),
        costUsd: Number(row.cost ?? 0),
        tasks: Number(row.n ?? 0),
      })),
      recent: recent.map(toTask),
    }
  }
}
