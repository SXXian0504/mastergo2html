# MasterGo2Code Demo 视频录制流程与镜头清单

> 建议成片：4 分 30 秒～5 分钟  
> 画面规格：1920 × 1080，16:9，30 fps  
> 核心主张：**用户只输入一句话，Skill 自动把多个 MasterGo Frame 转换成一个可运行、可验证、可继续开发的 React 项目。**

## 一、先确定视频只证明四件事

1. **输入少**：用户只选择页面并输入一句目标，不需要编写长 Prompt。
2. **过程完整**：Skill 自动执行逐页生成、截图验证、React 合并和工程检查。
3. **结果真实**：不是三张静态图片，而是有真实路由、交互和响应式的 Next.js 项目。
4. **设计被保留**：复杂 Logo、素材、布局关系和页面风格得到保留，并有视觉验证证据。

视频不要试图解释全部技术细节。主线应该是：

```text
设计页面 → 一句话 → Skill 工作流 → 视觉验证 → React 工程 → 可运行结果
```

## 二、推荐的最终时间线

| 时间 | 画面 | 具体操作 | 屏幕字幕 | 目的 |
|---|---|---|---|---|
| 00:00–00:10 | 三个最终页面快速预览 | 主页、岗位列表、岗位详情各闪现 2～3 秒 | From frames to product | 先让观众看到结果 |
| 00:10–00:28 | MasterGo 全局画布 | 展示三个完整 Frame；框选或逐个选中，让选中边框和页面名清晰可见 | 3 MasterGo frames selected | 证明输入来自真实设计稿 |
| 00:28–00:45 | Codex 输入框 | 在干净的新任务中输入并发送：`将当前选中的 MasterGo 页面转换成 React 项目。` | One instruction | 强调用户输入极少 |
| 00:45–01:05 | Codex 识别 Skill | 保留 Skill 名称、工作流读取、任务计划出现的画面 | Workflow loaded | 证明不是普通临时 Prompt |
| 01:05–01:42 | 逐页 HTML 生成蒙太奇 | 首页、列表、详情三个页面按顺序出现“生成中/完成”；每页只保留关键 5～8 秒 | Build each page independently | 证明每个 Frame 独立处理 |
| 01:42–02:12 | 逐页视觉验证 | 每页展示“设计稿 / 生成截图”并排或快速叠化；可短暂出现 diff 和 pass 状态 | Verify against the design | 证明生成完成不等于验收完成 |
| 02:12–02:38 | React 项目形成 | 展示三个页面进入同一 Next.js 工程；只展开关键路由和公共组件目录 | Merge into one React app | 证明是工程，不是散落 HTML |
| 02:38–03:25 | 浏览器真实路由 | 首页搜索进入岗位列表；点击岗位进入详情；点击 Logo 回首页 | Real routes. Connected pages. | 展示页面之间真实连接 |
| 03:25–03:50 | 响应式画面 | 浏览器从 1440/1920 宽缓慢缩到约 390 px；重点展示导航、卡片、列表或详情正文适配 | Responsive behavior | 证明不是固定尺寸截图 |
| 03:50–04:15 | 工程验证结果 | 只显示三个简洁绿色状态：TypeScript、Production Build、Visual QA | Typecheck · Build · Visual QA | 建立工程可信度 |
| 04:15–04:40 | Hero Case 局部对比 | 放大页尾 CVTE/seeWo/MAXHUB Logo、首页主视觉或岗位页装饰；设计稿与最终结果左右对比 | Design details preserved | 给出最强视觉证据 |
| 04:40–04:55 | 三页并列定格 | 三个浏览器页面并列，最后出现产品名和主张 | One instruction. One working project. | 完成记忆点 |

如果最终必须压缩到 4 分 30 秒，优先缩短“逐页生成”和“响应式”，不要删除一句指令、视觉验证、路由跳转和工程验证。

## 三、需要分别录制的原始画面

不要尝试一次连续录完。建议录成以下 7 组素材，后期再拼接。

### A. MasterGo 设计输入

必须录：

1. MasterGo 画布上同时看到主页、岗位列表、岗位详情三个 Frame。
2. 页面名称可读，避免缩放过小。
3. 框选三个 Frame，选中边框明显。
4. 分别快速放大三个 Frame 的首屏。
5. 单独录一段页尾复杂 Logo/社交图标区域，供后面的对比镜头使用。

录制建议：

- 先静止 2 秒，再开始框选。
- 鼠标移动要慢，不要在画布里来回寻找。
- 隐藏无关面板，只保留能证明这是 MasterGo 和 Frame 选择的界面。
- 每个动作前后都多留 1～2 秒，方便剪辑。

