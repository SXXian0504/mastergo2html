# 紧凑圆角视觉面与 Hover 还原手册

用于 MasterGo 转 HTML 时稳定还原徽标、chip、状态标签、按钮、分段导航活动项，以及卡片 hover/focus 反馈。核心原则是：**以设计节点和状态证据为准，不补画设计稿中不存在的边框。**

## 1. 识别真正的视觉节点

文字节点通常只负责文案、字体和颜色；有色背景、圆角和描边往往属于它的父级 `Frame`、`Rectangle` 或组件状态层。

生成前必须同时检查：

- 文本节点及其最近的非文本父节点；
- `fills` 的颜色与 alpha；
- `strokes`、`strokeWeight`；
- `cornerRadius`；
- `bounds`、Auto Layout padding 和对齐；
- 是否存在独立的 active/hover/focus 状态节点或变体。

不能因为节点面积占整页比例很小，就丢弃 `68×24` 徽标、活动胶囊或类似紧凑视觉面。

## 2. HTML/CSS 绑定约束

实际承载视觉面的元素必须绑定父级视觉节点：

```html
<span class="news-tag news-tag--blue" data-style-source-node-id="114:70546">校招动态</span>
```

```css
.news-tag--blue {
  width: 68px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background-color: rgba(12, 112, 219, 0.1);
  border: 1px solid rgba(12, 112, 219, 0.4); /* 仅当源节点本身有 stroke */
  border-radius: 8px;
}
```

以下实现视为失败：

- 只绑定文字节点，最后只剩彩色文字；
- 输出空的 `data-asset-id` / `data-source-node-id` 容器，却没有 fill/background；
- 用透明空层替代源节点的有色底；
- 漏掉源圆角、源描边或描边 alpha；
- 把整体分段导航拆成多个互不关联的矩形。

## 3. 分段导航活动胶囊

分段导航要分别保留：

1. 整体外框；
2. 当前活动项的独立圆角底；
3. 文本与必要的内部分隔线；
4. 活动状态切换时胶囊的位置变化。

活动底必须绑定实际的 Frame/Rectangle 节点，并保留其 fill、宽高和 radius。切换时优先移动同一个活动底，避免复制多个不可审计的色块。

窄屏响应式必须把“视觉面”和“点击区”分开处理，同时优先继承桌面比例：

- 每个按钮仍占满自己的等分槽位和完整高度，保证点击热区稳定；
- 活动胶囊默认继续占满一个等分槽位的宽度，不因窄屏主观地同时缩窄、缩矮；
- 如果外框 SVG/PNG 的画布含透明留白，应读取实际可见描边边界，用该边界校准活动胶囊的 `top/height/radius`，而不是机械使用资源画布高度；若资源没有透明留白，则继续以源几何比例为准；
- `top/height/radius` 必须逐页来自源设计节点或资产可见边界，不得把某次人工修复得到的像素值（例如某个断点下的固定高度）提升为所有页面的默认值；
- 活动胶囊中心必须始终与选中按钮中心重合，不能用“胶囊自身宽度 × index”计算位移；
- 推荐按槽位中心设置 `left`，再使用 `translateX(-50%)` 居中，这样高度或宽度的证据化调整不会破坏三项对齐；
- 整体外框、源分隔线和文本位置保持不变，不新增任何边框；
- HTML 使用 `role="tablist"`/`role="tab"` 表达语义，并在整体控件上标记 `data-segmented-control`、独立活动视觉面上标记 `data-segmented-active-surface`，让运行时校验能稳定定位二者。

## 4. Hover / Focus：禁止发明边框

如果输入只有默认态，或没有独立 hover/focus 状态证据：

- **禁止新增 `border`、`outline` 或改变描边宽度/颜色；**
- 禁止把交互面收紧到文字和图片边缘；
- 禁止通过增加边框造成尺寸变化和布局抖动；
- 可使用设计体系已有的背景、阴影、透明度或不超过 `2px` 的轻微位移；
- focus 需要可见反馈，但也不能凭空补画设计稿中不存在的边框。

整卡需要更宽松的 hover/focus 面时，使用不参与布局的伪元素：

```css
.card {
  position: relative;
  isolation: isolate;
}

.card::before {
  content: "";
  position: absolute;
  z-index: 0;
  inset: -14px -18px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0);
  box-shadow: 0 0 0 rgba(0, 14, 38, 0);
  opacity: 0;
  pointer-events: none;
}

.card > * {
  position: relative;
  z-index: 1;
}

.card:hover::before,
.card:focus-visible::before {
  opacity: 1;
  background: rgba(255, 255, 255, 0.9);
  box-shadow: 0 10px 28px rgba(0, 14, 38, 0.12);
}
```

这里的圆角背景与阴影用于扩大交互留白，**没有新增边框或 outline**，也不会改变卡片原有排版尺寸。

## 5. 静态校验要求

对于标记为 `compactSurfaceRequired` 的节点，校验器应检查：

- 存在 `data-style-source-node-id` 绑定；
- background/fill 与源色及 alpha 一致；
- `border-radius` 与源值一致；
- 源节点有 stroke 时，边框颜色、alpha 和宽度一致；
- 源节点无 stroke 时，不得因 hover/focus 凭空新增边框或 outline。

注意：源节点明确存在的 stroke 应被保留；“禁止新增边框”指禁止创造设计稿及交互状态中不存在的边框。

## 6. QA 清单

- [ ] 徽标、chip、状态标签不再退化为纯文字。
- [ ] fill 颜色与透明度和设计稿一致。
- [ ] 圆角、宽高、padding、对齐一致。
- [ ] 源 stroke 被准确保留；无源 stroke 时没有新增边框。
- [ ] 分段导航整体外框和活动胶囊都存在。
- [ ] 活动项切换时胶囊同步移动。
- [ ] 依次切换每个选项后，活动胶囊中心与对应按钮中心误差不超过 `2px`。
- [ ] 活动胶囊始终位于整体外框内，宽度保持设计计划中的单槽位比例。
- [ ] 每个按钮仍覆盖完整等分槽位和控件高度，视觉胶囊缩放不缩小点击热区。
- [ ] `data-segmented-control` 与 `data-segmented-active-surface` 已分别标记整体控件和独立视觉面。
- [ ] hover/focus 面有合理留白与圆角，不紧贴文本或图片。
- [ ] hover/focus 不产生布局位移，不出现凭空添加的边框。
- [ ] 390 / 768 / 1280 / 1920 / 2560 视口复核视觉面和交互面。
