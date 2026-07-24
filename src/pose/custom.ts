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

// CustomStep を実行可能な PoseStep（test 関数つき）へ変換
export function customStepToPoseStep(s: CustomStep): PoseStep {
  if (s.kind === 'snapshot') {
    return {
      id: s.id,
      label: s.label,
      holdMs: s.holdMs,
      test: snapshotTest(s.landmarks, s.minScore),
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

const STORAGE_KEY = 'gamen-rider:custom-routines'

// localStorage は SSR では存在しないのでガードする（クライアントのイベント/effect から呼ぶこと）
export function loadCustomRoutines(): CustomRoutine[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as CustomRoutine[]) : []
  } catch {
    return []
  }
}

export function saveCustomRoutines(routines: CustomRoutine[]): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(routines))
}
