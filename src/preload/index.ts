import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { API_METHODS, channelName, EVENT_CHANNEL, type AppEvent, type NexusApi } from '../shared/types'

// 界面跑在沙箱里，只能通过这里暴露的 window.nexus 和主进程说话。

const api: Record<string, unknown> = {}
for (const [group, methods] of Object.entries(API_METHODS)) {
  const bound: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  for (const method of methods) {
    bound[method] = (...args: unknown[]) => ipcRenderer.invoke(channelName(group, method), ...args)
  }
  api[group] = bound
}

api.onEvent = (listener: (event: AppEvent) => void): (() => void) => {
  const handler = (_event: IpcRendererEvent, payload: AppEvent): void => listener(payload)
  ipcRenderer.on(EVENT_CHANNEL, handler)
  return () => ipcRenderer.removeListener(EVENT_CHANNEL, handler)
}

contextBridge.exposeInMainWorld('nexus', api as unknown as NexusApi)
