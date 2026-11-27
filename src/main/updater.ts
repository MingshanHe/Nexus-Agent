import type { UpdateState } from '../shared/types'

// 软件内更新：从 GitHub Releases 检查、下载、重启安装（electron-updater + NSIS）。
// 这里只管状态机；真正的 autoUpdater 由 index.ts 注入，测试里用假的。

/** electron-updater 的 autoUpdater 里我们用到的部分 */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: string, listener: (...args: any[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdateServiceOptions {
  currentVersion: string
  /** 只有安装版才能更新；开发模式和解压即用的版本不行 */
  supported: boolean
  onChange(state: UpdateState): void
  /** 现在重启会不会打断任务 */
  isBusy(): boolean
  /** 重启安装之前要做的事（例如标记正在退出） */
  beforeRestart?(): void
}

function notesText(notes: unknown): string | null {
  if (typeof notes === 'string') return notes.replace(/<[^>]+>/g, '').trim() || null
  if (Array.isArray(notes)) {
    const text = notes
      .map((item) => (item && typeof item === 'object' && typeof (item as { note?: unknown }).note === 'string' ? (item as { note: string }).note : ''))
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim()
    return text || null
  }
  return null
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  // electron-updater 的报错常常带着一整段 HTTP 头，只留第一行
  const first = text.split('\n')[0].trim()
  if (/404|latest\.yml|Cannot find/i.test(text)) return '没有找到可用的更新信息（发布页上可能还没有新版本的更新文件）。'
  if (/ENOTFOUND|ETIMEDOUT|ECONNRE|net::|getaddrinfo/i.test(text)) return '连不上 GitHub，检查网络后再试。'
  return first.length > 200 ? `${first.slice(0, 200)}…` : first
}

export class UpdateService {
  private state: UpdateState
  /** 用户点了“更新”：下载完就自动重启安装（如果没有任务在跑） */
  private installWhenReady = false

  constructor(
    private updater: UpdaterLike | null,
    private options: UpdateServiceOptions,
  ) {
    this.state = {
      phase: updater && options.supported ? 'idle' : 'unsupported',
      currentVersion: options.currentVersion,
      latestVersion: null,
      percent: 0,
      notes: null,
      error: null,
      checkedAt: null,
    }
    if (!updater || !options.supported) return
    // 下载由用户点“更新”触发，不在后台偷偷下几百 MB
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = true
    updater.on('update-available', (info: { version?: string; releaseNotes?: unknown }) => {
      this.set({ phase: 'available', latestVersion: info?.version ?? null, notes: notesText(info?.releaseNotes), error: null, checkedAt: Date.now() })
    })
    updater.on('update-not-available', (info: { version?: string }) => {
      this.set({ phase: 'up-to-date', latestVersion: info?.version ?? this.state.currentVersion, error: null, checkedAt: Date.now() })
    })
    updater.on('download-progress', (progress: { percent?: number }) => {
      this.set({ phase: 'downloading', percent: Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0))) })
    })
    updater.on('update-downloaded', (info: { version?: string }) => {
      this.set({ phase: 'ready', percent: 100, latestVersion: info?.version ?? this.state.latestVersion })
      if (this.installWhenReady && !this.options.isBusy()) this.restart()
    })
    updater.on('error', (error: unknown) => {
      this.installWhenReady = false
      this.set({ phase: 'error', error: errorMessage(error), checkedAt: Date.now() })
    })
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.options.onChange(this.state)
  }

  /** 状态会在 await 期间被事件改掉，读的时候不要让类型收窄记住旧值 */
  private phase(): UpdateState['phase'] {
    return this.state.phase
  }

  status(): UpdateState {
    return this.state
  }

  async check(): Promise<UpdateState> {
    if (!this.updater || this.state.phase === 'unsupported') return this.state
    if (this.state.phase === 'checking' || this.state.phase === 'downloading' || this.state.phase === 'ready') return this.state
    this.set({ phase: 'checking', error: null })
    try {
      await this.updater.checkForUpdates()
    } catch (error) {
      this.set({ phase: 'error', error: errorMessage(error), checkedAt: Date.now() })
    }
    // 检查结果由事件写进状态；万一一个事件都没来，不要一直停在“检查中”
    if (this.phase() === 'checking') this.set({ phase: 'up-to-date', checkedAt: Date.now() })
    return this.state
  }

  /** 一键更新：下载新版本，下载完且没有任务在跑时自动重启安装。 */
  async install(): Promise<UpdateState> {
    if (!this.updater || this.state.phase === 'unsupported') return this.state
    if (this.state.phase === 'ready') {
      if (!this.options.isBusy()) this.restart()
      return this.state
    }
    if (this.state.phase === 'downloading') return this.state
    if (this.state.phase !== 'available') {
      await this.check()
      if (this.phase() !== 'available') return this.state
    }
    this.installWhenReady = true
    this.set({ phase: 'downloading', percent: 0, error: null })
    try {
      await this.updater.downloadUpdate()
    } catch (error) {
      this.installWhenReady = false
      this.set({ phase: 'error', error: errorMessage(error) })
    }
    return this.state
  }

  /** 新版本已经下载好：退出并安装，装完自动重新打开。 */
  restart(): void {
    if (!this.updater || this.state.phase !== 'ready') return
    this.options.beforeRestart?.()
    this.updater.quitAndInstall(true, true)
  }
}
