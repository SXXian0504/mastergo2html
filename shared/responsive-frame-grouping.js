export const MOBILE_FRAME_SUFFIX = '-移动端'

export function groupResponsiveFrames(frames, options = {}) {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('至少需要一个可见的顶层 Frame。')
  const pairingEnabled = options.pairingEnabled !== false
  const desktopMin = Number(options.desktopMin ?? 900)
  const mobileMax = Number(options.mobileMax ?? 767)
  const normalized = frames.map((frame, index) => ({
    ...frame,
    name: String(frame?.name || '').trim(),
    width: Number(frame?.width),
    height: Number(frame?.height),
    selectionIndex: Number.isInteger(frame?.selectionIndex) ? frame.selectionIndex : index,
  }))
  const invalid = normalized.filter((frame) => frame.type !== 'FRAME' || !frame.id || !frame.name)
  if (invalid.length > 0) {
    throw new Error(`多页面导出只支持有名称的可见顶层 Frame：${invalid.map(describeFrame).join('、')}`)
  }
  if (!pairingEnabled) return normalized.map(singleGroup).sort(bySelectionOrder)

  const byName = new Map()
  for (const frame of normalized) {
    const matches = byName.get(frame.name) || []
    matches.push(frame)
    byName.set(frame.name, matches)
  }
  const responsiveBaseNames = new Set(normalized
    .filter((frame) => frame.name.endsWith(MOBILE_FRAME_SUFFIX))
    .map((frame) => frame.name.slice(0, -MOBILE_FRAME_SUFFIX.length).trim()))
  const duplicates = [...byName.entries()].filter(([name, matches]) => matches.length > 1
    && (name.endsWith(MOBILE_FRAME_SUFFIX) || responsiveBaseNames.has(name)))
  if (duplicates.length > 0) {
    throw new Error(`存在重复 Frame 名称，无法确定页面配对：${duplicates.map(([name, matches]) => `${name}(${matches.map((item) => item.id).join(', ')})`).join('、')}`)
  }

  const consumed = new Set()
  const groups = []
  for (const mobile of normalized.filter((frame) => frame.name.endsWith(MOBILE_FRAME_SUFFIX))) {
    const baseName = mobile.name.slice(0, -MOBILE_FRAME_SUFFIX.length).trim()
    const desktop = byName.get(baseName)?.[0]
    if (!baseName || !desktop) throw new Error(`移动端 Frame 缺少同名桌面端：${describeFrame(mobile)}`)
    if (!Number.isFinite(desktop.width) || !Number.isFinite(mobile.width)
      || desktop.width < desktopMin || mobile.width > mobileMax || mobile.width >= desktop.width) {
      throw new Error(`响应式 Frame 尺寸不满足规则：${describeFrame(desktop)} / ${describeFrame(mobile)}；桌面端需 >= ${desktopMin}px，移动端需 <= ${mobileMax}px 且小于桌面端。`)
    }
    consumed.add(desktop.id)
    consumed.add(mobile.id)
    groups.push({
      kind: 'responsive-page',
      name: baseName,
      selectionIndex: Math.min(desktop.selectionIndex, mobile.selectionIndex),
      frames: [desktop, mobile],
      desktop,
      mobile,
    })
  }
  for (const frame of normalized) if (!consumed.has(frame.id)) groups.push(singleGroup(frame))
  return groups.sort(bySelectionOrder)
}

function singleGroup(frame) {
  return {
    kind: 'single-page',
    name: frame.name,
    selectionIndex: frame.selectionIndex,
    frames: [frame],
    frame,
  }
}

function bySelectionOrder(left, right) {
  return left.selectionIndex - right.selectionIndex || left.name.localeCompare(right.name)
}

function describeFrame(frame) {
  const size = Number.isFinite(frame?.width) ? `, ${frame.width}x${Number.isFinite(frame?.height) ? frame.height : '?'}` : ''
  return `${frame?.name || '<unnamed>'}(${frame?.id || 'missing-id'}${size})`
}
