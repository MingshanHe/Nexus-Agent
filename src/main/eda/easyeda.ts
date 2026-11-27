import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AgentConfig } from '../../shared/types'

// 嘉立创官方的 EasyEDA API Skill（https://github.com/easyeda/easyeda-api-skill，MIT）随应用内置：
//   - 技能本身（API 文档、代码范式）在任务启动前装进项目的 .claude/skills/easyeda-api/
//   - 它的桥接服务（scripts/bridge-server.mjs）由本应用用自带的运行时拉起，用户不需要另装 Node
// Agent 按技能文档先找已经在跑的桥接服务，找到就直接用，所以两边不会重复启动。

export const EASYEDA_SKILL = 'easyeda-api'
const PORT_START = 49620
const PORT_END = 49629
const SERVICE_ID = 'easyeda-bridge'
const IGNORE_ENTRY = `/.claude/skills/${EASYEDA_SKILL}/`

export function usesEasyedaSkill(config: Pick<AgentConfig, 'skills'>): boolean {
  return Array.isArray(config.skills) && config.skills.includes(EASYEDA_SKILL)
}

export function installedSkillDir(workspace: string): string {
  return path.join(workspace, '.claude', 'skills', EASYEDA_SKILL)
}

export function skillVersion(dir: string | null): string | null {
  if (!dir) return null
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' && fs.existsSync(path.join(dir, 'SKILL.md')) ? pkg.version : null
  } catch {
    return null
  }
}

function ensureIgnored(workspace: string): void {
  const file = path.join(workspace, '.gitignore')
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (current.split(/\r?\n/).some((line) => line.trim() === IGNORE_ENTRY)) return
  const prefix = current && !current.endsWith('\n') ? '\n' : ''
  fs.writeFileSync(file, `${current}${prefix}# Nexus Agent 内置的技能，由应用安装和更新\n${IGNORE_ENTRY}\n`, 'utf8')
}

export interface SkillInstallResult {
  /** 这次调用是否复制了文件 */
  changed: boolean
  version: string | null
}

/**
 * 把内置的技能装进项目。项目里已经是同一个版本时什么都不做；版本不同就整个替换。
 * wsModuleDir 是 ws 包所在的目录：技能自带的桥接脚本依赖它（打包后的内置技能里已经带了）。
 */
export function installSkill(workspace: string, bundledDir: string | null, wsModuleDir?: string | null): SkillInstallResult {
  const bundledVersion = skillVersion(bundledDir)
  if (!bundledDir || !bundledVersion) throw new Error('应用里没有找到内置的 EasyEDA API Skill。')
  const target = installedSkillDir(workspace)
  if (skillVersion(target) === bundledVersion) return { changed: false, version: bundledVersion }

  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(bundledDir, target, { recursive: true, filter: (file) => path.basename(file) !== '.git' })
  const wsTarget = path.join(target, 'node_modules', 'ws')
  if (!fs.existsSync(wsTarget) && wsModuleDir && fs.existsSync(wsModuleDir)) {
    fs.cpSync(wsModuleDir, wsTarget, { recursive: true })
  }
  ensureIgnored(workspace)
  return { changed: true, version: bundledVersion }
}

// ---------- 桥接服务 ----------

export interface BridgeProbe {
  running: boolean
  port: number | null
  managed: boolean
  windows: number
  error?: string
}

function getJson(port: number, route: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: route, timeout: timeoutMs }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        if (body.length < 100_000) body += chunk
      })
      response.on('end', () => {
        try {
          const parsed: unknown = JSON.parse(body)
          resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null)
        } catch {
          resolve(null)
        }
      })
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(null))
  })
}

async function findBridgePort(timeoutMs = 500): Promise<number | null> {
  const ports = Array.from({ length: PORT_END - PORT_START + 1 }, (_, i) => PORT_START + i)
  const found = await Promise.all(
    ports.map(async (port) => ((await getJson(port, '/health', timeoutMs))?.service === SERVICE_ID ? port : null)),
  )
  return found.find((port) => port !== null) ?? null
}

export class EdaBridge {
  private child: ChildProcess | null = null
  private lastError: string | undefined

  constructor(
    private options: {
      /** 内置技能所在的目录（里面有 scripts/bridge-server.mjs） */
      skillDir(): string | null
      /** 用来跑脚本的可执行文件：Electron 自己（带 ELECTRON_RUN_AS_NODE）或 node */
      execPath: string
    },
  ) {}

  async probe(): Promise<BridgeProbe> {
    const port = await findBridgePort()
    if (port === null) {
      return { running: false, port: null, managed: false, windows: 0, error: this.lastError }
    }
    const info = await getJson(port, '/eda-windows', 800)
    const windows = typeof info?.count === 'number' ? info.count : Array.isArray(info?.windows) ? info.windows.length : 0
    return { running: true, port, managed: this.child !== null && this.child.exitCode === null, windows }
  }

  /** 已经有桥接服务在跑（不管是谁启动的）就直接用；没有才启动一个。 */
  async ensureRunning(): Promise<BridgeProbe> {
    const before = await this.probe()
    if (before.running) return before
    const skillDir = this.options.skillDir()
    const script = skillDir ? path.join(skillDir, 'scripts', 'bridge-server.mjs') : null
    if (!script || !fs.existsSync(script)) {
      this.lastError = '没有找到内置的桥接脚本。'
      return { ...before, error: this.lastError }
    }
    this.lastError = undefined
    const child = spawn(this.options.execPath, [script], {
      cwd: path.dirname(script),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString()
    })
    child.on('error', (error) => {
      this.lastError = `桥接服务没有启动：${error.message}`
    })
    child.on('exit', (code) => {
      if (this.child === child) this.child = null
      if (code) this.lastError = `桥接服务退出了（代码 ${code}）。${stderr.trim().split('\n').slice(-2).join(' ')}`
    })

    const deadline = Date.now() + 6000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const status = await this.probe()
      if (status.running) return status
      if (child.exitCode !== null) break
    }
    return { running: false, port: null, managed: false, windows: 0, error: this.lastError ?? '桥接服务在 6 秒内没有就绪。' }
  }

  /** 只停本应用启动的那个；别处启动的不动。 */
  stop(): void {
    const child = this.child
    this.child = null
    if (child && child.exitCode === null) child.kill()
  }
}
