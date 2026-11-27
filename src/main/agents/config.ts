import fs from 'node:fs'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import { z } from 'zod'
import type { AgentConfig, AgentDetail } from '../../shared/types'

// 一个 Agent 就是一份配置文件。新增 Agent 只加文件，不改代码。
//   <工作区>/.nexus/agents/<id>.yaml   配置
//   <工作区>/.nexus/prompts/<id>.md    系统提示词

export const NEXUS_DIR = '.nexus'
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/

const mcpServerSchema = z
  .object({
    type: z.enum(['http', 'sse', 'stdio']),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .refine((s) => (s.type === 'stdio' ? !!s.command : !!s.url), {
    message: 'http/sse 类型需要 url，stdio 类型需要 command',
  })

const agentSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    role: z.enum(['specialist', 'orchestrator']).optional(),
    model: z.string().min(1),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    permission_mode: z.enum(['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions']).optional(),
    cwd: z.string().optional(),
    system_prompt: z.string().optional(),
    mcp_servers: z.record(z.string(), mcpServerSchema).optional(),
    allowed_tools: z.array(z.string()).optional(),
    disallowed_tools: z.array(z.string()).optional(),
    always_ask: z.array(z.string()).optional(),
    skills: z.union([z.array(z.string()), z.literal('all')]).optional(),
    setting_sources: z.array(z.enum(['user', 'project', 'local'])).optional(),
    resource: z.string().optional(),
    max_turns: z.number().int().positive().optional(),
    max_budget_usd: z.number().positive().optional(),
    git: z
      .object({ paths: z.array(z.string()).optional(), repo: z.string().optional() })
      .strict()
      .optional(),
  })
  .strict()

export function isValidAgentId(id: string): boolean {
  return ID_PATTERN.test(id)
}

export function agentsDir(workspace: string): string {
  return path.join(workspace, NEXUS_DIR, 'agents')
}

function agentFile(workspace: string, id: string): string {
  return path.join(agentsDir(workspace), `${id}.yaml`)
}

function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
    .join('；')
}

export function parseAgentYaml(id: string, text: string): AgentConfig {
  const raw: unknown = parse(text)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('配置文件必须是一个 YAML 对象')
  }
  const result = agentSchema.safeParse(raw)
  if (!result.success) throw new Error(describeZodError(result.error))
  return { id, ...result.data }
}

export function serializeAgent(config: AgentConfig): string {
  const { id: _id, ...rest } = config
  const result = agentSchema.safeParse(rest)
  if (!result.success) throw new Error(describeZodError(result.error))
  return stringify(pruneEmpty(result.data), { lineWidth: 0 })
}

/** 去掉空数组、空对象和空字符串，让保存出来的文件保持干净。 */
function pruneEmpty<T>(value: T): T {
  if (Array.isArray(value)) return value as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined || item === null || item === '') continue
      if (Array.isArray(item) && item.length === 0) continue
      if (typeof item === 'object' && !Array.isArray(item)) {
        const nested = pruneEmpty(item)
        if (Object.keys(nested as object).length === 0) continue
        out[key] = nested
        continue
      }
      out[key] = item
    }
    return out as T
  }
  return value
}

/** 提示词文件路径：相对 .nexus/ 目录，且不允许跳出工作区。 */
export function promptPath(workspace: string, config: Pick<AgentConfig, 'id' | 'system_prompt'>): string {
  const relative = config.system_prompt || `prompts/${config.id}.md`
  const base = path.join(workspace, NEXUS_DIR)
  const resolved = path.resolve(base, relative)
  const rel = path.relative(workspace, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`system_prompt 必须在工作区内：${relative}`)
  }
  return resolved
}

export function readPrompt(workspace: string, config: Pick<AgentConfig, 'id' | 'system_prompt'>): string {
  try {
    return fs.readFileSync(promptPath(workspace, config), 'utf8')
  } catch {
    return ''
  }
}

