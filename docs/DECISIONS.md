# 架构决策记录 (ADR)

> 新增决策按时间顺序追加，编号递增。

## [ADR-001] 使用 Pages Router 而非 App Router
- **背景**：Next.js 13+ 推荐使用 App Router
- **决策**：继续使用 Pages Router
- **原因**：项目已基于 Pages Router 构建，迁移成本高；Pages Router 生态更成熟稳定

## [ADR-002] 自定义 Server 而非 Vercel 部署
- **背景**：Next.js 支持零配置部署到 Vercel
- **决策**：使用自定义 `server.js` 启动
- **原因**：需要在启动时从 Apollo 配置中心动态拉取配置，Vercel 的 serverless 模式不支持此场景

## [ADR-003] BFF 层使用 API Route
- **背景**：前端需要调用多个后端服务
- **决策**：在 `pages/api/` 下建立 BFF 层
- **原因**：隐藏后端服务细节，统一鉴权和配置管理，减少前端跨域问题

## [ADR-004] 混合样式方案
- **背景**：项目同时存在 Tailwind、SCSS Modules、Ant Design 三种样式方案
- **决策**：三者共存，各有分工
- **原因**：Tailwind 覆盖基础样式，SCSS Module 处理复杂动画，Ant Design 提供交互组件；强行统一会破坏已有代码

## [ADR-005] react-query 管理服务端状态
- **背景**：需要管理 API 请求的缓存、加载、错误状态
- **决策**：使用 react-query 3.x，不引入 Redux/Zustand 等全局状态库
- **原因**：项目以展示为主，服务端状态远多于客户端状态，react-query 足够覆盖

## [ADR-006] MasterGo 设计转代码工作流
- **背景**：需要将 MasterGo 设计稿转为 Next.js 页面
- **决策**：使用 Codify MCP + 自定义 mastergo-to-page skill
- **原因**：自动化设计转代码流程，通过截图对比验证还原度
