# 路由 & API 映射

## 页面路由

| 路径 | 文件 | 用途 |
|------|------|------|
| `/` | `pages/index.tsx` | 入口页（重定向到 /home） |
| `/home` | `pages/home/index.tsx` | 首页 |
| `/position` | `pages/position/index.tsx` | 岗位列表 |
| `/position/[id]` | `pages/position/[id].tsx` | 岗位详情 |
| `/project/[id]` | `pages/project/[id]/index.tsx` | 项目详情 |
| `/project/[id]/qa` | `pages/project/[id]/qa.tsx` | 项目 Q&A |
| `/project/marketing_talent` | `pages/project/marketing_talent/` | 营销人才专区 |
| `/campus_news` | `pages/campus_news/index.tsx` | 校招资讯列表 |
| `/campus_news/[id]` | `pages/campus_news/[id].tsx` | 资讯详情 |
| `/referral/position` | `pages/referral/position/` | 内推岗位列表 |
| `/referral/position/[id]` | `pages/referral/position/` | 内推岗位详情 |
| `/referral/share` | `pages/referral/position/` | 内推分享页 |
| `/contact` | `pages/contact/index.tsx` | 联系我们 |
| `/cookies` | `pages/cookies/index.tsx` | Cookie 政策 |
| `/howtoapply` | `pages/howtoapply/index.tsx` | 投递指南 |
| `/legal` | `pages/legal/index.tsx` | 法律声明 |
| `/origin` | `pages/origin/index.tsx` | 品牌故事 |
| `/privacy` | `pages/privacy/index.tsx` | 隐私政策 |
| `/404` | `pages/404.tsx` | 404 页面 |

### 动态路由参数

| 路由 | 参数 | 说明 |
|------|------|------|
| `/position/[id]` | `id` | 岗位 ID |
| `/project/[id]` | `id` | 项目 ID |
| `/project/[id]/qa` | `id` | 项目 ID |
| `/campus_news/[id]` | `id` | 资讯文章 ID |

## API 路由

| 端点 | 方法 | 文件 | 用途 |
|------|------|------|------|
| `/api/position` | GET | `pages/api/position/` | 岗位搜索列表 |
| `/api/type` | GET | `pages/api/type.ts` | 岗位类型枚举 |
| `/api/city` | GET | `pages/api/city.ts` | 城市数据 |
| `/api/campus_news/home` | GET | `pages/api/campus_news/home.ts` | 首页资讯列表 |
| `/api/campus_news/[id]` | GET | `pages/api/campus_news/[id].ts` | 资讯详情 |
| `/api/campus_news/qa/graduate` | GET | `pages/api/campus_news/qa/` | 应届生 Q&A |
| `/api/campus_news/qa/intern` | GET | `pages/api/campus_news/qa/` | 实习生 Q&A |
| `/api/project/*` | GET | `pages/api/project/` | 项目数据 |
| `/api/recommend/share/*` | GET/POST | `pages/api/recommend/share/` | 内推分享系统 |

## 中间件

- `src/middleware.ts` — Next.js 中间件，处理请求拦截（如重定向、鉴权等）

## 自定义 Server

- `server.js` — 项目启动入口，包装 Next.js + Apollo 配置
- `apollo.js` — Apollo 配置中心客户端，被 `next.config.js` 和 `server.js` 引用
