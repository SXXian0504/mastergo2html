export const DEFAULT_GENERATION_TARGET = 'web'
export const APP_GENERATION_TARGET = 'app'

const APP_RULES = {
  layout: [
    'App 页面模式规则（优先级高于通用 PC/网页响应式规则）：当前 Frame 是移动 App 页面基准画布，不得按桌面网页扩展或改造成 PC 导航、多栏布局。',
    '以源 Frame 的 width/height 作为移动基准 viewport；保留屏幕内模块、卡片、浮层、底栏和装饰的源 bounds 与层级。桌面浏览器仅作为居中预览容器，不得对整页等比缩放。',
    '明确区分页面内容、App 顶部导航、状态栏占位、底部 Tab/操作栏与浮层。只有节点位置和语义有证据时才判定 fixed/sticky；不得凭空补充系统状态栏、刘海或原生导航。',
    'App 页面默认按单列和触控场景规划，不生成 PC 断点重排；窄屏差异优先通过安全裁剪、内容换行和局部滚动处理。',
  ],
  component: [
    'App 页面模式规则：组件结构必须以移动屏幕和触控操作为基准，保持顶部栏、内容滚动区、底部栏/浮层之间的独立层级，禁止套用桌面网页 Header/Main/Footer 或多栏容器模板。',
    '小图标和紧凑控件保持设计稿可见尺寸；需要扩大触控热区时使用透明包裹层或伪元素，不能改变视觉 bounds、间距和对齐。',
  ],
  assets: [
    'App 页面模式规则：图片、图标、启动区装饰和底栏资源必须按移动 Frame 内的源 bounds、裁剪与像素密度事实使用；不得因为桌面预览而拉伸到大屏、改成全宽 Banner 或使用 PC cover 逻辑。',
  ],
  interaction: [
    'App 页面模式规则：交互优先覆盖 tap/press/active、滚动、返回、Tab 切换、弹层和输入焦点；不得依赖 hover 才能看到关键信息。仍需保留键盘 focus 与 button/link 语义，未知原生能力不得虚构。',
    '触控目标建议至少 44×44 CSS px；当视觉图标更小时，通过不改变视觉布局的命中区扩展实现。',
  ],
  assembly: [
    'App 页面模式规则（覆盖通用 PC 优先规则）：组装结果必须是移动 App 页面 HTML 预览。使用源 Frame 宽度作为基准画布，宽屏时居中显示，窄屏时填满可用宽度，不生成桌面多栏版或另一套 DOM。',
    '必须裁决顶部栏、可滚动内容区、底部固定/粘性区域和弹层的层级；如底栏固定，内容区必须预留等量底部空间，不能遮挡最后一屏内容。',
    '安全区只在设计稿确有系统栏/底部手势区语义时使用 env(safe-area-inset-*），并避免与设计稿已经包含的状态栏高度重复相加。',
  ],
  html: [
    'App 页面模式规则（覆盖通用 PC 优先规则）：最终仍输出原生 index.html、styles.css、script.js，但页面按移动 App 画布实现。index.html 必须包含 width=device-width、initial-scale=1 的 viewport meta。',
    '使用源 Frame 宽度作为 App shell 基准：宽屏浏览器中居中预览，视口小于基准宽度时使用可用宽度；禁止把页面拉伸成桌面站点、生成 PC 多栏断点或对整页 transform:scale。',
    '页面高度和固定区域优先使用 100dvh/min-height:100dvh，并提供 100vh 兼容回退；禁止锁死 body 导致内容不可滚动。固定底栏必须为内容预留空间，键盘/窄屏下不能遮挡主要操作。',
    '顶部导航、状态栏占位、底部 Tab/操作栏、弹层和内容滚动区必须建立清晰 stacking context。只有设计稿事实支持时才使用 fixed/sticky，不得补画不存在的系统 UI。',
    '交互不得依赖 hover；触控热区可扩展到至少 44×44 CSS px，但不得改变图标、文字和控件的可见尺寸或源坐标。不得通过 user-scalable=no 或 maximum-scale=1 禁止用户缩放。',
  ],
}

export function resolveGenerationTarget(value) {
  const options = value && typeof value === 'object' && value.exportOptions && typeof value.exportOptions === 'object'
    ? value.exportOptions
    : value
  return options?.targetPlatform === APP_GENERATION_TARGET ? APP_GENERATION_TARGET : DEFAULT_GENERATION_TARGET
}

export function isAppGenerationTarget(value) {
  return resolveGenerationTarget(value) === APP_GENERATION_TARGET
}

export function buildGenerationTargetPrompt(workflow, value) {
  if (!isAppGenerationTarget(value)) return ''
  return (APP_RULES[workflow] || []).join('\n')
}

export function appendGenerationTargetPrompt(system, workflow, value) {
  const prompt = buildGenerationTargetPrompt(workflow, value)
  return prompt ? `${system}\n\n${prompt}` : system
}

export function appTargetContext(value) {
  return isAppGenerationTarget(value) ? { targetPlatform: APP_GENERATION_TARGET } : {}
}
