import { createHash } from 'node:crypto'

export const ROLE_GUIDANCE_VERSION = 'mastergo2html.role-guidance.v2'
export const FACT_PRECEDENCE = 'node-style-facts > asset-index/节点切片事实 > 角色判断 > page-layout > design-token 语义推断'

const ROLE_ORDER = ['component', 'assets', 'interaction', 'assembly']

const ROLE_GUIDANCE = Object.freeze({
  component: Object.freeze({
    title: '组件结构',
    role: 'MasterGo 转 HTML workflow 中的“组件结构分析 AI”',
    focus: '整页语义 DOM、组件边界、文档流、Flex/Grid、样式组织和响应式实现。',
    responsibilities: Object.freeze([
      '覆盖页面从顶部到底部的全部主要内容，不能因节点命名不佳而遗漏标题、正文、列表、控件或页尾。',
      '审阅 header、main、section、nav、footer 等语义结构、组件边界、真实重复结构和 class 组织。',
      '默认保留 source bounds、模块 bbox、绘制顺序和 stackingFacts；仅在 Auto Layout、flexContainerInfo、layoutMode 或重复行列事实支持时改为文档流、Flex 或 Grid。',
      '只允许在完整的 data-module-id 容器上调整模块层级；禁止把模块 z-index、main/header/section 身份赋给某个背景子节点，否则该背景会遮挡同模块的兄弟内容。',
      '语义包装必须覆盖该模块的全部根级兄弟节点并保持相对绘制顺序；不能把一个背景组误当作整个 main，也不能靠整张设计画布缩放充当响应式实现。',
      '表格、侧边栏、工具栏、浮层、重叠区域、复杂卡片和小尺寸控件优先保留 absolute 或局部 absolute。',
      '桌面 Frame 只推导保守响应式；独立审阅 Header/Nav/Footer 和中间视口，确保无横向溢出、遮挡或空白带。',
    ]),
  }),
  assets: Object.freeze({
    title: '静态资源',
    role: 'MasterGo 转 HTML workflow 中的“静态资源分析 AI”',
    focus: '整页图片、图标、Logo、背景和装饰资源的引用、裁剪、层级、缺失检查与降级。',
    responsibilities: Object.freeze([
      '逐项依据 assetId、imageRef、copiedPath、sourceNodeId 和文件存在状态审阅资源，禁止编造路径或图形。',
      '按照 renderPolicy 裁决真实资源、节点切片、CSS 绘制或透明占位；required-final 必须使用，review-only/forbidden-final 禁止引用。',
      '内容图片与品牌 Logo 优先真实资源；复杂组合优先切片；简单且有精确事实的纯色视觉才使用 CSS。',
      '区分内容资源与 background/decorative layer，审阅 object-fit、object-position、源坐标、裁剪、透明度和 z-index，禁止装饰资源进入文档流。',
      'positioningPolicy=source-bounds 的资源按 anchorNodeId/localBounds 定位；资源缺失时保留绑定和透明占位并暴露风险。',
      'croppingPolicy=preserve-rendered-slice 时使用 renderedLocalBounds/renderedBounds 和实际文件画布尺寸，禁止压回 source bounds、二次旋转、cover 裁剪或改变宽高比。',
      '逐个对照截图检查 Logo、图标、装饰切片和分割线；分割线必须绑定真实源节点，并使用源方向、长度、颜色和透明度，禁止新增无绑定线条。',
    ]),
  }),
  interaction: Object.freeze({
    title: '动态交互',
    role: 'MasterGo 转 HTML workflow 中的“动态交互分析 AI”',
    focus: '整页可推导交互、状态、事件绑定、无障碍行为、静态降级和最小 JS 实现。',
    responsibilities: Object.freeze([
      '只实现节点、文字、样式状态或常见控件语义能够证明的交互，不扩展未知业务流程。',
      '逐类审阅 default、hover、focus-visible、active/pressed、selected/open、disabled/loading、transition 和 reduced-motion。',
      '导航、按钮、链接、筛选、分页和高置信度详情卡片保留可感知的 Web 状态反馈；未知 URL 使用安全占位，不删除交互语义。',
      '导航必须由可见且可聚焦的真实 link/button 与真实文字组成；禁止在导航截图上覆盖透明热区作为最终实现。复合导航图只可作为重建前的视觉参考或不含控件的装饰层。',
      '所有可见控件至少实现与设计一致的 hover、focus-visible、active/selected 状态；在 reduced-motion 下关闭非必要过渡。',
      '补齐键盘操作、focus 可见性、button/link 语义和必要 ARIA；普通静态内容不添加 pointer cursor 或伪交互。',
      '采用最小 JS、事件委托和静态降级；动效不得改变布局，且不能成为关键信息或唯一反馈。',
    ]),
  }),
  assembly: Object.freeze({
    title: '页面级组装',
    role: 'MasterGo 转 HTML workflow 中的“单页面组装 AI”',
    focus: '统一组件、资源、交互、布局、层级、响应式和文件组织，并完成冲突裁决。',
    responsibilities: Object.freeze([
      '把三个角色的检查结果合并成覆盖整页的一套实现，不简单拼接结论，也不把架构决定留给后续步骤。',
      '对节点归属、布局、资源路径、交互语义、层级和响应式冲突逐项裁决；证据不足时采用保守实现并记录复核风险。',
      '统一 index.html、styles.css、script.js、assets/ 的职责、CSS 变量、字体、排版、容器、断点、层级和命名。',
      '按页面实际顺序审阅区域衔接、背景连续性、重叠和滚动；共享组件只抽取真实重复结构。',
      'finalize 前必须在桌面、笔记本、平板和手机宽度进行真实渲染复核，确认主题视觉、导航、内容和页尾可见，无资源变形、遮挡、横向溢出或意外分割线。',
      '最终实现必须完整保留不可变文字、source/text/style/asset bindings，并通过本地静态、运行时和视觉复核。',
    ]),
  }),
})

