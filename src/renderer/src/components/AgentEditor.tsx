import { useState } from 'react'
import type { AgentConfig, AgentDetail, EffortLevel, McpServerSpec } from '../../../shared/types'
import { errorText } from '../store'

// Agent 列表与配置：这里改的就是工作区里 .nexus/agents/<id>.yaml 和 .nexus/prompts/<id>.md。

interface Props {
  detail: AgentDetail
  isNew: boolean
  existingIds: string[]
  onClose(): void
  onSaved(id: string): void
}

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2']
const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

interface McpRow {
  name: string
  type: McpServerSpec['type']
  /** http/sse 填地址；stdio 填“命令 参数1 参数2” */
  target: string
  original?: McpServerSpec
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function toRows(servers: AgentConfig['mcp_servers']): McpRow[] {
  return Object.entries(servers ?? {}).map(([name, spec]) => ({
    name,
    type: spec.type,
    target: spec.type === 'stdio' ? [spec.command ?? '', ...(spec.args ?? [])].join(' ').trim() : (spec.url ?? ''),
    original: spec,
  }))
}

function fromRows(rows: McpRow[]): AgentConfig['mcp_servers'] {
  const servers: Record<string, McpServerSpec> = {}
  for (const row of rows) {
    const name = row.name.trim()
    if (!name || !row.target.trim()) continue
    if (row.type === 'stdio') {
      const [command, ...args] = row.target.trim().split(/\s+/)
      servers[name] = { type: 'stdio', command, args, env: row.original?.env }
    } else {
      servers[name] = { type: row.type, url: row.target.trim(), headers: row.original?.headers }
    }
  }
  return Object.keys(servers).length > 0 ? servers : undefined
}

function positive(text: string): number | undefined {
  const value = Number(text)
  return text.trim() !== '' && Number.isFinite(value) && value > 0 ? value : undefined
}

export function AgentEditor({ detail, isNew, existingIds, onClose, onSaved }: Props) {
  const { config } = detail
  const [id, setId] = useState(config.id)
  const [name, setName] = useState(config.name)
  const [description, setDescription] = useState(config.description ?? '')
  const [model, setModel] = useState(config.model)
  const [effort, setEffort] = useState<EffortLevel | ''>(config.effort ?? '')
  const [role, setRole] = useState<NonNullable<AgentConfig['role']>>(config.role ?? 'specialist')
  const [resource, setResource] = useState(config.resource ?? '')
  const [cwd, setCwd] = useState(config.cwd ?? '')
  const [maxTurns, setMaxTurns] = useState(config.max_turns ? String(config.max_turns) : '')
  const [maxBudget, setMaxBudget] = useState(config.max_budget_usd ? String(config.max_budget_usd) : '')
  const [allowed, setAllowed] = useState((config.allowed_tools ?? []).join('\n'))
  const [alwaysAsk, setAlwaysAsk] = useState((config.always_ask ?? []).join('\n'))
  const [disallowed, setDisallowed] = useState((config.disallowed_tools ?? []).join('\n'))
  const [skills, setSkills] = useState(config.skills === 'all' ? 'all' : (config.skills ?? []).join(', '))
  const [userSettings, setUserSettings] = useState((config.setting_sources ?? ['project']).includes('user'))
  const [gitPaths, setGitPaths] = useState((config.git?.paths ?? []).join(', '))
  const [gitRepo, setGitRepo] = useState(config.git?.repo ?? '')
  const [mcp, setMcp] = useState<McpRow[]>(toRows(config.mcp_servers))
  const [prompt, setPrompt] = useState(detail.prompt)
  const [error, setError] = useState(detail.error ?? '')
  const [saving, setSaving] = useState(false)
  const [dupId, setDupId] = useState<string | null>(null)

  const build = (): AgentConfig => {
    const skillList =
      skills.trim() === 'all'
        ? ('all' as const)
        : skills
            .split(/[,，\s]+/)
            .map((s) => s.trim())
            .filter(Boolean)
    const paths = gitPaths
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    return {
      id: id.trim(),
      name: name.trim(),
      description: description.trim() || undefined,
      role: role === 'orchestrator' ? 'orchestrator' : undefined,
      model: model.trim(),
      effort: effort || undefined,
      cwd: cwd.trim() || undefined,
      system_prompt: isNew ? undefined : config.system_prompt,
      mcp_servers: fromRows(mcp),
      allowed_tools: lines(allowed),
      always_ask: lines(alwaysAsk),
      disallowed_tools: lines(disallowed),
      skills: skillList === 'all' || skillList.length > 0 ? skillList : undefined,
      setting_sources: userSettings ? ['user', 'project'] : undefined,
      resource: resource.trim() || undefined,
      max_turns: positive(maxTurns) ? Math.floor(positive(maxTurns) as number) : undefined,
      max_budget_usd: positive(maxBudget),
      git: paths.length > 0 || gitRepo.trim() ? { paths: paths.length ? paths : undefined, repo: gitRepo.trim() || undefined } : undefined,
    }
  }

  const save = async (): Promise<void> => {
    setError('')
    const next = build()
    if (!next.id || !next.name || !next.model) {
      setError('id、名称和模型都要填。')
      return
    }
    if (isNew && existingIds.includes(next.id)) {
      setError(`已经有名为 ${next.id} 的 Agent。`)
      return
    }
    setSaving(true)
    try {
      await window.nexus.agents.save({ config: next, prompt })
      onSaved(next.id)
    } catch (e) {
      setError(errorText(e))
      setSaving(false)
    }
  }

  const duplicate = async (): Promise<void> => {
    // Electron 里没有 window.prompt，副本的 id 用对话框底部的输入框填
    if (dupId === null) {
      setDupId(`${config.id}-copy`)
      return
    }
    const newId = dupId.trim()
    if (!newId) return
    try {
      await window.nexus.agents.duplicate(config.id, newId)
      onSaved(newId)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const remove = async (): Promise<void> => {
    if (!window.confirm(`删除 Agent「${config.name}」？它的配置文件和提示词文件会被删除，历史会话记录保留。`)) return
    try {
      await window.nexus.agents.remove(config.id)
      onClose()
    } catch (e) {
      setError(errorText(e))
    }
  }

  const updateRow = (index: number, patch: Partial<McpRow>): void => {
    setMcp((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Agent 配置">
      <div className="dialog editor">
        <div className="dialog-head">
          <div>
            <div className="eyebrow">{isNew ? '新建 Agent' : `.nexus/agents/${config.id}.yaml`}</div>
            <h2>{isNew ? '新建 Agent' : config.name}</h2>
          </div>
          <button className="btn ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="dialog-body editor-grid">
          {error && <div className="note note-error span2">{error}</div>}

          <label>
            <span className="field-label">id（文件名，用于提交信息和交接单）</span>
            <input className="input mono" value={id} disabled={!isNew} placeholder="例如 mech" onChange={(e) => setId(e.target.value)} />
          </label>
          <label>
            <span className="field-label">名称</span>
            <input className="input" value={name} placeholder="例如 机械 Agent" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="span2">
            <span className="field-label">负责什么（总控 Agent 靠这句话决定派给谁）</span>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>

          <label>
            <span className="field-label">模型</span>
            <input className="input mono" list="nexus-models" value={model} onChange={(e) => setModel(e.target.value)} />
            <datalist id="nexus-models">
              {MODELS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <label>
            <span className="field-label">思考力度（effort）</span>
            <select className="input" value={effort} onChange={(e) => setEffort(e.target.value as EffortLevel | '')}>
              <option value="">模型默认</option>
              {EFFORTS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="field-label">角色</span>
            <select className="input" value={role} onChange={(e) => setRole(e.target.value as 'specialist' | 'orchestrator')}>
              <option value="specialist">专业 Agent</option>
              <option value="orchestrator">总控 Agent（获得 dispatch 工具）</option>
            </select>
          </label>
          <label>
            <span className="field-label">独占资源（同名的一次只跑一个任务）</span>
            <input className="input mono" value={resource} placeholder="例如 fusion、easyeda；留空则不限" onChange={(e) => setResource(e.target.value)} />
          </label>

          <label>
            <span className="field-label">单任务轮数上限</span>
            <input className="input" inputMode="numeric" value={maxTurns} placeholder="留空用全局设置" onChange={(e) => setMaxTurns(e.target.value)} />
          </label>
          <label>
            <span className="field-label">单任务预算上限（美元）</span>
            <input className="input" inputMode="decimal" value={maxBudget} placeholder="留空用全局设置" onChange={(e) => setMaxBudget(e.target.value)} />
          </label>

          <div className="span2">
            <span className="field-label">MCP 服务（只有这里列出的服务会挂给这个 Agent）</span>
            {mcp.map((row, index) => (
              <div className="mcp-row" key={index}>
                <input className="input mono" value={row.name} placeholder="名称" onChange={(e) => updateRow(index, { name: e.target.value })} />
                <select className="input" value={row.type} onChange={(e) => updateRow(index, { type: e.target.value as McpServerSpec['type'] })}>
                  <option value="http">http</option>
                  <option value="sse">sse</option>
                  <option value="stdio">stdio</option>
                </select>
                <input
                  className="input mono"
                  value={row.target}
                  placeholder={row.type === 'stdio' ? '命令 参数1 参数2' : 'http://127.0.0.1:27182/mcp'}
                  onChange={(e) => updateRow(index, { target: e.target.value })}
                />
                <button className="btn ghost" onClick={() => setMcp((rows) => rows.filter((_, i) => i !== index))}>
                  移除
                </button>
              </div>
            ))}
            <button className="btn small" onClick={() => setMcp((rows) => [...rows, { name: '', type: 'http', target: '' }])}>
              添加 MCP 服务
            </button>
          </div>

          <label>
            <span className="field-label">自动放行（每行一条；其余调用都弹审批）</span>
            <textarea className="input mono" rows={7} value={allowed} placeholder={'Read\nEdit(/mech/**)\nBash(pio run)'} onChange={(e) => setAllowed(e.target.value)} />
          </label>
          <label>
            <span className="field-label">每次都要确认（不能选“一直允许”）</span>
            <textarea className="input mono" rows={7} value={alwaysAsk} placeholder={'Bash(*upload*)\nmcp__fusion__fusion_mcp_update'} onChange={(e) => setAlwaysAsk(e.target.value)} />
          </label>

          <label>
            <span className="field-label">禁用的工具（每行一条）</span>
            <textarea className="input mono" rows={3} value={disallowed} onChange={(e) => setDisallowed(e.target.value)} />
          </label>
          <div>
            <label>
              <span className="field-label">技能（逗号分隔，或 all）</span>
              <input className="input mono" value={skills} placeholder="例如 easyeda-api" onChange={(e) => setSkills(e.target.value)} />
            </label>
            <label className="check">
              <input type="checkbox" checked={userSettings} onChange={(e) => setUserSettings(e.target.checked)} />
              <span>也读取用户级的 Claude Code 设置和技能（~/.claude）</span>
            </label>
          </div>

          <label>
            <span className="field-label">自动提交的路径（逗号分隔；留空提交全部改动）</span>
            <input className="input mono" value={gitPaths} placeholder="mech, handoff, spec" onChange={(e) => setGitPaths(e.target.value)} />
          </label>
          <label>
            <span className="field-label">独立仓库目录（例如关联 Overleaf 的 paper）</span>
            <input className="input mono" value={gitRepo} onChange={(e) => setGitRepo(e.target.value)} />
          </label>

          <label className="span2">
            <span className="field-label">工作目录（留空 = 工作区根目录）</span>
            <input className="input mono" value={cwd} onChange={(e) => setCwd(e.target.value)} />
          </label>

          <label className="span2">
            <span className="field-label">系统提示词（追加在 Claude Code 默认提示词之后；工作区的 CLAUDE.md 会自动读取）</span>
            <textarea className="input prompt" rows={14} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
        </div>

        <div className="dialog-foot">
          {!isNew && (
            <>
              <button className="btn danger" onClick={() => void remove()}>
                删除
              </button>
              {dupId !== null && (
                <input
                  className="input mono dup-id"
                  value={dupId}
                  aria-label="副本的 id"
                  placeholder="副本的 id"
                  onChange={(e) => setDupId(e.target.value)}
                />
              )}
              <button className="btn" onClick={() => void duplicate()}>
                {dupId === null ? '复制为新 Agent' : '确认复制'}
              </button>
            </>
          )}
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={saving} onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
