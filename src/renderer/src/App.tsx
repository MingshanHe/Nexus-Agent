import { useEffect, useState } from 'react'
import type { AgentConfig, AgentDetail } from '../../shared/types'
import { AgentEditor } from './components/AgentEditor'
import { ApprovalDialog } from './components/ApprovalDialog'
import { ChatView } from './components/ChatView'
import { CostPanel } from './components/CostPanel'
import { HandoffBoard } from './components/HandoffBoard'
import { ProjectsPanel } from './components/ProjectsPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { Sidebar } from './components/Sidebar'
import { useNexus } from './store'

const BLANK_AGENT: AgentConfig = {
  id: '',
  name: '',
  model: 'claude-sonnet-5-5',
  allowed_tools: ['Read', 'Grep', 'Glob'],
}

/** 模板的 id 在项目里已经被占用时，换一个不冲突的 */
function freeId(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) {
    if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`
  }
}

export function App() {
  const { state, reload, select, setView } = useNexus()
  /** 正在编辑的 Agent：已有的用 id，新建用 'new' */
  const [editing, setEditing] = useState<string | null>(null)
  /** 新建时选的模板 id；空字符串表示从空白开始 */
  const [templateId, setTemplateId] = useState('')
  const [templates, setTemplates] = useState<AgentDetail[]>([])

  useEffect(() => {
    void window.nexus.agents.templates().then(setTemplates)
  }, [])

  if (!state.ready || !state.settings || !state.workspace) {
    return <div className="boot">正在启动…</div>
  }

  const existingIds = state.agents.map((a) => a.config.id)
  const selected = state.agents.find((a) => a.config.id === state.selectedAgentId) ?? null
  const projectNames = Object.fromEntries(state.settings.projects.map((p) => [p.path.toLowerCase(), p.name]))

  let editingDetail: AgentDetail | null = null
  if (editing === 'new') {
    const template = templates.find((t) => t.config.id === templateId)
    editingDetail = template
      ? { config: { ...template.config, id: freeId(template.config.id, existingIds), system_prompt: undefined }, prompt: template.prompt }
      : { config: BLANK_AGENT, prompt: '' }
  } else if (editing) {
    editingDetail = state.agents.find((a) => a.config.id === editing) ?? null
  }

  const startNewAgent = (): void => {
    setTemplateId('')
    setEditing('new')
  }

  return (
    <div className="app">
      <Sidebar state={state} onSelect={select} onView={setView} onNewAgent={startNewAgent} onChanged={reload} />
      <main className="main">
        {state.view === 'chat' &&
          (selected ? (
            <ChatView
              key={`${state.settings.currentProjectId}:${selected.config.id}`}
              detail={selected}
              runtime={state.states[selected.config.id]}
              items={state.transcripts[selected.config.id] ?? null}
              taskVersion={state.taskVersion}
              hasApiKey={state.settings.hasApiKey}
              onEdit={() => setEditing(selected.config.id)}
              onOpenSettings={() => setView('settings')}
            />
          ) : state.settings.workspace ? (
            <div className="empty">
              <h2>这个项目还没有 Agent</h2>
              <p>新建一个 Agent：可以从机械、电子、嵌入式、论文、总控这些模板开始，也可以从空白开始。</p>
              <button className="btn primary" onClick={startNewAgent}>
                新建 Agent
              </button>
            </div>
          ) : (
            <div className="empty">
              <h2>还没有项目</h2>
              <p>先新建一个项目：选一个文件夹，按模板生成目录和 Agent。</p>
              <button className="btn primary" onClick={() => setView('projects')}>
                新建项目
              </button>
            </div>
          ))}
        {state.view === 'handoffs' && <HandoffBoard handoffs={state.handoffs} agents={state.agents} onOpenAgent={select} />}
        {state.view === 'costs' && <CostPanel taskVersion={state.taskVersion} settings={state.settings} />}
        {state.view === 'projects' && (
          <ProjectsPanel
            key={state.settings.projects.length === 0 ? 'empty' : 'list'}
            settings={state.settings}
            taskVersion={state.taskVersion}
            onChanged={reload}
          />
        )}
        {state.view === 'settings' && (
          <SettingsPanel
            key={state.settings.currentProjectId ?? 'none'}
            settings={state.settings}
            workspace={state.workspace}
            onChanged={reload}
          />
        )}
      </main>

      {editingDetail && (
        <AgentEditor
          key={`${editing}:${templateId}`}
          detail={editingDetail}
          isNew={editing === 'new'}
          existingIds={existingIds}
          templates={templates}
          templateId={templateId}
          onPickTemplate={setTemplateId}
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
          projectName={
            state.settings.projects.length > 1
              ? (projectNames[state.approvals[0].workspace.toLowerCase()] ?? state.approvals[0].workspace)
              : null
          }
          position={1}
          total={state.approvals.length}
        />
      )}
    </div>
  )
}
