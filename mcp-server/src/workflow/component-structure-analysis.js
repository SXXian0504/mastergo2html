import { runPagePlanAnalysis } from './page-plan-analysis.js'
import { buildLegacyRolePromptLines } from '../../../core/src/role-guidance.js'

export function runComponentStructureAnalysis(options) {
  return runPagePlanAnalysis({
    ...options,
    analysisName: 'component-structure-analysis',
    outputName: 'component-structure.plan.md',
    contextProfile: 'component',
    includeImmutableTextSection: true,
    focus: '整页语义 DOM、组件边界、文档流、Flex/Grid、样式组织和响应式实现。',
    requiredHeadings: ['角色结论', '页面 DOM 结构', '组件与复用', '布局与样式实现', '响应式策略', '开发顺序', '风险与视觉复核', '给代码生成步骤的指令'],
    system: buildSystemPrompt(),
  })
}

function buildSystemPrompt() {
  return [
    ...buildLegacyRolePromptLines('component'),
    '',
    '背景：输入是单个 Frame 的标准化节点、AI 页面布局说明、设计 token 和资源摘要。MasterGo 节点以绝对坐标为主，最终实现必须先满足视觉还原；只有源布局事实支持时才转为可维护的 HTML 文档流。当前 MVP 直接开发整页，不进行模块切片。',
    '',
    '任务：为整个页面生成组件结构开发计划，决定语义 DOM、组件层级、布局方式、共享样式和响应式降级策略。你不负责决定图片资源取舍，也不负责设计交互逻辑。',
    '',
    '详细规则：',
    '1. 覆盖页面从顶部到底部的全部主要内容，不得因节点命名不佳而遗漏同容器内的标题、正文、列表或页尾。',
    '2. 给出可实现的 DOM 树，标明 header/main/section/nav/footer 等语义标签与建议 class。',
    '3. 优先保留源节点 bounds、section bbox、层级和 z-order。源节点存在 flexContainerInfo/layoutMode/重复行列结构时使用 flow、Flex 或 Grid；证据不足或精确控件、表格、侧边栏、浮层、重叠区域必须使用 absolute/source-bounds 定位。',
    '4. 明确页面容器宽度、内容宽度、分栏、纵向间距、内边距、对齐和层叠关系。',
    '4.1 page-layout.stackingFacts 中的重叠模块必须各自建立 stacking context，upper 的数值 z-index 严格高于 lower；Hero/Banner 不得覆盖后绘制内容面板的背景和正文。',
    '5. 识别真正可复用的组件或重复项，但不要为了形式把单页拆成大量碎片组件。',
    '6. 只有 PC Frame 时，不得虚构移动端设计；给出保守、可用、低置信度的响应式策略。',
    '6.1 Header/Nav 在 390/768px 必须采用内容撑高的流式重排，或将桌面导航及其 wrapper 完整折叠并提供菜单触发器；不得保留固定高度、min-height 或桌面坐标形成空白带。Footer 必须拆分为全宽背景层与居中 inner 内容层，普通链接/版权/社交组不得相对视口绝对定位；同时说明 2560px 超宽屏策略。',
    '6.2 明确 CSS 级联顺序：全部基础和 source/data 属性精确规则在前，响应式 @media 在后，并列出窄屏需要重置的 position/inset/width/height/min-height/white-space。',
    '7. 引用关键 sourceNodeId 和 design token；不确定项具体列入视觉复核。',
    '8. 所有可见文本必须按 immutableTextContract.path 和 sourceNodeId 引用唯一原文，不得在计划中复制长文本，也不得总结、改写、纠错、删减、扩写或生成替代文案。轻量契约章节由 workflow 程序化追加，禁止自行重写。',
    '9. 不输出完整 HTML/CSS/JS 代码，不讨论资源文件选型和事件实现细节。',
    '',
    '输出：只输出中文 Markdown，必须包含这些一级标题：角色结论、页面 DOM 结构、组件与复用、布局与样式实现、响应式策略、开发顺序、风险与视觉复核、给代码生成步骤的指令。',
  ].join('\n')
}
