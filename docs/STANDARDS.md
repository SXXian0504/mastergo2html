# 项目编码规范（项目特有）

> 通用 TS/命名/代码风格规范见 `~/.claude/CLAUDE.md`，此处仅记录本项目特有规则。

## 组件分类规则

| 目录 | 条件 | 示例 |
|------|------|------|
| `layouts/` | 影响全局布局的组件 | Header、Footer、Meta |
| `in-page/` | 只在一个页面使用的业务组件，目录名与 `pages/` 对应 | Home/Banner、Position/List |
| `universal/` | 至少在 2 个以上页面复用的通用组件 | Animate、Button、Title |

**原则**：新组件默认放 `in-page/`，确认跨页面复用时才提升到 `universal/`。

## 样式分工

| 场景 | 方案 |
|------|------|
| 布局、间距、颜色、字体 | Tailwind class |
| 复杂动画、keyframes | SCSS Module |
| 伪类、嵌套选择器 | SCSS Module |
| 响应式断点 | Tailwind (`sm:` / `md:` / `lg:` / `xl:`) |
| 交互组件（Modal、Drawer） | Ant Design |

## API Route (BFF) 规范

- 文件名使用 kebab-case
- 通过 Apollo 配置中心获取后端 URL，**禁止硬编码**
- 统一使用 `src/utils/request.ts` 的 axios 封装
- 错误统一在 API Route 层处理，前端组件只处理成功态
- 接口变更时前端与 Node 端配置保持一致

## 文件命名

| 类型 | 规则 | 示例 |
|------|------|------|
| 组件 | PascalCase 目录 + `index.tsx` | `Banner/index.tsx` |
| 工具函数 | camelCase.ts | `request.ts`、`dom.ts` |
| 类型定义 | camelCase.ts | `position.ts`、`news.ts` |
| 常量配置 | camelCase.ts | `project.ts`、`qa.ts` |
| 样式文件 | 与组件同名 `.module.scss` | `Banner.module.scss` |

## 图片资源

- 静态图片放 `public/` 目录
- CDN 图片超 1MB **必须压缩后上传**
- 设计转代码的图片资产放 `.codify/design/` 下

## 配置变更

- 涉及 Apollo 配置变更时，前端与 Node 端同步修改
- `next.config.js` 修改后需确认 `server.js` 是否需要同步调整
- `tailwind.config.js` 修改需确认 `purge` 路径覆盖所有组件目录

## MasterGo 设计转代码

- 使用 `.claude/skills/mastergo-to-page/` 技能
- 设计产物输出到 `.codify/design/` 目录
- 通过截图对比验证还原度
