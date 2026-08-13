export type ResponsiveFrameCandidate = {
  id: string
  name: string
  type: string
  width: number
  height: number
  selectionIndex?: number
  [key: string]: unknown
}

export type ResponsiveFrameGroup<T extends ResponsiveFrameCandidate = ResponsiveFrameCandidate> =
  | { kind: 'single-page'; name: string; selectionIndex: number; frames: [T]; frame: T }
  | { kind: 'responsive-page'; name: string; selectionIndex: number; frames: [T, T]; desktop: T; mobile: T }

export const MOBILE_FRAME_SUFFIX: '-移动端'
export function groupResponsiveFrames<T extends ResponsiveFrameCandidate>(
  frames: T[],
  options?: { pairingEnabled?: boolean; desktopMin?: number; mobileMax?: number },
): Array<ResponsiveFrameGroup<T>>
