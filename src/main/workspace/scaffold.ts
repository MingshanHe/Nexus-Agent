import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { AgentConfig, AgentDetail, GitResult, McpStatus, ProjectTemplate, WorkspaceStatus } from '../../shared/types'
import { agentsDir, listAgents, NEXUS_DIR, parseAgentYaml } from '../agents/config'
import { git, isGitRepo, isRepoRoot } from '../git/git'

// 工作区 = 所有 Agent 共享的项目仓库。这里负责按模板建目录、导出阶段 0 用的 Claude Code 定义、
// 探测 MCP 端口，以及把 paper/ 关联到 Overleaf 的 Git 仓库。

function copyTree(from: string, to: string, created: string[], root: string): number {
  let skipped = 0
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    // 模板里的 gitignore 不能叫 .gitignore，否则会在本项目自己的仓库里生效
    const targetName = entry.name === 'gitignore.template' ? '.gitignore' : entry.name
    const target = path.join(to, targetName)
    if (entry.isDirectory()) {
      skipped += copyTree(source, target, created, root)
    } else if (fs.existsSync(target)) {
      skipped += 1 // 已有的文件一律不覆盖
    } else {
      fs.copyFileSync(source, target)
      created.push(path.relative(root, target).replace(/\\/g, '/'))
    }
  }
  return skipped
}

/**
 * 按模板建项目。已有的文件一律不覆盖，所以对已有的文件夹重复执行是安全的。
 *   robot：机器人研发的目录结构，加四个专业 Agent 和一个总控
 *   blank：只有项目总览和交接单目录，Agent 之后自己加
 */
export async function scaffoldWorkspace(
  workspace: string,
  defaultsDir: string,
  template: ProjectTemplate = 'robot',
): Promise<{ created: string[]; skipped: number }> {
  const created: string[] = []
  let skipped = 0
  fs.mkdirSync(workspace, { recursive: true })
  if (template === 'robot') {
    skipped += copyTree(path.join(defaultsDir, 'workspace'), workspace, created, workspace)
    skipped += copyTree(path.join(defaultsDir, 'agents'), agentsDir(workspace), created, workspace)
    skipped += copyTree(path.join(defaultsDir, 'prompts'), path.join(workspace, NEXUS_DIR, 'prompts'), created, workspace)
  } else {
    skipped += copyTree(path.join(defaultsDir, 'workspace-blank'), workspace, created, workspace)
    skipped += copyTree(path.join(defaultsDir, 'workspace', 'handoff'), path.join(workspace, 'handoff'), created, workspace)
    fs.mkdirSync(agentsDir(workspace), { recursive: true })
  }
  if (!(await isGitRepo(workspace))) {
    const init = await git(workspace, ['init'])
    if (init.ok) created.push('.git/（已执行 git init）')
  }
  return { created, skipped }
}

/** 自带的 Agent 模板：新建 Agent 时可以从它们开始。 */
export function agentTemplates(defaultsDir: string): AgentDetail[] {
  const dir = path.join(defaultsDir, 'agents')
  const templates: AgentDetail[] = []
  for (const file of fs.readdirSync(dir).sort()) {
    if (!/\.ya?ml$/i.test(file)) continue
    const id = file.replace(/\.ya?ml$/i, '')
    try {
      const config = parseAgentYaml(id, fs.readFileSync(path.join(dir, file), 'utf8'))
      const promptFile = path.join(defaultsDir, config.system_prompt ?? `prompts/${id}.md`)
      templates.push({ config, prompt: fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '' })
    } catch {
      // 模板随应用发布，这里不应该出错；出错就跳过这一个
    }
  }
  return templates
}

export async function workspaceStatus(workspace: string | null): Promise<WorkspaceStatus> {
  if (!workspace) return { path: null, exists: false, initialized: false, isGitRepo: false, agentCount: 0 }
  const exists = fs.existsSync(workspace)
  const agents = exists ? listAgents(workspace) : []
  return {
    path: workspace,
    exists,
    initialized: agents.length > 0,
    isGitRepo: exists ? await isGitRepo(workspace) : false,
    agentCount: agents.length,
  }
}

/**
 * 把 Agent 配置导出成 .claude/agents/<id>.md。
 * 阶段 0 直接在 Claude Code 里试四个角色时用；提示词和这里的管理软件是同一份。
 */
