import fs from 'node:fs'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import type { Handoff, HandoffStatus } from '../../shared/types'

// 交接走文件，不走聊天：handoff/ 目录下每张交接单是一个带 front matter 的 Markdown 文件。
//
//   ---
//   from: elec
//   to: [firmware]
//   status: open          # open | acknowledged | done
//   created: 2026-11-27
//   files: [elec/pinmap.csv, spec/interfaces.md]
//   ---
//   # IMU 的 INT 引脚从 GPIO4 改到 GPIO5
//   ...

export const HANDOFF_DIR = 'handoff'
const IGNORED = new Set(['readme.md', '_template.md'])
const STATUSES: HandoffStatus[] = ['open', 'acknowledged', 'done']

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return []
}

function splitFrontMatter(text: string): { meta: Record<string, unknown>; body: string } {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return { meta: {}, body: text }
  let meta: Record<string, unknown> = {}
  try {
    const parsed: unknown = parse(match[1])
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>
    }
  } catch {
    // front matter 写坏了：当作没有，交接单仍然显示出来
  }
  return { meta, body: match[2] }
}

function formatDate(value: unknown, fallback: Date): string {
  const date = value instanceof Date ? value : fallback
  if (typeof value === 'string' && value.trim()) return value.trim()
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function parseHandoff(file: string, text: string, mtime: number): Handoff {
  const { meta, body } = splitFrontMatter(text)
  const heading = /^#\s+(.+)$/m.exec(body)
  const status = STATUSES.includes(meta.status as HandoffStatus) ? (meta.status as HandoffStatus) : 'open'
  return {
    file,
    title: (typeof meta.title === 'string' && meta.title.trim()) || heading?.[1].trim() || file.replace(/\.md$/i, ''),
    from: typeof meta.from === 'string' ? meta.from.trim() : '',
    to: asStringList(meta.to),
    status,
    created: formatDate(meta.created, new Date(mtime)),
    files: asStringList(meta.files),
    body: body.trim(),
    mtime,
  }
}

export function listHandoffs(workspace: string): Handoff[] {
  const dir = path.join(workspace, HANDOFF_DIR)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const handoffs: Handoff[] = []
  for (const name of names) {
    if (!/\.md$/i.test(name) || IGNORED.has(name.toLowerCase())) continue
    const full = path.join(dir, name)
    try {
      const stat = fs.statSync(full)
      if (!stat.isFile()) continue
      handoffs.push(parseHandoff(name, fs.readFileSync(full, 'utf8'), stat.mtimeMs))
    } catch {
      // 文件正被写入或刚被删除：下一次扫描会补上
    }
  }
  const order: Record<HandoffStatus, number> = { open: 0, acknowledged: 1, done: 2 }
  return handoffs.sort((a, b) => order[a.status] - order[b.status] || b.mtime - a.mtime)
}

function handoffPath(workspace: string, file: string): string {
  const name = path.basename(file)
  if (name !== file || !/\.md$/i.test(name)) throw new Error(`不是有效的交接单文件名：${file}`)
  return path.join(workspace, HANDOFF_DIR, name)
}

export function setHandoffStatus(workspace: string, file: string, status: HandoffStatus): void {
  const full = handoffPath(workspace, file)
  const text = fs.readFileSync(full, 'utf8')
  const { meta, body } = splitFrontMatter(text)
  const next = { ...meta, status }
  fs.writeFileSync(full, `---\n${stringify(next, { lineWidth: 0 })}---\n${body}`, 'utf8')
}

function slugify(text: string): string {
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return ascii || 'handoff'
}

export function createHandoff(
  workspace: string,
  input: { from: string; to: string[]; title: string; body: string; files: string[] },
  now = new Date(),
): Handoff {
  const dir = path.join(workspace, HANDOFF_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const day = formatDate(undefined, now)
  const base = `${day}-${input.from || 'me'}-${slugify(input.title)}`
  let name = `${base}.md`
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}.md`
  const meta = { from: input.from, to: input.to, status: 'open', created: day, files: input.files }
  const text = `---\n${stringify(meta, { lineWidth: 0 })}---\n# ${input.title.trim()}\n\n${input.body.trim()}\n`
  fs.writeFileSync(path.join(dir, name), text, 'utf8')
  return parseHandoff(name, text, now.getTime())
}

/** 派给某个 Agent 跟进一张交接单时用的任务说明。 */
export function handoffPrompt(handoff: Handoff): string {
  const files = handoff.files.length ? `涉及的文件：${handoff.files.join('、')}。` : ''
  return [
    `请跟进交接单 ${HANDOFF_DIR}/${handoff.file}（来自 ${handoff.from || '未注明'}）：「${handoff.title}」。`,
    `先读这张交接单和它列出的文件，${files}再完成你这一侧需要跟着改的内容，并验证改动是对的。`,
    `做完后在交接单正文末尾的“跟进记录”里追加一行（日期、你是谁、改了什么）；` +
      `如果所有接收方都已跟进，把 front matter 里的 status 改成 done。`,
    `如果你的改动又影响到别的专业，按 CLAUDE.md 的规则更新 spec/interfaces.md 并新写一张交接单。`,
  ].join('\n')
}

/** 监视 handoff/ 目录。普通的文件监视，不依赖 SDK。 */
export function watchHandoffs(workspace: string, onChange: (handoffs: Handoff[]) => void): () => void {
  const dir = path.join(workspace, HANDOFF_DIR)
  let timer: NodeJS.Timeout | null = null
  let watcher: fs.FSWatcher | null = null
  let lastSignature = ''
  let closed = false

  const scan = (): void => {
    if (closed) return
    const handoffs = listHandoffs(workspace)
    const signature = handoffs.map((h) => `${h.file}:${h.mtime}:${h.status}`).join('|')
    if (signature !== lastSignature) {
      lastSignature = signature
      onChange(handoffs)
    }
  }
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(scan, 300)
  }
  const attach = (): void => {
    if (closed || watcher || !fs.existsSync(dir)) return
    try {
      watcher = fs.watch(dir, schedule)
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
      })
    } catch {
      watcher = null
    }
  }

  attach()
  scan()
  // 兜底：目录可能后来才建，网络盘上的 fs.watch 也可能漏事件
  const poll = setInterval(() => {
    attach()
    scan()
  }, 5000)

  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    clearInterval(poll)
    watcher?.close()
  }
}
