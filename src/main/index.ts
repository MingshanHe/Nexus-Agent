import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import {
  API_METHODS,
  channelName,
  EVENT_CHANNEL,
  type AgentDetail,
  type AppEvent,
  type AppSettings,
  type NexusApi,
} from '../shared/types'
import { duplicateAgent, getAgent, listAgents, removeAgent, saveAgent } from './agents/config'
import { AgentManager } from './agents/manager'
import { createOrchestratorServer } from './agents/orchestrator'
import { loadHistory, resolveClaudeExecutable, sdkQuery } from './agents/sdk'
import {
  createHandoff,
  handoffPrompt,
  listHandoffs,
  setHandoffStatus,
  watchHandoffs,
} from './handoff/handoffs'
import { SettingsStore } from './settings'
import { Store } from './store/db'
import {
  exportClaudeAgents,
  linkOverleaf,
  overleafSync,
  probeMcpServers,
  scaffoldWorkspace,
  workspaceStatus,
} from './workspace/scaffold'

const SMOKE = process.argv.includes('--smoke')
// 冒烟测试用独立的数据目录，不碰真实设置
if (SMOKE) app.setPath('userData', path.join(app.getPath('temp'), `nexus-agent-smoke-${process.pid}`))

let mainWindow: BrowserWindow | null = null
let stopWatching: (() => void) | null = null
let quitting = false

function emit(event: AppEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(EVENT_CHANNEL, event)
}

function defaultsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'defaults')
    : path.join(app.getAppPath(), 'resources', 'defaults')
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    show: false,
    title: 'Nexus Agent',
    backgroundColor: '#f6f5f1',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => {
    if (!SMOKE) win.show()
  })
  // 对话里的链接用系统浏览器打开，应用窗口本身不导航到别处
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  return win
}

