---
name: files
description: "查看和编辑文件（docx / pptx / xlsx / pdf / markdown / html / 纯文本 / 图片 / 音视频），新建 docx / pptx / xlsx / pdf / csv，并做 PDF 页操作、PDF→Office 转换与 PDF→PNG 导出——用户要打开文件、新建/生成演示文稿、文档、表格、PDF 或 CSV，修改 Office 文档，合并/拆分/裁剪 PDF，把 PDF 转成 Word/PPT/Excel，或把 PDF 页面导出成图片时用它；用户只说得出文档大概是什么（「上次那份季度汇报」）而没给路径时，也用它找。新建和改 docx / pptx / xlsx / pdf 都用它的 office_create / office_read / office_edit / pdf_edit / pdf_convert / pdf_render 工具，不要另写 Python（python-pptx / python-docx / openpyxl / reportlab / pypdf）、LibreOffice 或解压 OOXML 手改；用户的机器上不一定有 Python。改 docx 前必须先在查看器里打开那个文档。"
---

# 文件查看器

工作区文件的查看器（右栏）、Office/PDF 的编辑器，也是文档的生成器。文件树里点开一个文件，就是它在右栏渲染：
Office / PDF 走内置的 GenOffice 引擎，markdown / html 走 GenOffice 的查看器，txt / json / log 是纯文本视图。
agent 通过它贡献的工具新建、读取、编辑、拆分/合并文档，以及把 PDF 转成 Office。

## 覆盖范围（先看这张表，别猜）

| 格式 | 面板预览 | agent 读取/编辑 | agent 新建 |
|------|---------|----------------|-----------|
| `pptx` | ✅ Konva 渲染器，**可手动编辑**（文字 / 字体 / 填充 / 撤销重做） | ✅ 完整（命名 op，先 office_guide 拿词汇表） | ✅ `office_create` |
| `docx` `docm` | ✅ 分页渲染器，可编辑 | ✅ 结构编辑（**需先在查看器里打开该文档**，见下） | ✅ `office_create`（内容 op 会先打开文档） |
| `xlsx` `xlsm` | ✅ 表格渲染器（只读，公式显示缓存值） | ✅ 单元格编辑（改值 / 清空；不支持公式、格式、增删表） | ✅ `office_create`（空白或 CSV 网格） |
| `xls` | ✅ 表格渲染器（只读） | ❌ 工具返回 "not wired yet" | ❌ |
| `csv` | ✅ 表格渲染器（只读） | ❌ 不支持结构化编辑 | ✅ `office_create`（写 CSV 文本，带 BOM） |
| `pdf` | ✅ | ❌ 文本读取；**页操作走 `pdf_edit`**，**转 Office 走 `pdf_convert`** | ✅ `office_create`（空白 PDF） |
| `md` `markdown` | ✅ GenOffice 的 markdown 查看器 | — | 用普通文件写入工具 |
| `html` `htm` | ✅ GenOffice 的 html 查看器（图片暂不支持） | — | 用普通文件写入工具 |
| `txt` `json` `log` | ✅ 纯文本视图（等宽；json 美化） | — | 用普通文件写入工具 |
| `png` `jpg` `gif` `webp` `svg` 等 | ✅ 图片查看器（适应 / 1:1 / 缩放 / 拖动） | — | — |
| `mp4` `webm` `mov` `m4v` | ✅ 视频播放（系统内核解码；HEVC 等编码可能放不了） | — | — |
| `mp3` `m4a` `wav` `flac` `ogg` `aac` | ✅ 音频播放 | — | — |
| `mkv` `avi` 等 | ❌ 交给系统播放器 | — | — |
| `doc` `ppt`（97-2003 旧格式） | ✅ 仅文字（提取正文；排版、图片、表格不还原） | ❌ 不支持；要改就先另存为 docx/pptx | ❌ |

> **新建文档（Office / PDF / CSV）一律用 `office_create`。** 不要用 Python（python-pptx /
> python-docx / openpyxl / reportlab / pypdf）、LibreOffice 或自己拼 OOXML/PDF——这台机器上
> 装的是这个客户端，不保证有 Python；插件自带引擎，生成的就是能在查看器里直接打开、能继续编辑的文件。

> **PDF 的页操作、转换和导出另有三个工具：`pdf_edit`（合并/拆分/插页/删页/裁剪/缩放/N-up）、
> `pdf_convert`（PDF → docx/pptx/xlsx）和 `pdf_render`（PDF → PNG 图片）。**
> `office_read` / `office_edit` 仍然不读/改 PDF 正文。
> 其它格式会拿到 "not wired yet" / "not supported" —— 那是这条路径确实没接，**不要重试**。

## 先找文件：`files_search({ root, query })`

