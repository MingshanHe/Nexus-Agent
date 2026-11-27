import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, ProjectInfo, SettingsPatch } from '../shared/types'

// 应用设置存在用户数据目录的 settings.json：项目列表、当前项目、预算上限等。
// API Key 用系统的凭据加密（Windows 上是 DPAPI）后保存，明文不落盘，也不会发给界面。

export interface SecretBox {
  available(): Promise<boolean>
  encrypt(plain: string): Promise<string>
  decrypt(cipher: string): Promise<string>
}

interface Stored {
  projects: ProjectInfo[]
  currentProjectId: string | null
  apiKeyEncrypted: string | null
  defaultMaxBudgetUsd: number | null
  defaultMaxTurns: number | null
  monthlyBudgetUsd: number | null
  autoCommit: boolean
  notifications: boolean
}

const DEFAULTS: Stored = {
  projects: [],
  currentProjectId: null,
  apiKeyEncrypted: null,
  defaultMaxBudgetUsd: null,
  defaultMaxTurns: null,
  monthlyBudgetUsd: null,
  autoCommit: true,
  notifications: true,
}

function positiveOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a)
  const right = path.resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function folderName(dir: string): string {
  return path.basename(path.resolve(dir)) || dir
}

function readProjects(raw: unknown): ProjectInfo[] {
  if (!Array.isArray(raw)) return []
  const projects: ProjectInfo[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    if (typeof p.id !== 'string' || typeof p.path !== 'string' || !p.path) continue
    projects.push({
      id: p.id,
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : folderName(p.path),
      path: p.path,
      createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
      overleafGitUrl: typeof p.overleafGitUrl === 'string' && p.overleafGitUrl ? p.overleafGitUrl : null,
    })
  }
  return projects
}

export class SettingsStore {
  private data: Stored
  /** 解密后的 Key 只放在内存里 */
  private savedKey: string | null = null

  constructor(
    private file: string,
    private secrets: SecretBox,
    private appVersion = '0.0.0',
  ) {
    this.data = { ...DEFAULTS, projects: [] }
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
      const projects = readProjects(raw.projects)
      // 0.1.0 只有一个“工作区”：升级时把它变成第一个项目
      if (projects.length === 0 && typeof raw.workspace === 'string' && raw.workspace) {
        projects.push({
          id: randomUUID(),
          name: folderName(raw.workspace),
          path: raw.workspace,
          createdAt: Date.now(),
          overleafGitUrl: typeof raw.overleafGitUrl === 'string' && raw.overleafGitUrl ? raw.overleafGitUrl : null,
        })
      }
      const current = typeof raw.currentProjectId === 'string' ? raw.currentProjectId : null
      this.data = {
        projects,
        currentProjectId: projects.some((p) => p.id === current) ? current : (projects[0]?.id ?? null),
        apiKeyEncrypted: typeof raw.apiKeyEncrypted === 'string' ? raw.apiKeyEncrypted : null,
        defaultMaxBudgetUsd: positiveOrNull(raw.defaultMaxBudgetUsd),
        defaultMaxTurns: positiveOrNull(raw.defaultMaxTurns),
        monthlyBudgetUsd: positiveOrNull(raw.monthlyBudgetUsd),
        autoCommit: raw.autoCommit !== false,
        notifications: raw.notifications !== false,
      }
    } catch {
      // 第一次运行，或文件损坏：用默认值
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8')
  }

  // ---------- 项目 ----------

  get projects(): ProjectInfo[] {
    return this.data.projects
  }

  get currentProject(): ProjectInfo | null {
    return this.data.projects.find((p) => p.id === this.data.currentProjectId) ?? null
  }

  /** 当前项目的文件夹 */
  get workspace(): string | null {
    return this.currentProject?.path ?? null
  }

  projectByPath(dir: string): ProjectInfo | null {
    return this.data.projects.find((p) => samePath(p.path, dir)) ?? null
  }

  /** 加一个项目并切换过去；文件夹已经在列表里时只切换（并采用新名字）。 */
  addProject(input: { name: string; path: string }): ProjectInfo {
    const dir = path.resolve(input.path)
    const name = input.name.trim() || folderName(dir)
    let project = this.projectByPath(dir)
    if (project) {
      project.name = name
    } else {
      project = { id: randomUUID(), name, path: dir, createdAt: Date.now(), overleafGitUrl: null }
      this.data.projects.push(project)
    }
    this.data.currentProjectId = project.id
    this.persist()
    return project
  }

