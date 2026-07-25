import { BUILTIN_POSES } from './poses'
import type { HenshinRoutine, PoseStep } from './routine'
import { snapshotTest } from './snapshot'
import type { RefPoint } from './snapshot'

// ポーズ作成 UI で組み立てる 1 ステップ。
// - snapshot: 撮って登録したポーズ（類似度判定）
// - builtin : 幾何ルールで定義済みのポーズ（Tポーズ等）
export type CustomStep =
  | {
      kind: 'snapshot'
      id: string
      label: string
      minScore: number
      holdMs: number
      landmarks: RefPoint[]
    }
  | {
      kind: 'builtin'
      id: string
      label: string
      holdMs: number
      poseId: string
    }

export interface CustomRoutine {
  riderId: string
  riderName: string
  steps: CustomStep[]
}

// 実プレイでの判定は登録時のしきい値より少し緩める（登録済みライダー分にも即反映されるよう、
// ここで一律に下げる。登録し直さないと効かない minScore 自体は変えない）。
const RUNTIME_SCORE_LENIENCY = 10
const RUNTIME_SCORE_MIN = 50 // どれだけ緩めても下回らない下限（何でも通ってしまう事故防止）

// CustomStep を実行可能な PoseStep（test 関数つき）へ変換
export function customStepToPoseStep(s: CustomStep): PoseStep {
  if (s.kind === 'snapshot') {
    return {
      id: s.id,
      label: s.label,
      holdMs: s.holdMs,
      test: snapshotTest(s.landmarks, Math.max(RUNTIME_SCORE_MIN, s.minScore - RUNTIME_SCORE_LENIENCY)),
      guide: s.landmarks,
    }
  }
  const builtin = BUILTIN_POSES.find((b) => b.id === s.poseId)
  return { id: s.id, label: s.label, holdMs: s.holdMs, test: builtin?.test ?? (() => false) }
}

export function customToRoutine(c: CustomRoutine): HenshinRoutine {
  return {
    riderId: c.riderId,
    riderName: c.riderName,
    steps: c.steps.map(customStepToPoseStep),
  }
}