用户只说得出文档是什么、没给路径时（「上次那份季度汇报」「客户发来的方案」），**先调它**，
不要用 `ls` 猜，也不要挨个 `office_read`——后者会把每份文档的结构都读进上下文。

**它只管 Office 文档（含 doc / ppt 旧格式）和 PDF。** md / txt / csv 和代码是纯文本，**用 `grep` 搜**（全文、带行号），
不要用 `files_search` 找它们，也不要指望它把文本文件列出来。

- `root`：当前工作区目录（绝对路径，通常就是 cwd）
- `query`：按文件名、目录名、**文档标题**、**正文开头的一段文字**匹配，多个词要全部命中；
  传关键词，不要传用户整句（`"华东 预算"`，不是 `"帮我找那份提过华东预算的文件"`）；
  不传就是最近修改的若干份
- 返回：绝对路径、类型、修改时间、标题；如果命中的是正文，会多带一行命中片段

它的行为：

- 正文是**抠出来的原文**（docx 开头几段、pptx 按页顺序的文字、xlsx 的文本单元格），
  最多存 1500 字，不是模型写的摘要。
  所以搜「华东区预算」能找到正文里提过这句话的文档，哪怕标题里没有。
- 每次查询都会重新核对文件。你在 Word/Excel 里改过一份、存盘，下一次查询就会重新读它的标题和正文；
  被删掉的文件会从结果里消失。
- 索引只回答「哪份文件」，**不回答「里面是什么」**。选中之后：Office 文档（docx/pptx/xlsx）
  用 `office_read` 打开，md / txt / csv 用 `read` 工具打开；**PDF 目前只能打开查看器看，正文读不了**，
  不要对 PDF 调 `office_read` 或 `read` 指望拿到内容。
- 只覆盖 docx/docm/pptx/pptm/xlsx/xlsm、doc/ppt 的内容，pdf 只有标题；md/txt/csv 和代码不进来，走 `grep`。
  搜不到时换个词或去看目录，不要断言文件不存在。

## 文档工具（office_*）

### `office_create({ path, ops?, csv?, sheetName?, pages?, pageSize?, overwrite? })`

**新建**一份 `.pptx` / `.docx` / `.xlsx` / `.pdf` / `.csv`，可以顺带把第一批内容写进去。用户说「做一个 PPT」
「新建一个 Word 文档」「建个表格」「给一份空白 PDF」「给个 CSV」时用它——**不要用 Python、LibreOffice
或手写 OOXML/PDF**。

- `path` 必须是绝对路径，扩展名决定格式（`.pptx` / `.docx` / `.xlsx` / `.pdf` / `.csv`）
- `ops` 可选，形状和 `office_edit` 完全一样：
  - pptx：`office_guide` 的命名 op（空白稿自带 1 张空幻灯片）
  - docx：同样的命名 op / `insert_content`；插件会先把文档在查看器里打开，再用活编辑器执行
  - xlsx：`{ sheet, cell, value }` 单元格 op
- `csv` 可选：xlsx 用它作为第一张表的网格（逗号分隔、一行一条，数字识别、引号字段支持）；
  `.csv` 用它作为文件正文（写入时加 UTF-8 BOM，Excel 打开不乱码）
- `sheetName` 可选，xlsx 第一张表的名字（默认 `Sheet1`，ops 里要用同一个名字）
- `pages` / `pageSize` / `text` 可选，**只给 pdf**：
  - `pages` 空白页数（默认 1，最多 200），`pageSize` 纸张（`A4` / `Letter` / `Legal` / `A3`，默认 A4）
  - `text` 把文字放在第一页；`\n` 换行；默认 18pt、1 英寸页边距。GenOffice 会挑一个覆盖该文字的
    系统字体（中文也支持）并嵌入子集，生成的是**可搜索/可选中**的文字对象
  - `fontSize` / `font` 可覆盖字号和字体；更精细的页面/坐标/颜色用 `pdf_edit` 的 `insertText`
- `overwrite` 默认 `false`：目标已存在时直接拒绝，提示改用 `office_edit`。确实要重做才传 `true`
- pptx / xlsx 的 op 先在内存里校验，**被拒就一个字节都不写**；docx 因为编辑器要先有文件，
  内容批失败时会留下空白文档，工具结果里会说清楚

创建成功后会把右栏切到这个文件（聚焦预览）。要继续改：pptx/xlsx 直接 `office_read` → `office_edit`；
docx 创建后已经开在查看器里（内容 op 就是在那个编辑器里执行的），直接 `office_read` → `office_edit`。

例：生成一页写着 "i am weiqun" 的 PPT（空稿自带 1 张空幻灯片，用 `addElement` 放文本框）：

