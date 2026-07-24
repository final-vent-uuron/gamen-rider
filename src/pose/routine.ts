import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { isArmThrustForward, isTPose } from './poses'
import type { PoseTest } from './poses'
import type { RefPoint } from './snapshot'

export interface PoseStep {
  id: string
  label: string
  test: PoseTest
  holdMs: number // このポーズを連続成立で保持すべき時間
  // お手本として横に表示する参照ポーズ（snapshot 由来のみ。builtin は無し＝表示側でフォールバック）。
  guide?: RefPoint[]
}

export interface HenshinRoutine {
  riderId: string
  riderName: string
  steps: PoseStep[]
}

// ライダーごとの変身ポーズ手順。差し替え・追加はこの配列を編集するだけ。
// （CLAUDE.md 方針: 手順の中身は仮。ここを書き換えれば差し替え可能。）
export const RIDER_ROUTINES: HenshinRoutine[] = [
  {
    riderId: 'gamen',
    riderName: '画面ライダー(仮)',
    steps: [
      { id: 'tpose', label: 'Tポーズをキープ', test: isTPose, holdMs: 800 },
      { id: 'thrust', label: '片腕を前に突き出す', test: isArmThrustForward, holdMs: 600 },
    ],
  },
]

// 検出のブレを吸収する猶予。これ以内の一瞬の非成立では hold を巻き戻さない。
const STEP_GRACE_MS = 300

interface RoutineProgress {
  routine: HenshinRoutine
  stepIndex: number
  heldMs: number // 現 step を連続成立できている累積時間
  graceMs: number // 直近で test が外れてからの経過
  lastPass: boolean // 直近フレームで現 step が成立していたか
}

export interface RunnerStep {
  riderId: string
  riderName: string
  stepIndex: number
  stepCount: number
  label: string
  active: boolean // 現フレームで現 step の test が成立しているか
  progress: number // 現 step の hold 進捗 0..1
}

export interface RunnerState {
  steps: RunnerStep[] // 各ルーチンの現在地（UI 表示用）
  matchedRiderId: string | null
}

export interface RoutineRunner {
  update(lm: NormalizedLandmark[] | null, nowMs: number): RunnerState
  reset(): void
  getState(): RunnerState
}

// routines を並行に進める runner を作る。
// filterRiderId を渡すとそのライダーのみ評価する（カードで選んだライダーの「確認」用途）。
// 省略すると全ライダーを並行評価し、最初に完走したものを採用する（「どのライダーか判定」用途）。
export function createRoutineRunner(
  routines: HenshinRoutine[] = RIDER_ROUTINES,
  filterRiderId?: string,
): RoutineRunner {
  const target = filterRiderId
    ? routines.filter((r) => r.riderId === filterRiderId)
    : routines

  let progresses: RoutineProgress[] = []
  let matchedRiderId: string | null = null
  let lastMs = 0

  function init() {
    progresses = target.map((routine) => ({
      routine,
      stepIndex: 0,
      heldMs: 0,
      graceMs: 0,
      lastPass: false,
    }))
    matchedRiderId = null
    lastMs = 0
  }
  init()

  function snapshot(): RunnerState {
    return {
      matchedRiderId,
      steps: progresses.map((p) => {
        const step = p.routine.steps[p.stepIndex]
        return {
          riderId: p.routine.riderId,
          riderName: p.routine.riderName,
          stepIndex: p.stepIndex,
          stepCount: p.routine.steps.length,
          label: step.label,
          active: p.lastPass,
          progress: Math.min(1, p.heldMs / step.holdMs),
        }
      }),
    }
  }

  function update(lm: NormalizedLandmark[] | null, nowMs: number): RunnerState {
    const dt = lastMs === 0 ? 0 : Math.max(0, nowMs - lastMs)
    lastMs = nowMs

    if (matchedRiderId) return snapshot() // 成立済み。reset まで保持。

    for (const p of progresses) {
      const step = p.routine.steps[p.stepIndex]
      const pass = lm ? step.test(lm) : false
      p.lastPass = pass

      if (pass) {
        p.graceMs = 0
        p.heldMs += dt
        if (p.heldMs >= step.holdMs) {
          if (p.stepIndex + 1 >= p.routine.steps.length) {
            matchedRiderId = p.routine.riderId // 最終 step 完走 → 成立
            break
          }
          p.stepIndex += 1 // 次の step へ
          p.heldMs = 0
        }
      } else {
        p.graceMs += dt
        // 猶予を超えたら「現在の step」の hold だけ巻き戻す（ブレ吸収）。
        // 連続で決める必要はない＝1枚ずつポーズできれば良いので、既に完走した step
        // （stepIndex）まで巻き戻すことはしない（以前は長く崩れると最初からやり直しだった）。
        if (p.graceMs > STEP_GRACE_MS) p.heldMs = 0
      }
    }

    return snapshot()
  }

  return {
    update,
    reset: init,
    getState: snapshot,
  }
}
