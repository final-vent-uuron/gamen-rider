// バトル右下カメラでのファイナルベント発動シーケンス。
// メーター満タン → カード（ORB）→ ポーズ手順（変身と同じ流れ判定）→ sendAttack("final")。
// ポーズ手順は localStorage（finalVentPose.ts）のキャラ別登録。未登録時は前突き出し 1 ステップ。
// ガード用 MediaPipe と同じ <video> を共有し、カード／ポーズ相では cam ガードを mute する。

import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

import type { CardMatcher, CardRef } from '../card'
import { createCardMatcher } from '../card'
import { createRoutineRunner } from '../pose/routine'
import type { RoutineRunner, RunnerStep } from '../pose/routine'

import grapeUrl from '../assets/refs/grape.png'
import { resolveFinalVentRoutine } from './finalVentPose'

export const FINAL_VENT_CARD_REF: CardRef = {
  id: 'final-vent',
  label: 'ファイナルベント',
  url: grapeUrl,
}

export type FinalVentPhase = 'idle' | 'card' | 'pose' | 'fire'

const CARD_TIMEOUT_MS = 5000
// ポーズ相のベース制限。手順の hold 合計に余裕を足して実効タイムアウトにする。
const POSE_TIMEOUT_BASE_MS = 4000
const POSE_TIMEOUT_PER_STEP_MS = 2500
const FIRE_COOLDOWN_MS = 1500

export interface FinalVentPoseProgress {
  stepIndex: number
  stepCount: number
  label: string
  progress: number // 現ステップの hold 0..1
  active: boolean
}

export interface FinalVentController {
  setMeterFull(full: boolean): void
  onLandmarks(lm: NormalizedLandmark[] | null, now: number): void
  isCamMuted(): boolean
  phase(): FinalVentPhase
  start(): void
  stop(): void
}

export interface FinalVentControllerOptions {
  getVideo: () => HTMLVideoElement | null
  onPhase?: (phase: FinalVentPhase) => void
  onFire: () => void
  // ポーズ手順の進捗（UI 表示用）
  onPoseProgress?: (progress: FinalVentPoseProgress | null) => void
  cardRefs?: CardRef[]
  riderId?: string
  riderName?: string
}

export function createFinalVentController(
  opts: FinalVentControllerOptions,
): FinalVentController {
  const refs = opts.cardRefs ?? [FINAL_VENT_CARD_REF]
  const targetIds = new Set(refs.map((r) => r.id))
  const riderId = opts.riderId ?? ''
  const { routine } = resolveFinalVentRoutine(riderId, opts.riderName)
  const poseTimeoutMs =
    POSE_TIMEOUT_BASE_MS + routine.steps.length * POSE_TIMEOUT_PER_STEP_MS

  let runner: RoutineRunner | null = null
  let running = false
  let phase: FinalVentPhase = 'idle'
  let meterFull = false
  let matcher: CardMatcher | null = null
  let matcherReady = false
  let loadPromise: Promise<void> | null = null
  let rafId = 0
  let cardPhaseAt = 0
  let posePhaseAt = 0
  let cooldownUntil = 0

  const emitProgress = (step: RunnerStep | null) => {
    if (!step) {
      opts.onPoseProgress?.(null)
      return
    }
    opts.onPoseProgress?.({
      stepIndex: step.stepIndex,
      stepCount: step.stepCount,
      label: step.label,
      progress: step.progress,
      active: step.active,
    })
  }

  const ensureRunner = () => {
    if (!runner) {
      runner = createRoutineRunner([routine], routine.riderId)
    }
  }

  const setPhase = (next: FinalVentPhase) => {
    if (phase === next) return
    phase = next
    opts.onPhase?.(next)
    if (next === 'card') {
      cardPhaseAt = performance.now()
      matcher?.reset()
      emitProgress(null)
    } else if (next === 'pose') {
      posePhaseAt = performance.now()
      ensureRunner()
      runner?.reset()
      emitProgress({
        riderId: routine.riderId,
        riderName: routine.riderName,
        stepIndex: 0,
        stepCount: routine.steps.length,
        label: routine.steps[0]?.label ?? 'ポーズ',
        active: false,
        progress: 0,
      })
    } else if (next === 'idle' || next === 'fire') {
      emitProgress(null)
    }
  }

  const ensureMatcher = () => {
    if (matcher || loadPromise) return
    loadPromise = (async () => {
      const m = createCardMatcher(refs)
      await m.ready
      if (!running) {
        m.dispose()
        loadPromise = null
        return
      }
      matcher = m
      matcherReady = true
      loadPromise = null
    })().catch((err) => {
      console.warn('[finalVent] OpenCV / card matcher failed:', err)
      loadPromise = null
      matcherReady = false
    })
  }

  const tryArm = () => {
    if (!running || !meterFull) return
    if (performance.now() < cooldownUntil) return
    if (phase === 'idle') {
      ensureMatcher()
      setPhase('card')
    }
  }

  const disarm = () => {
    if (phase === 'idle') return
    setPhase('idle')
  }

  const fire = () => {
    setPhase('fire')
    cooldownUntil = performance.now() + FIRE_COOLDOWN_MS
    opts.onFire()
    setPhase('idle')
    window.setTimeout(() => {
      if (running && meterFull) tryArm()
    }, FIRE_COOLDOWN_MS)
  }

  const tickCard = (now: number) => {
    if (phase !== 'card' || !matcherReady || !matcher) return
    if (now - cardPhaseAt >= CARD_TIMEOUT_MS) {
      matcher.reset()
      cardPhaseAt = now
    }
    const video = opts.getVideo()
    if (!video || video.readyState < 2) return
    const match = matcher.detect(video, now)
    if (match && targetIds.has(match.id)) {
      setPhase('pose')
    }
  }

  const loop = (now: number) => {
    if (!running) return
    rafId = requestAnimationFrame(loop)
    if (phase === 'card') tickCard(now)
  }

  return {
    setMeterFull(full) {
      meterFull = full
      if (!running) return
      if (full) tryArm()
      else disarm()
    },

    onLandmarks(lm, now) {
      if (!running || phase !== 'pose') return
      if (now - posePhaseAt >= poseTimeoutMs) {
        setPhase('card')
        return
      }
      ensureRunner()
      const state = runner!.update(lm, now)
      const step = state.steps[0] ?? null
      emitProgress(step)
      if (state.matchedRiderId) fire()
    },

    isCamMuted() {
      return phase === 'card' || phase === 'pose' || phase === 'fire'
    },

    phase() {
      return phase
    },

    start() {
      if (running) return
      running = true
      rafId = requestAnimationFrame(loop)
      if (meterFull) tryArm()
    },

    stop() {
      running = false
      cancelAnimationFrame(rafId)
      matcher?.dispose()
      matcher = null
      matcherReady = false
      loadPromise = null
      runner = null
      emitProgress(null)
      if (phase !== 'idle') {
        phase = 'idle'
        opts.onPhase?.('idle')
      }
    },
  }
}
