# MasterGo2HTML 部署说明

本项目用于把 MasterGo 设计稿中选中的页面 Frame 转换为可交付的 HTML 静态页面。部署时需要同时准备两部分：

- MasterGo 插件：负责读取设计稿、导出结构和素材，并把任务提交到本地服务。
- 本地 MCP 服务：运行在客户电脑本机，负责调用 AI 模型生成 HTML，并保存结果文件。

默认服务地址为 `http://127.0.0.1:8787`。插件代码当前固定访问这个地址，因此请优先使用默认端口部署。

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

本地服务启动时会读取 `mcp-server/.env`。首次部署需要手动创建这个文件：

```bash
touch mcp-server/.env
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


### 可选配置：修改服务端口

服务支持通过 `MCP_PORT` 修改端口：

```bash
MCP_PORT=8787
```

注意：插件端当前写死访问 `http://127.0.0.1:8787`。除非同步修改并重新构建插件，否则不要改端口。

## 三、启动本地 MCP 服务

方式一：安装桌面启动器。

在 Finder 中双击项目根目录的 `install-launcher.command`，它会在桌面生成 `启动本地监听.command`。以后直接双击桌面上的 `启动本地监听.command` 即可启动本地 MCP 服务。

方式二：在 Finder 中双击项目根目录的 `start-mcp-dev.command`。

首次双击如果提示没有执行权限，可以在项目根目录执行一次：

```bash
chmod +x install-launcher.command start-mcp-dev.command
```

方式三：在项目根目录执行：

```bash
npm run mcp:dev
```

启动成功后，终端会看到类似输出：

```text
mastergo2html bridge listening on http://127.0.0.1:8787
panel: http://127.0.0.1:8787/panel
```

打开健康检查地址确认服务状态：

```text
http://127.0.0.1:8787/health
```

正常情况下会返回 JSON，并且 `llmConfigured` 应为 `true`。如果是 `false`，说明 `mcp-server/.env` 中的模型配置不完整。

任务面板地址：

```text
http://127.0.0.1:8787/panel
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
5. 运行插件，点击生成 HTML。

生成任务提交前，请确保本地 MCP 服务已经启动，并且地址 `http://127.0.0.1:8787/health` 可以访问。

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
- `http://127.0.0.1:8787/health` 是否能打开。
- 端口 `8787` 是否被其他程序占用。
- 是否修改过 `MCP_PORT`。如果修改端口，需要同步修改插件代码中的 `127.0.0.1:8787` 并重新构建。

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
http://127.0.0.1:8787/panel
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
