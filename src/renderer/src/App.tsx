import { useState } from 'react'
import type { AgentConfig } from '../../shared/types'
import { AgentEditor } from './components/AgentEditor'
import { ApprovalDialog } from './components/ApprovalDialog'
import { ChatView } from './components/ChatView'
import { CostPanel } from './components/CostPanel'
import { HandoffBoard } from './components/HandoffBoard'
import { SettingsPanel } from './components/SettingsPanel'
import { Sidebar } from './components/Sidebar'
import { useNexus } from './store'

const NEW_AGENT: AgentConfig = {
  id: '',
  name: '',
  model: 'claude-sonnet-5-5',
  allowed_tools: ['Read', 'Grep', 'Glob'],
}

export function App() {
  const { state, reload, select, setView } = useNexus()
  /** 正在编辑的 Agent：已有的用 id，新建用 'new' */
  const [editing, setEditing] = useState<string | null>(null)

  if (!state.ready || !state.settings || !state.workspace) {
    return <div className="boot">正在启动…</div>
  }

  const selected = state.agents.find((a) => a.config.id === state.selectedAgentId) ?? null
  const editingDetail =
    editing === 'new'
      ? { config: NEW_AGENT, prompt: '' }
      : (state.agents.find((a) => a.config.id === editing) ?? null)

  return (
    <div className="app">
      <Sidebar
        state={state}
        onSelect={select}
        onView={setView}
        onNewAgent={() => setEditing('new')}
      />
      <main className="main">
        {state.view === 'chat' &&
          (selected ? (
            <ChatView
              key={selected.config.id}
              detail={selected}
              runtime={state.states[selected.config.id]}
              items={state.transcripts[selected.config.id] ?? null}
              taskVersion={state.taskVersion}
              hasApiKey={state.settings.hasApiKey}
              onEdit={() => setEditing(selected.config.id)}
              onOpenSettings={() => setView('settings')}
            />
          ) : (
            <div className="empty">
              <h2>还没有 Agent</h2>
              <p>先在“设置”里选择工作区并初始化，四个专业 Agent 的配置会生成到工作区的 .nexus/ 目录。</p>
              <button className="btn primary" onClick={() => setView('settings')}>
                去设置
              </button>
            </div>
          ))}
        {state.view === 'handoffs' && <HandoffBoard handoffs={state.handoffs} agents={state.agents} onOpenAgent={select} />}
        {state.view === 'costs' && <CostPanel taskVersion={state.taskVersion} settings={state.settings} />}
        {state.view === 'settings' && (
          <SettingsPanel settings={state.settings} workspace={state.workspace} onChanged={reload} />
        )}
      </main>

      {editingDetail && (
        <AgentEditor
          key={editing}
          detail={editingDetail}
          isNew={editing === 'new'}
          existingIds={state.agents.map((a) => a.config.id)}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null)
            select(id)
          }}
        />
      )}

      {state.approvals.length > 0 && (
        <ApprovalDialog
          key={state.approvals[0].id}
          request={state.approvals[0]}
          position={1}
          total={state.approvals.length}
        />
      )}
    </div>
  )
}
