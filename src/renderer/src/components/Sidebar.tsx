import { AGENT_STATUS_LABEL, agentGlyph } from '../format'
import type { UiState, View } from '../store'

interface Props {
  state: UiState
  onSelect(agentId: string): void
  onView(view: View): void
  onNewAgent(): void
}

function baseName(dir: string): string {
  return dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || dir
}

export function Sidebar({ state, onSelect, onView, onNewAgent }: Props) {
  const openHandoffs = state.handoffs.filter((h) => h.status === 'open').length
  const workspace = state.settings?.workspace

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <div>
          <div className="brand-name">Nexus Agent</div>
          <button
            className="workspace"
            title={workspace ? `${workspace}\n点击在资源管理器里打开` : '还没有选择工作区'}
            onClick={() => (workspace ? void window.nexus.workspace.openInExplorer() : onView('settings'))}
          >
            {workspace ? baseName(workspace) : '未选择工作区'}
          </button>
        </div>
      </div>

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
        {workspace && (
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
        <button className={state.view === 'handoffs' ? 'active' : ''} onClick={() => onView('handoffs')}>
          交接看板
          {openHandoffs > 0 && <span className="badge">{openHandoffs}</span>}
        </button>
        <button className={state.view === 'costs' ? 'active' : ''} onClick={() => onView('costs')}>
          成本
        </button>
        <button className={state.view === 'settings' ? 'active' : ''} onClick={() => onView('settings')}>
          设置
          {state.settings && !state.settings.hasApiKey && <span className="badge warn">需配置</span>}
        </button>
      </nav>
    </aside>
  )
}
