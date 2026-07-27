const SKILL_SECTIONS = {
  layout: [
    '设计稿转 HTML 短规则 - 布局关系：描述元素关系、约束和规则，不机械复刻 MasterGo 坐标。普通内容、文本、按钮、列表、卡片、表单、导航优先使用文档流/Flex/Grid；absolute 只用于背景装饰、浮层、蒙层、吸附和有证据的重叠。',
    '间距与对齐必须基于相邻元素、容器内边距、组内/组间节奏和设计 token 表达；不得把大面积背景层、装饰矩形、蒙版 bounds 或 y/height 差值转成内容 padding/margin/min-height。',
    '尺寸只固定真正固定项，其余用 fill、min/max、等分、内容撑开、aspect-ratio 和容器约束表达；按钮宽度由文字和 padding 决定，图片按容器比例 cover/contain。',
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