  openProject(id: string): ProjectInfo {
    const project = this.data.projects.find((p) => p.id === id)
    if (!project) throw new Error('找不到这个项目。')
    this.data.currentProjectId = id
    this.persist()
    return project
  }

  renameProject(id: string, name: string): void {
    const project = this.data.projects.find((p) => p.id === id)
    if (!project) throw new Error('找不到这个项目。')
    if (!name.trim()) throw new Error('项目名称不能为空。')
    project.name = name.trim()
    this.persist()
  }

  /** 只从列表里移除，磁盘上的文件不动。 */
  removeProject(id: string): void {
    this.data.projects = this.data.projects.filter((p) => p.id !== id)
    if (this.data.currentProjectId === id) this.data.currentProjectId = this.data.projects[0]?.id ?? null
    this.persist()
  }

  setOverleafUrl(id: string, url: string | null): void {
    const project = this.data.projects.find((p) => p.id === id)
    if (!project) return
    project.overleafGitUrl = url?.trim() || null
    this.persist()
  }

  // ---------- API Key ----------

  /** 启动时调用一次：把保存的 Key 解密到内存。 */
  async init(): Promise<void> {
    this.savedKey = null
    if (!this.data.apiKeyEncrypted) return
    try {
      if (await this.secrets.available()) {
        this.savedKey = (await this.secrets.decrypt(this.data.apiKeyEncrypted)) || null
      }
    } catch {
      // 换了系统账号或凭据失效：当作没有保存
    }
  }

  /** 给 SDK 子进程用的 Key：应用里保存的优先，其次是环境变量。 */
  apiKey(): string | null {
    return this.savedKey ?? (process.env.ANTHROPIC_API_KEY?.trim() || null)
  }

  private apiKeySource(): AppSettings['apiKeySource'] {
    if (this.savedKey) return 'app'
    return process.env.ANTHROPIC_API_KEY?.trim() ? 'env' : 'none'
  }

  async setApiKey(key: string): Promise<void> {
    const trimmed = key.trim()
    if (!trimmed) throw new Error('API Key 不能为空。')
    if (!(await this.secrets.available())) {
      throw new Error('这台电脑上系统加密不可用，无法安全保存 Key。请改用环境变量 ANTHROPIC_API_KEY。')
    }
    this.data.apiKeyEncrypted = await this.secrets.encrypt(trimmed)
    this.savedKey = trimmed
    this.persist()
  }

  clearApiKey(): void {
    this.data.apiKeyEncrypted = null
    this.savedKey = null
    this.persist()
  }

  // ---------- 其他设置 ----------

  update(patch: SettingsPatch): void {
    if ('defaultMaxBudgetUsd' in patch) this.data.defaultMaxBudgetUsd = positiveOrNull(patch.defaultMaxBudgetUsd)
    if ('defaultMaxTurns' in patch) {
      const turns = positiveOrNull(patch.defaultMaxTurns)
      this.data.defaultMaxTurns = turns === null ? null : Math.floor(turns)
    }
    if ('monthlyBudgetUsd' in patch) this.data.monthlyBudgetUsd = positiveOrNull(patch.monthlyBudgetUsd)
    if ('autoCommit' in patch) this.data.autoCommit = patch.autoCommit !== false
    if ('notifications' in patch) this.data.notifications = patch.notifications !== false
    this.persist()
  }

  get autoCommit(): boolean {
    return this.data.autoCommit
  }
  get notifications(): boolean {
    return this.data.notifications
  }
  get defaultMaxBudgetUsd(): number | null {
    return this.data.defaultMaxBudgetUsd
  }
  get defaultMaxTurns(): number | null {
    return this.data.defaultMaxTurns
  }
  get monthlyBudgetUsd(): number | null {
    return this.data.monthlyBudgetUsd
  }

  /** 发给界面的视图：不含 Key 本身。 */
  view(): AppSettings {
    const source = this.apiKeySource()
    const current = this.currentProject
    return {
      workspace: current?.path ?? null,
      currentProjectId: current?.id ?? null,
      projects: this.data.projects.map((p) => ({ ...p })),
      appVersion: this.appVersion,
      hasApiKey: source !== 'none',
      apiKeySource: source,
      defaultMaxBudgetUsd: this.data.defaultMaxBudgetUsd,
      defaultMaxTurns: this.data.defaultMaxTurns,
      monthlyBudgetUsd: this.data.monthlyBudgetUsd,
      autoCommit: this.data.autoCommit,
      overleafGitUrl: current?.overleafGitUrl ?? null,
      notifications: this.data.notifications,
    }
  }
}