```json
{
  "path": "/workspace/hello.pptx",
  "ops": [
    {
      "op": "addElement",
      "target": { "slide": 0 },
      "kind": "textbox",
      "offset": { "x": 914400, "y": 2286000, "cx": 10363200, "cy": 2286000 },
      "paragraphs": [
        { "runs": [{ "text": "i am weiqun", "fontSize": 44, "bold": true }], "align": "center" }
      ],
      "bodyPr": { "anchor": "ctr" }
    }
  ]
}
```

例：生成一张带数据的表（`csv` 一行一条，比一格一个 op 省事）：

```
office_create({
  path: "/workspace/预算.xlsx",
  sheetName: "预算",
  csv: "项目,金额\n房租,3000\n餐饮,1200"
})
```

例：生成一页写着 "o my god" 的 PDF：

```
office_create({ path: "/workspace/o my god.pdf", text: "o my god", fontSize: 18 })
```

### `pdf_edit({ path, outputPath, ops, overwrite? })`

PDF 的**页操作**，跑在 GenOffice 自己的 pdf-lib 层上，不需要打开查看器。源文件只读，
结果写到 `outputPath`；`outputPath` 等于 `path` 才是原地修改，而且要显式 `overwrite: true`。

op 形状（先调 `office_guide({ domain: "pdf" })` 拿完整字段表）：

- `insertBlankPage { afterPageIndex? }` / `insertPdf { source, afterPageIndex? }`
- `merge { sources: [path, ...] }` / `replacePages { source, pages }`
- `extractPages { pages }` / `deletePages { pages }`
- `insertText { text, pageIndex?, x?, y?, fontSize?, color?, font?, bold?, italic?, align? }`：
  在页面上放新的可搜索文字（系统字体，中文可用）；`x`/`y` 是 PDF 用户坐标（y 从**底边**算），
  不传就是 1 英寸左上角；`\n` 换行
- `setPageSize { preset: "A4"|"Letter"|"Legal"|"A3" }` 或 `{ widthPt, heightPt }`
- `cropPages { pages, rect: { l, t, r, b } }`（按显示页面的比例 0..1）
- `mergePages { perSheet: 2..16, direction?, separator? }`（N-up 拼版）
- `splitPages { perPage: 2|4|9 }`（把每页切成网格）
- `split { everyPages }`（拆成多个文件；`outputPath` 是**目录**，必须是唯一一个 op）

页下标都是原始文档里的 0-based 下标。结果里带 `pages`、`records`（每个 op 做了什么）。

### `pdf_convert({ path, to, outputPath?, overwrite? })`

把 PDF 转成可编辑的 `.docx` / `.pptx` / `.xlsx`，完全本地跑（GenOffice 的 pdf2docx 重建层）。
文字保持可编辑；没有文本层的扫描页会整页转成图片，结果里的 `scannedDocument` / `warnings`
会说明。用户说「把这个 PDF 转成 Word/PPT/Excel」时用它——**不要用 Python 或外部转换器**。

`outputPath` 省略时是源文件同名的目标扩展名；已有文件默认拒绝，`overwrite: true` 才替换。
加密 PDF 传 `password`。

### `pdf_render({ path, pages?, scale?, outputDir?, password?, overwrite? })`

把 PDF 的页面渲染成 PNG 图片（GenOffice 的 pdfium 渲染器 + 无依赖 PNG 编码器，不需要 Electron）。
用户说「把这个 PDF 转成图片」「导出每一页」时用它。

- `pages`：0-based 页下标；不传就是全部页
- `scale`：每 PDF 点的像素数，默认 2（约 144 dpi），范围 0.5–4
- `outputDir`：PNG 输出目录，默认是源文件旁边的 `<文件名>-pages/`
- 文件名沿用 GenOffice 的 `<文件名>-p<n>.png`；已有文件默认整套拒绝，`overwrite: true` 才覆盖

### `office_read({ path })`

读一份 pptx 的结构，返回每张幻灯片和它上面的元素，**元素 id 就是 `office_edit` 的操作对象**。

先读后改。id 不要凭记忆或凭命名习惯推断——它是文档里的真实标识。

### `office_guide({ domain, group?, style? })`

op 的说明书。**写 ops 之前必须调一次。**

- 不带 `group`：返回按组分类的 op 名称表（6 个组：`text` / `element` / `insert` /
  `table` / `slide` / `deck`）
- 带 `group`：返回那一组的字段表、示例、以及常见错误；组名写错时返回有效组名列表，
  按它改重试即可
- `style: "signatures"`：每个 op 一行签名，想快速扫一遍完整签名表时用

**字段名靠猜是 batch 被拒的头号原因。** 这个工具就是用来消除猜测的。

**`domain: "xlsx"` 是另一回事**：表格没有 op 注册表，它的 op 就是单元格编辑。这个工具会
返回那条形状——`{ sheet, cell, value }`，`sheet` 和 `cell` 都来自 `office_read`。

