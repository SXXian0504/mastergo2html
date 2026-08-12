# MasterGo2HTML 部署说明

本项目用于把 MasterGo 设计稿中选中的页面 Frame 转换为可交付的 HTML 静态页面。部署时需要同时准备两部分：

- MasterGo 插件：负责读取设计稿、导出结构和素材，并把任务提交到本地服务。
- 本地 MCP 服务/CLI：运行在客户电脑本机，负责采集、标准化、校验、保存和交付结果；在插件独立生成模式下也负责调用已配置的 AI 模型。

默认服务地址为 `http://127.0.0.1:12322`。插件代码当前固定访问这个地址，因此请优先使用默认端口部署。

## 执行模式

当前保留两种明确隔离的执行模式：

- `codex-agent`（Codex 内默认）：CLI 只准备索引化事实和执行校验，当前 Codex 任务完成唯一实施计划，并直接写入 `index.html`、`styles.css`、`script.js`。项目不需要额外配置 API Key，也不会启动另一个 Codex SDK thread。
- `legacy-auto`（插件独立运行兼容模式）：插件原有“一键生成 HTML”、`POST /jobs`、查询、重试、下载、打开目录等契约保持不变。共享 job service 继续执行原有模型阶段，因此仍需要 OpenAI-compatible API Key 或 Codex SDK 登录。

执行内核收敛不会导致插件端失效。插件和 CLI 共享同一套 legacy 阶段顺序、状态和校验逻辑；HTTP、插件导出队列以及各自的任务存储目录仍由原适配层维护。

## 一、部署前准备

### 1. 安装基础软件

请先在客户电脑上准备：

- Node.js：要求 Node.js 18 或以上版本。
- npm：随 Node.js 一起安装。
- MasterGo 客户端或可加载本地插件的 MasterGo 环境。
- `codex-agent` 需要在当前 Codex 任务内执行，但不要求项目模型环境变量。
- 只有 `legacy-auto` 需要可访问模型服务的网络和模型认证。

https://nodejs.org/zh-cn/download



安装完成后，在终端检查：

```bash
node -v
npm -v
```



### 2. 获取项目代码

把项目代码放到客户电脑的固定目录。

如果是通过压缩包交付，解压后进入项目根目录即可。

### 3. 安装项目依赖

在项目根目录执行：

```bash
npm install
npm install --prefix mcp-server
```

第二条命令会安装本地 MCP 服务依赖，包括 `@openai/codex-sdk`。即使默认使用 API Key 后端，也建议安装完整依赖，确保两种路径都可切换。

## 二、配置独立插件模型（仅 legacy-auto）

本地服务启动时会读取 `mcp-server/.env`。首次部署可复制示例配置：

macOS / Linux：

```bash
cp mcp-server/.env.example mcp-server/.env
```

Windows PowerShell：

```powershell
Copy-Item mcp-server/.env.example mcp-server/.env
```

Windows CMD：

```bat
copy mcp-server\.env.example mcp-server\.env
```

`codex-agent` 跳过本节。只有需要插件脱离当前 Codex 任务独立生成时，才配置以下二选一模型后端；修改配置后必须重启服务。

### 路径 A：OpenAI-compatible API Key

```dotenv
LLM_BACKEND=openai-compatible
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_BASE_URL=https://token.cvte.com/v1
OPENAI_MODEL=gpt-5.5
OPENAI_WIRE_API=responses
```

兼容网关可以按模型覆盖协议，例如：

```dotenv
OPENAI_MODEL=deepseek-v4-pro
OPENAI_WIRE_API_DEEPSEEK_V4_PRO=chat-completions
```

### 路径 B：Codex SDK

先在运行服务的同一用户环境中完成 Codex CLI 登录：

```bash
codex login
codex login status
```

然后配置：

```dotenv
LLM_BACKEND=codex-sdk
CODEX_MODEL=
CODEX_REASONING_EFFORT=high
CODEX_SANDBOX_MODE=read-only
CODEX_REUSE_THREAD=true
```

`CODEX_MODEL` 留空时使用 Codex 当前默认模型。服务会优先使用 `CODEX_PATH`，否则从 `PATH` 自动发现 `codex` 可执行文件。Codex SDK 路径不要求本项目在 `mcp-server/.env` 中保存 `OPENAI_API_KEY`；认证由本机 Codex CLI 登录状态提供。它不会复用当前 Codex 桌面任务的上下文，而是通过 SDK 启动独立的 Codex thread。

