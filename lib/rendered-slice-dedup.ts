import type { AssetSourceNode } from '../messages/sender'

type ParentNode = {
  id: string
}

export function removeDescendantForcedSlices<T extends AssetSourceNode, N extends ParentNode>(
  sources: T[],
  parentById: Map<string, N | null>,
): T[] {
  const namedWholeNodeIds = new Set(sources
    .filter(isRequiredWholeNodeSlice)
    .map((source) => source.nodeId))
  const maskedSourceIds = new Set(sources
    .filter(isRequiredMaskedCompositeSlice)
    .map((source) => source.nodeId))
  const retainedMaskedSourceIds = new Set(
    sources
      .filter(isRequiredMaskedCompositeSlice)
      .filter((source) => !hasMaskedCompositeDescendant(source.nodeId, maskedSourceIds, parentById))
      .map((source) => source.nodeId),
  )

  // Only a parent that is guaranteed to be the final visual may replace descendants.
  // Review/fallback/CSS assets are references, so suppressing their child logo/icon would
  // leave the final HTML without a usable resource when the parent itself is hidden.
  const finalReplacementIds = new Set<string>([...namedWholeNodeIds, ...retainedMaskedSourceIds])
  for (const source of sources) {
    if (source.usageHint !== 'masked-composite' && source.renderPolicy === 'required-final') {
      finalReplacementIds.add(source.nodeId)
    }
  }

  return sources.filter((source) => {
    if (source.wholeNodePng) {
      return !hasAncestorInSet(source.nodeId, namedWholeNodeIds, parentById)
    }
    if (isRequiredMaskedCompositeSlice(source) && !retainedMaskedSourceIds.has(source.nodeId)) {
      return false
    }
    return !hasAncestorInSet(source.nodeId, finalReplacementIds, parentById)
  })
}

function isRequiredWholeNodeSlice(source: AssetSourceNode): boolean {
  return source.wholeNodePng === true && source.renderPolicy === 'required-final'
}

function isRequiredMaskedCompositeSlice(source: AssetSourceNode): boolean {
  return source.usageHint === 'masked-composite'
    && source.renderPolicy === 'required-final'
    && source.wholeNodePng !== true
}

function hasAncestorInSet<N extends ParentNode>(
  sourceId: string,
  ancestorIds: Set<string>,
  parentById: Map<string, N | null>,
): boolean {
  let parent = parentById.get(sourceId) ?? null
  while (parent) {
    if (ancestorIds.has(parent.id)) return true
    parent = parentById.get(parent.id) ?? null
  }
  return false
}

function hasMaskedCompositeDescendant<N extends ParentNode>(
  sourceId: string,
  maskedSourceIds: Set<string>,
  parentById: Map<string, N | null>,
): boolean {
  for (const maskedSourceId of maskedSourceIds) {
    if (maskedSourceId === sourceId) continue
    let parent = parentById.get(maskedSourceId) ?? null
    while (parent) {
      if (parent.id === sourceId) return true
      parent = parentById.get(parent.id) ?? null
    }
  }
  return false
}
