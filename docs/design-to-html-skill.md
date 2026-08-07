# 设计稿转 HTML 短规则集成

客户分享的《设计稿转 HTML 表述示例库》不是整段注入到模型的 prompt，而是拆成几类短规则，按 workflow 阶段选择性注入，避免固定输入 token 过高。

## 规则分类

- 布局关系：说关系、约束和规则，不机械复刻坐标；普通内容优先文档流、Flex、Grid，absolute 只用于背景装饰、浮层、蒙层、吸附和有证据的重叠。
- 响应式与溢出：PC 优先，768px 以下描述差量重排；长文本、chip、列表、表格必须有换行、省略或局部滚动策略。
- 状态稳定：补充静态稿看不到的 hover、focus、disabled、loading、empty、error、最长/最短文案、图片失败和多语言变长行为。
- 素材交付：SVG/PNG/CSS 的边界清晰；图标和简单图形优先 SVG，复杂照片/材质/切片使用 asset-index，圆角、阴影、纯色块和简单渐变用 CSS。
- 装饰画布完整性：光晕/波点等 SVG 必须读取真实 width/height/viewBox 与 blur/filter bleed，不能按 nominal 节点尺寸压缩；溢出裁切的装饰必须 `flex:none; max-width:none`，并以基准视口截图核对颜色覆盖面积。

## 注入位置

- `ai-layout-analysis`：注入布局关系、响应式与溢出。
- `component-structure-analysis`：注入布局关系、响应式与溢出。
- `static-asset-analysis`：注入素材交付、布局关系。
- `interaction-analysis`：注入状态稳定、响应式与溢出。
- `assembly-planning`：注入全部短规则，用于统一页面级裁决。
- `html-generation`：注入全部短规则，用于最终代码生成。

## Token 控制

规则集中在 `mcp-server/src/workflow/design-to-html-skill.js`。默认开启，可用环境变量关闭做 A/B 或 token 对比：

```bash
DESIGN_TO_HTML_SKILL_ENABLED=false npm --prefix mcp-server test
```

完整客户文档只作为规则来源和人工参考，不进入每次 LLM 输入。

