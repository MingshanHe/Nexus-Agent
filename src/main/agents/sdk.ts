import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { getSessionMessages, query } from '@anthropic-ai/claude-agent-sdk'
import type { ChatItem } from '../../shared/types'
import { historyToChat } from './history'
import type { QueryFn } from './runner'

// 只有这个文件直接调用 Claude Agent SDK 的运行时接口，其余模块通过注入拿到它们，便于测试。

export const sdkQuery: QueryFn = (params) => query(params)

export async function loadHistory(sessionId: string, cwd: string): Promise<ChatItem[]> {
  const messages = await getSessionMessages(sessionId, { dir: cwd })
  return historyToChat(messages)
}

/**
 * SDK 自带的 Claude Code 可执行文件在按平台分发的可选依赖包里。
 * 打包后它必须在 asar 之外（见 electron-builder.yml 的 asarUnpack），否则无法作为子进程启动。
 */
export function resolveClaudeExecutable(options: { packaged: boolean; resourcesPath: string }): string | undefined {
  const pkg = `claude-agent-sdk-${process.platform}-${process.arch}`
  const binary = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const candidates: string[] = []
  if (options.packaged) {
    candidates.push(
      path.join(options.resourcesPath, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', pkg, binary),
    )
  }
  try {
    const require = createRequire(import.meta.url)
    const manifest = require.resolve(`@anthropic-ai/${pkg}/package.json`)
    const dir = path.dirname(manifest).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
    candidates.push(path.join(dir, binary))
  } catch {
    // 这个平台没有对应的包：交给 SDK 自己去找
  }
  return candidates.find((candidate) => fs.existsSync(candidate))
}
