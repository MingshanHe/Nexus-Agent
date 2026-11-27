import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage, shell } from 'electron'
import electronUpdater from 'electron-updater'
import {
  API_METHODS,
  channelName,
  EVENT_CHANNEL,
  type AgentDetail,
  type AppEvent,
  type AppSettings,
  type BridgeStatus,
  type NexusApi,
  type ProjectInfo,
  type ProjectSummary,
} from '../shared/types'
import { duplicateAgent, getAgent, listAgents, removeAgent, saveAgent } from './agents/config'
import { AgentManager, type TaskNote } from './agents/manager'
import { createOrchestratorServer } from './agents/orchestrator'
import { loadHistory, resolveClaudeExecutable, sdkQuery } from './agents/sdk'
import { EdaBridge, installedSkillDir, installSkill, skillVersion, usesEasyedaSkill } from './eda/easyeda'
import {
  createHandoff,
  handoffPrompt,
  listHandoffs,
  setHandoffStatus,
  watchHandoffs,
} from './handoff/handoffs'
import { SettingsStore } from './settings'
import { Store } from './store/db'
import { UpdateService, type UpdaterLike } from './updater'
import {
  agentTemplates,
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
/** 正在为安装更新而退出 */
let updating = false

function send(event: AppEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(EVENT_CHANNEL, event)
}

function defaultsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'defaults')
    : path.join(app.getAppPath(), 'resources', 'defaults')
}

/** 随应用内置的 EasyEDA API Skill */
function bundledSkillDir(): string | null {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'skills', 'easyeda-api')
    : path.join(app.getAppPath(), 'vendor', 'easyeda-api-skill')
  return fs.existsSync(path.join(dir, 'SKILL.md')) ? dir : null
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 560,
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
  win.on('focus', () => win.flashFrame(false))
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  return win
}

