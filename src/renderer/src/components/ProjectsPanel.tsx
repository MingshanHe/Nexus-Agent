import { useEffect, useState } from 'react'
import type { AppSettings, FolderChoice, ProjectSummary, ProjectTemplate } from '../../../shared/types'
import { errorText } from '../store'

// 项目：每个项目是一个文件夹，带自己的一组 Agent、交接单和成本记录。
// 不同项目的任务可以同时在后台跑；Fusion 和嘉立创EDA 这类独占资源在项目之间仍然互斥。

interface Props {
  settings: AppSettings
  /** 任务状态变化时刷新“运行中”的计数 */
  taskVersion: number
  onChanged(): Promise<void>
}

const TEMPLATES: Array<{ id: ProjectTemplate; title: string; detail: string }> = [
  {
    id: 'robot',
    title: '机器人研发',
    detail: '机械、电子、控制与嵌入式、论文四个专业 Agent 加一个总控，以及 spec/、mech/、elec/、firmware/、paper/、handoff/ 目录',
  },
  { id: 'blank', title: '空白项目', detail: '只有项目总览和交接单目录，Agent 之后自己加（可以从模板里挑）' },
]

function NewProject({ onDone, onError }: { onDone(): Promise<void>; onError(text: string): void }) {
  const [folder, setFolder] = useState<FolderChoice | null>(null)
  const [name, setName] = useState('')
  const [template, setTemplate] = useState<ProjectTemplate>('robot')
  const [working, setWorking] = useState(false)

  const choose = async (): Promise<void> => {
    const choice = await window.nexus.projects.chooseFolder()
    if (!choice) return
    setFolder(choice)
    if (!name.trim()) setName(choice.name)
  }

  const create = async (): Promise<void> => {
    if (!folder) return
    setWorking(true)
    try {
      await window.nexus.projects.create({ name: name.trim() || folder.name, path: folder.path, template })
      await onDone()
    } catch (e) {
      onError(errorText(e))
      setWorking(false)
    }
  }

  return (
    <div className="panel">
      <div className="panel-title">
        <strong>新建或打开项目</strong>
        <span className="muted">选一个文件夹；空文件夹会按模板初始化，已有的文件不会被覆盖</span>
      </div>
      <div className="form-row inline two">
        <input className="input mono" readOnly value={folder?.path ?? ''} placeholder="还没有选择文件夹" />
        <button className="btn" onClick={() => void choose()}>
          选择文件夹…
        </button>
      </div>
      <label>
        <span className="field-label">项目名称</span>
        <input className="input" value={name} placeholder="例如 扑翼机器人 v2" onChange={(e) => setName(e.target.value)} />
      </label>
      {folder?.hasAgents ? (
        <div className="note note-info">这个文件夹里已经有 Agent 配置，会直接作为已有项目打开，不套模板。</div>
      ) : (
        <div className="template-list" role="radiogroup" aria-label="项目模板">
          {TEMPLATES.map((t) => (
            <label key={t.id} className={`template${template === t.id ? ' selected' : ''}`}>
              <input type="radio" name="template" checked={template === t.id} onChange={() => setTemplate(t.id)} />
              <span>
                <strong>{t.title}</strong>
                <span className="muted small">{t.detail}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      <div className="form-actions">
        <button className="btn primary" disabled={!folder || working} onClick={() => void create()}>
          {folder?.hasAgents ? '打开项目' : '创建项目'}
        </button>
      </div>
    </div>
  )
}

function ProjectRow({ project, onChanged, onError }: { project: ProjectSummary; onChanged(): Promise<void>; onError(text: string): void }) {
  const [renaming, setRenaming] = useState<string | null>(null)

  const act = async (work: () => Promise<unknown>): Promise<void> => {
    try {
      await work()
      await onChanged()
    } catch (e) {
      onError(errorText(e))
    }
  }

  return (
    <article className={`project${project.current ? ' current' : ''}`}>
      <div className="project-main">
        {renaming === null ? (
          <div className="project-name">
            {project.name}
            {project.current && <span className="pill">当前</span>}
            {project.activeTasks > 0 && (
              <span className="pill status-running">
                <i className="dot" />
                {project.activeTasks} 个任务进行中
              </span>
            )}
          </div>
        ) : (
          <div className="form-row inline two">
            <input className="input" value={renaming} aria-label="项目名称" onChange={(e) => setRenaming(e.target.value)} />
            <button
              className="btn small primary"
              onClick={() =>
                void act(async () => {
                  await window.nexus.projects.rename(project.id, renaming)
                  setRenaming(null)
                })
              }
            >
              保存
            </button>
          </div>
        )}
        <div className="project-path mono">{project.path}</div>
        <div className="muted small">
          {project.exists ? `${project.agentCount} 个 Agent` : '这个文件夹找不到了（可能被移动或删除）'}
        </div>
      </div>
      <div className="project-actions">
        <button className="btn small primary" disabled={project.current || !project.exists} onClick={() => void act(() => window.nexus.projects.open(project.id))}>
          打开
        </button>
        <button className="btn small" onClick={() => setRenaming(renaming === null ? project.name : null)}>
          {renaming === null ? '重命名' : '取消'}
        </button>
        <button className="btn small" disabled={!project.exists} onClick={() => void window.nexus.projects.reveal(project.id)}>
          打开文件夹
        </button>
        <button
          className="btn small danger"
          title="只从列表里移除，磁盘上的文件不会被删除"
          onClick={() => {
            if (window.confirm(`把「${project.name}」从列表里移除？文件夹和里面的文件都会保留，之后可以重新打开。`)) {
              void act(() => window.nexus.projects.remove(project.id))
            }
          }}
        >
          移出列表
        </button>
      </div>
    </article>
  )
}

export function ProjectsPanel({ settings, taskVersion, onChanged }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [creating, setCreating] = useState(settings.projects.length === 0)
  const [error, setError] = useState('')

  const projectKey = settings.projects.map((p) => `${p.id}:${p.name}`).join('|')
  useEffect(() => {
    void window.nexus.projects.list().then(setProjects)
  }, [projectKey, settings.currentProjectId, taskVersion])

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>项目</h1>
          <p className="muted">
            每个项目是一个文件夹，有自己的一组 Agent、交接单和成本记录。切换项目不会打断别的项目里正在跑的任务。
          </p>
        </div>
        {!creating && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            新建或打开项目
          </button>
        )}
      </header>
      {error && <div className="note note-error">{error}</div>}
      {creating && (
        <NewProject
          onError={setError}
          onDone={async () => {
            setCreating(false)
            setError('')
            await onChanged()
          }}
        />
      )}
      {projects?.length === 0 && !creating && <div className="muted pad">还没有项目。</div>}
      <div className="project-list">
        {projects?.map((project) => (
          <ProjectRow key={project.id} project={project} onChanged={onChanged} onError={setError} />
        ))}
      </div>
    </section>
  )
}
