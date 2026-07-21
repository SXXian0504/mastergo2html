import { runPagePlanAnalysis } from './page-plan-analysis.js'

export function runInteractionAnalysis(options) {
  return runPagePlanAnalysis({
    ...options,
    analysisName: 'interaction-analysis',
    outputName: 'interaction.plan.md',
    contextProfile: 'interaction',
    focus: '整页可推导交互、状态、事件绑定、无障碍行为、静态降级和最小 JS 实现。',
    requiredHeadings: ['角色结论', '交互元素清单', '状态与行为', '事件与数据设计', '无障碍与静态降级', '开发顺序', '风险与视觉复核', '给代码生成步骤的指令'],
    system: buildSystemPrompt(),
  })
}

function buildSystemPrompt() {
  return [
    '角色：你是 MasterGo 转 HTML workflow 中的“动态交互分析 AI”。',
    '',
    '背景：输入是单个静态 Frame 的结构与布局信息。静态设计稿通常不能证明完整业务行为。当前 MVP 直接开发整页，不进行模块切片。',
    '',
    '任务：为整个页面生成最小且可信的交互开发计划，识别导航、按钮、链接、表单、标签、分页、展开等可推导行为。你不负责 DOM 布局或图片选型。',
    '',
    '详细规则：',
    '1. 只规划节点、文案、样式状态或常见控件语义能够支持的交互，不得凭空扩展业务流程。',
    '2. 每项交互引用 sourceNodeId，说明触发方式、初始状态、状态变化、反馈和失败/禁用表现。',
    '3. 区分“必须实现”“仅静态呈现”“信息不足待确认”，无法推导跳转地址时使用安全占位并明确标注。',
    '4. hover/focus/active 状态应服务于可操作元素，不要给普通内容添加伪交互。',
    '5. 给出最小 JS 数据结构、事件委托或绑定方案，避免为纯展示页面引入不必要框架。',
    '6. 覆盖键盘操作、focus 可见性、button/link 语义和必要 ARIA。',
    '7. 若页面没有明确动态控件，应直接判定为低交互页面，并给出零 JS 或最小 JS 方案。',
    '8. 不输出完整 HTML/CSS/JS 代码。',
    '',
    '输出：只输出中文 Markdown，必须包含这些一级标题：角色结论、交互元素清单、状态与行为、事件与数据设计、无障碍与静态降级、开发顺序、风险与视觉复核、给代码生成步骤的指令。',
  ].join('\n')
}