async function start(): Promise<void> {
  const userData = app.getPath('userData')
  fs.mkdirSync(userData, { recursive: true })

  const settings = new SettingsStore(
    path.join(userData, 'settings.json'),
    {
      available: () => safeStorage.isAsyncEncryptionAvailable(),
      encrypt: async (plain) => (await safeStorage.encryptStringAsync(plain)).toString('base64'),
      decrypt: async (cipher) => (await safeStorage.decryptStringAsync(Buffer.from(cipher, 'base64'))).result,
    },
    app.getVersion(),
  )
  await settings.init()
  const store = new Store(path.join(userData, 'nexus.db'))
  const executablePath = resolveClaudeExecutable({ packaged: app.isPackaged, resourcesPath: process.resourcesPath })
  const bridge = new EdaBridge({ skillDir: bundledSkillDir, execPath: process.execPath })
  // 开发模式下内置技能目录里没有 ws，装进项目时从本应用的依赖里补一份
  const wsModuleDir = app.isPackaged ? null : path.join(app.getAppPath(), 'node_modules', 'ws')

  const projectName = (workspace: string): string => settings.projectByPath(workspace)?.name ?? path.basename(workspace)

  /** 窗口不在前台时，用系统通知和任务栏闪烁提醒 */
  const notify = (title: string, body: string): void => {
    const win = mainWindow
    if (!settings.notifications || !win || win.isDestroyed() || win.isFocused() || SMOKE) return
    win.flashFrame(true)
    if (!Notification.isSupported()) return
    const notification = new Notification({ title, body: body.length > 160 ? `${body.slice(0, 160)}…` : body })
    notification.on('click', () => {
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    notification.show()
  }

  const emit = (event: AppEvent): void => {
    send(event)
    if (event.type === 'approval-request') {
      const { request } = event
      notify(
        `${request.agentName} 需要你${request.kind === 'question' ? '回答' : '审批'}`,
        `${projectName(request.workspace)} · ${request.toolName}`,
      )
    } else if (event.type === 'task-updated' && event.task.endedAt !== null && event.task.status !== 'queued') {
      const { task } = event
      const label = task.status === 'done' ? '完成了任务' : task.status === 'error' ? '的任务出错了' : '的任务已中断'
      notify(`${task.agentName} ${label}`, `${projectName(task.workspace)} · ${task.prompt.replace(/\s+/g, ' ')}`)
    }
  }

  const auditDir = path.join(userData, 'audit')
  const manager: AgentManager = new AgentManager({
    store,
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
    orchestratorServer: (mgr, workspace, id) => createOrchestratorServer(mgr, workspace, id),
    prepare: async (workspace, config) => {
      // 用到 EasyEDA API Skill 的 Agent：先把内置技能装进项目，再确认桥接服务在跑
      if (!usesEasyedaSkill(config)) return []
      const notes: TaskNote[] = []
      try {
        const result = installSkill(workspace, bundledSkillDir(), wsModuleDir)
        if (result.changed) notes.push({ level: 'info', text: `已把内置的 EasyEDA API Skill ${result.version} 装进这个项目。` })
      } catch (error) {
        notes.push({ level: 'warn', text: `内置技能没有装上：${error instanceof Error ? error.message : String(error)}` })
      }
      const status = await bridge.ensureRunning()
      if (!status.running) {
        notes.push({ level: 'warn', text: `嘉立创EDA 的桥接服务没有启动：${status.error ?? '原因未知'}` })
      } else if (status.windows === 0) {
        notes.push({
          level: 'warn',
          text: `桥接服务在端口 ${status.port} 运行，但还没有嘉立创EDA 窗口连上。请确认嘉立创EDA专业版已打开，并且 Run API Gateway 扩展已安装并加载。`,
        })
      }
      return notes
    },
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

  // 软件内更新：只有安装版能更新（开发模式和冒烟测试里不启用）
  const canUpdate = app.isPackaged && !SMOKE
  const updates = new UpdateService(canUpdate ? (electronUpdater.autoUpdater as unknown as UpdaterLike) : null, {
    currentVersion: app.getVersion(),
    supported: canUpdate,
    onChange: (state) => send({ type: 'update-state', state }),
    isBusy: () => manager.isBusy(),
    beforeRestart: () => {
      // 更新安装是用户点的：不再弹“还有任务在跑”的确认
      quitting = false
      updating = true
    },
  })

  const watch = (): void => {
    stopWatching?.()
    stopWatching = null
    const workspace = settings.workspace
    if (workspace) stopWatching = watchHandoffs(workspace, (handoffs) => send({ type: 'handoffs-changed', handoffs }))
  }

  /** 当前项目的文件夹 */
  const current = (): string => {
    const workspace = settings.workspace
    if (!workspace) throw new Error('还没有打开项目。先在“项目”里新建或打开一个。')
    return workspace
  }

  const settingsChanged = (): AppSettings => {
    send({ type: 'settings-changed' })
    return settings.view()
  }

  /** 切换了项目：换一个目录监视交接单，界面整体刷新 */
  const projectChanged = (): AppSettings => {
    watch()
    send({ type: 'agents-changed' })
    return settingsChanged()
  }

  const summarize = (project: ProjectInfo): ProjectSummary => {
    const exists = fs.existsSync(project.path)
    return {
      ...project,
      exists,
      agentCount: exists ? listAgents(project.path).length : 0,
      activeTasks: manager.activeTasks(project.path),
      current: project.id === settings.currentProject?.id,
    }
  }

  const edaStatus = async (probe = bridge.probe()): Promise<BridgeStatus> => {
    const workspace = settings.workspace
    const bundled = skillVersion(bundledSkillDir())
    const installed = workspace ? skillVersion(installedSkillDir(workspace)) : null
    return { ...(await probe), skillVersion: bundled, installed: installed !== null && installed === bundled }
  }

  const handlers: Omit<NexusApi, 'onEvent'> = {
    settings: {
      get: async () => settings.view(),
      update: async (patch) => {
        settings.update(patch)
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
    projects: {
      list: async () => settings.projects.map(summarize),
      chooseFolder: async () => {
        const options = {
          title: '选择项目文件夹',
          properties: ['openDirectory' as const, 'createDirectory' as const],
        }
        const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
        const dir = result.canceled ? undefined : result.filePaths[0]
        if (!dir) return null
        return { path: dir, name: path.basename(dir) || dir, hasAgents: listAgents(dir).length > 0 }
      },
      create: async (input) => {
        const dir = input.path.trim()
        if (!dir || !path.isAbsolute(dir)) throw new Error('请先选择项目文件夹。')
        fs.mkdirSync(dir, { recursive: true })
        // 已经是 Nexus 项目的文件夹直接打开，不套模板
        if (listAgents(dir).length === 0) await scaffoldWorkspace(dir, defaultsDir(), input.template)
        settings.addProject({ name: input.name, path: dir })
        return projectChanged()
      },
      open: async (id) => {
        settings.openProject(id)
        return projectChanged()
      },
      rename: async (id, name) => {
        settings.renameProject(id, name)
        return settingsChanged()
      },
      remove: async (id) => {
        const project = settings.projects.find((p) => p.id === id)
        if (project && manager.isBusy(project.path)) {
          throw new Error('这个项目里有任务在运行或排队，先等它们结束或中断它们。')
        }
        settings.removeProject(id)
        return projectChanged()
      },
      reveal: async (id) => {
        const project = settings.projects.find((p) => p.id === id)
        if (project) await shell.openPath(project.path)
      },
    },
    workspace: {
      status: async () => workspaceStatus(settings.workspace),
      scaffold: async (template) => {
        const result = await scaffoldWorkspace(current(), defaultsDir(), template)
        watch()
        send({ type: 'agents-changed' })
        return result
      },
      exportClaudeAgents: async () => exportClaudeAgents(current()),
      openInExplorer: async () => {
        await shell.openPath(current())
      },
    },
    agents: {
      list: async () => (settings.workspace ? listAgents(settings.workspace) : []),
      templates: async () => agentTemplates(defaultsDir()),
      save: async (detail) => {
        const saved: AgentDetail = saveAgent(current(), detail.config, detail.prompt)
        send({ type: 'agents-changed' })
        return saved
      },
      remove: async (id) => {
        const workspace = current()
        if (manager.states(workspace).some((s) => s.agentId === id && s.status !== 'idle')) {
          throw new Error('这个 Agent 有任务在运行或排队，不能删除。')
        }
        removeAgent(workspace, id)
        send({ type: 'agents-changed' })
      },
      duplicate: async (id, newId) => {
        const copy = duplicateAgent(current(), id, newId)
        send({ type: 'agents-changed' })
        return copy
      },
      states: async () => (settings.workspace ? manager.states(settings.workspace) : []),
      probeMcp: async (id) => {
        const detail = getAgent(current(), id)
        if (!detail || detail.error) return []
        return probeMcpServers(detail.config)
      },
    },
    tasks: {
      start: async (agentId, prompt) => {
        if (!settings.workspace) return { ok: false, error: '还没有打开项目。' }
        return manager.submit(settings.workspace, agentId, prompt, 'user')
      },
      interrupt: async (agentId) => manager.interrupt(current(), agentId),
      transcript: async (agentId) => manager.transcript(current(), agentId),
      newSession: async (agentId) => manager.newSession(current(), agentId),
      setMode: async (agentId, mode) => manager.setMode(current(), agentId, mode),
    },
    sessions: {
      list: async (agentId) => (settings.workspace ? store.listSessions(settings.workspace, agentId) : []),
      resume: async (agentId, sessionId, fork) => manager.resumeSession(current(), agentId, sessionId, fork),
    },
    approvals: {
      pending: async () => manager.pendingApprovals(),
      resolve: async (decision) => manager.resolveApproval(decision),
    },
    handoffs: {
      list: async () => (settings.workspace ? listHandoffs(settings.workspace) : []),
      dispatch: async (file, agentId) => {
        const workspace = current()
        const handoff = listHandoffs(workspace).find((h) => h.file === file)
        if (!handoff) return { ok: false, error: `找不到交接单：${file}` }
        const result = manager.submit(workspace, agentId, handoffPrompt(handoff), 'handoff')
        if (result.ok && handoff.status === 'open') setHandoffStatus(workspace, file, 'acknowledged')
        return result
      },
      setStatus: async (file, status) => setHandoffStatus(current(), file, status),
      create: async (input) => createHandoff(current(), input),
    },
    costs: {
      summary: async () =>
        settings.workspace
          ? store.costSummary(settings.workspace)
          : { totalUsd: 0, allProjectsMonthUsd: 0, monthUsd: 0, todayUsd: 0, taskCount: 0, byAgent: [], byDay: [], recent: [] },
    },
    updates: {
      status: async () => updates.status(),
      check: async () => updates.check(),
      install: async () => updates.install(),
      restart: async () => updates.restart(),
    },
    eda: {
      status: async () => edaStatus(),
      startBridge: async () => edaStatus(bridge.ensureRunning()),
      stopBridge: async () => {
        bridge.stop()
        await new Promise((resolve) => setTimeout(resolve, 300))
        return edaStatus()
      },
      installSkill: async () => {
        installSkill(current(), bundledSkillDir(), wsModuleDir)
        return edaStatus()
      },
    },
    overleaf: {
      link: async (url) => {
        const result = await linkOverleaf(current(), url)
        const project = settings.currentProject
        if (result.ok && project) {
          settings.setOverleafUrl(project.id, url)
          send({ type: 'settings-changed' })
        }
        return result
      },
      pull: async () => overleafSync(current(), 'pull'),
      push: async () => overleafSync(current(), 'push'),
    },
  }

  for (const [group, methods] of Object.entries(API_METHODS)) {
    for (const method of methods) {
      const fn = (handlers as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>)[group][method]
      ipcMain.handle(channelName(group, method), (_event, ...args) => fn(...args))
    }
  }

  mainWindow = createWindow()
  mainWindow.on('close', (event) => {
    // 还有任务在跑：关窗口等于把它们全部中断，先问一句
    if (quitting || updating || SMOKE || !manager.isBusy() || !mainWindow) return
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['继续运行', '中断并退出'],
      defaultId: 0,
      cancelId: 0,
      title: 'Nexus Agent',
      message: `还有 ${manager.activeTasks()} 个任务在运行或排队`,
      detail: '退出会中断它们。已经完成的步骤会留在会话记录里，之后可以从“历史会话”恢复。',
    })
    if (choice === 0) event.preventDefault()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  watch()

  // 启动后过一会儿检查一次更新，之后每 6 小时查一次；只提示，不自动下载
  if (canUpdate) {
    setTimeout(() => void updates.check(), 8000)
    setInterval(() => void updates.check(), 6 * 60 * 60 * 1000).unref()
  }

  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    stopWatching?.()
    bridge.stop()
    void manager.reset().finally(() => {
      store.close()
      app.quit()
    })
  })

  if (SMOKE) {
    // 打包后的自检：窗口能加载、预加载脚本生效、数据库可用、能找到 Claude Code 可执行文件和内置技能
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
          const bridgeOk = await win.webContents.executeJavaScript(
            'typeof window.nexus === "object" && typeof window.nexus.tasks.start === "function" && document.querySelector("#root").childElementCount > 0',
          )
          const skillDir = bundledSkillDir()
          const report = {
            bridge: bridgeOk,
            executable: executablePath ?? null,
            executableExists: executablePath ? fs.existsSync(executablePath) : false,
            defaults: fs.existsSync(path.join(defaultsDir(), 'agents', 'mech.yaml')),
            db: store.costSummary('smoke').taskCount === 0,
            skill: skillVersion(skillDir),
            // 打包后的技能目录里必须带着桥接脚本的依赖
            skillWs: app.isPackaged ? Boolean(skillDir && fs.existsSync(path.join(skillDir, 'node_modules', 'ws'))) : true,
            encryption: await safeStorage.isAsyncEncryptionAvailable(),
          }
          clearTimeout(timer)
          const ok =
            report.bridge === true && report.executableExists && report.defaults && report.db && report.skill !== null && report.skillWs
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
