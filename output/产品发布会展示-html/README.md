# MasterGo2Code 产品发布会 HTML

## 打开方式

- 直接双击 `template.html`，或使用任意静态文件服务器打开。
- 键盘：`←` / `→` / `PageUp` / `PageDown` / `空格` 翻页，`Home` / `End` 跳转首尾页，`F` 进入全屏。
- 鼠标滚轮、触摸左右滑动和右下角圆点均可翻页。
- 支持 `template.html#1` 到 `template.html#12` 的逐页深链。

## 当前页序

1. 发布会封面
2. 设计稿交付，网页还要重新还原
3. 快速生成页面，不等于准确还原设计
4. 从设计稿到 HTML，我们要解决四类关键问题
5. MasterGo2Code 使用路线
6. 从选中Frame，到生成HTML
7. 从整体布局，到组件细节
8. 空白占位页（待补充）
9. 空白占位页（待补充）
10. 把更多时间，留给设计本身
11. 未来计划：下一步，不止是 HTML
12. 结束页：谢谢大家

## 已接入素材

- `assets/plugin.png`：封面 MasterGo2Code 插件截图。
- `assets/codex-command.png`：封面 Codex 指令截图底图；页面用可选中的 HTML 文本覆盖为规划中的 Frame 指令。
- `assets/comparison-list-design.webp`：第 3 页岗位列表设计稿对比基准。
- `assets/comparison-list-codify.webp`：第 3 页 Codify 岗位列表生成结果。
- `assets/comparison-list-codex.webp`：第 3 页 Codex 岗位列表生成结果。
- `assets/codify-job-list.png`、`assets/codify-job-list-footer.png`：旧版第 3 页截图，保留供后续局部对比复用。
- `assets/codify-job-detail.png`、`assets/codify-legal.png`：已随项目保留，便于后续追加对比页。
- `assets/accuracy-list-design.webp`、`assets/accuracy-list-generated.webp`：第 7 页岗位列表整体布局对比，已统一宽度、裁切和缩放基准。
- `assets/accuracy-qa-design.webp`、`assets/accuracy-qa-generated.webp`：第 7 页应届生 Q&A 版头组件对比。
- `assets/accuracy-detail-design.webp`、`assets/accuracy-detail-generated.webp`：第 7 页岗位详情内容卡片及操作页尾组件对比，已统一宽度、裁切和缩放基准。

第 6 页当前使用 CSS 生成的无文字视频占位画面，正式视频完成后可直接为 `.demo-video` 补充本地 `src` 和 `poster`，无需调整页面布局。

第 7 页进入后可继续使用 `←` / `→`、滚轮、滑动或翻页按钮，在同一页依次切换 4 个对比状态：整体布局、应届生 Q&A 版头、内容卡片区、操作与页尾区。

第 8、9 页按规划保留为空白占位，仅保留统一背景、页码和导航。第 11 页进入后，前 3 次前进操作会依次展示三个未来方向和横向虚线路径；展示完成后再进入第 12 页。第 12 页为稳定结束页，不自动循环。

## 待替换占位素材

- 第 2 页：3–4 张真实 MasterGo Frame。

替换时优先保持原容器结构和图片比例；样式集中在 `template.css`，交互集中在 `template.js`。
