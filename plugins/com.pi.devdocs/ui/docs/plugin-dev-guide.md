# Pi 插件开发指南

> 这份文档带你从零写出自己的插件。**第 1 节**建立整体认识，**第 2 节**跟着做就能跑通一个完整插件，其余各节按需查阅：想让 agent 主动用你的插件看第 3 节，查接口看第 4、5、11 节，发布看第 9 节。

## 1. 认识插件

一个插件就是一个文件夹。宿主（Pi 桌面应用）扫描插件目录，读到什么就往应用里挂什么：新工具、新面板、新命令。

### 文件夹里有什么

| 文件 | 必须有吗 | 作用 |
|---|---|---|
| `manifest.json` | ✅ | 清单：叫什么、要什么权限、贡献哪些工具和面板。宿主启动时读它 |
| `dist/main.mjs` | 可选 | 后端程序。一个 Node 进程，跑工具逻辑、替面板干活 |
| `ui/index.html` | 可选 | 面板页面。一张普通网页，宿主负责装进窗口 |
| `PLUGIN.md` | 强烈推荐 | 写给 agent 看的说明书。没有它，agent 基本不会用你的插件 |
| `assets/` | 可选 | 图标等静态资源 |

没有后端也可以（纯面板插件），没有面板也可以（纯工具插件）。两个都没有就只剩清单，没有意义。

### 一张图看懂通信

```
┌──────────────┐  ① 调用工具   ┌──────────────┐  ③ 调用宿主能力(每个都过权限门)
│    agent     │ ────────────→ │   插件后端    │ ─────────────────────→ 宿主主进程
│ (对话里的AI) │ ←──────────── │  (Node进程)   │ ←─────────────────────
└──────────────┘  ② 返回结果   └──────┬───────┘  ④ 双向消息(宿主只转发,不看内容)
                                     │
                              ┌──────┴───────┐
                              │   你的面板    │
                              │  (一张网页)   │
                              └──────────────┘
```

五条通路各司其职：

- **agent → 后端**：用户在对话里说了一句话，agent 决定调你的工具，后端的 `onTool` 被执行，返回值成为工具结果。
- **后端 → 宿主**：后端通过"能力调用"（`ctx.call`）使用宿主的功能——存数据、发通知、读写文件、开面板。每个能力都对应一项权限，主进程逐次校验。
- **面板 ↔ 后端**：面板只跟**自己插件的后端**说话，走一条宿主只转发、不检查内容的专用通道。
- **面板 → agent**：后端用 `chat.send` 能力把消息发进当前对话（带来源标注）——面板上的一个按钮就能"叫醒" agent。见第 2 节阶段③。
- **工具结果 → 对话**：工具可以返回一张声明式"卡片"，宿主把它渲染进对话流；用户点卡片上的按钮，事件回到后端的 `onCardEvent`。见第 2 节阶段④。
- **插件 → 对话消息**：后端用 `ctx.messages.post` 往**指定会话**发一条插件消息（卡片/文本/状态）。它和 AI 记录存在同一个会话文件里，但**不进入 AI 上下文**；界面上是独立的插件消息气泡。见第 11 节。

### 分工

| 宿主负责 | 你负责 |
|---|---|
| 拉起、监控、杀掉后端进程 | 写工具逻辑 |
| 面板的装载、显示、生命周期 | 写面板页面 |
| 权限校验 | 在清单里如实声明权限 |
| 与 agent 对接（注册工具、索引 PLUGIN.md） | 写 PLUGIN.md |
| 市场分发、安装、更新、回滚 | 打包、上架 |

### 你能往应用里挂什么（贡献点一览）

| 贡献点 | 效果 |
|---|---|
| `tools` | agent 多出几个可调用的工具 |
| `panels` | 侧栏多出一块面板 |
| `commands` | 输入框里的斜杠命令 |
| `settings` | 插件中心里自动渲染的设置表单 |
| `messageRenderers` | 工具结果渲染成对话里的交互卡片 |
| `filePreview` | 某类文件在文件树里被点开时，路由到你的面板 |
| `skills` | 附带给 agent 的技能文档 |

想看真实插件长什么样：仓库 `plugins/` 下的四个官方插件就是参照实现。**com.pi.tasks** 最典型（工具 + 面板 + 定时任务）；**com.pi.browser** 演示如何在面板里嵌入宿主的浏览器引擎，以及多标签与会话作用域；**com.pi.files** 演示插件如何自带一整套大型渲染引擎；**com.pi.devdocs**（就是这份文档）是最小的纯 UI 插件：只有 manifest + 一张网页，没有后端、没有构建步骤。

---

## 2. 快速开始：做一个覆盖主要能力的插件

目标：做一个「便签」插件。它故意保持很小，却完整走过插件系统的四条主干路：

| 阶段 | 加进应用的能力 | 用到的机制 |
|---|---|---|
| ① 工具 | agent 能读写便签 | `contributes.tools` + `storage` 能力 |
| ② 面板 | 右栏一块可编辑的界面 | `contributes.panels` + `piSDK` 三条对应 |
| ③ 面板 → agent | 面板上一键把便签交给 agent 处理 | `chat.send` 能力（消息自带来源标注） |
| ④ 对话卡片 | agent 每次改便签，对话流里出现一张带按钮的卡片 | `contributes.messageRenderers` + `onCardEvent` |

四个阶段是同一个插件在逐步长大：每一步做完应用里都有可见的变化，可以一次做完，也可以分开做、分开验收。

### 开始之前

- 装有 Node.js 20 或更新版本。
- 插件 SDK（`@pi/plugin-sdk`）目前还没有发布到 npm，随仓库分发。你的插件通过**路径依赖**指向仓库里的 `packages/plugin-sdk`（第 2 步会写），打包时 SDK 会被并进你的后端文件，发布插件时不需要仓库存在。

### 第 1 步 · 建目录

```bash
mkdir com.example.note && cd com.example.note
mkdir -p src/backend ui
```

整个教程做完的文件结构（注释标了每个文件诞生在哪个阶段）：

```
com.example.note/
├── package.json          ← 工程配置，只为安装依赖和打包服务（第 2 步）
├── manifest.json         ← 插件清单，随阶段逐步扩充（第 3 / 8 / 10 步）
├── PLUGIN.md             ← 给 agent 的说明书（第 4 步）
├── src/backend/index.ts  ← 后端源码，随阶段逐步扩充（第 5 / 9 / 10 步）
├── dist/main.mjs         ← 后端打包产物（每次改动后重新打包）
└── ui/index.html         ← 面板页面（第 8 / 9 步）
```

> `id` 的习惯是反域名格式（`com.公司.插件名`），目录名也建议保持一致。宿主只认 `manifest.json` 里的 `id`，目录名不一致仍能加载；但市场安装会用 `id` 作为安装目录名，两种路径下不一致时容易找错目录。

### 第 2 步 · `package.json` 并安装依赖

```json
{
  "name": "com.example.note",
  "private": true,
  "type": "module",
  "dependencies": {
    "@pi/plugin-sdk": "file:/换成你的实际路径/PiWork/packages/plugin-sdk"
  },
  "devDependencies": {
    "esbuild": "^0.24.0"
  }
}
```

```bash
npm install
```

### 第 3 步 · `manifest.json`（阶段①：只贡献工具）

```json
{
  "id": "com.example.note",
  "name": "便签",
  "version": "0.1.0",
  "apiVersion": 5,
  "description": "我的第一个插件：一条能保存的便签",
  "backend": "./dist/main.mjs",
  "permissions": ["storage"],
  "contributes": {
    "tools": [
      {
        "name": "note_read",
        "description": "Read the current note text.",
        "readOnly": true
      },
      {
        "name": "note_write",
        "description": "Replace the note text.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "text": { "type": "string", "description": "The new note content." }
          },
          "required": ["text"]
        }
      }
    ]
  }
}
```

逐个说清楚：

| 字段 | 这里填了什么 | 为什么 |
|---|---|---|
| `id` | `com.example.note` | 全应用唯一。建议与目录名一致（市场安装以 `id` 作为目录名） |
| `name` | 便签 | 界面里显示的名字 |
| `version` | 0.1.0 | 你自己的版本号 |
| `apiVersion` | 5 | 你照哪一版插件协议写的。宿主支持一个区间（当前 3 – 5），落进去就能加载 |
| `backend` | ./dist/main.mjs | 后端入口。省略这个字段 = 纯面板插件 |
| `permissions` | ["storage"] | 要用 `storage.*` 能力（存便签）就得声明它。安装时用户会看到并确认 |
| `contributes.tools` | 两个工具 | `name` 全应用唯一；`description` 是 agent 决定调不调它的依据；`inputSchema` 用标准 JSON Schema 描述参数；`readOnly: true` 声明此工具只读不写 |

