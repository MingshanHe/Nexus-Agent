# Nexus Agent

一个跑在本机的桌面应用，按项目管理一组专业 Agent：每个项目有自己的 Agent（例如机械、电子、控制与嵌入式、论文，外加一个可选的总控），应用负责创建、启动、监控、审批和调度。Agent 的内核是 [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview.md)（也就是 Claude Code 的内核），这里自己写的只有外层的管理界面和调度逻辑。

它要装在有 Fusion 和嘉立创EDA 的那台电脑上：这两个软件的接口都只在本机可达。只有模型推理走 Claude API。

## 安装

到 [Releases](https://github.com/MingshanHe/Nexus-Agent/releases) 下载 `Nexus-Agent-Setup-<版本>.exe` 并运行。每次推送到 `main` 的构建产物也可以在 [Actions](https://github.com/MingshanHe/Nexus-Agent/actions) 的运行记录里下载（Artifacts 里的 `Nexus-Agent-Setup`）。

- 安装包约数百 MB：里面带着 Claude Code 的可执行文件和 EasyEDA API Skill，不需要另装 Node 或 Claude Code。
- 安装包没有代码签名，Windows SmartScreen 会提示“未知发布者”，需要点“仍要运行”。
- 目前只构建 Windows x64。
- 从 0.1.0 升级：直接运行新的安装包。原来的工作区会自动变成第一个项目，设置和历史记录都保留。

## 第一次使用

1. 打开“项目”，**新建项目**：选一个文件夹，起个名字，选模板。
   - **机器人研发**：生成下面的目录结构，以及机械、电子、控制与嵌入式、论文四个专业 Agent 和一个总控。
   - **空白项目**：只有项目总览和交接单目录，Agent 之后自己加。
   - 选的文件夹里已经有 Agent 配置时，会直接作为已有项目打开。已有的文件不会被覆盖。
2. 在“设置”里填 **Claude API Key**。SDK 要求第三方应用用 API Key 按量计费，不能用 claude.ai 账号登录。Key 用 Windows 的系统凭据加密后保存，不会以明文落盘。也可以不填，改用环境变量 `ANTHROPIC_API_KEY`。
3. 在别的软件里把接口打开：
   - **Fusion**：“偏好设置 > 常规 > API”里启用 MCP 服务，地址 `http://127.0.0.1:27182/mcp`。
   - **嘉立创EDA专业版**：安装 [Run API Gateway 扩展](https://jlc-ext.com/item/oshwhub/run-api-gateway)并允许外部交互。技能和桥接服务已经内置，不用另装。
   - **PlatformIO**：命令行里能运行 `pio --version`。
4. 把项目里 `CLAUDE.md` 和 `spec/interfaces.md` 的占位内容换成你的项目。
5. 在左边选一个 Agent，派一件小事试试：画一个支架、放一个稳压电路、编译一个闪灯程序、写一段相关工作综述。

```text
robot-project/
├─ CLAUDE.md     所有 Agent 都会读的项目总览和规则
├─ spec/         需求、接口约定 interfaces.md
├─ mech/         机械笔记、导出的 STEP、尺寸表
├─ elec/         原理图说明、引脚分配表、BOM
├─ firmware/     PlatformIO 工程、控制算法、仿真脚本
├─ paper/        LaTeX 工程、图、参考文献
├─ handoff/      交接单：谁改了什么，谁需要跟着改
└─ .nexus/       Agent 的配置（agents/*.yaml）和提示词（prompts/*.md）
```

## 项目

每个项目是一个文件夹，有自己的一组 Agent、会话、交接单和成本记录。

- 左上角的下拉框切换项目；“项目”页面里新建、重命名、打开文件夹，或把项目移出列表（只是不再显示，磁盘上的文件不动）。
- **切换项目不会打断别的项目里正在跑的任务。** 它们在后台继续，需要审批时照样弹窗（标明来自哪个项目），窗口不在前台时发系统通知。
- **独占资源在项目之间仍然互斥。** Fusion 和嘉立创EDA 各只有一个正在打开的会话，所以不管哪个项目，用到同一个资源的任务一次只跑一个，其余排队。
- 每月预算上限按所有项目的合计算；成本页面显示的是当前项目。
- 新建 Agent 时可以从模板开始（机械、电子、嵌入式、论文、总控），也可以从空白开始。同一个模板可以在一个项目里用多次，只要 id 不同。

## 功能

| 功能 | 做什么 |
| --- | --- |
| 项目 | 多个项目并存，各有各的 Agent；任务可以跨项目同时运行 |
| Agent 列表与配置 | 新建（可从模板）、复制、编辑、删除 Agent；显示各自的 MCP 服务是否连上 |
| 对话与任务 | 选一个 Agent 派任务，流式看它的回复和工具调用；任务进行中可以追加指令或中断 |
| 会话历史 | 每个 Agent 的历史会话可以恢复，也可以分叉出一个分支重试 |
| 审批 | 没有自动放行的调用弹窗，显示工具名和参数；可以批准、拒绝（并附说明）或本次会话内一直允许 |
| 成本 | 按任务、按 Agent、按天统计；可以设单任务预算、单任务轮数和每月预算上限 |
| 交接看板 | 监视 `handoff/` 目录，新交接单显示为待办，点一下派给接收方跟进 |
| 自动提交 | 每个任务结束提交一次 Git，提交信息以 `[agent id]` 开头 |
| 嘉立创EDA | 内置官方的 EasyEDA API Skill，桥接服务由应用启动，界面显示嘉立创EDA 窗口是否连上 |
| 总控 Agent | 一个只读的 Agent，用 `dispatch(agent, task)` 把目标拆给本项目的专业 Agent；每次派发都要你确认 |
| 通知 | 窗口不在前台时，需要审批或任务结束会发系统通知；还有任务在跑时关窗口会先问一句 |

## 嘉立创EDA

电子 Agent 用的是嘉立创官方的 [EasyEDA API Skill](https://github.com/easyeda/easyeda-api-skill)（MIT），它随应用内置，不需要自己安装：

- **技能**：电子 Agent 的任务开始前，应用把内置的技能装进项目的 `.claude/skills/easyeda-api/`（并写进 `.gitignore`）。应用更新后带了新版本，下次任务会自动换成新的。
- **桥接服务**：技能自带的桥接脚本由应用用自己的运行时启动，监听本机 49620–49629 中的一个端口，不需要另装 Node。如果已经有一个桥接服务在跑（比如你在别处启动的），应用会直接复用它。
- **连接状态**：电子 Agent 的对话页顶部显示桥接服务是否在跑、连上了几个嘉立创EDA 窗口。显示“等待嘉立创EDA 连接”时，检查嘉立创EDA专业版是否打开、Run API Gateway 扩展是否加载。

任何 Agent 只要在配置的 `skills` 里写了 `easyeda-api`，就会得到同样的处理。想改用你自己装在 `~/.claude/skills` 里的版本，在这个 Agent 的配置里勾上“也读取用户级的 Claude Code 设置和技能”。

## Agent 配置

一个 Agent 就是 `.nexus/agents/<id>.yaml` 加一份提示词。新增 Agent 只加文件，不改代码；也可以在界面里点“配置”编辑。

```yaml
name: 机械 Agent
description: 参数化建模、装配、读尺寸、导出 STEP/STL
model: claude-opus-5-5
system_prompt: prompts/mech.md
resource: fusion                 # 同名独占资源一次只跑一个任务
mcp_servers:
  fusion:
    type: http
    url: http://127.0.0.1:27182/mcp
allowed_tools:                   # 自动放行；其余调用都弹审批
  - Read
  - Grep
  - Glob
  - mcp__fusion__fusion_mcp_read
  - Edit(/mech/**)               # 只能自动写自己的目录
always_ask:                      # 每次都要确认，不能选“一直允许”
  - mcp__fusion__fusion_mcp_update
git:
  paths: [mech, handoff, spec]   # 任务结束后自动提交的路径
```

| 字段 | 含义 |
| --- | --- |
| `model`、`effort` | 模型和思考力度。机械和电子出错代价高，默认用 Opus 5.5；嵌入式和论文默认 Sonnet 5.5 |
| `mcp_servers` | 只有这里列出的服务会挂给这个 Agent。项目的 `.mcp.json` 和全局配置都不继承，所以机械 Agent 看不到嘉立创EDA 的工具，论文 Agent 碰不到 Fusion |
| `allowed_tools` | 自动放行的调用，语法和 Claude Code 的权限规则相同：`Read`、`Bash(pio run -e *)`、`Edit(/mech/**)`、`mcp__服务__工具` |
| `always_ask` | 每次都必须人工确认的调用，优先于放行规则。默认配置里，Fusion 的写操作、烧录、擦除、装依赖都在这里 |
| `disallowed_tools` | 从 Agent 的上下文里移除的工具 |
| `resource` | 独占资源名。同名资源一次只跑一个任务，跨项目也一样；嵌入式和论文没有独占资源，可以同时跑 |
| `skills`、`setting_sources` | 启用的技能，以及是否读取用户级的 Claude Code 设置。默认只读项目级的 |
| `max_turns`、`max_budget_usd` | 单任务的轮数和预算上限，覆盖全局设置 |
| `git.paths`、`git.repo` | 自动提交哪些路径；`repo` 用于 `paper/` 这种独立仓库 |
| `role: orchestrator` | 总控 Agent：获得 `dispatch`、`list_agents`、`list_handoffs` 三个工具 |

跑顺之后，把低风险的调用从 `always_ask` 挪到 `allowed_tools`，审批会越来越少。

## 协作方式

- **交接走文件，不走聊天。** 每个 Agent 是独立会话，彼此看不到对方的对话。接口尺寸、引脚分配、参数表都写进仓库。
- **`spec/interfaces.md` 是跨专业事实的唯一出处。** 谁改了它，谁就在 `handoff/` 写一张交接单（格式见 `handoff/_template.md`）。
- **交接看板**发现新交接单后显示为待办。你点“派给……”，对应的 Agent 读交接单、跟进、登记。
- **回滚**：`git log --grep="^\[mech\]"` 可以找出某个 Agent 的全部提交。

## Overleaf

Overleaf 没有公开的编辑 API，程序化入口是它的 Git 集成（付费功能）。在“设置 > Overleaf”里填项目的 Git 地址，当前项目的 `paper/` 会变成那个 Overleaf 项目的克隆，之后可以点“拉取”“推送”同步；论文 Agent 的改动先提交在 `paper/` 自己的仓库里。第一次连接时系统的 Git 凭据管理器会让你填 Overleaf 的 Git 令牌，本应用不接触它。

文献库目前按最简单的方式处理：论文 Agent 维护 `paper/refs.bib`，只收录它实际检索并打开过的文献。如果你用 Zotero，可以让 Better BibTeX 自动导出到这个文件。

## 需要知道的限制

- **电子设计不能放手不管。** 模型可能编造引脚、连错网络，自动布线只是基础水平。电子 Agent 的定位是查料、连线、检查、出文件的助手：写入要审批，每次改动后跑 ERC 和 DRC，打板前人工复核。
- **Fusion 的 MCP 直接操作你正开着的文档。** 写操作默认每次都要审批；有风险的改动让 Agent 在副本上做。
- **硬件安全。** 烧录和擦除每次都要审批。电机和舵机的首次上电请你在场，电源限流。
- **论文事实性。** 提示词要求只引用打开过的文献、数据只取自仓库，但投稿前仍要逐条核对。
- **成本是估算值。** 数字来自 SDK 报告的用量，以 Claude Console 的账单为准。
- 本机和 CI 验证了构建、打包、界面、调度逻辑、SDK 会话的启动，以及内置技能和桥接服务的启动；真正连上 Fusion、嘉立创EDA 和硬件的端到端流程需要在你的电脑上走一遍。

## 开发

需要 Node.js 24 和 Git。

```bash
npm install
npm run dev            # 开发模式，带热更新
npm run check          # 类型检查 + 测试
npm run dist           # 生成安装包到 release/
npm run update:skill   # 把 vendor/ 里的 EasyEDA API Skill 更新到上游最新版
```

| 目录 | 内容 |
| --- | --- |
| `src/main/agents/` | 配置解析、SDK 参数翻译与会话执行（`runner.ts`）、调度核心（`manager.ts`）、总控的 dispatch 工具 |
| `src/main/eda/` | 内置 EasyEDA 技能的安装和桥接服务的启动 |
| `src/main/store/`、`src/main/settings.ts` | 任务和成本（SQLite，Node 自带的 `node:sqlite`）；项目列表和应用设置 |
| `src/main/handoff/`、`src/main/git/`、`src/main/workspace/` | 交接单、自动提交、项目模板与 Overleaf |
| `src/preload/`、`src/shared/` | 界面与主进程之间的接口和共用类型 |
| `src/renderer/` | 界面（React） |
| `resources/defaults/` | 默认的 Agent 配置、提示词和项目模板 |
| `vendor/easyeda-api-skill/` | 上游技能的快照，来源和版本记在 `vendor/easyeda-api-skill.source.json` |
| `tests/` | 测试：用假的 SDK 消息流驱动调度核心，不调用 API |

发布新版本：改 `package.json` 里的 `version`，推一个同名的标签（例如 `v0.2.0`），GitHub Actions 会构建安装包、对打包后的应用做一次自检，并创建 Release。

应用数据（项目列表、设置、任务与成本数据库、工具调用的审计日志）在 `%APPDATA%\Nexus Agent\`；会话正文由 SDK 存在 `~/.claude/projects/`。