Codex SDK 的 legacy CLI workflow 在布局分析完成后，会用三个独立 thread 并行执行组件结构、静态资源和交互分析，三路全部成功后再由独立 thread 执行一次 `plan-and-generate`，在同一模型调用内完成页面裁决与 HTML 生成。进程级模型并发默认且最多为 5；可通过 `GLOBAL_MODEL_CONCURRENCY=1` 到 `4` 主动降低，但不能配置为大于 5。

两种后端都可以用下面的命令检查：

```bash
npm run --silent cli -- doctor --json
```



### 服务端口

插件与本地服务的默认地址已统一为 `http://127.0.0.1:12322`，正常使用时不需要在命令行设置 `MCP_PORT`，直接运行 `npm run mcp:dev` 即可。

如需覆盖端口，推荐在 `mcp-server/.env` 中配置：

```dotenv
MCP_PORT=12322
```

也可以临时设置环境变量：

macOS / Linux：

```bash
MCP_PORT=12322 npm run mcp:dev
```

Windows PowerShell：

```powershell
$env:MCP_PORT = '12322'; npm run mcp:dev
```

Windows CMD：

```bat
set "MCP_PORT=12322" && npm run mcp:dev
```

注意：插件端默认访问 `http://127.0.0.1:12322`。若改成其他端口，还需要同步修改插件的 `BRIDGE_BASE_URL` 并重新构建。

## 三、启动本地 MCP 服务

方式一：直接在项目根目录执行（Windows、macOS、Linux 通用）：

```bash
npm run mcp:dev
```

方式二：使用系统启动脚本。

- Windows：双击 `start-mcp-dev.bat`。
- macOS：双击 `start-mcp-dev.command`。

方式三：安装桌面启动器。

- Windows：双击 `install-launcher.bat`，它会在桌面生成 `启动本地监听.bat`。
- macOS：双击 `install-launcher.command`，它会在桌面生成 `启动本地监听.command`。

macOS 首次双击如果提示没有执行权限，可以在项目根目录执行一次：

```bash
chmod +x install-launcher.command start-mcp-dev.command
```

启动成功后，终端会看到类似输出：

```text
mastergo2html bridge listening on http://127.0.0.1:12322
panel: http://127.0.0.1:12322/panel
```

打开健康检查地址确认服务状态：

```text
http://127.0.0.1:12322/health
```

正常情况下会返回 JSON，并且 `llmConfigured` 应为 `true`。如果是 `false`，说明 `mcp-server/.env` 中的模型配置不完整。

任务面板地址：

```text
http://127.0.0.1:12322/panel
```


## 四、Mastergo 插件所需环境配置

```bash
yarn install
```

```bash
yarn build
```


## 五、在 MasterGo 中导入插件

1. 打开 MasterGo。
2. 进入插件开发或本地插件导入入口。
3. 选择本项目根目录下的 `manifest.json`。
4. 加载插件后，在设计稿页面中选中一个完整页面 Frame。
5. 运行插件，选择生成目标后开始生成。

### App / 网页端生成模式

插件提供两个明确隔离的生成目标：

- `网页端（默认）`：完全沿用原有 HTML 导出参数和生成规则。该模式不会写入新的目标字段，旧任务、旧版 `00-input` 和未选择模式的调用仍按原网页链路执行。
- `App 页面`：仅本次任务附加 `targetPlatform: "app"`，并启用移动 Frame、触控热区、安全区、顶部/底部栏、动态视口和 App 滚动层级等专用规则。可以选中单个 Frame，也可以同时选中同一页面的多个交互状态 Frame。

服务端只把显式的 `targetPlatform: "app"` 识别为 App 模式；字段缺失、值无效或旧格式输入都会回落到网页端，因此不会改变原有网页 HTML 的生成效果。导出静态资源时，`export-options.json` 也会记录导出当时选择的模式。

App 多状态生成规则：