export function exportClaudeAgents(workspace: string): { written: string[] } {
  const dir = path.join(workspace, '.claude', 'agents')
  fs.mkdirSync(dir, { recursive: true })
  const written: string[] = []
  for (const detail of listAgents(workspace)) {
    if (detail.error || detail.config.role === 'orchestrator') continue
    const { config, prompt } = detail
    const description = (config.description || config.name).replace(/\s+/g, ' ')
    const text = [
      '---',
      `name: ${config.id}`,
      `description: ${JSON.stringify(description)}`,
      `model: ${config.model}`,
      '---',
      '',
      `<!-- 由 Nexus Agent 从 .nexus/agents/${config.id}.yaml 导出，改提示词请改 .nexus/prompts/ 后重新导出 -->`,
      '',
      prompt.trim(),
      '',
    ].join('\n')
    const file = path.join(dir, `${config.id}.md`)
    fs.writeFileSync(file, text, 'utf8')
    written.push(path.relative(workspace, file).replace(/\\/g, '/'))
  }
  return { written }
}

function probePort(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const finish = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** 不启动会话，只看 MCP 服务的端口通不通。真正的连接状态以任务启动时 SDK 报告的为准。 */
export async function probeMcpServers(config: AgentConfig): Promise<McpStatus[]> {
  const results: McpStatus[] = []
  for (const [name, spec] of Object.entries(config.mcp_servers ?? {})) {
    if (spec.type === 'stdio') {
      results.push({ name, status: 'stdio' })
      continue
    }
    try {
      const url = new URL(spec.url ?? '')
      const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
      const ok = await probePort(url.hostname, port)
      results.push({ name, status: ok ? 'reachable' : 'unreachable', error: ok ? undefined : `${url.host} 没有响应` })
    } catch {
      results.push({ name, status: 'unreachable', error: 'url 无效' })
    }
  }
  return results
}

// ---------- Overleaf ----------
// Overleaf 没有公开的编辑 API，官方给的程序化入口是 Git 集成（付费功能）：
// 每个项目有一个 https://git.overleaf.com/<项目 id> 仓库。这里把它克隆成工作区里的 paper/。
// 认证由系统的 Git 凭据管理器处理，本应用不接触 Overleaf 的令牌。

const PAPER_DIR = 'paper'

function ensureIgnored(workspace: string, entry: string): void {
  const file = path.join(workspace, '.gitignore')
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (current.split(/\r?\n/).some((line) => line.trim() === entry)) return
  const prefix = current && !current.endsWith('\n') ? '\n' : ''
  fs.writeFileSync(file, `${current}${prefix}# paper/ 是关联 Overleaf 的独立仓库\n${entry}\n`, 'utf8')
}

export async function linkOverleaf(workspace: string, url: string): Promise<GitResult> {
  const trimmed = url.trim()
  if (!/^https:\/\/[^\s]+$/.test(trimmed)) {
    return { ok: false, output: '请填写 https 开头的 Git 地址，例如 https://git.overleaf.com/<项目 id>' }
  }
  if (new URL(trimmed).username || new URL(trimmed).password) {
    return { ok: false, output: '地址里不要带用户名或令牌；认证交给系统的 Git 凭据管理器。' }
  }
  const paper = path.join(workspace, PAPER_DIR)
  if (await isRepoRoot(paper)) {
    const result = await git(paper, ['remote', 'set-url', 'origin', trimmed])
    if (result.ok) ensureIgnored(workspace, `/${PAPER_DIR}/`)
    return result.ok ? { ok: true, output: 'paper/ 已经是独立仓库，已把 origin 指向这个地址。' } : result
  }
  // paper/ 里已有的文件不删：整个目录改名留作备份，再把 Overleaf 项目克隆到 paper/
  let backup: string | null = null
  if (fs.existsSync(paper)) {
    if (fs.readdirSync(paper).length > 0) {
      backup = `${PAPER_DIR}-before-overleaf-${Date.now()}`
      fs.renameSync(paper, path.join(workspace, backup))
    } else {
      fs.rmdirSync(paper)
    }
  }
  const clone = await git(workspace, ['clone', trimmed, PAPER_DIR], 300_000)
  if (!clone.ok) {
    // 克隆失败：把原来的目录放回去
    if (backup) {
      fs.rmSync(paper, { recursive: true, force: true })
      fs.renameSync(path.join(workspace, backup), paper)
    }
    return clone
  }
  ensureIgnored(workspace, `/${PAPER_DIR}/`)
  const note = backup ? `\n原来的 paper/ 已改名为 ${backup}/，需要的文件请手动挪回去。` : ''
  return { ok: true, output: `${clone.output}${note}`.trim() }
}

export async function overleafSync(workspace: string, direction: 'pull' | 'push'): Promise<GitResult> {
  const paper = path.join(workspace, PAPER_DIR)
  if (!(await isRepoRoot(paper))) return { ok: false, output: 'paper/ 还没有关联 Overleaf 的 Git 仓库。' }
  return direction === 'pull'
    ? git(paper, ['pull', '--rebase', '--autostash'], 300_000)
    : git(paper, ['push'], 300_000)
}