### 第 4 步 · `PLUGIN.md`（让 agent 认识你）

在插件根目录建 `PLUGIN.md`：

```markdown
---
name: note
description: "用户的个人便签。用户提到「便签」——查看、更新、随手记一条——时用它。"
---

# 便签

一条全局便签，存本地。

- `note_read` — 读当前内容
- `note_write({ text })` — 整体替换内容
- 面板里也能直接编辑，两边是同一份数据
```

六行就够用了。frontmatter 里的 `description` 是 agent 每次对话都能看到的一行索引，**写"用户会说什么话时用它"**，不要写"这是什么"——这是决定 agent 会不会想起你的唯一一行字。写法详解见第 3 节。

### 第 5 步 · 后端 `src/backend/index.ts`（阶段①：只实现 onTool）

```ts
import { plugin } from '@pi/plugin-sdk';

plugin({
  // agent 调用工具时走这里
  async onTool(name, args, ctx) {
    if (name === 'note_read') {
      const note = await ctx.call('storage.get', { key: 'note' });
      return String(note ?? '');
    }
    if (name === 'note_write') {
      await ctx.call('storage.set', { key: 'note', value: String(args.text ?? '') });
      return '已保存。';
    }
    throw new Error(`unknown tool: ${name}`);
  },
});
```

要点：

- `plugin(...)` 在**模块顶层调用一次**。宿主启动时直接把 `dist/main.mjs` 作为子进程运行，所以"导入即启动"，不需要你写 main 函数。
- `ctx.call('能力名', 参数)` 调用宿主能力。`storage.*` 存的是插件私有的键值对，别的插件读不到。
- `return` 的字符串就是 agent 看到的工具结果。**忘了 `return` 会被当成错误报出来**，不会静默。

### 第 6 步 · 打包

```bash
npx esbuild src/backend/index.ts --bundle --platform=node --format=esm \
  --target=node20 --minify=false --keep-names --outfile=dist/main.mjs
```

完成后 `dist/main.mjs` 应该出现。

> **必须 `--bundle`（把依赖打进单文件）。** 宿主只运行 `dist/main.mjs` 这一个文件，SDK 和其它依赖都要在里面。`--minify=false --keep-names` 不压缩不改名——后端的报错堆栈会进应用日志，压缩过的堆栈没法看。面板（HTML）不需要打包。

### 第 7 步 · 安装并重启

```bash
mkdir -p ~/.pi/agent/plugins/com.example.note
cp manifest.json PLUGIN.md ~/.pi/agent/plugins/com.example.note/
cp -R ui dist ~/.pi/agent/plugins/com.example.note/
```

然后**完全退出并重新打开应用**（安装新插件目前需要重启；市场安装不用）。

### 阶段① 验收

逐条检查，每条都应成立：

1. 打开插件中心：已安装列表里出现「便签」，开关打开，状态"运行中"（此刻它还没有面板，右侧栏的插件列表里也没有它——那是阶段②的事）。
2. 在对话里说「帮我在便签里记一句：周五交报告」→ agent 调用 `note_write`，回复"已保存"。
3. 说「便签里写了什么」→ agent 调用 `note_read`，复述内容。

### 第 8 步 · 阶段②：面板——右栏一块能编辑的界面

清单的 `contributes` 里加一块面板（和 `tools` 平级）：

```json
"panels": [
  { "id": "main", "title": "便签", "entry": "./ui/index.html" }
]
```

`id` 在插件内唯一即可；`entry` 指向网页文件；面板默认出现在右侧栏。

后端加三个回调（和 `onTool` 平级，贴在它后面）：

```ts
// 面板加载完成时走这里 —— 面板的首次绘制放这儿
async onPanelMounted(panelId, params, ctx) {
  const note = await ctx.call('storage.get', { key: 'note' });
  ctx.send(panelId, 'note.render', { text: note ?? '' });
},

// 面板向后端要数据时走这里
async onRequest(panelId, method, params, ctx) {
  if (method === 'note.get') {
    const note = await ctx.call('storage.get', { key: 'note' });
    return note ?? '';
  }
  throw new Error(`unknown method: ${method}`);
},

// 面板报告用户操作时走这里
async onEvent(panelId, event, data, ctx) {
  if (event === 'note.save') {
    const text = String((data as { text?: string })?.text ?? '');
    await ctx.call('storage.set', { key: 'note', value: text });
    ctx.send(panelId, 'note.saved', {});
  }
},
```

同时给 `note_write` 分支补一行推送，让面板跟着 agent 的修改刷新：

```ts
if (name === 'note_write') {
  await ctx.call('storage.set', { key: 'note', value: String(args.text ?? '') });
  ctx.send('main', 'note.changed', {}); // ← 新增。面板没开着时它返回 false，不是错误
  return '已保存。';
}
```

新建面板页面 `ui/index.html`。面板就是一张普通网页，宿主会在页面加载前往 `window` 上注入 `piSDK`，你只管用它：

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body {
        margin: 0; padding: 12px; font-size: 13px;
        font-family: var(--font-sans, system-ui);
        color: hsl(var(--foreground, 222 19% 7%));
        background: hsl(var(--background, 0 0% 100%));
      }
      textarea {
        width: 100%; box-sizing: border-box; min-height: 140px; padding: 8px;
        border: 1px solid hsl(var(--border, 214 32% 91%));
        border-radius: 6px;
        background: hsl(var(--card, 0 0% 100%));
        color: inherit; resize: vertical;
      }
      button { margin-top: 8px; padding: 4px 14px; }
      #status { margin-left: 8px; font-size: 12px; opacity: 0.6; }
    </style>
  </head>
  <body>
    <textarea id="note"></textarea>
    <div>
      <button id="save">保存</button>
      <span id="status"></span>
    </div>

    <script>
      const note = document.getElementById('note');
      const status = document.getElementById('status');

      // ① 收后端推来的消息
      piSDK.onMessage((msg) => {
        if (msg.event === 'note.render' || msg.event === 'note.changed') load();
        if (msg.event === 'note.saved') status.textContent = '已保存 ✓';
      });

      // ② 向后端要数据（后端 onRequest 返回什么，这里就拿到什么）
      async function load() {
        status.textContent = '';
        note.value = (await piSDK.request('note.get')) ?? '';
      }
      load();

      // ③ 告诉后端用户干了什么（后端 onEvent 收到）
      document.getElementById('save').onclick = () => {
        piSDK.emit('note.save', { text: note.value });
      };
    </script>
  </body>
