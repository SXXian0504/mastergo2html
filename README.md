# MasterGo2Code

MasterGo2Code 是一个本地运行的 MasterGo 插件，可以把设计稿中的页面 Frame 转换为可预览、可交付的 HTML、CSS、JavaScript 和静态资源。

本项目由两部分组成：

- **MasterGo 插件**：读取当前选中的 Frame，采集设计结构、截图和图片资源。
- **本地服务与 CLI**：接收插件任务，调用已配置的 AI 模型，生成并校验页面，最后输出源文件和 ZIP。

插件和服务默认通过 `http://127.0.0.1:12322` 通信。使用插件期间，请保持本地服务窗口处于运行状态。

## 开始之前

请先准备：

- [Node.js](https://nodejs.org/zh-cn/download) 18 或更高版本（推荐安装 LTS 版本）
- npm（安装 Node.js 时会自动安装）
- MasterGo 桌面端，或其他支持导入本地插件的 MasterGo 环境
- 一份模型服务凭据：OpenAI-compatible API Key 或已登录的 Codex CLI，二选一
- 本项目的完整代码目录

在终端中检查 Node.js 和 npm：

```bash
node -v
npm -v
```

如果终端提示找不到命令，请先完成 Node.js 安装，然后重新打开终端。

## 快速开始

下面的步骤只需在第一次使用时完整执行一次。

### 第 1 步：进入项目目录

打开终端，进入解压或克隆后的项目根目录。判断是否进入正确目录的方法是：当前目录中应能看到 `package.json`、`manifest.json`、`mcp-server` 等文件。

macOS / Linux 示例：

```bash
cd /你的路径/mastergo2json
```

Windows PowerShell 示例：

```powershell
cd "D:\你的路径\mastergo2json"
```

### 第 2 步：安装依赖

在项目根目录依次执行：

```bash
npm install
npm install --prefix mcp-server
```

第一条命令安装插件和 CLI 依赖，第二条命令安装本地服务依赖。两条命令都成功结束后再继续。

### 第 3 步：配置模型

插件中的“一键生成”使用 `legacy-auto` 流程，需要本地服务能够访问 AI 模型。先复制示例配置：

macOS / Linux：

```bash
cp mcp-server/.env.example mcp-server/.env
```

Windows PowerShell：

```powershell
Copy-Item mcp-server/.env.example mcp-server/.env
```

然后用文本编辑器打开 `mcp-server/.env`，选择下面一种方式配置。

#### 方式 A：OpenAI-compatible API Key

适合已有 OpenAI 或兼容网关账号的用户：

```dotenv
LLM_BACKEND=openai-compatible
OPENAI_API_KEY=替换为你的API密钥
OPENAI_BASE_URL=https://你的服务地址/v1
OPENAI_MODEL=你的模型名称
OPENAI_WIRE_API=responses
```

如果服务只支持 Chat Completions 协议，将最后一项改为：

```dotenv
OPENAI_WIRE_API=chat-completions
```

不要把真实 API Key 提交到 Git。`mcp-server/.env` 已被 `.gitignore` 忽略。

#### 方式 B：Codex SDK

适合本机已经安装并登录 Codex CLI 的用户。先检查登录状态：

```bash
codex login
codex login status
```

再把 `mcp-server/.env` 中的模型配置改为：

```dotenv
LLM_BACKEND=codex-sdk
CODEX_MODEL=
CODEX_REASONING_EFFORT=high
CODEX_SANDBOX_MODE=read-only
CODEX_REUSE_THREAD=true
```

`CODEX_MODEL` 留空时使用 Codex 默认模型。这种方式不需要在项目中保存 `OPENAI_API_KEY`，但启动服务的系统用户必须已经登录 Codex CLI。

完成配置后运行检查：

```bash
npm run --silent cli -- doctor --json
```

确认输出中包含：

```json
{
  "llmConfigured": true,
  "configErrors": []
}
```

### 第 4 步：构建并导入插件

生成 MasterGo 可加载的插件文件：

```bash
npm run build
```

构建成功后，`dist/` 中会生成 `main.js` 和 `index.html`。随后在 MasterGo 中：

1. 打开“插件开发”或“导入本地插件”入口。
2. 选择本项目根目录下的 `manifest.json`。
3. 确认插件名称 `MasterGo2Code` 出现在本地插件列表中。
4. 打开需要转换的设计稿并运行插件。

修改过插件代码后，需要重新执行 `npm run build`，并在 MasterGo 中重新加载插件。

### 第 5 步：启动服务并生成页面

在项目根目录启动本地服务：

```bash
npm run mcp:dev
```

看到下面两行说明服务已启动：

```text
mastergo2html bridge listening on http://127.0.0.1:12322
panel: http://127.0.0.1:12322/panel
```

不要关闭这个终端窗口。然后：

1. 在浏览器打开 [服务健康检查](http://127.0.0.1:12322/health)。
2. 确认返回内容中的 `ok` 和 `llmConfigured` 都是 `true`。
3. 回到 MasterGo，选中一个完整的页面 Frame。
4. 打开 `MasterGo2Code` 插件。
5. 保持“网页端（默认）”，点击“一键生成”。
6. 等待最近任务状态变成“完成”。
7. 在插件中打开输出目录或下载 ZIP，也可以打开 [任务面板](http://127.0.0.1:12322/panel) 查看任务。

第一次生成可能需要较长时间，实际耗时取决于页面复杂度、图片数量、网络和模型响应速度。

## 日常使用

首次安装完成后，以后通常只需：

1. 进入项目根目录，运行 `npm run mcp:dev`。
2. 打开 MasterGo 设计稿和 `MasterGo2Code` 插件。
3. 选中完整页面 Frame，点击“一键生成”。
4. 在插件或任务面板中等待并获取结果。

停止服务时，回到运行服务的终端并按 `Ctrl+C`。

也可以直接使用仓库自带的启动脚本：

- macOS：双击 `start-mcp-dev.command`
- Windows：双击 `start-mcp-dev.bat`

macOS 如果提示文件没有执行权限，在项目根目录执行一次：

```bash
chmod +x start-mcp-dev.command install-launcher.command
```

`install-launcher.command` 和 `install-launcher.bat` 可以在桌面创建服务启动器。

## 生成结果在哪里

从插件“一键生成”的任务默认保存在：

```text
mcp-server/data/jobs/<jobId>/
```

主要交付文件：

```text
05-output/
├── index.html
├── styles.css
├── script.js
└── assets/

final/
└── output.zip
```

- `05-output/index.html`：页面入口，可以直接用浏览器打开。
- `05-output/styles.css`：页面样式。
- `05-output/script.js`：页面交互脚本。
- `05-output/assets/`：页面使用的图片、图标等资源。
- `final/output.zip`：适合发送和交付的完整压缩包。

CLI 生成的任务默认保存在 `.mastergo2html/jobs/<jobId>/`，不要和插件任务目录混淆。

## 如何准备 MasterGo 设计稿

为了提高生成成功率和视觉还原度：

- 选中代表完整页面的顶层 Frame，不要只选中某个按钮、文本或图片图层。
- Frame 和关键图层使用能表达业务含义的名称，例如“首页”“导航栏”“登录弹窗”。
- 使用蒙版改变图片效果时，建议在对应组名称中包含“蒙版”，方便导出器识别整体视觉。
- 首次测试优先使用渲染切片，以获得更接近设计稿的视觉效果；需要可替换原始素材时再使用原图。
- 生成期间保持 MasterGo、插件窗口和本地服务均处于打开状态。

### 单选与多选规则

- 网页端“一键生成”要求只选中一个完整页面 Frame。
- 网页端多选用于导出多页面资源，再通过 CLI 或 Codex 按页面批量生成。

当前插件界面只开放网页端目标。代码中保留的 App 目标兼容逻辑不属于当前新手使用入口。

## 服务地址与配置

默认地址：

- 健康检查：<http://127.0.0.1:12322/health>
- 任务面板：<http://127.0.0.1:12322/panel>

正常使用时不要修改端口。插件代码中的服务地址固定为 `127.0.0.1:12322`；如果确实需要更改端口，必须同时修改 `mcp-server/.env` 中的 `MCP_PORT`、插件中的 `BRIDGE_BASE_URL`，然后重新构建插件。

修改 `mcp-server/.env` 后，必须停止并重新启动服务才能生效。

## 常见问题

### 插件提示“本地 MCP 服务不可用”

依次检查：

1. 运行服务的终端是否仍然打开。
2. `npm run mcp:dev` 是否有报错。
3. 浏览器能否打开 <http://127.0.0.1:12322/health>。
4. 端口 `12322` 是否被其他程序占用。
5. 是否修改过服务端口但没有同步修改和重建插件。

### 健康检查显示 `llmConfigured: false`

查看返回内容中的 `configErrors`，然后运行：

```bash
npm run --silent cli -- doctor --json
```

- API Key 模式：检查 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` 和协议是否正确。
- Codex SDK 模式：检查是否执行了 `npm install --prefix mcp-server`，以及 `codex login status` 是否正常。

`doctor` 只检查配置和本机依赖是否完整，不会发起一次真实的模型生成请求。最终连通性仍以实际生成任务为准。

### `npm install` 或生成阶段出现网络错误

检查代理、防火墙和模型服务地址。公司内网用户还需要确认 npm 镜像与模型网关可以从当前电脑访问。

### 任务长时间没有完成

打开 <http://127.0.0.1:12322/panel> 查看当前阶段和错误信息。图片很多、模型响应慢或网络不稳定都会延长任务时间。失败任务可以在插件或任务面板中从失败阶段重试。

### 生成结果缺少图片或视觉效果不一致

- 优先重新使用渲染切片生成。
- 检查相关图片节点是否被隐藏、裁切或放在蒙版组中。
- 为复杂蒙版组添加包含“蒙版”的明确命名。
- 检查任务目录中的资源导出报告和 `assets/` 文件。

### 修改代码后 MasterGo 中没有变化

重新执行 `npm run build`，然后在 MasterGo 中重新加载本地插件。开发时可以运行 `npm run dev` 持续监听构建。

## 进阶：两种执行模式

项目保留两条彼此隔离的生成路线：

- `legacy-auto`：插件“一键生成”和普通 `generate` 命令使用的自动流程。它会在本地服务中调用模型，因此必须完成模型配置。
- `codex-agent`：由当前 Codex 任务直接实现页面。Core 先以纯规则生成坐标保真的 HTML 手稿，当前 Agent 再直接编辑草稿。该路线本身不调用 SDK/API，也不要求项目模型环境变量。

新手使用插件时只需关注 `legacy-auto`。`codex-agent` 适合需要当前 Agent 参与编辑、检查和验收的开发场景。

### 单页面 Agent v2

先准备任务：

```bash
npm run --silent cli -- agent-prepare --input ./00-input --json
```

命令会生成 `02-layout/layout-sketch.json`、不可变的 `agent/prototype-source/` 和可以直接打开的 `agent/draft/`。开始编辑前记录时间：

```bash
npm run --silent cli -- agent-begin <jobId> --json
```

当前 Agent 只编辑：

```text
agent/draft/index.html
agent/draft/styles.css
agent/draft/script.js
```

完成后验收并打包：

```bash
npm run --silent cli -- agent-finalize <jobId> --json
```

`agent-finalize` 不会自动修复结果。无论通过与否，都会保留 `05-first-pass/` 和 `final/first-pass.zip`；只有校验通过时才发布 `05-output/` 与 `final/output.zip`。报告会记录 `prepareMs`、`handoffWaitMs`、`agentMs`、`finalizeMs`、`activeTotalMs` 和 `jobWallMs`。Chrome 不可用时，截图与运行时检查会标记为 `skipped`，但仍会生成报告。

### 从当前 MasterGo 选区生成

保持本地服务、MasterGo 设计稿和插件窗口打开，然后运行：

```bash
npm run --silent cli -- generate-from-mastergo --json
```

- 单选一个 Frame：创建一个普通 HTML 任务。
- 多选多个网页 Frame：创建页面包，并为每个 Frame 分别生成 HTML。

### 已有输入包时生成

```bash
npm run --silent cli -- validate-input --input ./00-input
npm run --silent cli -- generate --input ./00-input --json
```

查看和预览最近任务：

```bash
npm run --silent cli -- list
npm run --silent cli -- status --latest
npm run --silent cli -- serve --latest
```

预览服务在前台运行，按 `Ctrl+C` 停止。查看所有命令：

```bash
npm run --silent cli -- --help
```

### 多页面批处理

从当前 MasterGo 多选 Frame 创建 Agent 批次：

```bash
npm run --silent cli -- agent-prepare-pages --source mastergo-plugin --json
npm run --silent cli -- agent-batch-status <batchId> --json
```

已有页面包时：

```bash
npm run --silent cli -- agent-prepare-pages --input ./website-page-bundle.zip --json
```

多页面目前维持 Agent v1：每页有独立 job 和 `implementation-plan.json`，Agent 按 `nextPage` 逐页处理；单页面 Agent v2 不创建或验收 implementation plan。

`legacy-auto` 页面批处理可以直接运行：

```bash
npm run --silent cli -- generate-pages \
  --input ./website-page-bundle.zip \
  --page-concurrency 2 \
  --model-concurrency 5 \
  --quality-gate-pages 2 \
  --page-retries 2 \
  --json
```

首次返回 `quality-gate` 时，先对照设计截图检查代表页面。确认质量后继续：

```bash
npm run --silent cli -- resume-pages <batchId> --approve-quality --json
```

代表页面需要重跑时：

```bash
npm run --silent cli -- resume-pages <batchId> --retry-quality --json
```

批次因认证、网络或限流问题暂停时，修复问题后运行：

```bash
npm run --silent cli -- resume-pages <batchId> --json
```

批次记录位于 `.mastergo2html/page-batches/<batchId>/batch.json`。所有页面完成后，可再使用仓库的 `mastergo2code` Skill 将 HTML 合并为 Next.js App Router + TypeScript 项目。正式转换前，应检查 `mastergo-pages.json` 中自动推断的首页和路由是否符合业务含义。

## 开发命令

```bash
# 监听插件代码并持续构建
npm run dev

# 构建生产版插件
npm run build

# 检查 CLI 和模型配置
npm run cli:doctor

# 运行本地服务测试
npm --prefix mcp-server test

# 查看 CLI 帮助
npm run --silent cli -- --help
```

## 项目目录

```text
.
├── manifest.json          # MasterGo 本地插件清单
├── lib/                   # 插件主线程代码
├── ui/                    # 插件界面
├── messages/              # 插件主线程与 UI 的消息类型
├── core/                  # CLI 与服务复用的生成内核
├── cli/                   # 命令行入口
├── mcp-server/            # 本地任务服务
│   ├── .env               # 本机模型配置，不提交到 Git
│   ├── data/jobs/         # 插件任务和生成结果
│   └── src/               # HTTP 服务与工作流
├── dist/                  # 插件构建产物
├── skills/                # Codex Skills
└── package.json           # 项目脚本
```

## 安全提示

- 本地服务只监听 `127.0.0.1`，不要将其改为公网可访问地址。
- 不要提交 `mcp-server/.env`、API Key 或包含敏感设计稿的任务目录。
- 对外发送生成结果前，检查页面文案、图片、链接和交互是否符合预期。