export function getRoleGuidance(profile) {
  const guidance = ROLE_GUIDANCE[profile]
  if (!guidance) throw new Error(`Unknown role guidance profile: ${profile}`)
  return guidance
}

export function buildLegacyRolePromptLines(profile) {
  const guidance = getRoleGuidance(profile)
  return [
    `角色：你是 ${guidance.role}。`,
    '',
    `本角色重点：${guidance.focus}`,
    '',
    '分析方法：',
    ...guidance.responsibilities.map((item, index) => `${index + 1}. ${item}`),
    ...(profile === 'assembly' ? ['', `事实优先级：${FACT_PRECEDENCE}。`] : []),
  ]
}

export function buildAgentGenerationPlaybook({ target = 'web' } = {}) {
  const lines = [
    '# Agent v2 Generation Playbook',
    '',
    `version: ${ROLE_GUIDANCE_VERSION}`,
    `target: ${target}`,
    '',
    '本文件定义审阅与裁决方法，不是页面约束副本。页面硬约束只以 `agent/constraint-pack.md` 为准。',
    'draft 是实现起点，不是无需审阅的最终实现。不得从空文件重建页面。',
    '',
    '## 证据优先级',
    '',
    `${FACT_PRECEDENCE}。截图用于视觉复核，不能覆盖结构化硬事实。`,
  ]
  for (const profile of ROLE_ORDER) {
    const guidance = ROLE_GUIDANCE[profile]
    lines.push('', `## ${guidance.title}审阅`, '', `角色关注：${guidance.focus}`)
    for (const item of guidance.responsibilities) lines.push(`- ${item}`)
  }
  lines.push(
    '',
    '## 执行顺序',
    '',
    '1. 先审阅 `prototype-manifest.json`、`prototype-validation.json` 和 draft，确认文字、绑定、资源与 degradation 状态。',
    '2. 内部依次完成组件结构、静态资源和动态交互审阅；需要细节时使用 `agent-inspect` 定向取证。',
    '3. 内部完成页面级组装和冲突裁决，并按证据优先级选择保守实现。',
    '4. 将所有结论直接落实到 `agent/draft/index.html`、`styles.css`、`script.js`。',
    '5. 不生成角色计划、Assembly Markdown、JSON 代码信封或推理过程。',
    '6. finalize 前检查不可变文字、source/text/style/asset bindings、资源路径、语义、交互、响应式和本地文件引用；必须完成多视口真实渲染复核，不能只依据静态 validator 宣告完成。',
    '',
  )
  return lines.join('\n')
}

export function buildRoleGuidanceManifest({ target = 'web' } = {}) {
  const playbook = buildAgentGenerationPlaybook({ target })
  return {
    version: ROLE_GUIDANCE_VERSION,
    target,
    sha256: createHash('sha256').update(playbook).digest('hex'),
  }
}
