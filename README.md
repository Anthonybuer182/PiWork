# PiWork

基于 Electron + React 的 AI 编程助手桌面应用，提供 Web 和桌面双端体验。

## 下载

[![下载最新版本](https://img.shields.io/badge/下载-最新版本-2ea44f?style=for-the-badge)](https://github.com/Anthonybuer182/PiWork/releases/latest)

点上面按钮（或直接打开 [Releases](https://github.com/Anthonybuer182/PiWork/releases/latest)），按平台取安装包：

| 平台 | 安装包 |
|------|--------|
| macOS（Apple 芯片） | `.dmg`，文件名带 `-arm64` |
| macOS（Intel） | `.dmg`，文件名不带架构后缀 |
| Windows（x64） | `.exe` |
| Linux（x64） | `.AppImage` 或 `.deb` |

> 产物目前未做代码签名：macOS 首次打开需右键 →「打开」，Windows 会出现 SmartScreen 提示，选「更多信息」→「仍要运行」。

## 主要功能

- **AI 对话** — 多轮对话式编程助手，支持思考过程展示和工具调用可视化
- **工作空间管理** — 创建和管理多个项目工作空间
- **会话管理** — 支持会话分组、历史查看和会话切换
- **文件浏览** — 内置文件树，支持文件浏览和管理
- **文档预览** — 支持代码高亮、Markdown、PDF、Office 文档（.docx/.xlsx/.pptx）等格式预览
- **模型配置** — 支持多种 AI 提供商和模型选择，可自定义思考等级
- **斜杠命令** — 支持 `/help`、`/clear`、`/compact`、`/model`、`/config` 等命令
- **浏览器自动化** — 支持通过 AI 驱动浏览器进行网页操作，实现自动化浏览与交互

## 功能演示

### AI 编程助手

![Demo](./assets/demo.gif)

### 浏览器自动化

![Browser Automation](./assets/chrome.gif)

## 技术栈

| 类别 | 技术 |
|------|------|
| **桌面框架** | Electron + electron-vite |
| **前端框架** | React 19 + TypeScript |
| **Web 构建** | Vite |
| **UI** | Tailwind CSS + shadcn/ui (Radix) |
| **状态管理** | Zustand + TanStack React Query |
| **代码编辑器** | Monaco Editor |
| **文档预览** | PDF.js、Mammoth (.docx)、SheetJS (.xlsx) |
| **构建工具** | Turborepo + pnpm workspace |
| **AI SDK** | @earendil-works/pi-coding-agent |

## 架构概览

项目采用 monorepo 架构，桌面端和 Web 端共享同一套 UI 组件，仅传输层不同：

```
桌面端:  Renderer (React) ──IPC──▶ Main Process ──▶ SDK ──▶ AI Backend
Web 端:  Browser (React)   ──HTTP─▶ Vite API Proxy ──▶ SDK ──▶ AI Backend
```

```
PiWork/
├── apps/
│   ├── desktop/          # Electron 桌面应用
│   │   ├── src/main/     # 主进程 (窗口管理、IPC 处理)
│   │   ├── src/preload/  # 预加载脚本 (contextBridge)
│   │   └── src/renderer/ # 渲染进程 (React)
│   └── web/              # Web 应用
├── packages/
│   ├── sdk-wrapper/      # SDK 封装层 (IPC/HTTP 双传输)
│   ├── types/            # 共享类型定义
│   └── ui/               # 共享 UI 组件库 (布局、聊天、预览等)
├── plugins/              # 首方插件 (不属 pnpm workspace，见「插件」一节)
├── scripts/              # setup / dev-plugin / build-market 等辅助脚本
├── pnpm-workspace.yaml
└── turbo.json
```

## 环境要求

- Node.js >= 20.0.0
- pnpm >= 9.0.0

## 快速开始

```bash
# 安装依赖（含插件，插件不属 workspace，必须走这一步）
pnpm setup

# 把首方插件装进用户目录 —— 客户路径运行的前提
# （等价于 setup:market + 在插件中心安装）
pnpm plugins:publish --install

# 启动 Web 开发服务器 (localhost:5173)
# Web 端内置 API 代理，无需单独启动后端服务
pnpm dev:web

# 启动 Electron 桌面应用（客户路径：加载 ~/.pi/agent/plugins）
pnpm dev:desktop

# 只想改插件、要求改动立刻生效时，改用仓库插件模式
pnpm dev:desktop:plugins
```

`pnpm setup` 会依次做：根依赖安装 → 根构建 → 逐个插件的依赖安装与构建 → 校验 vendor 资源完整性。首次运行约需下载 1 GB 的插件依赖，请耐心等待。

## 插件

桌面端的左右侧栏面板来自 `plugins/` 下的首方插件。这套机制有几个容易踩的坑，搭建时请留意：

**`plugins/` 不属 pnpm workspace。** `pnpm-workspace.yaml` 只包含 `packages/*` 和 `apps/*`，所以根目录的 `pnpm install` 和 `turbo run build` 都不会碰插件。每个插件是独立的 npm 项目，自带 `package-lock.json`，需要单独安装和构建——这正是 `pnpm setup` 替你做的事。

**面板入口是构建产物。** `com.pi.files`（文件查看器）和 `com.pi.tasks`（日程本）的 `manifest.json` 里，面板入口指向 `./ui-dist/panel/index.html`，而 `ui-dist/` 被插件自己的 `.gitignore` 忽略。不构建就没有面板可显示，只会看到插件静默消失。

**两种启动方式，对应两种插件来源。** 插件的查找根按优先级 `dev > user` 解析：

- **`pnpm dev:desktop`（客户路径）**：不设开发根，应用只读 `~/.pi/agent/plugins/`。安装、更新、回滚都在插件中心走真实市场流程（sha256 校验、权限确认、原子替换）。这是验证"用户实际会看到什么"的方式。
- **`pnpm dev:desktop:plugins`（插件开发）**：通过 `PI_DEV_PLUGINS` 把本仓库设为开发插件根，直接加载 `plugins/`，改代码立刻生效。它会遮蔽用户目录里的同名副本，所以不能用来测安装/更新流程。
- `pnpm dev:desktop:raw` 是客户路径的历史别名，等价于 `pnpm dev:desktop`。

**从仓库发布到用户目录。** 两个目录不会自动同步。标准流程是重新打市场包，再在插件中心安装/更新：

```bash
pnpm plugins:publish                 # 构建 + 重新打市场包（默认带开发版本后缀）
pnpm plugins:publish --only com.pi.browser
pnpm plugins:publish --install       # 额外无界面安装到 ~/.pi/agent/plugins
```

默认的版本后缀（`0.7.1-dev.<时间>`）让插件中心显示「更新」并保留 `.previous`，可以测试回滚；加 `--no-stamp` 则保持原版本号，插件中心显示「重装」。

**vendor 资源不可重建，只能靠 git。** `com.pi.files` 内嵌了一份 GenOffice 引擎（`vendor/genoffice/`，Apache-2.0）。它由 `vendor-genoffice.mjs` 从外部源码复制而来，而那份源码是临时路径、不随仓库保存，所以这份 vendor 树**删了就回不来**。`vendor/UPSTREAM.json` 登记了每个文件的 sha256；`pnpm verify:vendor` 用它校验本地树是否完整。

**可选的本地插件市场。** `pnpm setup:market` 会把插件打成 zip 并在 `market-dist/` 建一个本地市场，把 `~/.pi/agent/plugins/_state.json` 的 `registry` 指向它。它只准备市场、不安装；安装仍在插件中心完成（或 `pnpm plugins:publish --install`）。

## 命令参考

### 开发

| 命令 | 说明 |
|------|------|
| `pnpm setup` | 一键搭建：根安装/构建 + 逐个插件安装/构建 + vendor 校验 |
| `pnpm dev:web` | 启动 Web 应用 (localhost:5173) |
| `pnpm dev:desktop` | 启动 Electron 桌面应用（客户路径，读 `~/.pi/agent/plugins/`） |
| `pnpm dev:desktop:plugins` | 启动 Electron 桌面应用（开发模式，加载本仓库的 `plugins/`） |
| `pnpm dev:desktop:raw` | 客户路径的历史别名，等价于 `pnpm dev:desktop` |
| `pnpm setup:market` | 构建本地插件市场（不安装） |
| `pnpm plugins:publish` | 构建插件 + 重新打市场包（`--only`、`--install`、`--no-stamp`） |
| `pnpm verify:vendor` | 校验内嵌 GenOffice 资源是否完整（对照 `UPSTREAM.json` 的 sha256） |

### 构建与打包

| 命令 | 说明 |
|------|------|
| `pnpm build` | 构建所有子包 |
| `pnpm pack:mac` | 打包 macOS 应用 (.dmg) |
| `pnpm pack:win` | 打包 Windows 应用 (.exe) |
| `pnpm pack:linux` | 打包 Linux 应用 (AppImage) |
| `pnpm pack:all` | 打包全平台 |

打包产物输出在 `apps/desktop/release/` 目录。

### 代码质量

| 命令 | 说明 |
|------|------|
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm lint` | 代码检查 |
| `pnpm test` | 跑测试（desktop 的 `node:test` + plugin-sdk 冒烟） |
| `pnpm format` | 代码格式化 (Prettier) |
| `pnpm clean` | 清理构建产物 |

## 发版

版本号真源是 `apps/desktop/package.json` 的 `version`。tag 必须与它完全一致，否则发布流程在打包前就会失败。

```bash
# 1. 改版本号（只改文件，不自动打 tag）
cd apps/desktop && npm version 0.2.0 --no-git-tag-version && cd ../..

# 2. 提交，打与版本号一致的 tag，push（tag 会触发发布）
git commit -am "发布 0.2.0"
git tag v0.2.0
git push origin HEAD --tags
```

push tag 后 `.github/workflows/release.yml` 依次执行：

1. **verify** —— 与 CI 相同的 build / typecheck / lint / test，不通过就停在这里；
2. **build** —— macOS（arm64 + x64）、Windows x64、Linux x64 各出一份安装包；
3. **publish** —— 创建 GitHub Release，把四个平台的产物挂到 Assets，正文自动生成。

tag 里带 `-`（如 `v0.2.0-beta.1`）会自动标成 prerelease；产物暂未做代码签名。
