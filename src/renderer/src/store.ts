import { useCallback, useEffect, useReducer } from 'react'
import type {
  AgentDetail,
  AgentRuntimeState,
  AppEvent,
  AppSettings,
  ApprovalRequest,
  ChatItem,
  Handoff,
  WorkspaceStatus,
} from '../../shared/types'

export type View = 'chat' | 'handoffs' | 'costs' | 'settings'

export interface UiState {
  ready: boolean
  settings: AppSettings | null
  workspace: WorkspaceStatus | null
  agents: AgentDetail[]
  states: Record<string, AgentRuntimeState>
  /** 只保存已经向主进程取过的对话记录 */
  transcripts: Record<string, ChatItem[]>
  approvals: ApprovalRequest[]
  handoffs: Handoff[]
  selectedAgentId: string | null
  view: View
  /** 任务状态每变一次加一，成本和历史面板据此刷新 */
  taskVersion: number
}

type Action =
  | {
      type: 'loaded'
      settings: AppSettings
      workspace: WorkspaceStatus
      agents: AgentDetail[]
      states: AgentRuntimeState[]
      approvals: ApprovalRequest[]
      handoffs: Handoff[]
    }
  | { type: 'event'; event: AppEvent }
  | { type: 'transcript'; agentId: string; items: ChatItem[] }
  | { type: 'select'; agentId: string }
  | { type: 'view'; view: View }

const initial: UiState = {
  ready: false,
  settings: null,
  workspace: null,
  agents: [],
  states: {},
  transcripts: {},
  approvals: [],
  handoffs: [],
  selectedAgentId: null,
  view: 'chat',
  taskVersion: 0,
}

function upsert(items: ChatItem[], item: ChatItem): ChatItem[] {
  const index = items.findIndex((existing) => existing.id === item.id)
  if (index < 0) return [...items, item]
  const next = items.slice()
  next[index] = item
  return next
}

function applyEvent(state: UiState, event: AppEvent): UiState {
  switch (event.type) {
    case 'agent-state':
      return { ...state, states: { ...state.states, [event.state.agentId]: event.state } }
    case 'chat': {
      const items = state.transcripts[event.agentId]
      if (!items) return state
      return { ...state, transcripts: { ...state.transcripts, [event.agentId]: upsert(items, event.item) } }
    }
    case 'chat-delta': {
      const items = state.transcripts[event.agentId]
      if (!items) return state
      const next = items.map((item) =>
        item.id === event.itemId && item.kind === 'assistant' ? { ...item, text: item.text + event.text } : item,
      )
      return { ...state, transcripts: { ...state.transcripts, [event.agentId]: next } }
    }
    case 'chat-reset': {
      const { [event.agentId]: _dropped, ...rest } = state.transcripts
      return { ...state, transcripts: rest }
    }
    case 'approval-request':
      if (state.approvals.some((a) => a.id === event.request.id)) return state
      return { ...state, approvals: [...state.approvals, event.request] }
    case 'approval-resolved':
      return { ...state, approvals: state.approvals.filter((a) => a.id !== event.id) }
    case 'handoffs-changed':
      return { ...state, handoffs: event.handoffs }
    case 'task-updated':
      return { ...state, taskVersion: state.taskVersion + 1 }
    default:
      return state
  }
}

function reducer(state: UiState, action: Action): UiState {
  switch (action.type) {
    case 'loaded': {
      const ids = action.agents.map((a) => a.config.id)
      const selected =
        state.selectedAgentId && ids.includes(state.selectedAgentId) ? state.selectedAgentId : (ids[0] ?? null)
      const needsSetup = !action.settings.workspace || action.agents.length === 0
      return {
        ...state,
        ready: true,
        settings: action.settings,
        workspace: action.workspace,
        agents: action.agents,
        states: Object.fromEntries(action.states.map((s) => [s.agentId, s])),
        approvals: action.approvals,
        handoffs: action.handoffs,
        selectedAgentId: selected,
        view: !state.ready && needsSetup ? 'settings' : state.view,
      }
    }
    case 'event':
      return applyEvent(state, action.event)
    case 'transcript':
      return { ...state, transcripts: { ...state.transcripts, [action.agentId]: action.items } }
    case 'select':
      return { ...state, selectedAgentId: action.agentId, view: 'chat' }
    case 'view':
      return { ...state, view: action.view }
    default:
      return state
  }
}

/** 主进程抛出的错误带着 “Error invoking remote method …” 的前缀，去掉它。 */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function useNexus() {
  const [state, dispatch] = useReducer(reducer, initial)

  const reload = useCallback(async () => {
    const api = window.nexus
    const [settings, workspace, agents, states, approvals, handoffs] = await Promise.all([
      api.settings.get(),
      api.workspace.status(),
      api.agents.list(),
      api.agents.states(),
      api.approvals.pending(),
      api.handoffs.list(),
    ])
    dispatch({ type: 'loaded', settings, workspace, agents, states, approvals, handoffs })
  }, [])

  useEffect(() => {
    void reload()
    return window.nexus.onEvent((event) => {
      if (event.type === 'agents-changed' || event.type === 'settings-changed') void reload()
      else dispatch({ type: 'event', event })
    })
  }, [reload])

  // 选中的 Agent 还没有对话记录时向主进程取一次，之后靠事件保持同步
  const selected = state.selectedAgentId
  const hasTranscript = selected ? selected in state.transcripts : true
  useEffect(() => {
    if (!selected || hasTranscript) return
    let cancelled = false
    void window.nexus.tasks.transcript(selected).then((items) => {
      if (!cancelled) dispatch({ type: 'transcript', agentId: selected, items })
    })
    return () => {
      cancelled = true
    }
  }, [selected, hasTranscript])

  return {
    state,
    reload,
    select: (agentId: string) => dispatch({ type: 'select', agentId }),
    setView: (view: View) => dispatch({ type: 'view', view }),
  }
}