</html>
```

面板和后端一共就三个呼应：`piSDK.request` ↔ `onRequest`、`piSDK.emit` ↔ `onEvent`、`piSDK.onMessage` ↔ `ctx.send`。**面板不直接调宿主能力**（`storage` 之类必须由后端调），这条规则详见第 4 节。

样式里的 `hsl(var(--...))` 是在适配宿主主题：宿主会把一组 CSS 变量注入面板，细节见第 4 节；上面写的兜底值保证不注入时也不难看。

重新打包（第 6 步的命令），把 `manifest.json`、`ui/`、`dist/` 重新拷进安装目录，重启应用。

**验收（阶段②）**

1. 右侧栏的插件网格或加号弹层里出现「便签」，点开是一个标签页，能输入文字、点保存出现"已保存 ✓"。
2. 完全退出应用再打开：便签内容还在（说明 `storage` 真的落盘了）。
3. 对 agent 说「把便签改成：XXX」→ 开着的面板自动刷新成新内容（`note.changed` 那行推送）。

### 第 9 步 · 阶段③：面板发消息给 agent

目标：面板上加一个「让 agent 整理」按钮——点一下，当前对话里出现一条来自插件的消息，agent 接手处理。

面板 `<body>` 里加按钮（和保存按钮并排）：

```html
<button id="ask">让 agent 整理</button>
```

面板脚本加：

```js
document.getElementById('ask').onclick = () => {
  piSDK.emit('note.ask', {});   // 还是那三条对应：emit → 后端 onEvent
};
```

后端的 `onEvent` 加一个分支：

```ts
if (event === 'note.ask') {
  const note = await ctx.call('storage.get', { key: 'note' });
  await ctx.call('chat.send', {
    text: `请把我的便签整理成三个要点。便签内容：${note ?? '(空)'}`,
  });
}
```

关于 `chat.send`，要知道这些：

- **不需要声明权限**，但发出的消息永远带来源标注（「插件消息 · 来自 便签（com.example.note）」）——插件够得着对话，但拿不到用户的声音，agent 和用户都看得出这不是用户亲手打的。
- 消息会像用户输入一样触发一个 agent 回合：上面那条消息发出后，agent 会自己去调 `note_read`，把整理结果回在对话里。
- 它要求当前有一个打开的会话。
- 对话里显示的不是用户气泡，而是一张**插件请求卡**（插件图标/名称、「已交给 AI」徽章）。`text` 是用户读到的文案，`agentText` 是给模型的指令——两者可以不同：
  ```ts
  await ctx.call('chat.send', {
    agentText: '把选中的网页内容翻译成中文，结果用 browser_show 展示…',  // 只给模型
    title: '翻译网页内容',                        // 卡片标题
    quote: 'Trending',                            // 卡片里的引用块（最多 4000 字）
    source: { label: 'GitHub Trending', url: 'https://github.com/trending' }, // 来源行
  });
  ```
  `title` / `quote` / `source` / `agentText` 都可省略；只有 `text` 的普通消息同样渲染成插件卡片，绝不会变成假用户气泡。

重新打包、拷贝、重启。

**验收（阶段③）**

在对话里开一个会话，到面板上点「让 agent 整理」→ 对话流里出现带「插件消息 · 来自 便签」标注的消息 → agent 接手，回复整理结果。

### 第 10 步 · 阶段④：对话卡片——工具结果渲染进对话流

目标：agent 每次改便签，对话流里不只一行文字，而是一张**带按钮的卡片**：显示新内容，能撤销、能跳到面板。

清单的 `contributes` 里加（`type` 填**工具名**——声明后这个工具的结果就会用卡片渲染）：

```json
"messageRenderers": [{ "type": "note_write" }]
```

把 `onTool` 里的 `note_write` 分支整个换成下面这版——多存一份上一个内容（给撤销用），返回值从字符串变成 `{ content, card }`：

```ts
if (name === 'note_write') {
  const text = String(args.text ?? '');
  const previous = await ctx.call('storage.get', { key: 'note' });
  await ctx.call('storage.set', { key: 'previous', value: String(previous ?? '') });
  await ctx.call('storage.set', { key: 'note', value: text });
  ctx.send('main', 'note.changed', {});
  return {
    content: [{ type: 'text', text: '便签已更新。' }],
    card: {
      component: 'Card',
      props: { title: '便签已更新' },
      children: [
        { component: 'Text', props: { text } },
        {
          component: 'Row',
          children: [
            { component: 'Button', props: { label: '撤销这次修改' }, events: { onClick: 'undo' } },
            { component: 'Button', props: { label: '打开面板', variant: 'ghost' }, events: { onClick: 'open_panel' } },
          ],
        },
      ],
    },
  };
}
```

`card` 是一棵声明式的 UI 树（`{ component, props, children, events }`）——你只描述"长什么样"，宿主用它自带的组件渲染，你的插件不用发任何 UI 代码。`events: { onClick: 'undo' }` 的意思是：按钮被点击时，把 `undo` 这个事件 id 送回后端。完整的组件词汇表见下表。

| 组件 | 常用 props |
| --- | --- |
| `Card` | `title`（顶部标题条）、`icon`（`file` / `folder` / `check` / `mail` / `calendar` / `clock` / `alert` / `info` / `link` / `sparkles`）、`status`（`success` / `info` / `warning` / `error` / `loading`，标题条右侧的状态点） |
| `Row` / `Column` | `gap`（`sm` / `md` / `lg`）、`padding`、`grow: true`（撑满剩余宽度）；`Row` 另有 `justify`（`between` / `end` / `center`） |
| `Text` | `text`、`variant`（`default` / `muted` / `small` / `title`）、`weight: 'bold'`、`mono: true`、`truncate: true` |
| `Badge` | `text`——小号描边标签，放格式、状态这类短词 |
| `Button` | `label`、`variant`（默认 `outline` 描边；`primary` 才是主色实心）、`disabled`；点击事件写成 `events: { onClick: 'eventId' }`，节点 `props` 会作为 `payload` 回到 `onCardEvent` |
| `KeyValue` | `items` 既可以是 `{ key, value }` 对象，也可以是 `['key', value]` 数组 |
| `List` | `items: [{ key, label, description?, badge? }]`；带 `events.onClick` 时整行可点 |
| `Input` | `placeholder`、`value`，回车触发 `events.onSubmit` |
| `Image` | `source`（base64，可配 `mimeType`）、`maxHeight` |
| `Separator` / `Spinner` / `EmptyState` | 分隔线 / `label` / `title` + `description` |

样式约定：卡片里不写颜色、字号——宿主按当前主题渲染，深浅色都跟着走。按钮默认是描边样式，一张卡最多留一个 `primary` 用来突出唯一的主操作。

后端加 `onCardEvent` 回调（和 `onTool` 平级）：

```ts
// 用户点了你返回到对话里的卡片上的按钮时走这里
async onCardEvent(toolName, eventId, kind, payload, ctx) {
  if (eventId === 'undo') {
    const previous = await ctx.call('storage.get', { key: 'previous' });
    if (previous != null) {
      await ctx.call('storage.set', { key: 'note', value: previous });
      await ctx.call('storage.delete', { key: 'previous' });
      ctx.send('main', 'note.changed', {}); // 让开着的面板跟着回退
      ctx.log.info('已撤销一次便签修改');
    }
  }
  if (eventId === 'open_panel') {
    ctx.openPanel('main', { focus: true });
  }
},
```

两个要知道的规则：

- **卡片事件是单向的**：`onCardEvent` 没有返回值，卡片不会因为撤销了就自己从对话里消失或改样——想让界面反映新状态，靠下一次工具结果返回新卡片，或像上面这样用 `ctx.send` 刷新自己的面板。
- 工具**运行中**，参数还会被宿主实时渲染成「生成中」卡片（agent 正在打的 text 边流边显示）。这是 `messageRenderers` 自带的行为，不用写代码。

重新打包、拷贝、重启。

**验收（阶段④）**

1. 对 agent 说「把便签改成：今晚八点开会」→ 对话流里出现一张「便签已更新」卡片：内容是新文字，下面两个按钮。
2. 点「撤销这次修改」→ 便签回到上一个内容；面板开着的话同步刷新；应用日志里出现 `[plugin:com.example.note]` 的"已撤销一次便签修改"。
3. 点「打开面板」→ 右栏的便签面板被打开并拿到焦点。

### 装完没看到？常见原因对照

| 症状 | 原因 | 怎么查 |
|---|---|---|
| 插件中心根本没有它 | `manifest.json` 有语法错误（JSON 不允许注释和尾逗号）；或清单里声明的 `backend` 文件不存在；或没重启 | 用任意 JSON 校验器过一遍清单；确认 `backend` 指向的文件真实存在 |
| 有条目，但状态是"错误" | 后端启动失败：打包时没 `--bundle` 导致运行时找不到模块，或 10 秒内没发 `ready`（不用 SDK 手写协议时才会遇到） | 看插件后端日志；重跑第 6 步，确认命令一个词不少 |
| 面板空白或打不开 | `entry` 路径写错或文件没构建；或后端日志提示缺少 `onPanelMounted` | 看第 6 节「日志」 |
| agent 从不调用你的工具 | 没有 `PLUGIN.md`，或 `description` 写的是"是什么"不是"什么时候用" | 看第 3 节 |
| 工具结果没有渲染成卡片 | 清单没声明 `messageRenderers`，或 `type` 和工具名不一致 | 核对第 10 步的清单改动 |
| 卡片上的按钮点了没反应 | 后端没实现 `onCardEvent`（按钮退化成展示，不会坏） | 加上 `onCardEvent`，事件 id 对上 `events.onClick` |

---

## 3. PLUGIN.md：让 agent 主动用你的插件

agent **能**调你的工具（清单里注册过）是一回事，**想得到**去调是另一回事——`PLUGIN.md` 解决的是后者。**没有它，agent 对你的插件的全部认知只有工具的 `name` 和 `description`。** 第 4 步已经给过便签的六行版本，这一节讲它的工作方式和写法规则。

### 工作方式：索引常驻，正文按需读

两级结构，和"技能"（skill）一样：

| | 进系统提示吗 | 何时发生 |
|---|---|---|
| frontmatter 的 `description` | ✅ 每次对话都占一行 | 应用启动时 |
| 正文 | ❌ 不进 | agent 判断任务匹配后，自己用 `read` 读 |

所以几十个插件也不会撑爆上下文。**`description` 是唯一让 agent 想起你的地方**，写法见下。

### description 写「什么时候用」，不写「这是什么」

❌ 反例：

> 我的第一个插件：一条能保存的便签

这是写给人的。agent 看完不知道用户说什么话时该掏它。

✅ 正例：

> 用户的个人便签。用户提到「便签」——查看、更新、随手记一条——时用它。

这写的是**用户会说什么**，agent 才能把任务和插件对上。

正文里把边界也写清楚：哪些情况支持、哪些不支持、失败了怎么办。agent 读到「这个格式没接，不要重试」就不会反复试错。

### 和 `contributes.skills` 的区别

- **PLUGIN.md** — 一个插件一份，讲这个插件整体：是什么、什么时候用、工具怎么配合。
- **`contributes.skills`** — 插件附带的可复用技能，会被同步进用户的技能目录。

大多数插件只需要 PLUGIN.md。它直接放在插件目录里，装卸即时生效（下次开对话就更新，不用重启）。

---

## 4. 面板开发

第 2 节已经见过最小面板，这节把规则讲全。面板就是一张普通网页：**不用打包、不用手写消息协议、不用知道宿主怎么装它**。宿主在页面加载前注入 `window.piSDK`。

### 三条对应关系

| 面板这头 | 后端那头 | 说明 |
|---|---|---|
| `await piSDK.request(method, params)` | `onRequest(panelId, method, params, ctx)` | 面板在等一个答复，后端 `return` 的值就是答复 |
| `piSDK.emit(event, data)` | `onEvent(panelId, event, data, ctx)` | 单向报告，没有回复 |
| `piSDK.onMessage(cb)` | `ctx.send(panelId, event, data)` | 收后端推来的东西，`cb` 收到 `{ event, data }` |

**面板 id 不用你管。** 宿主加载页面时把"你是哪块面板"注进去，`piSDK` 自动盖在每条消息上。一个插件有多块面板时，后端天然分得清是谁在说话。

### 面板属于哪个工作区：`piSDK.workspace`

```js
const ws = piSDK.workspace;           // 绝对路径，或 null
piSDK.onWorkspace((id) => { ... });   // 用户切换工作区时再触发；订阅时立刻回放当前值
```

为什么要专门给一条通道：**后端是一个进程，服务所有窗口**。如果把工作区当成后端的模块变量记下来，就成了"最后打开面板的那个窗口说了算"——两个窗口开着不同项目时会互相覆盖。工作区属于**视图**，所以它直接推到页面，不经过后端。协议 7 起可用；老宿主上这两个接口是 `undefined`，按"没有工作区"处理即可。

同理，工具调用里的 `call.workspaceId` 是**调用方会话**所属的工作区，宿主解析不出来时为空——空就是"不知道"，别拿它去猜成"当前窗口的"。

### 对不上会报错，不会静默

| 情形 | 结果 |
|---|---|
| 面板请求了后端没处理的方法 | 后端没实现 `onRequest`、或 handler 抛错时，立即返回带方法名的错误；只有后端完全不回应时，才等到 90 秒超时 |
| 后端 `onRequest` 处理了但忘了 `return` | 面板收到明确报错（"处理了但没返回东西"），不是拿到 `undefined` 假装成功 |
| 插件没有 `onEvent`，面板却发了事件 | 后端日志一条警告，带事件名；实现了 `onEvent` 后所有事件都会交给它，是否处理由你判断 |
| 面板打开后一直空白 | 后端日志会提醒：你没实现 `onPanelMounted` |

### ⚠️ 唯一要记的一条：面板不能直接调宿主能力

面板只能跟**你自己插件的后端**说话，中间那条通道宿主只转发、不看内容。下面这行是错的：

```js
// ❌ 这不叫「读插件存储」——除非你的后端自己实现了叫 storage.get 的方法
await piSDK.request('storage.get', { key: 'x' });
```

正确做法是后端去调（第 2 节的示例正是这么做的：面板 `request('note.get')`，后端在 `onRequest` 里 `ctx.call('storage.get', ...)`）。宿主能力统统走后端的 `ctx.call()`，因为那些调用要过主进程的权限门；面板里没有权限门。

### 多块面板

一个插件可以有多块面板，每块在右侧栏的插件网格/加号弹层里各有一个入口，打开后各是一个标签页（`hidden: true` 的除外，它只能被 `panel.open` 打开）。`panelId` 由宿主注入，你只要在 `ctx.send` 时选对收件人。`keepAlive` 决定切走时面板保不保活（`always` / `lru` 默认 / `never`）。左侧栏的面板建议 `keepAlive: "always"`——左右两侧共享一个只保留 2 个的 LRU 池，左侧面板用 `lru` 会被右侧面板挤掉、状态全丢。

#### 多标签面板：`multiInstance`

一块面板默认只有一个宿主标签：再次打开只聚焦已有那个。声明 `multiInstance: true` 后，同一块面板可以同时开多个宿主标签——每个标签有独立原生视图、独立 `params` 和独立 `tabId`。文件查看器和浏览器就是这么做的（一个标签一个文件/网页）。

多实例面板要处理四件事：

- `onPanelMounted(panelId, params, ctx, meta)` 的 `meta.tabId` 是当前标签；`onRequest` / `onEvent` 的第五个参数 `meta.tabId` 相同。
- `ctx.send(panelId, event, data, tabId)` 只推给那个标签；不传 `tabId` 时推给该面板的所有标签（向后兼容）。
- 实现 `onPanelActivated(panelId, params, ctx, meta)`：用户切到某个标签时触发，用来更新"当前文档 / 当前页面"。
- 标签关闭时后端会收到 `panel.closed` 事件（`data.tabId`），用它清理这个实例的状态。

宿主标签的标题和打开参数可以用 `ctx.call('panel.updateTab', { panelId, tabId, title, params })` 更新——查看器打开文件后就是把标签名改成文件名。

打开面板时宿主会自己决定：同一个 `params` 的标签直接聚焦，**没有 `params` 的空标签优先复用**，都没有才新建。所以不要自己维护"第几个标签"，用 `meta.tabId` 认人。

`scope` 决定面板的标签跟不跟会话走（`global` 默认 / `session`）。展示"这个会话的产物"的面板（agent 开的网页、正在讨论的文档）声明 `session`：切会话时它的标签连同打开参数一起收进那个会话，切回来原样恢复——并发会话之间不会互相抢"当前文档"。跨会话的工作台面板（待办）保持默认。注意：`session` 只是标签归属和参数恢复；引擎/文档本身仍是单实例（当前会话可见的那份），多实例是后续版本的事。

### 主题适配

宿主往面板 `<html>` 上注入一组 CSS 变量（`--background` / `--foreground` / `--card` / `--border` / `--radius` / `--font-sans` 等）。前五个的值是 **Tailwind 风格的 HSL 分量**（如 `222 19% 7%`，不带 `hsl()`），所以颜色必须写成 `hsl(var(--background, 222 19% 7%))` ——分量不是颜色，直接 `var(--background)` 会让整条声明失效、面板变成透明底。`var()` 里的兜底分量保证注入前后都正确。`--radius` / `--font-sans` 是完整值，直接 `var()` 引用。

### 选区归你自己

面板里的文字被选中时，宿主不做任何事——没有滑词菜单，也没有选区上报。想围绕选区做点什么（浮出按钮、送进对话），在你的面板里自己实现。宿主提供 `chat.send` 能力，怎么触发由你决定。

### 进阶：原生槽 piSDK.liveSlot

面板页可以把一块**宿主引擎视图**嵌进自己的布局——宿主把原生视图精确摆在你给的矩形里，你的页面在它周围自由发挥。浏览器插件就是这么做的：地址栏是页面，下面嵌引擎。

```js
// 返回 { detach(), refresh() }。绑定后逐帧跟随元素尺寸；矩形没变不重发。
const slot = piSDK.liveSlot('page', document.getElementById('page-slot'));

