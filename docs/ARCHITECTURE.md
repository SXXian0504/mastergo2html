# 项目架构

## 整体架构

```
用户浏览器
    ↓
Next.js SSR/CSR（server.js 自定义启动）
    ↓
API Route / BFF 层（pages/api/）
    ↓
@cvte/apollo-node-client（Apollo 配置中心）
    ↓
后端微服务
```

## 自定义 Server

- `server.js` — 项目入口，启动时重新执行 `next.config.js` 获取最新 Apollo 配置
- `apollo.js` — 从 Apollo 配置中心拉取运行时配置（环境变量、后端 URL 等）
- `next.config.js` — async 函数，依赖 Apollo 配置动态设置 `images.remotePatterns`
- 修改 `next.config.js` 时需确认 `server.js` 是否需要同步调整

## 数据流

1. 页面组件通过 **react-query** 发起数据请求
2. 请求发到本地 **API Route**（`pages/api/`）
3. API Route 通过 `@cvte/apollo-node-client` 获取后端服务地址
4. API Route 调用后端服务，处理并返回数据
5. 前端 HTTP 请求统一使用 `src/utils/request.ts`（axios 封装）

## 组件三层架构

| 层级 | 目录 | 职责 | 示例 |
|------|------|------|------|
| 布局层 | `components/layouts/` | 全局结构，影响所有页面 | BasicLayout（Header + Footer）、Meta（SEO） |
| 页面层 | `components/in-page/` | 与页面一一对应的业务组件 | Home/Banner、Position/List、Project/QA |
| 通用层 | `components/universal/` | 跨页面复用的通用组件 | Animate、Button、Title、ContactModal |

**in-page/ 子目录与 pages/ 的对应关系：**
- `in-page/Home/` → `pages/home/`
- `in-page/Position/` → `pages/position/`
- `in-page/Project/` → `pages/project/`
- `in-page/Banner/` → 多页面共用的 Banner 组件
- `in-page/Page/` → 通用页面包装器

## 样式方案

三者可混用，各有分工：

| 方案 | 适用场景 | 示例 |
|------|---------|------|
| **Tailwind CSS** | 布局、间距、颜色、字体、响应式 | `flex items-center gap-4 text-gray-600` |
| **SCSS Modules** | 复杂动画、伪类、需变量计算的样式 | `*.module.scss` |
| **Ant Design** | 表单、弹窗、抽屉等交互组件 | `<Modal>`, `<Drawer>` |

**原则**：Tailwind 能解决的场景不要用 SCSS。

## 状态管理

- 服务端状态：**react-query 3.x**（缓存、加载态、错误态）
- 客户端状态：React 原生 `useState` / `useReducer`
- 无全局状态库（Redux / Zustand 等）

## MasterGo 设计转代码工作流

- 技能定义：`.claude/skills/mastergo-to-page/`
- 设计产物输出：`.codify/design/`
- 验证截图对比：`.codify/screenshots/`
- 对比报告：`.codify/compare-report.json`
- 配置文件：`.mcp.json`（Codify MCP 服务端点）

## 内部依赖包

| 包名 | 用途 |
|------|------|
| `@cvte/apollo-node-client` | Apollo 配置中心客户端 |
| `@cvte/ciac` | 内部工具库 |
| `@cvte/koa-messages` | 国际化消息 |
| `@cvte/koa-redis` | Redis 缓存 |
