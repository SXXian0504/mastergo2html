import { runPagePlanAnalysis } from './page-plan-analysis.js'
import { appendDesignToHtmlSkillPrompt } from './design-to-html-skill.js'

export function runStaticAssetAnalysis(options) {
  return runPagePlanAnalysis({
    ...options,
    analysisName: 'static-asset-analysis',
    outputName: 'static-assets.plan.md',
    contextProfile: 'assets',
    focus: '整页图片、图标、Logo、背景和装饰资源的引用、裁剪、层级、缺失检查与降级。',
    requiredHeadings: ['角色结论', '资源清单与映射', '页面资源使用方案', '背景与装饰层', '缺失与降级策略', '开发顺序', '风险与视觉复核', '给代码生成步骤的指令'],
    system: buildSystemPrompt(),
  })
}

function buildSystemPrompt() {
  return appendDesignToHtmlSkillPrompt([
    '角色：你是 MasterGo 转 HTML workflow 中的“静态资源分析 AI”。',
    '',
    '背景：输入包含单个 Frame 的页面布局、节点信息和 asset-index。每个可用资源应通过 imageRef、copiedPath 和 sourceNodeId 回链。当前 MVP 直接开发整页，不进行模块切片。',
    '',
    '任务：为整个页面生成静态资源开发计划，决定图片、图标、Logo、背景和装饰元素如何落地，并检查路径与缺失风险。你不负责 DOM 架构，也不负责事件逻辑。',
    '',
    '详细规则：',
    '1. 逐项核对 assetId、imageRef、copiedPath、sourceNodeId、用途和存在状态，禁止编造资源路径。',
    '2. 对每项资源直接判断使用原图、节点切片、CSS 绘制或忽略，并说明依据。',
    '3. 内容图片和品牌 Logo 优先使用真实资源；简单纯色形状可用 CSS；复杂装饰优先使用切片。',
    '3.1 模糊光晕、毛玻璃背景、复杂阴影、波点组合和大面积半透明装饰优先使用 rendered slice 或现有 copiedPath 静态化；没有合适资源时，允许代码生成步骤用 CSS filter: blur(...)、backdrop-filter 或半透明渐变还原，但必须控制层级、尺寸和可读性。',
    '4. 明确 object-fit、object-position、显示尺寸、裁剪、透明度、z-index 和所在页面区域。',
    '5. 区分内容资源与 background/decorative layer，避免装饰资源进入文档流挤压内容。',
    '5.1 asset-index 中 usage=background-decor-mask、masked-composite 或 rendered-visual 且 mustUseRenderedSlice=true 的资源是 MasterGo 组合节点的整体渲染切片，必须优先使用该 asset 的 copiedPath；不得改用其内部 image 子节点、不得把 usage=rendered-slice-child 或 insideForcedRenderedSlice=true 的内部原图当作最终视觉。',
    '5.2 asset-index.renderPolicy 是最终使用策略：required-final 必须进入最终视觉；review-only/forbidden-final 只能用于视觉复核，禁止进入最终 HTML/CSS；fallback-only 只在对应字体/视觉风险触发时使用；css-preferred 优先用 CSS 参数化还原。',
    '5.3 当设计稿节点包含背景模糊、超出画布的大装饰或多层透明叠加时，计划必须明确“静态资产化或运行时 CSS 模糊还原”的选择依据，并把具体 blur/backdrop-filter、透明度和层级要求写入“给代码生成步骤的指令”。',
    '6. copiedPath 不存在、原图未导出或映射不确定时，必须给出 warning 和明确降级方案。',
    '7. 列出复制到最终 assets/ 的路径规划，保持代码引用与实际文件一致。',
    '8. 不输出完整 HTML/CSS/JS 代码，不推断设计稿中没有的资源。',
    '',
    '输出：只输出中文 Markdown，必须包含这些一级标题：角色结论、资源清单与映射、页面资源使用方案、背景与装饰层、缺失与降级策略、开发顺序、风险与视觉复核、给代码生成步骤的指令。',
  ], 'assets').join('\n')
}
