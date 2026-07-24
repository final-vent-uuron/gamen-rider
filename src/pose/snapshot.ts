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

// 類似度で重視する関節（腕・手首中心）。変身ポーズの違いはほぼ腕の位置に出る一方、
// 33点を単純平均すると顔・脚・足のほとんど動かない点が差を薄めてしまい、
// 別のポーズでも「なんとなく立っていれば」高スコアになって誤認識の原因になっていた。
// 手首・肘を重く、肩・腰を軽く見ることで、実際に動く部分の差がスコアへ素直に反映されるようにする。
const SIMILARITY_WEIGHTS: Record<number, number> = {
  [LM.NOSE]: 0.6,
  [LM.L_SHOULDER]: 1,
  [LM.R_SHOULDER]: 1,
  [LM.L_ELBOW]: 1.4,
  [LM.R_ELBOW]: 1.4,
  [LM.L_WRIST]: 1.8,
  [LM.R_WRIST]: 1.8,
  [LM.L_HIP]: 0.5,
  [LM.R_HIP]: 0.5,
}

function similarityNormalized(a: ReadonlyArray<RefPoint>, b: ReadonlyArray<RefPoint>): number {
  let sum = 0
  let weightTotal = 0
  for (const [idxStr, w] of Object.entries(SIMILARITY_WEIGHTS)) {
    const i = Number(idxStr)
    const pa = a[i]
    const pb = b[i]
    if (!pa || !pb) continue
    const dx = pa.x - pb.x
    const dy = pa.y - pb.y
    const dz = pa.z - pb.z
    sum += w * Math.sqrt(dx * dx + dy * dy + dz * dz)
    weightTotal += w
  }
  if (weightTotal === 0) return 0
  const avg = sum / weightTotal
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
