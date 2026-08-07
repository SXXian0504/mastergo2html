# 装饰光晕 SVG 首次生成约束

本文是 MasterGo → HTML → React 链路的生成约束，适用于页面背景、卡片背景、Banner 和其他包含光晕、波点、模糊圆的装饰层。目标是首次生成即保留设计稿中的颜色覆盖面积、扩散范围和裁切关系，而不是生成后再通过 prompt 手调。

## 1. 典型失败与根因

### 失败症状

- 光晕颜色占比明显偏低，大面积变白。
- 光晕核心位置大致正确，但扩散范围缩小。
- 卡片或页面宽高改变后，SVG 被组件宽度继续压缩。
- 整个背景被导出为一张 PNG，无法独立调整光晕与波点。

### 根因

MasterGo 的模糊椭圆 SVG 可能同时包含两套尺寸：

```svg
<svg width="192" height="192" viewBox="0 0 1212 1212">
  <filter><feGaussianBlur stdDeviation="127.5"/></filter>
  ...
</svg>
```

`width/height=192` 是 nominal 几何主体，`viewBox=1212×1212` 才是包含 filter bleed 的完整透明画布。若 asset-index 或 CSS 使用 192×192，浏览器会把完整 1212×1212 画布压缩，导致光晕变小、变淡。

第二个根因是资源选择错误：背景组虽然名为“整体导出”，但其内容仅由底色、多个独立光晕和波点蒙版组成时，本质上是可拆分装饰背景。使用整组 PNG 会丢失可调性，也会让响应式裁切和局部定位失真。

## 2. 首次生成资源决策

按以下优先级执行：

1. **可拆分背景**：CSS 底色/渐变 + 独立光晕 SVG + 独立波点/蒙版切片。
2. **简单独立光晕**：`ELLIPSE`、无文字、非图片填充、可见效果全部为 `LAYER_BLUR`，导出 required-final SVG。
3. **波点/蒙版组合**：按最小独立组合导出透明 PNG，不扩大为整页背景 PNG。
4. **复杂效果**：毛玻璃、背景模糊、多种阴影或无法安全拆分的混合效果使用 required-final PNG。
5. **CSS 降级**：只有输入包缺少可用资源时，才用 CSS blur/gradient 临时还原。

“可拆分背景装饰组”的安全识别条件：

- 容器名称同时包含背景语义（`bg/background/背景`）与整体导出语义（`整体导出/整体显示`）；
- 无可见文字后代；
- 至少包含两个独立光晕，或包含至少一个独立光晕和一个波点/蒙版子组。

普通业务组件、Logo、复杂蒙版卡片即使名称包含“整体导出”，也不能套用此例外。

## 3. SVG 画布解析

- 同时读取根 `<svg>` 的 `width`、`height`、`viewBox`。
- 普通 icon/logo 优先保持作者声明的 `width/height`。
- SVG 包含 `filter`、`feGaussianBlur` 或 `feDropShadow`，且 `viewBox` 明显大于 `width/height` 时，以 `viewBox` 宽高作为导出画布。
- 使用完整画布与 `absoluteRenderBounds`/`renderBounds` 推导 `renderedBounds` 和 `renderedLocalBounds`，禁止压回 `sourceBounds/localBounds`。
- 父层只负责建立坐标系与裁切；不能通过缩放子 SVG 达到裁切效果。

## 4. HTML/CSS 实现模板

```html
<section class="hero" data-source-node-id="hero-node">
  <div class="hero__decor" aria-hidden="true">
    <img
      class="hero__glow hero__glow--red"
      src="assets/decorative/red-glow.svg"
      data-asset-id="red_glow"
      data-source-node-id="red-glow-node"
      alt=""
    >
    <img class="hero__dots" src="assets/decorative/dots.png" alt="">
  </div>
  <div class="hero__content">...</div>
</section>
```

```css
.hero {
  position: relative;
  isolation: isolate;
}

.hero__decor {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
}

.hero__glow {
  position: absolute;
  display: block;
  flex: none;
  max-width: none;
  pointer-events: none;
}

.hero__glow--red {
  left: 1281px;
  top: -279px;
  width: 1212px;
  height: 1212px;
}

.hero__content {
  position: relative;
  z-index: 1;
}
```

禁止以下实现：

```css
.glow {
  width: 100%;
  height: 100%;
  max-width: 100%;
  object-fit: cover;
  inset: 0;
  background-size: cover;
}
```

也禁止用 Flex/Grid 自动对齐光晕、使用 `right/bottom/%/vw/vh` 近似源坐标，或在断点中重新缩放光晕。

## 5. 静态验收

对 required-final filter-bleed SVG 必须检查：

- 使用 asset-index 的 `copiedPath`，并绑定 `data-asset-id` 与源节点 ID。
- `position:absolute`。
- `left/top/width/height` 精确采用 `renderedLocalBounds`。
- 明确 `flex:none`（或等价 `flex-shrink:0`）和 `max-width:none`。
- 不使用 `object-fit:cover`、`background-size:cover`、`inset:0`、百分比宽高。
- 同一源节点不再用 CSS blur、shadow、gradient 或色块重复绘制。
- 在设计稿基准视口对比颜色覆盖面积、光晕核心、扩散 bleed、波点位置和父层裁切边界。

## 6. React 迁移约束

HTML → React 时以上属性属于不可变视觉事实：

- 资源搬迁只能改 import/src，不得改变 SVG 文件、viewBox 或 CSS 画布尺寸。
- CSS Modules、SCSS、Tailwind reset 和全局 `img { max-width: 100% }` 不得覆盖 `max-width:none` 与 `flex:none`。
- 组件化不得新增会改变 source coordinate system 的 positioned wrapper。
- 响应式只能由父装饰层裁切或按计划隐藏，不能重新 cover、缩放或流式排列光晕。
