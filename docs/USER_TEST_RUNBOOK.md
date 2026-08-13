# 用户测试前冻结清单

目标：下午展示一条稳定、可复现的 MasterGo2Code 结果，不在现场临时修复生成链路。

## 上午必须完成

1. 启动 bridge：`npm run mcp:dev`。
2. 确认 bridge 使用 `codex-sdk`：

```bash
curl -sS http://127.0.0.1:12322/health
```

响应中的 `llm.provider` 必须是 `codex-sdk`，`llmConfigured` 必须是 `true`。

3. 运行完整预检：

```bash
npm run demo:preflight
```

必须看到 `READY`。如果只需要展示已经完成的 React 工程，允许在 bridge 后端未对齐时继续演示，但必须明确这是冻结产物演示，不要点击 live generation。

4. 预热并打开冻结工程：

```bash
cd task-workspaces/html-to-react-demo-20260805/app
npm run start
```

打开 `http://localhost:4178/home`，按顺序检查首页、岗位列表、岗位详情、资讯、Q&A、反馈和法律声明。

## 下午演示顺序

1. 先展示 MasterGo Frame 和最终 React 工程的路由目录。
2. 展示 `/home`、`/position`、`/position/algorithm-engineer` 三条核心路由。
3. 展示岗位筛选、详情投递、反馈表单等已实现交互。
4. 最后说明 HTML 阶段与 React 工程阶段的边界：当前交付是可运行的第一版，后端数据接入和生产部署仍需继续开发。

## 不要在现场做的事

- 不要临时切换 Agent v2、Legacy 或模型后端。
- 不要用新的任意 Frame 现场证明 React 自动合并能力。
- 不要在用户测试中修改生成 HTML 或 React 源码。
- 不要把 `validate_project.py` 通过描述成“所有交互和视觉都已自动验证”。

## Live generation 备用路径

只有在 `demo:preflight` 通过且用户明确要看现场生成时，才执行：

```bash
npm run --silent codex:generate-from-mastergo -- \
  --page-concurrency 2 \
  --model-concurrency 5 \
  --quality-gate-pages 2 \
  --page-retries 2
```

质量门禁停在 `quality-gate` 时，先人工查看代表页面，再继续：

```bash
npm run --silent cli -- resume-pages <batchId> --approve-quality --json
```

现场生成失败时保留 `batchId` 和 `jobId`，回到冻结 React 工程，不要重启或删除批次目录。
