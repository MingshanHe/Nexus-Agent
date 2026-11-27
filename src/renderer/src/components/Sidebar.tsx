import { AGENT_STATUS_LABEL, agentGlyph } from '../format'
import { errorText, type UiState, type View } from '../store'

interface Props {
  state: UiState
  onSelect(agentId: string): void
  onView(view: View): void
  onNewAgent(): void
  onChanged(): Promise<void>
}

const MANAGE = '__manage__'

export function Sidebar({ state, onSelect, onView, onNewAgent, onChanged }: Props) {
  const openHandoffs = state.handoffs.filter((h) => h.status === 'open').length
  const settings = state.settings
  const projects = settings?.projects ?? []
  const hasProject = Boolean(settings?.workspace)

  const switchProject = async (value: string): Promise<void> => {
    if (value === MANAGE) {
      onView('projects')
      return
    }
    try {
      await window.nexus.projects.open(value)
      await onChanged()
    } catch (e) {
      window.alert(errorText(e))
    }
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <div className="brand-name">Nexus Agent</div>
      </div>

      <label className="side-label" htmlFor="project-select">
        项目
      </label>
      <select
        id="project-select"
        className="project-select"
        value={settings?.currentProjectId ?? MANAGE}
        title={settings?.workspace ?? '还没有项目'}
        onChange={(event) => void switchProject(event.target.value)}
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
        <option value={MANAGE}>{projects.length === 0 ? '新建项目…' : '管理项目…'}</option>
      </select>

      <div className="side-label">Agent</div>
      <nav className="agent-list">
        {state.agents.map(({ config, error }) => {
          const runtime = state.states[config.id]
          const status = runtime?.status ?? 'idle'
          const active = state.view === 'chat' && state.selectedAgentId === config.id
          return (
            <button
              key={config.id}
              className={`agent-row${active ? ' active' : ''}`}
              onClick={() => onSelect(config.id)}
            >
              <span className={`glyph role-${config.role ?? 'specialist'}`} data-agent={config.id}>
                {agentGlyph(config.name)}
              </span>
              <span className="agent-text">
                <span className="agent-name">{config.name}</span>
                <span className={`agent-status status-${error ? 'error' : status}`}>
                  <i className="dot" />
                  {error ? '配置有错误' : AGENT_STATUS_LABEL[status]}
                  {runtime && runtime.queueLength > 0 ? ` · 排队 ${runtime.queueLength}` : ''}
                </span>
              </span>
            </button>
          )
        })}
        {hasProject && (
          <button className="agent-row add" onClick={onNewAgent}>
            <span className="glyph add-glyph">＋</span>
            <span className="agent-text">
              <span className="agent-name">新建 Agent</span>
            </span>
          </button>
        )}
      </nav>

      <div className="side-spacer" />

      <nav className="side-nav">
        <button className={state.view === 'handoffs' ? 'active' : ''} disabled={!hasProject} onClick={() => onView('handoffs')}>
          交接看板
          {openHandoffs > 0 && <span className="badge">{openHandoffs}</span>}
        </button>
        <button className={state.view === 'costs' ? 'active' : ''} disabled={!hasProject} onClick={() => onView('costs')}>
          成本
        </button>
        <button className={state.view === 'projects' ? 'active' : ''} onClick={() => onView('projects')}>
          项目
          {projects.length > 1 && <span className="count">{projects.length}</span>}
        </button>
        <button className={state.view === 'settings' ? 'active' : ''} onClick={() => onView('settings')}>
          设置
          {settings && !settings.hasApiKey && <span className="badge warn">需配置</span>}
        </button>
      </nav>
      {settings && <div className="version muted">v{settings.appVersion}</div>}
    </aside>
  )
}