/** Agent 的工作目录：默认是工作区根目录。 */
export function resolveAgentCwd(workspace: string, config: Pick<AgentConfig, 'cwd'>): string {
  if (!config.cwd) return workspace
  return path.isAbsolute(config.cwd) ? config.cwd : path.resolve(workspace, config.cwd)
}

export function listAgents(workspace: string): AgentDetail[] {
  const dir = agentsDir(workspace)
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f))
  } catch {
    return []
  }
  const details: AgentDetail[] = []
  for (const file of files.sort()) {
    const id = file.replace(/\.ya?ml$/i, '')
    const text = fs.readFileSync(path.join(dir, file), 'utf8')
    try {
      const config = parseAgentYaml(id, text)
      details.push({ config, prompt: readPrompt(workspace, config) })
    } catch (error) {
      details.push({
        config: { id, name: id, model: '' },
        prompt: '',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  // 总控排在最后，其余按文件名
  return details.sort((a, b) => {
    const ra = a.config.role === 'orchestrator' ? 1 : 0
    const rb = b.config.role === 'orchestrator' ? 1 : 0
    return ra - rb || a.config.id.localeCompare(b.config.id)
  })
}

export function getAgent(workspace: string, id: string): AgentDetail | null {
  return listAgents(workspace).find((a) => a.config.id === id) ?? null
}

export function saveAgent(workspace: string, config: AgentConfig, prompt: string): AgentDetail {
  if (!isValidAgentId(config.id)) {
    throw new Error('Agent 的 id 只能用小写字母、数字、- 和 _，并以字母或数字开头')
  }
  const normalized: AgentConfig = {
    ...config,
    system_prompt: config.system_prompt || `prompts/${config.id}.md`,
  }
  const yamlText = serializeAgent(normalized)
  const file = agentFile(workspace, config.id)
  const promptFile = promptPath(workspace, normalized)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.mkdirSync(path.dirname(promptFile), { recursive: true })
  fs.writeFileSync(file, yamlText, 'utf8')
  fs.writeFileSync(promptFile, prompt, 'utf8')
  return { config: normalized, prompt }
}

export function removeAgent(workspace: string, id: string): void {
  const detail = getAgent(workspace, id)
  fs.rmSync(agentFile(workspace, id), { force: true })
  if (detail && !detail.error) {
    // 提示词只在没有别的 Agent 共用时才删
    const mine = promptPath(workspace, detail.config)
    const shared = listAgents(workspace).some(
      (other) => !other.error && promptPath(workspace, other.config) === mine,
    )
    if (!shared) fs.rmSync(mine, { force: true })
  }
}

export function duplicateAgent(workspace: string, id: string, newId: string): AgentDetail {
  if (!isValidAgentId(newId)) {
    throw new Error('新 id 只能用小写字母、数字、- 和 _，并以字母或数字开头')
  }
  if (fs.existsSync(agentFile(workspace, newId))) throw new Error(`已经有名为 ${newId} 的 Agent`)
  const source = getAgent(workspace, id)
  if (!source || source.error) throw new Error(`找不到可复制的 Agent：${id}`)
  const config: AgentConfig = {
    ...source.config,
    id: newId,
    name: `${source.config.name}（副本）`,
    system_prompt: `prompts/${newId}.md`,
  }
  return saveAgent(workspace, config, source.prompt)
}

/** 把规则加进 Agent 的自动放行名单（“一直允许”写入配置）。返回实际新增的规则。 */
export function addAllowedRules(workspace: string, id: string, rules: string[]): string[] {
  const detail = getAgent(workspace, id)
  if (!detail || detail.error) return []
  const existing = detail.config.allowed_tools ?? []
  const added = rules.filter((rule) => rule && !existing.includes(rule))
  if (added.length === 0) return []
  saveAgent(workspace, { ...detail.config, allowed_tools: [...existing, ...added] }, detail.prompt)
  return added
}
