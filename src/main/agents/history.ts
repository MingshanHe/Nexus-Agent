import type { ChatItem } from '../../shared/types'
import { toolResultText } from './runner'

// 把 SDK 本机会话记录（~/.claude/projects/ 下）里的消息换成界面用的条目。

export interface StoredMessage {
  type: 'user' | 'assistant' | 'system'
  uuid: string
  message: unknown
  parent_tool_use_id: string | null
}

type Loose = Record<string, any>

/** 记录里混有系统注入的提示（system-reminder 之类的标签块），不是用户说的话。 */
function isInjected(text: string): boolean {
  return /^\s*<[a-z][\w-]*[\s>]/i.test(text)
}

export function historyToChat(messages: StoredMessage[]): ChatItem[] {
  const items: ChatItem[] = []
  const toolIndex = new Map<string, number>()
  let ts = 0
  for (const entry of messages) {
    const message = (entry.message ?? {}) as Loose
    const nested = entry.parent_tool_use_id !== null && entry.parent_tool_use_id !== undefined
    const content = message.content
    ts += 1
    if (entry.type === 'user') {
      if (typeof content === 'string') {
        if (!nested && content.trim() && !isInjected(content)) {
          items.push({ id: entry.uuid, kind: 'user', text: content, ts })
        }
        continue
      }
      if (!Array.isArray(content)) continue
      content.forEach((block: Loose, i: number) => {
        if (block.type === 'text' && typeof block.text === 'string') {
          if (!nested && block.text.trim() && !isInjected(block.text)) {
            items.push({ id: `${entry.uuid}:${i}`, kind: 'user', text: block.text, ts })
          }
        } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const index = toolIndex.get(block.tool_use_id)
          const existing = index === undefined ? undefined : items[index]
          if (index !== undefined && existing?.kind === 'tool') {
            items[index] = {
              ...existing,
              status: block.is_error ? 'error' : 'done',
              result: toolResultText(block.content),
            }
          }
        }
      })
    } else if (entry.type === 'assistant') {
      if (!Array.isArray(content)) continue
      content.forEach((block: Loose, i: number) => {
        if (block.type === 'text' && typeof block.text === 'string') {
          if (!nested && block.text.trim()) {
            items.push({ id: `${entry.uuid}:${i}`, kind: 'assistant', text: block.text, ts })
          }
        } else if (block.type === 'tool_use' && typeof block.id === 'string') {
          toolIndex.set(block.id, items.length)
          items.push({
            id: block.id,
            kind: 'tool',
            name: String(block.name),
            input: block.input,
            // 历史记录里没有结果的调用，说明当时任务被打断了
            status: 'error',
            result: '（没有记录到这次调用的结果）',
            ts,
            ...(nested ? { nested: true } : {}),
          })
        }
      })
    }
  }
  return items
}