### B. Codex 一句话指令

必须录：

1. 一个干净的新 Codex 任务。
2. 输入真实指令：

   > 将当前选中的 MasterGo 页面转换成 React 项目。

3. 完整拍到点击发送。
4. 拍到 **MasterGo2Code** Skill（调用标识 `$mastergo2code`）被识别或读取的明确证据。
5. 拍到工作计划形成，但不要长时间展示文字输出。

画面重点：

- 让观众能完整读完这句话。
- 输入过程可保留 3～5 秒，也可以先输入好、停留 2 秒后发送。
- 不要在同一条指令里追加几十行验收要求，否则会破坏“一句话”的产品主张。
- 如果路径、用户名、Token 或内部服务信息出现，后期裁切或打码。

### C. 逐页生成过程

建议分别录三段，每段只拍关键状态：

1. 首页 Frame 被读取并生成页面。
2. 岗位列表 Frame 被读取并生成页面。
3. 岗位详情 Frame 被读取并生成页面。

画面可以包含：

- 页面名和对应路由；
- 当前阶段名称；
- 已完成/通过状态；
- 页面截图缩略图；
- 实际原始耗时。

不要录：

- 等待模型输出的完整过程；
- 连续几十秒终端字符滚动；
- 大段 JSON；
- 重试和失败排查；
- 三页完全相同的重复操作。

后期处理：把真实生成过程加速或用跳切压缩为 30～40 秒，并在角落标注“原始任务耗时”，不要让观众误以为剪辑后的 5 秒就是实际生成时间。

### D. 视觉验证

每页至少录一组：

```text
MasterGo Frame | HTML/React 截图 | 验证状态
```

优先展示：

1. 首页 Hero 主视觉和页尾品牌区；
2. 岗位列表的招聘流程、筛选区和岗位列表布局；
3. 岗位详情的标题、正文面板和投递按钮；
4. Logo、蒙版、SVG 或复杂组合素材没有变成黑框/占位图。

现有可用素材：

- 设计稿：`merged-cvte-career-next/design-references/index/frame-screenshot.png`
- 设计稿：`merged-cvte-career-next/design-references/jobs/frame-screenshot.png`
- 设计稿：`merged-cvte-career-next/design-references/jobs-id/frame-screenshot.png`
- React 最终截图：`merged-cvte-career-next/visual/react-final/index.png`
- React 最终截图：`merged-cvte-career-next/visual/react-final/jobs.png`
- React 最终截图：`merged-cvte-career-next/visual/react-final/jobs-id.png`
- 差异图：`merged-cvte-career-next/visual/react-final/*.diff.png`
- 验证报告：`merged-cvte-career-next/visual/react-final/*.json`

三个当前报告均为 `pass`。视频中不建议显示 changed ratio 等复杂指标，只保留“尺寸匹配、视觉验证通过”和局部对比；详细数据放 Q&A 备用页。

### E. React 工程结构

只录 8～12 秒，不要把视频变成代码讲解。

建议在编辑器中展开：

```text
src/app/page.tsx
src/app/jobs/page.tsx
src/app/jobs/[id]/page.tsx
src/components/
src/styles/
```

重点拍到：

- 三个真实路由；
- React/Next.js 源文件，而不是 iframe 或 HTML 字符串嵌入；
- 公共组件目录；
- 设计资源目录。

可以轻微滚动一次代码，但不要讲具体实现。字幕只写：`One project. Real routes.`

### F. 浏览器最终产品

推荐按以下操作顺序连续录制一条干净素材：

1. 打开首页 `/`，停留 Hero 2 秒。
2. 在搜索框输入“算法工程师”或“广州”，点击搜索。
3. 页面跳到 `/jobs?q=...`，展示真实 URL 改变。
4. 在岗位列表短暂操作搜索或筛选，让岗位结果发生变化。
5. 点击任一岗位卡片，进入 `/jobs/algorithm-engineer`。
6. 在岗位详情页向下滚动，展示正文和“立即投递”。
7. 主要用搜索和筛选证明可见交互；“立即投递”按钮只有在录屏中能清楚看到加载状态时再保留。
8. 点击顶部 Logo 回到首页。

当前可展示路由：

- `/`
- `/jobs`
- `/jobs/algorithm-engineer`

录制时浏览器建议：

