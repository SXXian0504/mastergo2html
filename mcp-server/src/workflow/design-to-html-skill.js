const SKILL_SECTIONS = {
  layout: [
    '设计稿转 HTML 短规则 - 布局关系：高保真还原优先。Magic DSL、插件 00-input 和带 absoluteBoundingBox/layoutStyle/flexContainerInfo 的输入必须先按设计稿坐标、尺寸、层级和 Auto Layout 事实还原；只有节点事实明确存在 flex/grid/flow 关系，或为响应式降级需要时，才把普通内容转为文档流/Flex/Grid。不得为了“语义化”牺牲首屏、表格、侧边栏、叠层、精确控件和图标位置。',
    '间距与对齐必须基于相邻元素、容器内边距、组内/组间节奏和设计 token 表达；不得把大面积背景层、装饰矩形、蒙版 bounds 或 y/height 差值转成内容 padding/margin/min-height。',
    '尺寸只固定真正固定项，其余用 fill、min/max、等分、内容撑开、aspect-ratio 和容器约束表达；按钮宽度由文字和 padding 决定，图片按容器比例 cover/contain。',
    '重叠模块必须服从源绘制顺序：上下层都建立独立 stacking context，后绘制层的数值 z-index 严格更高；Hero 不得盖住与其重叠的内容面板背景、圆角或正文。',
  ],
  responsive: [
    '设计稿转 HTML 短规则 - 响应式与溢出：先还原 PC，移动端只描述相对 PC 的差量；768px 以下多栏改上下堆叠、网格减列、次要信息换行/折叠，不写两套 DOM，不做整页等比缩小。',
    'Header/Nav 移动端硬规则：导航必须选择“完整换行/纵向排列”或“桌面导航整体隐藏并提供可见菜单触发器”之一；隐藏导航时其父容器、占位层、固定高度、min-height、padding 和 margin 必须同步折叠。窄屏 Header 高度必须由可见内容撑开，不得在 Logo 与导航之间保留桌面坐标造成的大块空白带。源导航为单一圆角横向分段控件且 390px 可容纳标签时，必须保留整体外框和活动胶囊，不得拆成矩形或纵向堆叠；窄屏保持桌面等分比例，按外框可见边界校准，禁止无据缩窄缩矮；top/height/radius 必须有设计/资产证据，不得复用单页像素常量。按钮覆盖完整槽位且与胶囊同心；整体和活动面分别标记 data-segmented-control、data-segmented-active-surface。菜单按钮可去静态边框/底色，但保留 focus-visible 轮廓。',
    'Header/Nav 中间视口硬规则：769px 到设计基准宽度之间从 source absolute 降级时必须成组切换：header inner 改为 Flex，Logo 重置 static/flex:none，Nav 重置 static 并用 margin-left:auto 保持右对齐；禁止只把 Nav 改为 static 而父层仍非 Flex。Nav 声明宽度必须容纳全部 item 与 gap。必检 769/1024/1280/1440/1600：brand.right < nav.left、nav.right <= inner.right、scrollWidth <= clientWidth + 2；断点必须覆盖 1280，禁止 max-width:1279px 造成 1280px 断点空洞。',
    'Footer 宽屏硬规则：Footer 外层背景必须全宽，内容必须放在居中的流式/max-width inner 容器中；不得把普通链接、版权、友情链接或社交入口直接用视口级 absolute left/right 锚定。大于设计稿基准宽度时保持内容组整体居中和同一栅格，不得把少量链接甩到屏幕远端形成孤岛。',
    '断点覆盖硬规则：响应式覆盖必须写在所有基础规则和 data-source/data-text 精确绑定规则之后，或具有足够明确的选择器；断点内必须显式重置 position/left/right/top/width/height/min-height/white-space 等会维持桌面几何的属性，禁止基础 source-bounds 规则在级联顺序上反向覆盖移动端。',
    '移动卡片流式排版硬规则：桌面用 absolute 定位的徽标/tag 与标题在窄屏转为正常流时必须一起重置。若标题改为 relative/static，徽标也必须改为 relative/static，并用 flex/grid/gap/margin 保留垂直间距；禁止徽标继续 absolute 覆盖标题首行。',
    '纵向滚动硬规则：页面只保留 html/body 一个纵向滚动根，page-shell/main/content 等结构容器不得设置 overflow-y:auto/scroll 形成嵌套滚动条。嵌入式预览需要隐藏页面内侧滚动条时，只隐藏 scrollbar 视觉，仍须保留滚轮、触控和键盘滚动。absolute/fixed 装饰裁切层若使用 overflow-x:hidden，必须同步显式设置 overflow-y:hidden/clip；否则另一轴会计算为 auto，装饰层会意外生成内侧滚动条。',
    '所有可能超出的内容必须有策略：单行或多行文本省略/换行，chip 自动换行，长列表/表格局部滚动，页面本身保持正常纵向滚动，避免非预期横向滚动。Header、Nav、Footer 的结构容器不得依靠 overflow:hidden 掩盖仍为桌面宽度的子元素；其 scrollWidth 必须与可用宽度一致。',
    'Web 页面默认遵循 `mastergo2html.responsive-contract.v1`：验收视口为 390/768/1280/1920/2560，必检模块为 Header/Nav/Main/Footer，页面与普通组件禁止横向滚动，超宽屏 Header/Footer 外层全宽且普通内容组保持居中。',
  ],
  state: [
    '设计稿转 HTML 短规则 - 状态稳定：静态稿只代表一个尺寸和默认态；计划必须补充 hover/focus/active/disabled/loading/empty/error、最长/最短文案、图片失败和多语言变长时的布局表现。',
    '加载骨架、空态占位、数字位数变化、按钮/标签变长和图片失败不得造成关键容器高度跳动、点击热区缩小或内容挤破布局。',
    '紧凑圆角视觉面不可丢失：徽标、chip、状态标签、按钮和分段导航活动项若由非文本 Frame/Rectangle 的 SOLID fill、stroke、cornerRadius 与 bounds 构成，必须保留整个容器并绑定其 sourceNodeId；禁止退化为只有彩色文字或透明空层。',
    'Hover 不得发明设计语言：没有独立 hover 状态证据时，禁止新增 border/outline 或改变描边粗细。整卡反馈需要留白时用不参与布局的圆角 wrapper/伪元素扩大视觉面，优先背景、阴影、透明度或不超过 2px 位移，不能紧贴文字和图片。',
  ],
  assets: [
    '设计稿转 HTML 短规则 - 素材交付：图标和简单图形优先 SVG，保留 viewBox，单色图标用 currentColor/颜色变量；照片、复杂材质和不可拆分的真实合成使用 asset-index 中的 PNG/切片资源。可拆分背景必须使用底色/渐变、独立光晕 SVG、独立波点/蒙版切片分层实现，禁止使用整页或整组背景 PNG。',
    'SVG/PNG 装饰画布硬约束：光晕、波点、模糊圆、阴影等装饰资源不得只按设计节点的 nominal width/height 缩放；使用前必须读取文件真实 width、height、viewBox 及 filter/blur 扩散范围，按完整 SVG 画布或 asset-index 的 renderedLocalBounds/source bounds 决定 CSS 尺寸。若 PNG 已被 clipsContent Frame 预裁切，renderedLocalBounds 取 absoluteRenderBounds 与裁切祖先边界的交集左上角，不得再围绕完整 render bounds 中心对齐。真实画布尺寸与节点尺寸不一致时，必须保留画布比例和视觉 bleed，不能把 996×996 画布压回 304×304 主体尺寸。',
    '装饰图片抗压缩硬约束：需要超出父容器并由 overflow 裁切的 SVG/PNG 必须 position:absolute，并显式设置 renderedLocalBounds 对应的 left、top、width、height、flex:none、max-width:none；父装饰层负责 overflow 裁切。不得被全局 img{max-width:100%}、flex-shrink、object-fit:cover、background-size:cover、inset:0 或 width/height:100% 二次压缩。光晕、波点等必须在基准视口截图中复核颜色覆盖面积、核心位置和裁切边界。',
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
