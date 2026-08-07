import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDesignToHtmlSkillPrompt, isDesignToHtmlSkillEnabled } from '../src/workflow/design-to-html-skill.js'

test('design-to-html skill injects workflow-specific compact rules', () => {
  const layoutPrompt = buildDesignToHtmlSkillPrompt('layout', { env: {} })
  assert.match(layoutPrompt, /布局关系/)
  assert.match(layoutPrompt, /响应式与溢出/)
  assert.doesNotMatch(layoutPrompt, /素材交付/)

  const assetPrompt = buildDesignToHtmlSkillPrompt('assets', { env: {} })
  assert.match(assetPrompt, /素材交付/)
  assert.match(assetPrompt, /SVG\/PNG 装饰画布硬约束/)
  assert.match(assetPrompt, /真实 width、height、viewBox/)
  assert.match(assetPrompt, /flex:none、max-width:none/)
  assert.match(assetPrompt, /颜色覆盖面积/)
  assert.match(assetPrompt, /布局关系/)
  assert.doesNotMatch(assetPrompt, /状态稳定/)

  const htmlPrompt = buildDesignToHtmlSkillPrompt('html', { env: {} })
  assert.match(htmlPrompt, /布局关系/)
  assert.match(htmlPrompt, /响应式与溢出/)
  assert.match(htmlPrompt, /Header\/Nav 移动端硬规则/)
  assert.match(htmlPrompt, /Header\/Nav 中间视口硬规则/)
  assert.match(htmlPrompt, /margin-left:auto/)
  assert.match(htmlPrompt, /禁止只把 Nav 改为 static/)
  assert.match(htmlPrompt, /769\/1024\/1280\/1440\/1600/)
  assert.match(htmlPrompt, /断点空洞/)
  assert.match(htmlPrompt, /保持桌面等分比例/)
  assert.match(htmlPrompt, /外框可见边界/)
  assert.match(htmlPrompt, /按钮覆盖完整槽位/)
  assert.match(htmlPrompt, /data-segmented-control/)
  assert.match(htmlPrompt, /data-segmented-active-surface/)
  assert.match(htmlPrompt, /不得复用单页像素常量/)
  assert.match(htmlPrompt, /Footer 宽屏硬规则/)
  assert.match(htmlPrompt, /断点覆盖硬规则/)
  assert.match(htmlPrompt, /移动卡片流式排版硬规则/)
  assert.match(htmlPrompt, /页面只保留 html\/body 一个纵向滚动根/)
  assert.match(htmlPrompt, /overflow-x:hidden/)
  assert.match(htmlPrompt, /装饰层会意外生成内侧滚动条/)
  assert.match(htmlPrompt, /禁止徽标继续 absolute 覆盖标题首行/)
  assert.match(htmlPrompt, /mastergo2html\.responsive-contract\.v1/)
  assert.match(htmlPrompt, /390\/768\/1280\/1920\/2560/)
  assert.match(htmlPrompt, /状态稳定/)
  assert.match(htmlPrompt, /紧凑圆角视觉面不可丢失/)
  assert.match(htmlPrompt, /禁止新增 border\/outline/)
  assert.match(htmlPrompt, /圆角 wrapper\/伪元素/)
  assert.match(htmlPrompt, /素材交付/)
  assert.equal(htmlPrompt.length < 4100, true)
})

test('design-to-html skill can be disabled by env for token comparisons', () => {
  const env = { DESIGN_TO_HTML_SKILL_ENABLED: 'false' }
  assert.equal(isDesignToHtmlSkillEnabled(env), false)
  assert.equal(buildDesignToHtmlSkillPrompt('html', { env }), '')
})