1. 同时选中的节点必须全部是 Frame，选择顺序中的第一个 Frame 作为页面默认态。
2. 后续 Frame 作为同一页面的弹层、展开、切换、选中等交互态，建议按“默认态 / 筛选展开 / 确认弹层”等含义命名。
3. 所有状态合并到同一个 `index.html` 中进行状态切换，不会并排拼接，也不会拆成多个页面。
4. 默认态截图写入 `frame-screenshot.png`，其他状态截图写入 `state-screenshots/`。
5. 网页端插件内的“一键生成 HTML”仍保持单 Frame 规则；Codex 的 `generate-from-mastergo` 会自动识别当前选区：单个 Frame 走单任务，多个 Frame 生成页面包并逐页创建独立 HTML 任务，不会把多个页面合并成一个任务。

生成任务提交前，请确保本地 MCP 服务已经启动，并且地址 `http://127.0.0.1:12322/health` 可以访问。

## 六、生成和交付结果

插件运行后会把选中的 Frame、设计结构、截图和素材提交给本地 MCP 服务。服务会按阶段处理任务，并在页面中显示任务进度。

结果默认保存在：

```text
mcp-server/data/jobs/<jobId>/
```

主要产物包括：

- `05-output/index.html`
- `05-output/styles.css`
- `05-output/script.js`
- `05-output/assets/`
- `final/output.zip`

在插件界面或任务面板中，可以查看任务状态、打开输出目录或下载 ZIP。

## 七、日常运行流程

客户每次使用时，按下面顺序操作：

1. 打开终端，进入项目根目录。
2. 启动本地服务：

```bash
npm run mcp:dev
```

3. 打开 MasterGo 并运行本地插件。
4. 选中一个完整页面 Frame。
5. 点击生成 HTML。
6. 等任务完成后，检查 `output.zip` 或 `05-output` 目录。

### mastergo命名相关事项
1.如果使用路径、
2.或者通过蒙版更改了原始图片的效果，需要将组的命名加上“蒙版”关键词

## 八、开发调试流程

如果需要边改插件边调试，可以启动监听构建：

```bash
npm run dev
```

同时启动本地 MCP 服务：

```bash
npm run mcp:dev
```

如果只需要重新生成生产版插件文件：

```bash
npm run build
```

运行服务端测试：

```bash
npm --prefix mcp-server test
```

## 九、常见问题

### 1. 插件提示 MCP 本地服务不可用

检查：

- 是否已经执行 `npm run mcp:dev`。
- `http://127.0.0.1:12322/health` 是否能打开。
- 端口 `12322` 是否被其他程序占用。
- 是否修改过 `MCP_PORT`。如果修改端口，需要同步修改插件代码中的 `127.0.0.1:12322` 并重新构建。

### 2. `/health` 返回 `llmConfigured: false`

检查 `/health` 返回的 `configErrors`：