// 可选第三个参数 getTag 告诉宿主当前要显示哪个引擎标签（如浏览器活动 tab id）。
// 切标签时 DOM 尺寸不变、ResizeObserver 不会再触发，调用 slot.refresh() 立即重报。
const slotB = piSDK.liveSlot('page-b', document.getElementById('second-pane'), () => activeTabId);
```

规则：

- **矩形即一切**。元素多大视图多大；元素 `display:none` 或卸载会上报 0×0，即"隐藏视图"。
- 槽名空间是插件级的：实际槽 id 是 `<插件id>:<名字>`，页面改不了前缀；槽名不得与自己的面板 id 重名。
- 不是每个插件都有视图可嵌。目前：manifest 声明 `browser` 权限的插件自动获得 `<插件id>:page` 槽（主视图）和 `<插件id>:page-b` 槽（分屏第二栏），内容是宿主的内嵌浏览器引擎。没有的插件调用会在 attach 时被宿主拒绝，原因打进 console。
- 只有原生视图容器（桌面端的面板）能嵌引擎；不在原生视图里调用会返回一个空句柄并打一条 `console.error`，不会抛异常。

### 进阶：原生弹出菜单 piSDK.showPopupMenu

`piSDK.showPopupMenu(items, x, y)` 在原生视图里弹出系统菜单（浮在引擎视图之上），`items` 是 `[{ id, label }]`，返回被点中的 `id`（取消返回 `null`，120 秒无操作也会返回 `null`）。仅桌面原生面板可用；其他环境返回 `null` 并打 `console.error`。浏览器插件的标签右键菜单就是这么做的。

---

## 5. 后端参考

### 能实现哪些回调

| 回调 | 什么时候被调 |
|------|------|
| `onInit(ctx)` | 后端起来了。**此时面板还没开**，别在这儿画界面 |
| `onPanelMounted(panelId, params, ctx, meta?)` | 某块面板加载完了 —— 首次绘制放这儿。`meta.sessionId` 是它当前服务的会话；`meta.tabId` 是多实例面板的宿主标签；`scope: session` 的面板切会话会重新触发 |
| `onPanelActivated(panelId, params, ctx, meta?)` | 用户切到了这个标签（多实例面板用来更新"当前文档/当前页面"） |
| `onRequest(panelId, method, params, ctx, meta?)` | 面板在等一个答复（`return` 它）。`meta.tabId` 是发起请求的标签 |
| `onEvent(panelId, event, data, ctx, meta?)` | 面板报了一件事（单向，无回复）。`meta.tabId` 是发起事件的标签；标签关闭时收到 `panel.closed` |
| `onTool(name, params, ctx, call)` | agent 调了你的工具（`return` 字符串或 `{ content, details, card }`）。`call.sessionId` 是调用方会话 |
| `onCommand(name, args, ctx)` | 斜杠命令跑了 |
| `onContextRequest(providerId, message, ctx)` | 宿主发消息前要上下文，返回要注入的文字 |
| `onHostEvent(event, data, ctx)` | 宿主推了个事件：`session.changed`（`{ sessionId }`，所有后端）、`browser.urlChanged` / `browser.tabOpened`（`{ tabId, url }`，仅 `browser` 权限） |
| `onCardEvent(toolName, eventId, kind, payload, ctx)` | 用户点了你返回到对话里的卡片按钮（`kind:'click'`）或在其中输入框回车（`kind:'submit'`）。事件是单向的；想让卡片反映后续状态，靠下一次工具结果返回新卡片 |
| `onMessageAction(messageId, eventId, kind, payload, ctx, meta?)` | 用户点了你用 `ctx.messages.post` 发到对话里的插件消息卡片。`meta.sessionId` 是该消息所在的会话；用 `ctx.messages.update/remove` 改同一条消息 |

`onPanelMounted` 的 `meta.sessionId`、`meta.tabId` 和 `onTool` 的 `call.sessionId` 用来把"当前文档 / 当前页面"解析到对应会话和标签——并发会话或同会话多标签共用一个全局 current 会串台。

一个都不实现也行——那是一个没有后端的插件（清单里去掉 `backend` 字段）。

### `ctx` 里有什么

| | |
|---|---|
| `ctx.pluginId` | 插件 id |
| `ctx.dataDir` | 这个插件的私有目录（启动前就建好了），随便写文件 |
| `ctx.call(method, params, { timeoutMs? })` | 调宿主能力，返回 Promise；默认 30 秒超时，可单次覆盖 |
| `ctx.send(panelId, event, data, tabId?)` | 往某块面板推事件；`tabId` 只推给那个多实例标签；返回 `false` 表示没送出去（面板没开），不是错误 |
| `ctx.panelAlive(panelId, timeoutMs?)` | 问某块面板还活着吗（尽力而为的探测） |
| `ctx.openPanel(panelId, { focus })` | 打开自己的面板；`focus: false` 只亮角标不抢焦点。要带打开参数时直接用 `ctx.call('panel.open', { panelId, focus, params })`——SDK 的封装只传 focus |
| `ctx.setBadge(panelId, n)` | 面板图标上的角标，传 `null` 清掉 |
| `ctx.messages.post({ sessionId, card?, text?, status?, files?, agentVisible? })` | 往会话发一条插件消息；返回 `{ messageId, entryId }`。`sessionId` 必填（用 `meta.sessionId` 或 `call.sessionId`）；`files` 是绝对路径数组，宿主渲染成文件附件卡片；默认不进入 AI 上下文，`agentVisible: true` 才让模型看到 |
| `ctx.messages.update({ sessionId, messageId, card?, text?, status?, files?, agentVisible? })` | 更新自己发过的消息；省略的字段保持不变，`card: null` / `text: ''` / `files: null` 清空。`agentVisible: true` 表示这一版也进入 AI 上下文。返回新 `revision` |
| `ctx.messages.remove({ sessionId, messageId })` | 撤回自己发过的消息（追加墓碑，不改写历史） |
| `ctx.log.info / warn / error(msg)` | 写进应用日志，前缀是你的插件 id |

### 能力清单（`ctx.call` 的全部可用方法）

| 组 | 方法 | 需要的权限 | 说明 |
|---|---|---|---|
| 应用 | `app.info` | 无 | 返回 `{ pluginId, apiVersion, appVersion, platform }` |
| 存储 | `storage.get` / `storage.set` / `storage.delete` | `storage` | 插件私有键值对，落盘持久 |
| 通知 | `notify.show` | `notify` | 系统通知 |
| 面板 | `panel.open` / `panel.close` / `panel.focusTab` / `panel.updateTab` / `panel.setStatus` | 无 | 只能操作**自己的**面板（`ctx.openPanel` / `ctx.setBadge` 是它们的封装）。`panel.open` 可带 `params`，原样交给面板的 `onPanelMounted`；`panel.focusTab` 聚焦一个已经打开的标签（不按参数匹配）；`panel.updateTab` 改宿主标签的标题/参数 |
| 对话 | `chat.send` | 无 | 叫醒当前对话的 agent 并开始一个回合。对话流里显示**插件请求卡**（不是用户气泡）：`text` 给用户看，`agentText` 给模型（自动带来源标注），可选 `title` / `quote`（最多 4000 字）/ `source`（`{ label, url }`）/ `card` / `files` / `status`。插件够得着对话，但拿不到用户的声音 |
| 对话 | `messages.post` / `update` / `remove` | `messages` | 往**指定会话**发/改/撤回插件消息（卡片/文本/文件/状态）。存进会话记录、可随会话回放，默认**不进入 AI 上下文**；`agentVisible: true` 才让模型看到这一版。`sessionId` 必填；卡片是声明式 UI 树；`files` 是绝对路径数组，渲染成文件附件卡片；更新是追加 revision，读取时折叠最新；删除是追加墓碑。用户可在插件中心静音某个插件的消息 |
| 对话框 | `dialog.openFile` / `dialog.saveFile` | 无 | 系统文件对话框。用户亲手选就是授权。`openFile` 返回 `{ canceled, path, paths }`，`saveFile` 返回 `{ canceled, path }` |
| 文件 | `filesystem.read` / `write` / `delete` | `filesystem` | 任意绝对路径。`read` 返回 UTF-8 文本（≤2MB；docx/xlsx/pptx 用 `office.read`）；`write` 支持 `content`（文本）或 `contentB64`（二进制），`expectedMtime` 冲突检测；`delete` 同样支持 `expectedMtime` |
| Office | `office.read` | `filesystem` | 提取 docx / pptx / xlsx 等文档的文本内容（≤20MB） |
| 网络 | `network.fetch` | `network:<域名>` | 出站请求，按清单里声明的域名白名单逐次校验；返回 `{ ok, status, body }`，响应体上限 2MB |
| 浏览器页面 | `browser.navigate` / `click` / `fill` / `hover` / `scroll` / `select` / `reload` / `back` / `forward` / `screenshot` / `getText` / `getUrl` / `find` / `walk` / `evaluate` / `getState` | `browser` | 驱动宿主内嵌浏览器（自动化、读页面、截图）。页面级方法接受可选 `tabId`，省略时用当前活动标签 |
| 浏览器标签 | `browser.tabList` / `newTab` / `reorderTab` / `setSplitTabs` / `activateTab` / `closeTab` | `browser` | 多标签管理：标签按 `sessionId` 分桶，`newTab` / `activateTab` / `closeTab` / `reorderTab` 用会话定位；`setSplitTabs` 设置分屏伙伴 |

调用示例：

```js
await ctx.call('storage.set', { key: 'note', value: 'text' });
await ctx.call('filesystem.read', { path: '/workspace/data.json' });
await ctx.call('filesystem.write', { path, content, expectedMtime });
await ctx.call('browser.navigate', { url });
await ctx.call('network.fetch', { url, method: 'GET' });
await ctx.call('notify.show', { title, body });
await ctx.call('panel.open', { panelId: 'main', focus: true });
await ctx.call('chat.send', { text: '该喝水了' });
await ctx.call('dialog.openFile', { filters: [{ name: 'Word', extensions: ['docx'] }] });
```

### 写错了会怎样

**这一节是 SDK 存在的理由。下面每一条，以前全都是静默的**——界面上"点了没反应"，日志里什么都没有，只能靠猜：

| 你写了什么 | 会发生什么 |
|---|---|
| `onRequest` 忘了 `return` | 面板收到明确报错："处理了但没返回东西" |
| 回调里抛异常 | 对面收到报错，带着异常信息 |
| `onTool` 忘了 `return` | agent 收到报错："工具没返回任何东西" |
| 面板发了个你**没有实现 `onEvent`** 的事件 | 后端日志一条 `warn`，带事件名（实现了 `onEvent` 后所有事件都会送进来，是否处理由你决定） |
| 面板的消息没带 panel id | 后端日志一条 `warn` |
| 实现了 `onEvent` 但没实现 `onPanelMounted` | 面板首次挂载时 `warn` 一条，提醒你别忘了画 |
| `ctx.call` 一直不回 | 30 秒后拒绝，带方法名（可用 `timeoutMs` 覆盖） |
| 面板的 `piSDK.request` 一直不回 | 90 秒后拒绝，带方法名（比后端宽，给深列表留裕量） |
| 不在宿主里直接运行后端文件 | `plugin(...)` 立刻抛错：后端只能由宿主拉起 |

日志前缀是 `[plugin:你的插件id]`，和应用日志混在一起——直接搜插件 id 就能找到。

### 底层协议（一般不用看）

SDK 底下是两套通道。**只有你不打算用 SDK 的时候才需要知道**（比如给一个已经很复杂的既有后端做适配）：

- **控制面** —— `process.parentPort`。生命周期、能力调用、工具、命令都走这儿，都过主进程，所以权限在这边判。
- **数据面** —— 一个 MessagePort，面板和你的后端点对点，宿主只转发不看内容。

启动后 10 秒内必须发 `ready`，否则宿主会杀掉后端。消息类型见仓库 `packages/types/src/plugin/protocol.ts`（控制面）和 `packages/plugin-sdk/src/index.ts`（数据面）。

---

## 6. 调试与自测

### 看日志

后端的所有 `ctx.log.*` 和未捕获报错都进应用日志，前缀 `[plugin:你的插件id]`。开发本仓库时跑 `pnpm dev:desktop:plugins`（仓库插件模式），日志直接在终端里。

### 开发本仓库的官方插件：不要拷目录

上面第 7 步那条路装的是**副本**。装完再改仓库里的 `plugins/<id>/` 不会有任何反应——应用读的是 `~/.pi/agent/plugins/` 里那份。这个坑的典型症状是"我明明改了，怎么没生效"。

开发时把仓库的 `plugins/` 直接设成开发根目录：

```bash
pnpm dev:desktop:plugins  # 设 PI_DEV_PLUGINS=<仓库>/plugins 后再启动
```

也可以手动设：`PI_DEV_PLUGINS=/绝对路径/plugins`（**冒号分隔**，可给多个）。开发目录的优先级高于用户目录，同名插件以仓库为准，不会打架。

想把仓库插件发布到用户目录、走真实的安装/更新流程：

```bash
pnpm plugins:publish              # 构建 + 重新打市场包（默认带开发版本后缀）
pnpm plugins:publish --install    # 直接安装到 ~/.pi/agent/plugins
pnpm dev:desktop                  # 客户路径：读用户目录
```

`--no-stamp` 保持原版本号，此时插件中心显示「重装」而不是「更新」。

两个配套注意点：

- `plugins/` 不在 pnpm workspace 里，根目录的 `pnpm install` 碰不到它。新 clone 后先跑一次 `pnpm setup`（逐个插件装依赖并构建）。有的官方插件（`com.pi.tasks`、`com.pi.files`）面板入口在 `ui-dist/`，属于构建产物——不构建的话插件会**静默不显示**，不是报错。
- 插件默认启用：`~/.pi/agent/plugins/_state.json` 里没有记录的插件视为开启。

### 不启动应用，单独测后端

拿一个假宿主驱动打包好的 `dist/main.mjs`：

```js
process.parentPort = fakePort;                 // 必须在 import 之前
await import('./dist/main.mjs');               // SDK 在导入时接管
```

> 顺序不能反：SDK 在 `plugin(...)` 被调用那一刻就要宿主端口，拿不到直接抛错。

现成的样板：

- SDK 自己的契约测试（21 项，覆盖每一条报错路径）：先 `pnpm --filter @pi/plugin-sdk build`，再 `node packages/plugin-sdk/tests/smoke.mjs`。测试加载的是 `dist/`，改了 SDK 源码不重建会测到旧代码。
- 各官方后端的自测：`node plugins/com.pi.tasks/scripts/smoke-backend.mjs`（browser / files 也有同名脚本）。它们加载各自的 `dist/main.mjs`，改过后端要先重新构建该插件。

### 常见坑速查

| 症状 | 原因 |
|---|---|
| 插件静默不显示 | 面板入口文件（如 `ui-dist/`）没构建 |
| 面板透明底 / 颜色不对 | CSS 变量没包 `hsl()`，见第 4 节 |
| 工具永远不被调用 | 没有 PLUGIN.md，或 `description` 写的是"是什么"不是"什么时候用" |
| 改了没生效 | 装的是副本，改的是仓库（见上文"不要拷目录"） |
| 后端启动即被杀 | 10 秒内没发 `ready`（不用 SDK 手写协议时才会遇到） |

---

## 7. 定时任务（进阶）

定时器/调度逻辑放在**后端**，不放面板——宿主在启动时拉起所有已启用插件的后端，且没有空闲回收，所以后端是插件里唯一活得比面板久的地方。面板里的定时器会在用户切走的那一刻停掉，而那正是需要提醒的时候。

评估窗口记在 storage 里，每次只算 `(上次评估, 现在]` 这一段：

```js
async function tick() {
  const from = state.lastTickAt ? new Date(state.lastTickAt) : new Date();
  const now = new Date();
  for (const firing of dueBetween(state.items, from, now)) {
    await perform(firing);           // notify.show / chat.send
  }
  state.lastTickAt = now;
  await save();
}
```

三个容易踩的点：

**1. 用半开区间 `(from, to]`。** 左闭的话，每次 tick 都会把边界上那一次重放一遍。

**2. 给每一次触发一个稳定的 key，已经跑过的跳过。** key 用 `条目 + 发生在哪一次 + 触发器`，不要用时间戳或自增序号——否则 tick 和启动补齐重叠时会重复触发。幂等做对了，补跑和重启才都是安全的。

**3. 别用固定 `setInterval` 轮询。** 「下一次什么时候该响」是算得出来的：

```js
const next = soonestFiringAfter(items, now);
setTimeout(tick, next ? clamp(next - now, 250, 30_000) : 30_000);
```

上限 30 秒是兜底（时钟跳变、休眠唤醒、日期翻页），下限 250 毫秒防止空转。

### 错过的触发：记下来，**不要**自动补跑

应用关闭期间不会执行。后端启动时拿 storage 里的时间戳一比，就能算出这段时间里本该发生什么——这一段是可靠的。

但**不要把错过的触发一次性全补上**：一口气弹 8 小时的通知是噪音，一口气跑 8 个 agent 任务还可能花掉用户的钱。正确做法是给一个宽限期（两分钟左右，吸收 tick 抖动和短暂重启），超过宽限期的记成「错过」，**由用户决定要不要补跑**。

### 判断「用户还在不在」没有可靠信号

后端拿不到渲染进程已死的通知；往死掉的通道上发消息是静默 no-op，`try/catch` 什么也抓不到。实测的一个反直觉现象：**macOS 上关掉窗口，插件的面板视图仍然活着**（`visibilityState` 是 `hidden`），所以「面板还响应」并不能证明「消息送得出去」——composer 在主窗口里，不在插件面板里。

结论：与其猜，不如**以发送本身的结果为准**。`ctx.send` 返回 `false`、`chat.send` 失败，就记成「没送到」（而不是「出错」），把原始错误留在详情里，并在界面上写清楚这类触发要求窗口开着。不要因为服务不可用在界面上显示「已送达」。

---

## 8. 权限参考

| 权限 | 说明 |
|------|------|
| `storage` | 插件私有键值对（每插件独立目录，互不可见） |
| `notify` | 系统通知 |
| `messages` | 往会话里发插件消息（`messages.post`）；默认不进入 AI 上下文 |
| `browser` | 驱动宿主浏览器自动化，并解锁 `liveSlot` 的 `page` / `page-b` 引擎槽 |
| `network:<域名>` | 出站网络（域名白名单，可多条） |
| `filesystem` | 读写文件，**任意绝对路径**（含二进制），不限工作区 |

> 安装授权文案里还会出现 `clipboard` 和 `secrets:<命名空间>` 两项，但宿主**目前没有对应能力**：声明了也无法通过 `ctx.call` 调用（会报 unknown capability），剪贴板与凭据保管箱仍是预留项。

权限在安装时逐条展示给用户确认；运行时每个能力调用都被主进程逐次校验，未授权直接拒绝。

> **`filesystem` 的范围，是这台机器上本进程能碰到的所有路径**，不是某个工作区。写清楚是因为安装时用户是看着这句话点同意的：一个 `filesystem` 插件能读 `~/.ssh/id_rsa`，也能写 `~/.zshrc`。真要收窄，得给清单加路径范围声明（例如 `filesystem:~/Documents`）——那是协议层的改动，目前没有。
>
> 所以：**需要用户指定文件时，用 `dialog.*` 让用户自己选**，别去猜路径。用户亲手选出来的路径，才是这条权限唯一有意义的边界。

---

## 9. 发布到市场

**前四步不用手写**——仓库里的 `scripts/build-market.mjs` 全干了：

```bash
node scripts/build-market.mjs          # 打包 + 算 sha256 + 写 index.json
node scripts/build-market.mjs --out ./dist-market
```

它只打运行时该带的（`manifest` / `dist/` / `ui-dist/` / `assets/` / `PLUGIN.md`），跳过 `src/`、`tests/`、`node_modules/` 等。打完把 `market-dist/` 传到哪儿都行，然后把 `~/.pi/agent/plugins/_state.json` 的 `registry` 指过去。

想自己实现一遍，是这四步：

1. 打包插件目录为 zip
2. 计算 sha256（**索引里必须有，缺了会拒绝安装**）
3. 发布注册表 `index.json`：

```json
{
  "plugins": [{
    "id": "com.example.my-plugin",
    "name": "My Plugin",
    "version": "1.0.0",
    "apiVersion": 5,
    "url": "https://cdn.example.com/my-plugin-1.0.0.zip",
    "sha256": "…",
    "permissions": ["storage", "network:api.example.com"]
  }]
}
```

`url` 可以是相对 `index.json` 的路径（官方 `build-market.mjs` 就这么写，市场目录整体搬到别处仍然可用）。`apiVersion` 会用于下载前的兼容性预检；缺了它就要等装的时候才发现版本不兼容。

4. 宿主安装流：拉索引 → 下载 zip → sha256 校验 → 版本协商 → 原子解压 → 授权确认 → 激活

### 图标规范

- 插件品牌图标：自带 SVG（单色，CSS mask 渲染随主题变色）。建议上架带上；没有时插件中心和面板图标会回落到 `puzzle`。
- 面板图标：清单里面板的 `icon` 字段。写路径（`./assets/x.svg`）是自带文件，写名字（`calendar`）用系统图标；不写就继承插件品牌图标。
- 可用系统图标名：settings / puzzle / globe / browser / mail / calendar / todo / knowledge / database / erp / chat / eye / note / users / money / clock / sliders / layout / file / folder / search / session（写错不报错，回落到 puzzle；没有 `gear`，齿轮是 `settings`）

---

## 10. 现成模板：连接器插件

把外部业务系统（ERP / CRM / 工单）接进来，仓库里有现成脚手架：**`templates/connector-plugin/`**。复制、把 `NAME` 全局替换成你的系统标识、改三处就好：

| 改哪 | 改什么 |
|---|---|
| `src/backend/index.ts` → `fetchRecords()` | 换成对你系统的 HTTP API 调用 |
| `src/backend/index.ts` → `toListItems()` | 把 API 记录映射成面板行 |
| `manifest.json` | id / 名称 / 权限 |

它和官方插件走**同一套** SDK 和同一套构建方式，照着写不会踩旧坑。

---

## 11. manifest.json 字段总表

### 顶层字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 反向 DNS 格式（`com.company.plugin`），也是目录名 |
| `name` | ✅ | 显示名称 |
| `version` | ✅ | 你的版本号，semver |
| `apiVersion` | ✅* | 你照哪一版协议写的。宿主按**支持区间**判定：当前 **3 – 5**，落区间内即可加载；低于下限提示"插件太旧"，高于上限提示"请升级客户端"（市场目录里就会标出来，不会装到一半才失败）。协议只加功能时只抬上限，你的插件不受影响；只有破坏性变更才抬下限。(*文档示例请务必写上；省略时按历史遗留插件放行) |
| `description` | — | 一句话说明（插件中心显示） |
| `engines` | — | 宿主版本约束 `{ "pi-desktop": ">=0.1.0" }` |
| `backend` | — | 后端入口（相对路径）；省略则纯 UI 插件 |
| `permissions` | — | 权限声明数组（见第 8 节） |
| `icon` | — | 品牌图标，相对路径（推荐 SVG） |
| `contributes` | — | 贡献点，见下 |

### contributes.panels — 面板

**面板就是一张网页**，`entry` 指明它在哪，其余宿主负责。面板默认落在**右侧栏**；左侧栏是"全局视角"列（全部文件、全部会话、agent 配置），右侧是"当前对象"列。放哪边取决于面板讲的是工作区整体还是正在看的那一个东西。

```json
{
  "panels": [
    {
      "id": "main",
      "title": "面板标题",
      "entry": "./ui/index.html",
      "icon": "./assets/icon.svg",
      "keepAlive": "lru",
      "region": "right",
      "anchor": "top",
      "order": 0
    }
  ]
}
```

| 属性 | 说明 |
|------|------|
| `entry` | ✅ 面板的 HTML 页面，相对插件根目录 |
| `icon` | 写 `./assets/x.svg` 是自带文件，写 `calendar` 是系统图标。不写就继承插件品牌图标 |
| `keepAlive` | `always` / `lru`（默认）/ `never` — 切走时保活策略 |
| `multiInstance` | `true` 时同一面板可以开多个宿主标签（文件查看器、浏览器）；默认一个 |
| `scope` | `global`（默认）/ `session` — 面板标签跟不跟会话走；`session` 的标签和打开参数随会话切换收起/恢复 |
| `hidden` | `true` 不上图标栏，仅 `panel.open` 可达 |
| `companion` | 同一插件的另一块面板 id：主面板打开时，这块面板作为分屏第二栏并排显示。通常把 companion 本身设为 `hidden: true`，只能通过分屏打开 |
| `region` | `left` / `right`（默认） |
| `anchor` | `top`（默认）/ `bottom` — 在所属栏图标列里的位置（仅左侧栏使用；右侧栏的入口按 `order` / 用户排序排列） |
| `order` | 同一 region + anchor 内的排序，默认 0 |

> 没有"面板类型"这个字段。你不需要声明面板长什么样、宿主怎么装它——那是宿主的事，而且会变。你的面板在任何宿主上都是同一张网页、同一套 `piSDK`。

### contributes.tools — agent 工具

```json
{
  "tools": [{
    "name": "query_orders",
    "description": "Query orders by status",
    "readOnly": true,
    "inputSchema": {
      "type": "object",
      "properties": { "status": { "type": "string" } },
      "required": ["status"]
    }
  }]
}
```

**命名规则**：工具名在**所有插件之间**是同一个命名空间。给工具名带一个稳定前缀（通常取自你的插件 id，如 `office_read`）。同一个清单里重名 → 清单整个被拒绝；跨插件重名 → 先注册的赢（开发目录优先于用户目录，和插件 id 的遮蔽规则一致），后到的被忽略并打进日志——别指望靠后加载覆盖别人的工具。

**`readOnly`**：声明这个工具只观察状态、不写任何东西。宿主可以据此跳过确认或在插件中心打标——声明要诚实，错的 `true` 等于教宿主信任一个会写数据的工具。

**`description` 写一句话就够**：它每次对话都进上下文，是触发线（"是什么、什么时候调"），不是说明书。操作细节、顺序、坑，写进你的 `PLUGIN.md`——那里按需加载，不占常驻成本。

#### `contract` — 工具能力契约（可选，协议 6）

工具除了长什么样，还要告诉模型**边界**：它能做什么、明确不能做什么、结果最多多大。这些写不进 JSON Schema，写进 `contract`：

```json
{
  "tools": [{
    "name": "query_orders",
    "description": "Query orders by status",
    "readOnly": true,
    "inputSchema": { "type": "object", "properties": { "status": { "type": "string" } }, "required": ["status"] },
    "contract": {
      "domain": "orders",
      "summary": "Query orders by status; returns a bounded page of rows.",
      "guidelines": [
        "Call this instead of reading the orders spreadsheet directly."
      ],
      "limits": { "maxOutputChars": 20000, "cursorParam": "offset" },
      "unsupported": [
        { "operation": "writing or cancelling orders", "alternativeTool": "order_update" }
      ]
    }
  }]
}
```

| 字段 | 作用 |
|---|---|
| `domain` | 粗粒度领域，用于分组和日志，如 `office` / `browser` / `orders` |
| `summary` | 一行摘要，进系统提示的 Available tools；不写就从 `description` 第一行推导 |
| `guidelines` | 追加到系统提示 Guidelines 的短条目，写"什么时候用/别用" |
| `limits.maxOutputChars` | 返回给模型的文本上限，默认 **50,000 字符** |
| `limits.maxOutputLines` | 行数上限，默认 **2,000 行** |
| `limits.cursorParam` | 分页参数名；截断提示会告诉模型传这个参数继续 |
| `unsupported` | 明确不做的操作。每条会生成一条「不要用它做 X」的提示；有替代工具就写 `alternativeTool` |
| `requiresModel.input` | 结果依赖的模型能力；`"image"` 表示结果可能含图片，文本模型看不到 |

约定：

- **契约是提示，不是硬拦截。** `unsupported` 让模型提前知道边界，避免退化成 shell/裸改 XML；真正的校验仍由工具自己负责。
- **只截断返回给模型的文本**，不动 `details`、卡片或插件状态。超限时宿主会在末尾追加 `[output truncated: ...]`，有 `cursorParam` 就提示模型继续取。
- **可选、向后兼容。** 不写 `contract` 的插件照常加载：宿主会从 `description` 推一行摘要并套默认上限。协议 6 只是加了字段，最低支持版本仍是 3。
- 第三方插件声明 `apiVersion: 6` 表示"我知道契约"；声明 5 也能在支持契约的宿主上加载，只是新宿主的契约特性用不上。

### contributes.commands — 斜杠命令

```json
{ "commands": [{ "name": "/sync", "title": "同步数据" }] }
```

### contributes.contextProviders — 上下文注入

```json
{ "contextProviders": [{ "id": "relevant-docs", "auto": true }] }
```

### contributes.settings — 插件设置（插件中心自动渲染）

```json
{ "settings": [{ "key": "apiKey", "type": "string", "label": "API Key" }] }
```

`type` 可以是 `string` / `number` / `boolean` / `enum`（`enum` 配 `options`）。保存的值写进插件自己的 `storage`，键是 `settings.<key>`；后端用 `ctx.call('storage.get', { key: 'settings.<key>' })` 读取。声明里的 `default` 只决定表单初值——没有保存过时 `storage.get` 返回 `undefined`，需要默认值就在后端自己兜底。

### contributes.messageRenderers — 对话内卡片

```json
{ "messageRenderers": [{ "type": "item_add" }] }
```

`type` 填**工具名**。声明后，工具结果里的 `card`（声明式 UI 树：`Column` / `Row` / `Card` / `Text` / `Badge` / `KeyValue` / `List` / `Button` / `Input` / `Image` / `Separator` / `Spinner` / `EmptyState`）由宿主渲染进对话，工具运行中还会把参数实时渲染成「生成中」卡片（`streaming: false` 可关闭）。卡片里的 Button / Input 是**活的**：用户点击/回车，事件带着节点上声明的 `eventId` 回到后端的 `onCardEvent`。旧版客户端或没实现 `onCardEvent` 的后端，按钮退化成展示——不会坏，只是不动。

**领域惯例：你工具的产出物，就用你自己的卡片展示。** 日程本插件的条目卡片、文件查看器的「文档已创建 / 文档已更新」卡片（office_edit 保存成功后返回：文件图标 + 标题条 + 文件名 + 格式徽章 + 「打开」按钮）都是这么做。把上下文（如文件路径）放进按钮的 `props`——点击时它作为 `payload` 回到 `onCardEvent`，这样对话里堆了多少张卡片，每张打开的都还是它自己那份产出物。

### `ctx.messages.post` — 插件主动消息

工具结果卡片是"agent 调了你的工具"的产物。如果插件想在**没有工具调用**时往会话里放一条消息（后台任务完成、面板里的操作结果、定时推送），用 `ctx.messages.post`：

```js
await ctx.messages.post({
  sessionId: meta.sessionId, // 必填；从 onPanelMounted / onTool 的 meta 拿
  text: '邮件已发送',
  status: 'success',
  files: [{ path: '/workspace/Q3.pdf', label: 'Q3 报告' }], // 可选：文件附件卡片
  card: {
    component: 'Card',
    props: { title: '邮件已发送' },
    children: [
      { component: 'Text', props: { text: '收件人：张三' } },
      { component: 'Button', props: { label: '查看邮件' }, events: { onClick: 'open' } },
    ],
  },
});
```

要点：

- **`sessionId` 必填**。插件后端是进程级的，多会话/多窗口下"当前对话"不唯一；从面板的 `meta.sessionId` 或工具的 `call.sessionId` 拿，不要猜。
- 消息**存进同一个会话记录**（pi 的 `custom` 条目），随会话回放；但**不进入 AI 上下文**，不耗 token。
  - 只有显式传 `agentVisible: true` 时，这一版会追加一条 `custom_message` 条目，模型才能看到它。模型只看到 `text`（或卡片标题），卡片和文件不会发送给模型；所以需要 AI 理解的内容请写进 `text`。
  - `agentVisible` 是逐次选择的：默认关闭；一次可见不会让后续每次 update 都自动进入上下文。
- 界面上是**独立的插件消息气泡**（带插件名/图标），不和 AI 回复混在一起。曾经 `agentVisible` 的消息会带「AI 可见」小徽章。
- 用户可以在**插件中心**把某个插件的「在会话里显示插件消息」关掉（静音）。静音只隐藏界面上的气泡，**不会删除消息**，也不会阻止 `agentVisible` 的内容进入模型上下文；重新打开后历史还在。
- `files` 里的路径必须是**绝对路径且文件存在**；宿主渲染成和文件树一致的文件附件卡片，点击走 `filePreview` 链打开右栏。
- 宿主对 `post` 有频率限制（60 条/分钟/插件+会话），`update` / `remove` 不计入——高频内容请更新同一条消息，不要不断 post。
- 需要 `messages` 权限。

**更新和撤回**：`post` 返回的 `messageId` 就是后续的句柄。更新是**追加一个新 revision**，读取时折叠最新；删除是追加墓碑。两者都不改写历史行。

```js
const { messageId } = await ctx.messages.post({ sessionId, text: '发送中', status: 'loading' });

