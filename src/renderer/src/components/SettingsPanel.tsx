import { useState } from 'react'
import type { AppSettings, GitResult, UpdateState, WorkspaceStatus } from '../../../shared/types'
import { errorText } from '../store'

interface Props {
  settings: AppSettings
  update: UpdateState | null
  workspace: WorkspaceStatus
  onChanged(): Promise<void>
}

function numberOrNull(text: string): number | null {
  const value = Number(text)
  return text.trim() !== '' && Number.isFinite(value) && value > 0 ? value : null
}

const UPDATE_TEXT: Record<UpdateState['phase'], string> = {
  unsupported: '这个版本不是用安装包装的（开发模式），不能在软件内更新',
  idle: '还没有检查过',
  checking: '正在检查…',
  'up-to-date': '已经是最新版本',
  available: '有新版本',
  downloading: '正在下载',
  ready: '新版本已经下载好',
  error: '检查或下载时出错',
}

export function SettingsPanel({ settings, update, workspace, onChanged }: Props) {
  const [message, setMessage] = useState<{ level: 'info' | 'error'; text: string } | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [taskBudget, setTaskBudget] = useState(settings.defaultMaxBudgetUsd?.toString() ?? '')
  const [taskTurns, setTaskTurns] = useState(settings.defaultMaxTurns?.toString() ?? '')
  const [monthBudget, setMonthBudget] = useState(settings.monthlyBudgetUsd?.toString() ?? '')
  const [overleafUrl, setOverleafUrl] = useState(settings.overleafGitUrl ?? '')
  const [gitOutput, setGitOutput] = useState<GitResult | null>(null)
  const [working, setWorking] = useState(false)

  const run = async (work: () => Promise<string | void>): Promise<void> => {
    setMessage(null)
    setWorking(true)
    try {
      const text = await work()
      if (text) setMessage({ level: 'info', text })
      await onChanged()
    } catch (e) {
      setMessage({ level: 'error', text: errorText(e) })
    } finally {
      setWorking(false)
    }
  }

  const overleaf = (work: () => Promise<GitResult>): Promise<void> =>
    run(async () => {
      setGitOutput(null)
      setGitOutput(await work())
    })

  return (
    <section className="page settings">
      <header className="page-head">
        <div>
          <h1>设置</h1>
          <p className="muted">这个应用要跑在装有 Fusion 和嘉立创EDA 的那台电脑上：两个接口都只在本机可达。</p>
        </div>
      </header>
      {message && <div className={`note note-${message.level}`}>{message.text}</div>}

      <div className="panel">
        <div className="panel-title">
          <strong>1. 当前项目</strong>
          <span className="muted">新建、切换和移除项目在左边的“项目”里</span>
        </div>
        <div className="kv">
          <span>项目</span>
          <span>{settings.projects.find((p) => p.id === settings.currentProjectId)?.name ?? '还没有打开项目'}</span>
          <span>位置</span>
          <span className="mono">{workspace.path ?? '—'}</span>
          <span>状态</span>
          <span>
            {!workspace.path
              ? '—'
              : !workspace.exists
                ? '这个文件夹不存在了'
                : `${workspace.agentCount} 个 Agent${workspace.isGitRepo ? '，Git 仓库' : '，还不是 Git 仓库'}`}
          </span>
        </div>
        <div className="form-actions left">
          <button
            className="btn"
            disabled={working || !workspace.path}
            title="按机器人研发模板补上缺的文件：CLAUDE.md、spec/、mech/、elec/、firmware/、paper/、handoff/ 和五个 Agent 的配置；已有的文件不会被覆盖"
            onClick={() =>
              void run(async () => {
                const result = await window.nexus.workspace.scaffold('robot')
                return `新建了 ${result.created.length} 个文件，${result.skipped} 个已存在的文件保持不变。`
              })
            }
          >
            补齐机器人研发模板
          </button>
          <button
            className="btn"
            disabled={working || !workspace.initialized}
            title="把 Agent 配置导出成 .claude/agents/*.md，想直接在 Claude Code 里试这些角色时用"
            onClick={() =>
              void run(async () => {
                const result = await window.nexus.workspace.exportClaudeAgents()
                return `已导出：${result.written.join('、') || '（没有可导出的 Agent）'}`
              })
            }
          >
            导出为 Claude Code Agent 定义
          </button>
          <button className="btn ghost" disabled={!workspace.path} onClick={() => void window.nexus.workspace.openInExplorer()}>
            打开文件夹
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <strong>2. Claude API Key</strong>
          <span className="muted">Agent SDK 用 API Key 按量计费，不能用 claude.ai 账号登录</span>
        </div>
        <div className="kv">
          <span>当前</span>
          <span>
            {settings.apiKeySource === 'app' && '已保存在本应用（用系统凭据加密）'}
            {settings.apiKeySource === 'env' && '来自环境变量 ANTHROPIC_API_KEY'}
            {settings.apiKeySource === 'none' && '还没有配置'}
          </span>
        </div>
        <div className="form-row inline">
          <input
            className="input mono"
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder="在这里粘贴 API Key"
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button
            className="btn primary"
            disabled={working || !apiKey.trim()}
            onClick={() =>
              void run(async () => {
                await window.nexus.settings.setApiKey(apiKey)
                setApiKey('')
                return 'API Key 已保存。'
              })
            }
          >
            保存
          </button>
          <button
            className="btn"
            disabled={working || settings.apiKeySource !== 'app'}
            onClick={() => void run(async () => void (await window.nexus.settings.clearApiKey()))}
          >
            清除
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <strong>3. 预算和轮数上限</strong>
          <span className="muted">对所有项目生效；留空表示不限，每个 Agent 的配置里可以单独覆盖</span>
        </div>
        <div className="form-row three">
          <label>
            <span className="field-label">单任务预算上限（美元）</span>
            <input className="input" inputMode="decimal" value={taskBudget} placeholder="不限" onChange={(e) => setTaskBudget(e.target.value)} />
          </label>
          <label>
            <span className="field-label">单任务轮数上限</span>
            <input className="input" inputMode="numeric" value={taskTurns} placeholder="不限" onChange={(e) => setTaskTurns(e.target.value)} />
          </label>
          <label>
            <span className="field-label">每月预算上限（美元）</span>
            <input className="input" inputMode="decimal" value={monthBudget} placeholder="不限" onChange={(e) => setMonthBudget(e.target.value)} />
          </label>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.autoCommit}
            onChange={(e) => void run(async () => void (await window.nexus.settings.update({ autoCommit: e.target.checked })))}
          />
          <span>每个任务结束自动提交一次 Git（提交信息以 [agent id] 开头，可以按 Agent 回滚）</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.notifications}
            onChange={(e) => void run(async () => void (await window.nexus.settings.update({ notifications: e.target.checked })))}
          />
          <span>窗口不在前台时，需要审批或任务结束就发系统通知</span>
        </label>
        <div className="form-actions left">
          <button
            className="btn primary"
            disabled={working}
            onClick={() =>
              void run(async () => {
                await window.nexus.settings.update({
                  defaultMaxBudgetUsd: numberOrNull(taskBudget),
                  defaultMaxTurns: numberOrNull(taskTurns),
                  monthlyBudgetUsd: numberOrNull(monthBudget),
                })
                return '上限已保存。'
              })
            }
          >
            保存上限
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <strong>4. Overleaf（可选）</strong>
          <span className="muted">把当前项目的 paper/ 关联到 Overleaf 项目的 Git 仓库</span>
        </div>
        <p className="muted small">
          Overleaf 的程序化入口是它的 Git 集成（付费功能）：在 Overleaf 项目菜单的 Git 里可以看到地址。
          第一次连接时系统的 Git 凭据管理器会弹窗让你填 Overleaf 的 Git 令牌，本应用不接触它。
        </p>
        <div className="form-row inline">
          <input
            className="input mono"
            value={overleafUrl}
            placeholder="https://git.overleaf.com/<项目 id>"
            onChange={(e) => setOverleafUrl(e.target.value)}
          />
          <button className="btn primary" disabled={working || !workspace.initialized || !overleafUrl.trim()} onClick={() => void overleaf(() => window.nexus.overleaf.link(overleafUrl))}>
            关联
          </button>
          <button className="btn" disabled={working || !settings.overleafGitUrl} onClick={() => void overleaf(() => window.nexus.overleaf.pull())}>
            拉取
          </button>
          <button className="btn" disabled={working || !settings.overleafGitUrl} onClick={() => void overleaf(() => window.nexus.overleaf.push())}>
            推送
          </button>
        </div>
        {gitOutput && <pre className={`code ${gitOutput.ok ? '' : 'diff-del'}`}>{gitOutput.output || (gitOutput.ok ? '完成。' : '失败。')}</pre>}
      </div>

      <div className="panel">
        <div className="panel-title">
          <strong>5. 软件更新</strong>
          <span className="muted">从 GitHub Releases 下载，装完自动重新打开</span>
        </div>
        <div className="kv">
          <span>当前</span>
          <span className="mono">v{settings.appVersion}</span>
          <span>状态</span>
          <span>
            {update ? UPDATE_TEXT[update.phase] : '—'}
            {update?.phase === 'available' && update.latestVersion ? ` v${update.latestVersion}` : ''}
            {update?.phase === 'downloading' ? ` ${update.percent}%` : ''}
            {update?.error ? `：${update.error}` : ''}
          </span>
        </div>
        {update?.phase === 'downloading' && (
          <div className="meter" role="img" aria-label={`下载进度 ${update.percent}%`}>
            <div className="meter-fill" style={{ width: `${update.percent}%` }} />
          </div>
        )}
        {update?.notes && (update.phase === 'available' || update.phase === 'ready') && <pre className="code">{update.notes}</pre>}
        <div className="form-actions left">
          <button
            className="btn"
            disabled={!update || update.phase === 'unsupported' || update.phase === 'checking' || update.phase === 'downloading'}
            onClick={() => void window.nexus.updates.check()}
          >
            检查更新
          </button>
          {update && (update.phase === 'available' || update.phase === 'downloading') && (
            <button className="btn primary" disabled={update.phase === 'downloading'} onClick={() => void window.nexus.updates.install()}>
              {update.phase === 'downloading' ? '正在下载…' : '更新并重启'}
            </button>
          )}
          {update?.phase === 'ready' && (
            <button className="btn primary" onClick={() => void window.nexus.updates.restart()}>
              重启并安装
            </button>
          )}
        </div>
        <p className="muted small">
          点“更新并重启”后会下载新版本；下载完如果没有任务在跑就自动重启安装，有任务在跑则等你点“重启并安装”。
        </p>
      </div>

      <div className="panel">
        <div className="panel-title">
          <strong>开始之前要在别的软件里做的事</strong>
        </div>
        <ul className="checklist">
          <li>
            <strong>Fusion：</strong>在“偏好设置 &gt; 常规 &gt; API”里启用 MCP 服务（地址 <code>http://127.0.0.1:27182/mcp</code>）。
          </li>
          <li>
            <strong>嘉立创EDA专业版：</strong>安装 Run API Gateway 扩展并允许外部交互。EasyEDA API Skill 和桥接服务已经内置，不用另装。
          </li>
          <li>
            <strong>PlatformIO：</strong>确认命令行里能运行 <code>pio --version</code>。
          </li>
          <li>
            <strong>项目：</strong>新建后，把 <code>CLAUDE.md</code> 和 <code>spec/interfaces.md</code> 里的占位内容换成你的项目。
          </li>
        </ul>
      </div>
    </section>
  )
}
