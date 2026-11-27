import os from 'node:os'
import path from 'node:path'

// 本文件只做一件事：判断一次工具调用是否命中某条规则。
// 自动放行（allowed_tools）和拒绝（disallowed_tools）由 Claude Code 自己按同样的语法判定；
// 这里的匹配用于 always_ask 的兜底检查，以及决定审批窗能不能给“一直允许”。
// 所以拿不准时宁可判为命中（多问一次），不能判为不命中。

export interface ParsedRule {
  tool: string
  spec?: string
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const PATH_TOOLS = new Set([...WRITE_TOOLS, 'Read'])

export function parseRule(rule: string): ParsedRule {
  const trimmed = rule.trim()
  const open = trimmed.indexOf('(')
  if (open > 0 && trimmed.endsWith(')')) {
    return { tool: trimmed.slice(0, open).trim(), spec: trimmed.slice(open + 1, -1).trim() }
  }
  return { tool: trimmed }
}

export function formatRule(rule: { toolName: string; ruleContent?: string }): string {
  return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

/** `*` 匹配任意字符（含空格和斜杠）。用于工具名和命令行。 */
export function wildcardToRegExp(pattern: string, flags = 's'): RegExp {
  const body = pattern.split('*').map(escapeRegExp).join('.*')
  return new RegExp(`^${body}$`, flags)
}

/** 路径通配：`**` 跨目录，`*` 不跨目录。 */
export function pathGlobToRegExp(glob: string, flags = ''): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += escapeRegExp(ch)
    }
  }
  return new RegExp(`^${out}$`, flags)
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

/** 把规则里的路径模式换成绝对路径模式：`//x` 是绝对路径，`/x` 和 `x` 相对工作目录，`~/x` 相对用户目录。 */
export function resolvePathPattern(spec: string, cwd: string): string {
  const base = toPosix(path.resolve(cwd)).replace(/\/+$/, '')
  if (spec.startsWith('//')) return toPosix(spec.slice(1))
  if (spec.startsWith('~/')) return `${toPosix(os.homedir())}/${spec.slice(2)}`
  if (/^[A-Za-z]:[\\/]/.test(spec)) return toPosix(spec)
  if (spec.startsWith('./')) return `${base}/${spec.slice(2)}`
  if (spec.startsWith('/')) return `${base}${spec}`
  return `${base}/${spec}`
}

function toolFilePath(input: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = input[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}

function toolNameMatches(ruleTool: string, toolName: string): boolean {
  if (ruleTool === toolName) return true
  // Edit(...) 规则管所有写文件的内置工具
  if (ruleTool === 'Edit' && WRITE_TOOLS.has(toolName)) return true
  if (ruleTool.includes('*')) return wildcardToRegExp(ruleTool).test(toolName)
  return false
}

export function matchRule(
  rule: string,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): boolean {
  const { tool, spec } = parseRule(rule)
  if (!tool || !toolNameMatches(tool, toolName)) return false
  if (spec === undefined || spec === '' || spec === '*') return true

  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    // 旧写法 `npm run:*` 等价于前缀匹配
    const pattern = spec.endsWith(':*') ? `${spec.slice(0, -2)}*` : spec
    const re = wildcardToRegExp(pattern)
    if (re.test(command)) return true
    // 复合命令（a && b; c | d）里任何一段命中都算命中
    return command
      .split(/&&|\|\||;|\||\n/)
      .map((part) => part.trim())
      .some((part) => part !== '' && re.test(part))
  }

  if (PATH_TOOLS.has(toolName)) {
    const file = toolFilePath(input)
    if (!file) return true
    const absolute = toPosix(path.resolve(cwd, file))
    const flags = process.platform === 'win32' ? 'i' : ''
    return pathGlobToRegExp(resolvePathPattern(spec, cwd), flags).test(absolute)
  }

  // 其他工具带了限定条件：对参数整体做通配匹配
  return wildcardToRegExp(`*${spec}*`).test(JSON.stringify(input))
}

export function firstMatch(
  rules: readonly string[] | undefined,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): string | null {
  if (!rules) return null
  for (const rule of rules) {
    if (matchRule(rule, toolName, input, cwd)) return rule
  }
  return null
}