// 发送完成后更新同一条消息
await ctx.messages.update({
  sessionId,
  messageId,
  text: '邮件已发送',
  status: 'success',
  card: { component: 'Card', props: { title: '邮件已发送' } },
});

// 不需要了就撤回
await ctx.messages.remove({ sessionId, messageId });
```

需要 agent 也知道时，显式打开：

```js
await ctx.messages.post({
  sessionId,
  text: '收到一封新邮件：张三 / Q3 周报。需要我处理吗？',
  agentVisible: true,
});
```

**卡片交互**：插件消息里的 Button / Input 是活的。用户点击/回车，事件带着 `messageId`、`eventId`、`payload` 和 `sessionId` 回到后端的 `onMessageAction`；后端通常直接 `update` 同一条消息：

```js
async onMessageAction(messageId, eventId, kind, payload, ctx, meta) {
  if (eventId === 'retry') {
    await ctx.messages.update({
      sessionId: meta.sessionId,
      messageId,
      text: '重试中…',
      status: 'loading',
    });
  }
}
```

`update` 的省略字段保持不变；`card: null` / `text: ''` 清空；只有消息的 `pluginId` 和当前插件一致时才能改/删。

### contributes.filePreview — 文件树路由

```json
{ "filePreview": [{ "match": ["docx", "xlsx", "pptx"] }] }
```

匹配到扩展名后，宿主打开该插件的**第一个面板**（`panels[0]`）——想用 `filePreview` 至少得声明一块面板，并把它放在第一位。

### contributes.skills — agent 使用说明

```json
{ "skills": [{ "path": "./skills/usage" }] }
```

---

## 12. 发布前检查清单

- [ ] `apiVersion` 写了（照当前协议填）
- [ ] 后端打包成了单文件（`--bundle`），装到全新机器上能跑
- [ ] 面板入口（`panels[].entry`）真实存在；使用 `ui-dist/` 的插件别忘了构建
- [ ] 带 `PLUGIN.md`，`description` 写的是"用户会说什么"
- [ ] 工具名带稳定前缀，`description` 一句话、写"什么时候调"
- [ ] `readOnly` 如实声明
- [ ] 工具边界写进 `contract`（尤其是"不支持什么、别用什么替代"），输出上限按需收紧
- [ ] 权限最小化：只声明实际需要的；要用户选文件的地方用了 `dialog.*`
- [ ] 错误处理：能力调用可能失败，catch 并在面板中显示；工具返回值里把"不支持、别重试"说清楚
- [ ] 有产出物的工具（创建/修改文件、草稿等）返回声明式卡片，让产出物在对话里可见、可操作
- [ ] 状态放后端，面板只是投影；定时任务在后端（见第 7 节）
- [ ] 品牌图标：单色 SVG
- [ ] 用假宿主跑通过自测（见第 6 节）