async function start(): Promise<void> {
  const userData = app.getPath('userData')
  fs.mkdirSync(userData, { recursive: true })

  const settings = new SettingsStore(path.join(userData, 'settings.json'), {
    available: () => safeStorage.isAsyncEncryptionAvailable(),
    encrypt: async (plain) => (await safeStorage.encryptStringAsync(plain)).toString('base64'),
    decrypt: async (cipher) => (await safeStorage.decryptStringAsync(Buffer.from(cipher, 'base64'))).result,
  })
  await settings.init()
  const store = new Store(path.join(userData, 'nexus.db'))
  const executablePath = resolveClaudeExecutable({ packaged: app.isPackaged, resourcesPath: process.resourcesPath })

  const auditDir = path.join(userData, 'audit')
  const manager: AgentManager = new AgentManager({
    store,
    getWorkspace: () => settings.workspace,
    getSettings: () => ({
      apiKey: settings.apiKey(),
      defaultMaxBudgetUsd: settings.defaultMaxBudgetUsd,
      defaultMaxTurns: settings.defaultMaxTurns,
      monthlyBudgetUsd: settings.monthlyBudgetUsd,
      autoCommit: settings.autoCommit,
    }),
    emit,
    queryFn: sdkQuery,
    executablePath,
    loadHistory,
    orchestratorServer: (mgr, id) => createOrchestratorServer(mgr, id, () => settings.workspace),
    audit: (entry) => {
      // 每次工具调用留一行记录，按月分文件
      try {
        fs.mkdirSync(auditDir, { recursive: true })
        const month = new Date(entry.ts).toISOString().slice(0, 7)
        const line = JSON.stringify({ ...entry, input: JSON.stringify(entry.input).slice(0, 2000) })
        fs.appendFileSync(path.join(auditDir, `${month}.jsonl`), `${line}\n`, 'utf8')
      } catch {
        // 审计日志写不进去不应该打断任务
      }
    },
  })

  const watch = (): void => {
    stopWatching?.()
    stopWatching = null
    const workspace = settings.workspace
    if (workspace) stopWatching = watchHandoffs(workspace, (handoffs) => emit({ type: 'handoffs-changed', handoffs }))
  }

  const requireWorkspace = (): string => {
    const workspace = settings.workspace
    if (!workspace) throw new Error('还没有选择工作区。')
    return workspace
  }

  const settingsChanged = (): AppSettings => {
    emit({ type: 'settings-changed' })
    return settings.view()
  }

  const handlers: Omit<NexusApi, 'onEvent'> = {
    settings: {
      get: async () => settings.view(),
      update: async (patch) => {
        settings.update(patch)
        return settingsChanged()
      },
      chooseWorkspace: async () => {
        if (manager.isBusy()) throw new Error('有任务在运行或排队，先等它们结束再切换工作区。')
        const options = {
          title: '选择共享项目仓库（工作区）',
          properties: ['openDirectory' as const, 'createDirectory' as const],
          defaultPath: settings.workspace ?? undefined,
        }
        const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
        if (!result.canceled && result.filePaths[0]) {
          await manager.reset()
          settings.setWorkspace(result.filePaths[0])
          watch()
          emit({ type: 'agents-changed' })
        }
        return settingsChanged()
      },
      setApiKey: async (key) => {
        await settings.setApiKey(key)
        return settingsChanged()
      },
      clearApiKey: async () => {
        settings.clearApiKey()
        return settingsChanged()
      },
    },
    workspace: {
      status: async () => workspaceStatus(settings.workspace),
      scaffold: async () => {
        const result = await scaffoldWorkspace(requireWorkspace(), defaultsDir())
        watch()
        emit({ type: 'agents-changed' })
        return result
      },
      exportClaudeAgents: async () => exportClaudeAgents(requireWorkspace()),
      openInExplorer: async () => {
        await shell.openPath(requireWorkspace())
      },
    },
    agents: {
      list: async () => (settings.workspace ? listAgents(settings.workspace) : []),
      save: async (detail) => {
        const saved: AgentDetail = saveAgent(requireWorkspace(), detail.config, detail.prompt)
        emit({ type: 'agents-changed' })
        return saved
      },
      remove: async (id) => {
        if (manager.states().some((s) => s.agentId === id && s.status !== 'idle')) {
          throw new Error('这个 Agent 有任务在运行或排队，不能删除。')
        }
        removeAgent(requireWorkspace(), id)
        emit({ type: 'agents-changed' })
      },
      duplicate: async (id, newId) => {
        const copy = duplicateAgent(requireWorkspace(), id, newId)
        emit({ type: 'agents-changed' })
        return copy
      },
      states: async () => manager.states(),
      probeMcp: async (id) => {
        const detail = getAgent(requireWorkspace(), id)
        if (!detail || detail.error) return []
        return probeMcpServers(detail.config)
      },
    },
    tasks: {
      start: async (agentId, prompt) => manager.submit(agentId, prompt, 'user'),
      interrupt: async (agentId) => manager.interrupt(agentId),
      transcript: async (agentId) => manager.transcript(agentId),
      newSession: async (agentId) => manager.newSession(agentId),
    },
    sessions: {
      list: async (agentId) => (settings.workspace ? store.listSessions(settings.workspace, agentId) : []),
      resume: async (agentId, sessionId, fork) => manager.resumeSession(agentId, sessionId, fork),
    },
    approvals: {
      pending: async () => manager.pendingApprovals(),
      resolve: async (decision) => manager.resolveApproval(decision),
    },
    handoffs: {
      list: async () => (settings.workspace ? listHandoffs(settings.workspace) : []),
      dispatch: async (file, agentId) => {
        const workspace = requireWorkspace()
        const handoff = listHandoffs(workspace).find((h) => h.file === file)
        if (!handoff) return { ok: false, error: `找不到交接单：${file}` }
        const result = manager.submit(agentId, handoffPrompt(handoff), 'handoff')
        if (result.ok && handoff.status === 'open') setHandoffStatus(workspace, file, 'acknowledged')
        return result
      },
      setStatus: async (file, status) => setHandoffStatus(requireWorkspace(), file, status),
      create: async (input) => createHandoff(requireWorkspace(), input),
    },
    costs: {
      summary: async () =>
        settings.workspace
          ? store.costSummary(settings.workspace)
          : { totalUsd: 0, monthUsd: 0, todayUsd: 0, taskCount: 0, byAgent: [], byDay: [], recent: [] },
    },
    overleaf: {
      link: async (url) => {
        const result = await linkOverleaf(requireWorkspace(), url)
        if (result.ok) {
          settings.update({ overleafGitUrl: url.trim() })
          emit({ type: 'settings-changed' })
        }
        return result
      },
      pull: async () => overleafSync(requireWorkspace(), 'pull'),
      push: async () => overleafSync(requireWorkspace(), 'push'),
    },
  }

  for (const [group, methods] of Object.entries(API_METHODS)) {
    for (const method of methods) {
      const fn = (handlers as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>)[group][method]
      ipcMain.handle(channelName(group, method), (_event, ...args) => fn(...args))
    }
  }

  mainWindow = createWindow()
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  watch()

  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    stopWatching?.()
    void manager.reset().finally(() => {
      store.close()
      app.quit()
    })
  })

  if (SMOKE) {
    // 打包后的自检：窗口能加载、预加载脚本生效、数据库可用、能找到 Claude Code 可执行文件
    const win = mainWindow
    const fail = (reason: string): void => {
      console.log(`SMOKE_FAIL ${reason}`)
      app.exit(1)
    }
    const timer = setTimeout(() => fail('timeout'), 30_000)
    win.webContents.once('did-fail-load', (_e, code, description) => fail(`load ${code} ${description}`))
    win.webContents.once('did-finish-load', () => {
      void (async () => {
        try {
          const bridge = await win.webContents.executeJavaScript(
            'typeof window.nexus === "object" && typeof window.nexus.tasks.start === "function" && document.querySelector("#root").childElementCount > 0',
          )
          const report = {
            bridge,
            executable: executablePath ?? null,
            executableExists: executablePath ? fs.existsSync(executablePath) : false,
            defaults: fs.existsSync(path.join(defaultsDir(), 'agents', 'mech.yaml')),
            db: store.costSummary('smoke').taskCount === 0,
            encryption: await safeStorage.isAsyncEncryptionAvailable(),
          }
          clearTimeout(timer)
          const ok = report.bridge === true && report.executableExists && report.defaults && report.db
          console.log(`${ok ? 'SMOKE_OK' : 'SMOKE_FAIL'} ${JSON.stringify(report)}`)
          store.close()
          app.exit(ok ? 0 : 1)
        } catch (error) {
          fail(String(error))
        }
      })()
    })
  }
}

if (!app.requestSingleInstanceLock() && !SMOKE) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.on('window-all-closed', () => app.quit())
  void app.whenReady().then(() => {
    app.setAppUserModelId('com.mingshanhe.nexus-agent')
    return start()
  })
}