- `LLM_BACKEND=openai-compatible`：确认 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` 完整。
- `LLM_BACKEND=codex-sdk`：确认已安装 `mcp-server` 依赖、Node.js 版本至少为 18，并在同一系统用户下完成 `codex login`。

### 3. 任务长时间停在 AI 阶段

可能原因：

- 模型服务响应较慢。
- 网络连接不稳定。
- 模型上下文或输出较大。

可以先查看任务面板：

```text
http://127.0.0.1:12322/panel
```

如果任务失败，可在插件界面中从失败阶段重试。

### 4. 生成结果缺少图片

插件提供两种图片模式：

- 切片：导出节点渲染结果，测试阶段推荐，更容易贴近视觉稿。
- 原图：使用设计稿引用的原始图片资源，最终交付时可尝试使用。

如果视觉还原优先，建议先使用“切片”模式生成。

### 5. 修改配置后没有生效

修改 `mcp-server/.env` 后，需要停止并重新启动本地 MCP 服务。

## 十、目录说明

```text
.
├── manifest.json              # MasterGo 插件清单
├── lib/                       # 插件主线程逻辑
├── ui/                        # 插件 UI
├── messages/                  # 插件主线程和 UI 通信类型
├── mcp-server/                # 本地任务服务
│   ├── .env                   # 本地模型配置，部署时创建
│   ├── data/jobs/             # 任务输入、阶段产物和最终输出
│   └── src/                   # 服务端代码和 workflow
├── dist/                      # 插件构建产物
└── package.json               # 项目脚本
```

## 网页端多 Frame → 多页面 HTML → React 项目

网页端选择多个 Frame 后，“导出 00-input / 多页面包”会一次性采集全部页面输入，并生成：

```text
mastergo-pages.json
pages/<page-id>/00-input/**
```

每个 Frame 都有独立的 `raw.json`、`asset-manifest.json`、`frame-screenshot.png` 和 `assets/**`，不会把多个页面拼成一个 HTML。

### 推荐调度策略

Codex 内默认使用 Agent 批次。它不会把全部页面上下文合并后反复传输，而是创建独立 job 并按 `nextPage` 逐页规划、生成和校验：

```bash
npm run --silent cli -- agent-prepare-pages --source mastergo-plugin --json
npm run --silent cli -- agent-batch-status <batchId> --json
```

已有页面包时使用：

```bash
npm run --silent cli -- agent-prepare-pages --input ./website-page-bundle.zip --json
```

每页只维护一个 `implementation-plan.json`。Codex 直接写三个 draft 文件，finalizer 不解析大型 JSON 代码信封；只有小型控制 JSON 继续做严格 schema 校验。批次记录只保存 job 和 context-index 路径，不复制页面事实。

页面约束统一维护在 `core/constraints/registry.json`。`agent-prepare` 将适用于当前 Web/App 目标的规则编译为 `agent/constraint-pack.md`，legacy workflow 按阶段从同一注册表编译约束子集；计划和约束包通过 version/hash 锁定，最终校验输出 `constraintCoverage`，防止 Agent 与插件路径再次产生规则漂移。

以下并发/质量门策略只适用于 `legacy-auto` 页面批处理：

默认调度器配置为：

- 页面 Worker 并发 2；
- 全局模型请求并发 5（硬上限 5）；
- 瞬时错误指数退避重试，默认每页 2 次；
- API Key、Codex 登录、模型配置等全局致命错误自动暂停；
- 同类网络、超时、限流错误重复出现后自动暂停；
- 页面保留 `jobId`，从失败阶段恢复，不重复已完成阶段；
- 先生成 2 个代表页面，人工质量通过后再展开剩余页面。

已在 MasterGo 中选中一个或多个网页 Frame 且插件窗口保持打开时，使用统一命令（单 Frame 自动走普通任务，多 Frame 自动走页面批次）：

```bash
npm run --silent cli -- generate-from-mastergo \
  --page-concurrency 2 \
  --model-concurrency 5 \
  --quality-gate-pages 2 \
  --page-retries 2 \
  --json
```

多选时所有可见选中节点必须都是 `FRAME`。如需强制要求多页面输入，可继续使用 `generate-pages-from-mastergo`；如通过 `--frame` 或 `--node-id` 指定目标，则统一命令固定生成单个 Frame。Bridge 需要在 `/health` 中声明 `mastergo-auto-frame-bundle-v1`。

如果已有页面包：

```bash
npm run --silent cli -- generate-pages \
  --input ./website-page-bundle.zip \
  --page-concurrency 2 \
  --model-concurrency 5 \
  --quality-gate-pages 2 \
  --page-retries 2 \
  --json
```

首次正常返回通常是 `status: "quality-gate"`。对照返回的 `frameScreenshotPath` 检查代表页面的 HTML；确认布局、字体、颜色、图片和交互质量可接受后继续：

```bash
npm run --silent cli -- resume-pages <batchId> --approve-quality --json
```

如果代表页面视觉质量不通过，先修复生成策略或 Prompt，再只重跑代表页面的 `plan-and-generate` 阶段：

```bash
npm run --silent cli -- resume-pages <batchId> --retry-quality --json
```

如果返回 `paused`，先修复共享的认证、配置、网络或限流问题，再执行：

```bash
npm run --silent cli -- resume-pages <batchId> --json
```

如果返回 `quality-failed`，不要直接批准，先用不带 `--approve-quality` 的 `resume-pages` 恢复失败的代表页。静态校验失败的代表页会从 `plan-and-generate` 重跑；模型连接失败的代表页会从记录的失败阶段恢复。成功页面不会被重新生成。

批次记录保存在 `.mastergo2html/page-batches/<batchId>/batch.json`。只有状态达到 `done` 后，再使用仓库 Skill **MasterGo2Code**（调用标识 `$mastergo2code`，内部调用 **HTML2React**（`$html2react`））合并为 Next.js App Router + TypeScript 项目。

`mastergo-pages.json` 中的路由由 Frame 名称初步推断，正式转换 React 前应检查并修正动态路由、首页和业务语义。
