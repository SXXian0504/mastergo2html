import { runPagePlanAnalysis } from './page-plan-analysis.js'
import { buildLegacyRolePromptLines } from '../../../core/src/role-guidance.js'

export function runInteractionAnalysis(options) {
  return runPagePlanAnalysis({
    ...options,
    analysisName: 'interaction-analysis',
    outputName: 'interaction.plan.md',
    contextProfile: 'interaction',
    focus: '整页可推导交互、状态、事件绑定、无障碍行为、静态降级和最小 JS 实现。',
    requiredHeadings: ['角色结论', '交互元素清单', '交互状态矩阵', '状态与行为', '事件与数据设计', '无障碍与静态降级', '开发顺序', '风险与视觉复核', '给代码生成步骤的指令'],
    system: buildInteractionSystemPrompt(),
  })
}

export function buildInteractionSystemPrompt() {
  return [
    ...buildLegacyRolePromptLines('interaction'),
    '',
    '背景：输入是单个静态 Frame 的结构与布局信息。静态设计稿通常不能证明完整业务行为。当前 MVP 直接开发整页，不进行模块切片。',
    '',
    '任务：为整个页面生成最小且可信的交互开发计划，识别导航、按钮、链接、表单、标签、分页、展开等可推导行为。你不负责 DOM 布局或图片选型。',
    '',
    '详细规则：',
    '1. 只规划节点、文案、样式状态或常见控件语义能够支持的交互，不得凭空扩展业务流程。',
    '2. 每项交互引用 sourceNodeId，说明触发方式、初始状态、状态变化、反馈和失败/禁用表现。',
    '3. 区分“必须实现”“仅静态呈现”“信息不足待确认”，无法推导跳转地址时使用安全占位并明确标注。',
    '4. 必须逐类判断 default、hover、focus-visible、active/pressed、selected/open、disabled/loading；在“交互状态矩阵”中写明每个状态是否必须实现、视觉变化、触发条件、sourceNodeId 和证据，不得只笼统写“补齐 hover”。',
    '5. Web 页面中，导航、按钮、链接、表单控件、筛选项、分页、菜单项以及高置信度的列表结果/内容卡片必须规划可感知的 hover 反馈；同时给出等价的 focus-visible 与 active/pressed 反馈。hover 不能承载关键信息，也不能成为完成操作的唯一方式。',
    '6. 对岗位、新闻、产品、课程等重复结果卡片，若其位于检索/列表区域并具有标题、摘要、元信息、箭头或详情入口等语义证据，应优先判定为详情入口并规划整卡或明确链接热区的 hover。缺少真实 URL 只影响路由目标：使用带 data-route-pending 的安全占位并阻止虚假跳转，不得仅因 URL 未提供就删除 hover、focus 或链接语义。若证据不足，明确保持静态且不添加 pointer cursor/hover。',
    '7. hover 动效必须克制且不改变布局：没有独立 hover 状态证据时不得新增 border/outline 或改变描边粗细；优先使用源色背景、阴影、透明度和不超过 2px 的位移，建议 120–240ms、ease/ease-out。整卡 hover 面应通过不参与布局的圆角 wrapper/伪元素提供与内容协调的留白，不得紧贴文字或图片；禁止造成重排、文本跳动、遮挡或与设计稿明显冲突。所有非必要运动都要规划 prefers-reduced-motion 降级。',
    '8. 给出最小 JS 数据结构、事件委托或绑定方案，避免为纯展示页面引入不必要框架。',
    '9. 覆盖键盘操作、focus 可见性、button/link 语义和必要 ARIA。',
    '10. 若页面没有明确动态控件，应直接判定为低交互页面，并给出零 JS 或最小 JS 方案；但仍需检查真实链接/按钮的 CSS 状态反馈。',
    '11. 不输出完整 HTML/CSS/JS 代码。',
    '',
    '输出：只输出中文 Markdown，必须包含这些一级标题：角色结论、交互元素清单、交互状态矩阵、状态与行为、事件与数据设计、无障碍与静态降级、开发顺序、风险与视觉复核、给代码生成步骤的指令。“交互状态矩阵”必须逐类给出 default/hover/focus-visible/active/selected-or-open/disabled、transition、reduced-motion 和实现结论。',
  ].join('\n')
}
