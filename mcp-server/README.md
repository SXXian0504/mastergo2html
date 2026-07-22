# MasterGo2JSON MCP Bridge

阶段 1.5 的本地任务服务原型。

启动：

```bash
npm run mcp:dev
```

默认地址：

- Health: `http://127.0.0.1:8787/health`
- Jobs: `http://127.0.0.1:8787/jobs`
- Panel: `http://127.0.0.1:8787/panel`

当前实现是插件可访问的 HTTP bridge 和任务状态持久化骨架。后续正式 workflow 可以接入 `processJob()`，或在服务内部调用 MCP tools。

## AI 模型配置

本地服务启动时会读取 `mcp-server/.env`。如果使用公司 CCH / Codex-compatible 服务，推荐填写：

```bash
OPENAI_API_KEY=your-api-key-here
OPENAI_BASE_URL=https://token.cvte.com/v1
OPENAI_MODEL=gpt-5.5
OPENAI_WIRE_API=responses
# 可选，页面组装模型调用超时，默认 900000（15 分钟）
ASSEMBLY_LLM_TIMEOUT_MS=900000
# 页面组装默认使用 Responses SSE 流式输出；false 可回滚非流式模式
ASSEMBLY_STREAMING_ENABLED=true
# 流式连接、首事件和事件间空闲超时
ASSEMBLY_LLM_CONNECT_TIMEOUT_MS=30000
ASSEMBLY_LLM_FIRST_EVENT_TIMEOUT_MS=300000
ASSEMBLY_LLM_IDLE_TIMEOUT_MS=120000
# 可选，HTML 代码生成使用独立模型参数
HTML_GENERATION_MODEL=gpt-5.5
HTML_GENERATION_MAX_TOKENS=14000
HTML_GENERATION_TIMEOUT_MS=900000
HTML_GENERATION_TEMPERATURE=0.15
```

如果使用 OpenAI chat-completions-compatible 服务，可以改用：

```bash
OPENAI_API_KEY=sk-your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
OPENAI_WIRE_API=chat-completions
```

## 失败阶段重试

失败任务可以复用已落盘的输入和前序阶段产物，从失败阶段继续运行：

```http
POST /jobs/{jobId}/retry
Content-Type: application/json

{"phase":"assembly-planning"}
```

`phase` 必须是任务当前的失败阶段。服务会保留此前已完成阶段的状态、token、耗时和产物，并重新执行失败阶段及其后续阶段。同一任务运行时重复提交重试会返回 `409`。

`assembly-planning` 使用流式输出时会持续写入阶段的 `streamMetrics`，插件与外部面板显示连接状态、已接收字符数和事件数。收到部分正文后中断会保留 `04-assembly/assembly.plan.partial.md`，且不会自动重试；用户可通过失败阶段重试重新开始。网关明确返回不支持流式的 400、404、415 或 422 时，服务只回退一次非流式请求。

阶段八生成可双击打开的原生 `05-output/index.html`、`styles.css`、`script.js`，并复制完整 `00-input/assets/`。视觉比对与 ZIP 打包留到阶段九。
