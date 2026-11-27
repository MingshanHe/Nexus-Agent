import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, SettingsPatch } from '../shared/types'

// 应用设置存在用户数据目录的 settings.json。
// API Key 用系统的凭据加密（Windows 上是 DPAPI）后保存，明文不落盘，也不会发给界面。

export interface SecretBox {
  available(): Promise<boolean>
  encrypt(plain: string): Promise<string>
  decrypt(cipher: string): Promise<string>
}

interface Stored {
  workspace: string | null
  apiKeyEncrypted: string | null
  defaultMaxBudgetUsd: number | null
  defaultMaxTurns: number | null
  monthlyBudgetUsd: number | null
  autoCommit: boolean
  overleafGitUrl: string | null
}

const DEFAULTS: Stored = {
  workspace: null,
  apiKeyEncrypted: null,
  defaultMaxBudgetUsd: null,
  defaultMaxTurns: null,
  monthlyBudgetUsd: null,
  autoCommit: true,
  overleafGitUrl: null,
}

function positiveOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export class SettingsStore {
  private data: Stored
  /** 解密后的 Key 只放在内存里 */
  private savedKey: string | null = null

  constructor(
    private file: string,
    private secrets: SecretBox,
  ) {
    this.data = { ...DEFAULTS }
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Stored>
      this.data = {
        workspace: typeof raw.workspace === 'string' ? raw.workspace : null,
        apiKeyEncrypted: typeof raw.apiKeyEncrypted === 'string' ? raw.apiKeyEncrypted : null,
        defaultMaxBudgetUsd: positiveOrNull(raw.defaultMaxBudgetUsd),
        defaultMaxTurns: positiveOrNull(raw.defaultMaxTurns),
        monthlyBudgetUsd: positiveOrNull(raw.monthlyBudgetUsd),
        autoCommit: raw.autoCommit !== false,
        overleafGitUrl: typeof raw.overleafGitUrl === 'string' && raw.overleafGitUrl ? raw.overleafGitUrl : null,
      }
    } catch {
      // 第一次运行，或文件损坏：用默认值
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8')
  }

  get workspace(): string | null {
    return this.data.workspace
  }

  setWorkspace(dir: string | null): void {
    this.data.workspace = dir
    this.persist()
  }

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

  update(patch: SettingsPatch): void {
    if ('defaultMaxBudgetUsd' in patch) this.data.defaultMaxBudgetUsd = positiveOrNull(patch.defaultMaxBudgetUsd)
    if ('defaultMaxTurns' in patch) {
      const turns = positiveOrNull(patch.defaultMaxTurns)
      this.data.defaultMaxTurns = turns === null ? null : Math.floor(turns)
    }
    if ('monthlyBudgetUsd' in patch) this.data.monthlyBudgetUsd = positiveOrNull(patch.monthlyBudgetUsd)
    if ('autoCommit' in patch) this.data.autoCommit = patch.autoCommit !== false
    if ('overleafGitUrl' in patch) this.data.overleafGitUrl = patch.overleafGitUrl?.trim() || null
    this.persist()
  }

  get autoCommit(): boolean {
    return this.data.autoCommit
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
  get overleafGitUrl(): string | null {
    return this.data.overleafGitUrl
  }

  /** 发给界面的视图：不含 Key 本身。 */
  view(): AppSettings {
    const source = this.apiKeySource()
    return {
      workspace: this.data.workspace,
      hasApiKey: source !== 'none',
      apiKeySource: source,
      defaultMaxBudgetUsd: this.data.defaultMaxBudgetUsd,
      defaultMaxTurns: this.data.defaultMaxTurns,
      monthlyBudgetUsd: this.data.monthlyBudgetUsd,
      autoCommit: this.data.autoCommit,
      overleafGitUrl: this.data.overleafGitUrl,
    }
  }
}
