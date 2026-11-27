import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { GitResult } from '../../shared/types'

// 每个任务结束自动提交一次 Git，提交信息带 Agent 名，出问题可以按 Agent 回滚：
//   git log --grep="^\[mech\]"

export function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim()
        resolve({ ok: !error, output: output || (error ? error.message : '') })
      },
    )
  })
}

export async function isGitRepo(dir: string): Promise<boolean> {
  if (!fs.existsSync(dir)) return false
  const result = await git(dir, ['rev-parse', '--is-inside-work-tree'], 15_000)
  return result.ok && result.output.trim() === 'true'
}

/** dir 自己就是仓库根目录（而不是某个上层仓库里的子目录）。 */
export async function isRepoRoot(dir: string): Promise<boolean> {
  if (!fs.existsSync(dir)) return false
  const result = await git(dir, ['rev-parse', '--show-toplevel'], 15_000)
  if (!result.ok) return false
  return path.resolve(result.output.trim()).toLowerCase() === path.resolve(dir).toLowerCase()
}

export function commitMessage(input: {
  agentId: string
  agentName: string
  prompt: string
  taskId: string
  sessionId: string | null
}): string {
  const firstLine = input.prompt.replace(/\s+/g, ' ').trim()
  const subject = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine
  return [
    `[${input.agentId}] ${subject || '任务'}`,
    '',
    `Agent: ${input.agentName}`,
    `Task: ${input.taskId}`,
    ...(input.sessionId ? [`Session: ${input.sessionId}`] : []),
  ].join('\n')
}

let queue: Promise<unknown> = Promise.resolve()
/** 同一时间只让一个 git 写操作在跑，两个 Agent 同时收工也不会抢 index.lock。 */
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.catch(() => undefined)
  return next
}

export interface AutoCommitResult {
  committed: boolean
  sha: string | null
  detail: string
}

/**
 * 把这次任务的改动提交掉。paths 为空时提交仓库里的全部改动；
 * 否则只提交这些路径（Agent 自己的目录加上 handoff/ 和 spec/），避免把别的 Agent 正在改的文件带进来。
 */
export function autoCommit(input: {
  repoDir: string
  paths?: string[]
  message: string
}): Promise<AutoCommitResult> {
  return serialize(async () => {
    if (!(await isGitRepo(input.repoDir))) {
      return { committed: false, sha: null, detail: '不是 Git 仓库，跳过自动提交' }
    }
    const existing: string[] = []
    for (const candidate of input.paths ?? []) {
      if (!fs.existsSync(path.resolve(input.repoDir, candidate))) continue
      // 被 .gitignore 忽略的路径（例如单独关联了 Overleaf 的 paper/）交给 git add 会整体报错
      const ignored = await git(input.repoDir, ['check-ignore', '-q', '--', candidate], 15_000)
      if (!ignored.ok) existing.push(candidate)
    }
    if (input.paths && input.paths.length > 0 && existing.length === 0) {
      return { committed: false, sha: null, detail: '没有可提交的路径' }
    }
    const pathspec = existing.length > 0 ? existing : ['.']
    const add = await git(input.repoDir, ['add', '-A', '--', ...pathspec])
    if (!add.ok) return { committed: false, sha: null, detail: `git add 失败：${add.output}` }

    const staged = await git(input.repoDir, ['diff', '--cached', '--name-only', '--', ...pathspec])
    if (!staged.ok || staged.output.trim() === '') {
      return { committed: false, sha: null, detail: '没有改动' }
    }
    // 只提交这些路径，别人已暂存的内容不受影响
    const commit = await git(input.repoDir, ['commit', '-m', input.message, '--', ...pathspec])
    if (!commit.ok) return { committed: false, sha: null, detail: `git commit 失败：${commit.output}` }

    const head = await git(input.repoDir, ['rev-parse', '--short', 'HEAD'])
    return { committed: true, sha: head.ok ? head.output.trim() : null, detail: staged.output.trim() }
  })
}