**`domain: "pdf"`**：返回 `pdf_edit` 的页操作词汇（合并/拆分/插页/删页/裁剪/缩放/N-up），
写 `pdf_edit` 的 `ops` 之前看它。

### `office_edit({ path, ops, dryRun? })`

对文档应用一批 op 并保存。

- **整批原子**：任何一个 op 被拒，就什么都不写，并在 `failures` 里说明哪里要改。
  所以失败不会留下半改的状态——放心提交，按 `failures` 修完重来。
- `dryRun: true`：只校验并回一个执行计划，不碰文件。**不熟的 batch 先跑这个。**
- 写回带 mtime 冲突检测：如果文件在你读之后被外部改过，写入会被拒绝而不是覆盖。
  这时重新 `office_read` 再改。
- 返回里的 `details.opsAvailable` 用来发现你缓存的 op 列表已经过期。

## 新建文档的标准流程

1. 用户没给路径 → 在工作区里取一个明确的名字（如 `<workspace>/季度汇报.pptx`），**用绝对路径**
2. pptx / docx 先 `office_guide` —— 拿 op 词汇；xlsx / pdf / csv 不需要
3. `office_create({ path, ops?, csv?, pages?, pageSize? })` —— 一次建好并写入第一批内容
4. 之后还要改 → 走下面的对应修改流程（不要重新覆盖创建）；PDF 的页操作走 `pdf_edit`

## 改 pptx 的标准流程

1. `office_read` —— 拿到幻灯片和元素 id
2. 不确定字段名 → `office_guide`（先看组名，再进具体组）
3. `office_edit` + `dryRun: true` —— 先验证
4. `office_edit` —— 正式提交
5. 报 `failures` 时按提示改 op 重提，**不要**逐个 op 拆开试

## 改 docx 的标准流程

**前提：那份文档必须先在查看器里打开。** docx 的 op 驱动的是一个**活着的编辑器**
（GenOffice 自己的编辑器，它的内置 AI 也是这么工作的）—— 没有无头路径。
文档没开时 `office_edit` 会直接告诉你，不会静默失败。用 `files_open` 打开。

1. `office_guide({ domain: "docx" })` —— 拿 op 形状、target 的写法和 op 列表
2. `office_read` —— 拿 block 下标（**下标会随任何一次编辑失效，别跨轮复用**）
3. `office_edit` + `dryRun: true` —— 先验证
4. `office_edit` —— 正式提交（改完自动保存）

op 形如 `{ op: "setFont", target: { scope: "selection" }, bold: true }`。
**`target.scope: "selection"` 正好接得上用户刚才选中的内容** —— 用户选了东西说"这段"，
就用它，比按 block 下标更稳。字段是**补丁**语义：给了就设、`null` 清空、不给就不动。

`dryRun` 只覆盖注册表 op；`insert_content` / `replace_blocks` 这两个整块命令没有 dry-run，
批里带它们时 `dryRun` 会被拒绝（而不是偷偷改文档）。

## 改 xlsx 的标准流程

1. `office_read` —— 拿到工作表名和单元格地址
2. `office_edit`，ops 形如 `{ sheet: "Sheet1", cell: "B2", value: 4321 }`
   （`value: null` 清空该格）
3. 不熟就先 `dryRun: true`，它会告诉你这批会动到哪些 xlsx 内部条目
4. 改完不必重读——返回里带 `mtime`，下次改动会拿它做冲突检测

**xlsx 目前只支持改单元格的值**：不支持公式、格式、增删工作表、图表、合并单元格。
遇到这些直接说"还不支持"，别换参数重试。

## 边界

- 打印 / 导出 PDF / 另存为：走宿主对话框能力（`dialog.*`）。
- **docx 的 op 要在查看器里开着那份文档才生效** —— 其余格式（pptx / xlsx）后端自己就能改。
- 改完立即落盘，并且带 mtime 冲突检测（读之后被外部改过就拒绝，不覆盖）。
- 文档渲染跑的是内置的 GenOffice 引擎（Apache-2.0），不需要联网、不需要外部工具。

### 面板内手动编辑（pptx）

pptx 面板不是只读：双击文字直接改，字体、段落格式、填充、描边、移动/缩放/旋转、增删元素、
撤销/重做都走 GenOffice 自己的编辑层（`src/ui/slides/editor.ts`，把上游主进程的编辑 handler
移植进面板，引擎仍是 vendored 的 `pptx-ops` + `pptx-render`）。一次拖动只占一步撤销。
**仍未接的**：幻灯片增删/复制、表格/图表/图片插入、母版、动画、切换、导出——工具栏里这些按钮
点了不会生效，是待移植，不是坏了。

保存走 `file.write` + mtime 冲突检测。文件在打开期间被 `office_edit` 改过时，面板不会自动重载
（那会丢掉未保存的手动编辑），而是弹出「重新加载 / 覆盖保存」让人选一个。