- 使用无痕或专用演示 Profile；
- 隐藏书签栏和无关扩展；
- 地址栏可以保留，用于证明真实路由；
- 页面缩放固定 100%；
- 鼠标轨迹稳定，不要快速甩动；
- 每次跳转后停 1～2 秒。

### G. 工程验证

先单独录下真实命令成功结果，后期再做成三个绿色状态，不要全屏展示终端。

建议验证：

```bash
npm run typecheck
npm run build
npm run validate
```

如果还要展示截图验证，可补充：

```bash
npm run capture
```

成片中只保留：

```text
✓ TypeScript Passed
✓ Production Build Passed
✓ Visual Regression Recorded
```

真实终端输出可以作为备用素材，但主视频里每项最多出现 2～3 秒。

## 四、建议额外录制的安全镜头

每个关键阶段再录一个无鼠标、无操作的 3～5 秒静态镜头：

1. 三个 MasterGo Frame 全景；
2. Codex 一句话已输入但尚未发送；
3. Skill 已加载；
4. 三个页面生成完成；
5. 三个视觉验证通过；
6. 三个浏览器路由首屏；
7. 移动端视口；
8. 三个工程验证通过；
9. 页尾 Logo 局部；
10. 最终三页并列。

这些静态安全镜头可用于遮挡剪辑跳点、配旁白或应对某段动态素材不够干净。

## 五、录制前准备清单

### 环境

- [ ] MasterGo 已打开正确文件，三个 Frame 已定位好。
- [ ] Codex 使用干净任务，输入框和 Skill 加载区域可见。
- [ ] React 项目可在本地稳定启动。
- [ ] `/`、`/jobs`、`/jobs/algorithm-engineer` 均可访问。
- [ ] 首页搜索、岗位筛选、岗位卡片跳转和投递按钮已测试。
- [ ] typecheck、build、validate 已提前完整跑通。
- [ ] 所有通知、聊天软件弹窗、自动更新提示已关闭。
- [ ] 屏幕上没有 API Key、内部 Token、个人聊天和敏感路径。

### 录屏

- [ ] 1920 × 1080、30 fps。
- [ ] 系统缩放、浏览器缩放固定。
- [ ] 鼠标光标大小适中。
- [ ] 关闭鼠标点击夸张特效。
- [ ] 每段开头和结尾留 2 秒静止。
- [ ] 每个关键操作至少录两遍。
- [ ] 原始录屏按镜头编号命名，不直接覆盖。

推荐文件命名：

```text
01-final-preview.mov
02-mastergo-frames.mov
03-codex-one-prompt.mov
04-skill-loaded.mov
05-build-pages.mov
06-visual-validation.mov
07-react-project.mov
08-route-navigation.mov
09-responsive.mov
10-engineering-checks.mov
11-logo-comparison.mov
12-final-montage.mov
```

## 六、字幕和旁白原则

### 字幕

每段只写一个结论，建议使用：

- `3 MasterGo frames selected`
- `One instruction`
- `Workflow loaded`
- `Build each page independently`
- `Verify against the design`
- `Merge into one React app`
- `Real routes. Connected pages.`
- `Responsive behavior`
- `Typecheck · Build · Visual QA`
- `Design details preserved`
- `One instruction. One working project.`

字幕不要解释内部脚本、批次号、JSON 字段或 Agent 名称。

### 旁白

推荐只在开头和结尾说话，中间让画面与字幕自己证明。

开头：

> 接下来请重点看两件事：我输入了多少信息，以及 Skill 自动接管了多少步骤。

结尾：

> 用户只需要说明目标。Skill 会读取设计、逐页生成、视觉验证、合并路由并完成工程检查。多个设计页面，最终成为一个可以运行、验证和继续开发的 React 项目。

## 七、成片中必须删除的内容

- 完整等待过程；
- 长时间终端滚屏；
- 鼠标寻找文件或按钮；
- 失败、重试和现场排障；
- 无法解释价值的代码特写；
- 内部端口、Token、用户目录等敏感信息；
- 三个页面的重复生成流程；
- “100% 还原”“完全替代前端”等无法证明的表述。

## 八、最低可交付版本

如果时间很紧，至少录齐以下 8 个镜头：

1. MasterGo 三个 Frame 被选中；
2. Codex 中真实的一句话；
3. Skill 被明确加载；
4. 三个页面分别完成；
5. 一组设计稿与生成结果对比；
6. `/ → /jobs → /jobs/algorithm-engineer` 路由跳转；
7. typecheck、build、Visual QA 三项通过；
8. 三个最终页面并列定格。

这 8 个镜头已经能够完整证明“输入少、过程专业、结果真实、工程可用”。
