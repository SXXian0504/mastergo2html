# MasterGo2HTML 部署说明

本项目用于把 MasterGo 设计稿中选中的页面 Frame 转换为可交付的 HTML 静态页面。部署时需要同时准备两部分：

- MasterGo 插件：负责读取设计稿、导出结构和素材，并把任务提交到本地服务。
- 本地 MCP 服务：运行在客户电脑本机，负责调用 AI 模型生成 HTML，并保存结果文件。

默认服务地址为 `http://127.0.0.1:12322`。插件代码当前固定访问这个地址，因此请优先使用默认端口部署。

## 一、部署前准备

### 1. 安装基础软件

请先在客户电脑上准备：

- Node.js：建议使用 Node.js 18 LTS 或以上版本，最低要求 `>=14.14.0`。
- npm：随 Node.js 一起安装。
- MasterGo 客户端或可加载本地插件的 MasterGo 环境。
- 可访问 AI 模型服务的网络环境。
- AI 模型服务的 API Key、Base URL 和模型名称。

https://nodejs.org/zh-cn/download



安装完成后，在终端检查：

```bash
node -v
npm -v
```

AI模型：

```
# cch
# gpt
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_BASE_URL=https://token.cvte.com/v1
OPENAI_MODEL=gpt-5.5
OPENAI_WIRE_API=responses

# deepseek
# OPENAI_API_KEY=sk-your-api-key-here
# OPENAI_BASE_URL=https://token.cvte.com/v1
# OPENAI_MODEL=deepseek-v4-pro
# OPENAI_WIRE_API_DEEPSEEK_V4_PRO=chat-completions
```


### 2. 获取项目代码

把项目代码放到客户电脑的固定目录。

如果是通过压缩包交付，解压后进入项目根目录即可。

### 3. 安装项目依赖

在项目根目录执行：

```bash
npm install
```

本地 MCP 服务当前只使用 Node.js 内置能力，不需要单独安装第三方依赖；统一执行根目录的 `npm install` 即可。

## 二、配置 AI 模型

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

AI模型：

```
# cch
# gpt
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_BASE_URL=https://token.cvte.com/v1
OPENAI_MODEL=gpt-5.5
OPENAI_WIRE_API=responses

# deepseek
# OPENAI_API_KEY=sk-your-api-key-here
# OPENAI_BASE_URL=https://token.cvte.com/v1
# OPENAI_MODEL=deepseek-v4-pro
# OPENAI_WIRE_API_DEEPSEEK_V4_PRO=chat-completions
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
5. 网页端插件内的“一键生成 HTML”仍保持单 Frame 规则；网页多选 Frame 通过“多页面包导出”或 Codex 的 `generate-pages-from-mastergo` 桥接链路逐页生成，不会作为一个任务合并生成。

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

说明模型配置不完整。检查 `mcp-server/.env` 中是否包含：

```bash
OPENAI_API_KEY=...
OPENAI_BASE_URL=...
OPENAI_MODEL=...
```

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

网页端选择多个 Frame 后，“导出 00-input / 多页面包”会按 Frame 分开采集资源，并生成：

```text
mastergo-pages.json
pages/<page-id>/00-input/**
```

每个 Frame 都有独立的 `raw.json`、`asset-manifest.json`、`frame-screenshot.png` 和 `assets/**`，不会把多个页面拼成一个 HTML。

如果目标 Frame 已在 MasterGo 当前页面中选中，并且 MasterGo2HTML 插件窗口保持打开，Codex 可直接请求插件提取当前多选 Frame 并逐页生成 HTML：

```bash
npm run --silent cli -- generate-pages-from-mastergo --json
```

该命令通过本地 Bridge 获取 `mastergo-pages.json + pages/*/00-input`，随后为每个 Frame 启动一个独立 HTML 生成任务。如果使用的是升级前已启动的 Bridge，需要先重启 `npm run mcp:dev`，使 `/health` 声明 `mastergo-page-bundle-v1`。

如果插件窗口未打开，或者用户已经手动下载了页面包，则使用静态输入命令：

```bash
npm run --silent cli -- generate-pages --input ./website-page-bundle.zip --json
```

CLI 会逐页生成 HTML，并在 `.mastergo2html/page-batches/<batchId>/batch.json` 保存路由、任务和输出路径。随后使用仓库 skill `mastergo-pages-to-react`（内部调用 `merge-html-to-next-app`）将页面合并为符合工程规范的 Next.js App Router + TypeScript 项目。

`mastergo-pages.json` 中的路由由 Frame 名称初步推断，正式转换 React 前应检查并修正动态路由、首页和业务语义。
