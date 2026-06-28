import { LM } from './landmarks'
import type { PoseTest } from './poses'

// スナップショットとして保存する 1 点（可視性は使わないので x,y,z のみ）
export interface RefPoint {
  x: number
  y: number
  z: number
}
export type PoseSnapshot = RefPoint[]

type Point = { x: number; y: number; z: number }

// ヒップ中心・体幹スケールで正規化。立ち位置やカメラ距離の差を吸収する。
export function normalizeLandmarks(lms: ReadonlyArray<Point>): RefPoint[] {
  const lHip = lms[LM.L_HIP]
  const rHip = lms[LM.R_HIP]
  const lSh = lms[LM.L_SHOULDER]
  const rSh = lms[LM.R_SHOULDER]

  const cx = (lHip.x + rHip.x) / 2
  const cy = (lHip.y + rHip.y) / 2
  const cz = (lHip.z + rHip.z) / 2

  const shoulderMidY = (lSh.y + rSh.y) / 2
  const scale = Math.max(Math.abs(cy - shoulderMidY), 0.01)

  return lms.map((l) => ({
    x: (l.x - cx) / scale,
    y: (l.y - cy) / scale,
    z: (l.z - cz) / scale,
  }))
}

function similarityNormalized(a: ReadonlyArray<RefPoint>, b: ReadonlyArray<RefPoint>): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const dx = a[i].x - b[i].x
    const dy = a[i].y - b[i].y
    const dz = a[i].z - b[i].z
    sum += Math.sqrt(dx * dx + dy * dy + dz * dz)
  }
  const avg = sum / n
  // dist=0 → 100, dist>=2 → 0
  return Math.max(0, Math.round((1 - avg / 2) * 100))
}

// 2 ポーズの一致度（0..100）。基準ポーズ作成 UI のライブ確認用。
export function poseSimilarity(a: ReadonlyArray<Point>, b: ReadonlyArray<Point>): number {
  return similarityNormalized(normalizeLandmarks(a), normalizeLandmarks(b))
}

// 撮って登録したポーズを PoseTest 化する。基準を正規化して閉じ込めておく。
export function snapshotTest(ref: PoseSnapshot, minScore = 80): PoseTest {
  const nref = normalizeLandmarks(ref)
  return (lm) => lm.length >= 33 && similarityNormalized(normalizeLandmarks(lm), nref) >= minScore
}
