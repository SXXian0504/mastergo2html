const SKILL_SECTIONS = {
  layout: [
    '设计稿转 HTML 短规则 - 布局关系：高保真还原优先。Magic DSL、插件 00-input 和带 absoluteBoundingBox/layoutStyle/flexContainerInfo 的输入必须先按设计稿坐标、尺寸、层级和 Auto Layout 事实还原；只有节点事实明确存在 flex/grid/flow 关系，或为响应式降级需要时，才把普通内容转为文档流/Flex/Grid。不得为了“语义化”牺牲首屏、表格、侧边栏、叠层、精确控件和图标位置。',
    '间距与对齐必须基于相邻元素、容器内边距、组内/组间节奏和设计 token 表达；不得把大面积背景层、装饰矩形、蒙版 bounds 或 y/height 差值转成内容 padding/margin/min-height。',
    '尺寸只固定真正固定项，其余用 fill、min/max、等分、内容撑开、aspect-ratio 和容器约束表达；按钮宽度由文字和 padding 决定，图片按容器比例 cover/contain。',
    '重叠模块必须服从源绘制顺序：上下层都建立独立 stacking context，后绘制层的数值 z-index 严格更高；Hero 不得盖住与其重叠的内容面板背景、圆角或正文。',
  ],
  responsive: [
    '设计稿转 HTML 短规则 - 响应式与溢出：先还原 PC，移动端只描述相对 PC 的差量；768px 以下多栏改上下堆叠、网格减列、次要信息换行/折叠，不写两套 DOM，不做整页等比缩小。',
    '所有可能超出的内容必须有策略：单行或多行文本省略/换行，chip 自动换行，长列表/表格局部滚动，页面本身保持正常纵向滚动，避免非预期横向滚动。',
  ],
  state: [
    '设计稿转 HTML 短规则 - 状态稳定：静态稿只代表一个尺寸和默认态；计划必须补充 hover/focus/active/disabled/loading/empty/error、最长/最短文案、图片失败和多语言变长时的布局表现。',
    '加载骨架、空态占位、数字位数变化、按钮/标签变长和图片失败不得造成关键容器高度跳动、点击热区缩小或内容挤破布局。',
  ],
  assets: [
    '设计稿转 HTML 短规则 - 素材交付：图标和简单图形优先 SVG，保留 viewBox，单色图标用 currentColor/颜色变量；照片、复杂材质、真实切片和复杂背景使用 asset-index 中的 PNG/切片资源。',
    '圆角、阴影、描边、纯色块、简单渐变和可参数化效果优先用 CSS，不切图；资源命名、sourceNodeId、assetId 和 copiedPath 必须可回链，不得编造路径。',
    'Banner 前景图标/装饰按 source-bounds 的 px left/top/width/height 锚定，禁止百分比漂移；缺失字体的大标题优先使用对应 rendered text fallback，原文仅作无障碍隐藏文本。',
  ],
}

const WORKFLOW_SECTIONS = {
  layout: ['layout', 'responsive'],
  component: ['layout', 'responsive'],
  assets: ['assets', 'layout'],
  interaction: ['state', 'responsive'],
  assembly: ['layout', 'responsive', 'state', 'assets'],
  html: ['layout', 'responsive', 'state', 'assets'],
}

export function isDesignToHtmlSkillEnabled(env = process.env) {
  return env.DESIGN_TO_HTML_SKILL_ENABLED !== 'false'
}

export function buildDesignToHtmlSkillPrompt(workflow, { env = process.env } = {}) {
  if (!isDesignToHtmlSkillEnabled(env)) return ''
  const sectionNames = WORKFLOW_SECTIONS[workflow] || []
  const lines = sectionNames.flatMap((name) => SKILL_SECTIONS[name] || [])
  return [...new Set(lines)].join('\n')
}

export function appendDesignToHtmlSkillPrompt(lines, workflow, options = {}) {
  const skillPrompt = buildDesignToHtmlSkillPrompt(workflow, options)
  if (!skillPrompt) return lines
  return [...lines, '', skillPrompt]
}
