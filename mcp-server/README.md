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
```

如果使用 OpenAI chat-completions-compatible 服务，可以改用：

```bash
OPENAI_API_KEY=sk-your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
OPENAI_WIRE_API=chat-completions
```
