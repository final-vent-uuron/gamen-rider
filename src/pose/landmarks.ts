import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

// MediaPipe Pose（33点モデル）の主要ランドマーク index
export const LM = {
  NOSE: 0,
  L_SHOULDER: 11,
  R_SHOULDER: 12,
  L_ELBOW: 13,
  R_ELBOW: 14,
  L_WRIST: 15,
  R_WRIST: 16,
  L_HIP: 23,
  R_HIP: 24,
} as const

export type Landmarks = NormalizedLandmark[]

// 正規化画像座標（x,y は 0..1）での 2D 距離
export function dist2d(a: NormalizedLandmark, b: NormalizedLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// z（奥行き）も含めた 3D 距離
export function dist3d(a: NormalizedLandmark, b: NormalizedLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

// 肩幅（左右肩の 2D 距離）。各しきい値の基準スケールとして使う。
export function shoulderWidth(lm: Landmarks): number {
  return Math.max(dist2d(lm[LM.L_SHOULDER], lm[LM.R_SHOULDER]), 1e-3)
}

// 頂点 b における角度（b→a と b→c のなす角）を度で返す。2D。
export function angleAt(
  a: NormalizedLandmark,
  b: NormalizedLandmark,
  c: NormalizedLandmark,
): number {
  const v1x = a.x - b.x
  const v1y = a.y - b.y
  const v2x = c.x - b.x
  const v2y = c.y - b.y
  const m1 = Math.hypot(v1x, v1y)
  const m2 = Math.hypot(v2x, v2y)
  if (m1 < 1e-6 || m2 < 1e-6) return 0
  const cos = Math.min(1, Math.max(-1, (v1x * v2x + v1y * v2y) / (m1 * m2)))
  return (Math.acos(cos) * 180) / Math.PI
}

// 頂点 b における角度（b→a と b→c のなす角）を度で返す。z も含めた 3D。
// カメラ軸方向へ伸びた腕は 2D だと点が重なり角度が不安定になるため、伸展判定は 3D を使う。
export function angleAt3d(
  a: NormalizedLandmark,
  b: NormalizedLandmark,
  c: NormalizedLandmark,
): number {
  const v1x = a.x - b.x
  const v1y = a.y - b.y
  const v1z = a.z - b.z
  const v2x = c.x - b.x
  const v2y = c.y - b.y
  const v2z = c.z - b.z
  const m1 = Math.hypot(v1x, v1y, v1z)
  const m2 = Math.hypot(v2x, v2y, v2z)
  if (m1 < 1e-6 || m2 < 1e-6) return 0
  const cos = Math.min(1, Math.max(-1, (v1x * v2x + v1y * v2y + v1z * v2z) / (m1 * m2)))
  return (Math.acos(cos) * 180) / Math.PI
}

// 可視性（その関節が十分に検出されているか）
export function visible(lm: NormalizedLandmark, minVis = 0.5): boolean {
  return (lm?.visibility ?? 0) >= minVis
}

export function allVisible(lm: Landmarks, indices: number[], minVis = 0.5): boolean {
  return indices.every((i) => lm[i] != null && visible(lm[i], minVis))
}

// MediaPipe の z はヒップ基準の相対深度で、値が小さいほどカメラに近い。
// front が back より margin 以上カメラ手前にあるか。
export function isForwardOf(
  front: NormalizedLandmark,
  back: NormalizedLandmark,
  margin: number,
): boolean {
  return back.z - front.z >= margin
}
