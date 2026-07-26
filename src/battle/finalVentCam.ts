// バトル右下カメラでのファイナルベント発動シーケンス。
// メーター満タン中は通常戦闘のまま裏でカードを監視し、かざした瞬間に
// ポーズ手順（変身と同じ流れ判定）→ sendAttack("final") へ進む（任意タイミング発動）。
// かざすカードの参照は変身フローと同じ登録ライダー画像（/auth/register → registry）。
// ポーズ手順は localStorage（finalVentPose.ts）のキャラ別登録。未登録時は前突き出し 1 ステップ。
// ガード用 MediaPipe と同じ <video> を共有し、ポーズ相では cam ガードを mute する。

import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

import type { CardMatcher, CardRef } from '../card'
import { createCardMatcher } from '../card'
import { customToRoutine } from '../pose/custom'
import type { CustomStep } from '../pose/custom'
import { createRoutineRunner } from '../pose/routine'
import type { HenshinRoutine, RoutineRunner, RunnerStep } from '../pose/routine'
import type { RegisteredRiderWithImage } from '../rider-registry'

import { resolveFinalVentRoutine } from './finalVentPose'

/** 変身フローと同じく、登録ライダー画像から FV 用 CardRef を組み立てる。 */
export function resolveFinalVentCardRefs(
  registered: RegisteredRiderWithImage[],
  riderId: string,
  riderName?: string,
): CardRef[] {
  const all: CardRef[] = registered.map((r) => ({
    id: r.id,
    label: r.name,
    url: r.imageDataUrl,
  }))
  if (all.length === 0) return []
  // /auth 経由: registry の id そのもの
  const byId = all.filter((r) => r.id === riderId)
  if (byId.length) return byId
  // /select の言語 id（arduino 等）→ 登録名（Arduino）で紐付け
  const nameLc = (riderName ?? '').trim().toLowerCase()
  if (nameLc) {
    const byName = all.filter((r) => r.label.trim().toLowerCase() === nameLc)
    if (byName.length) return byName
  }
  // 紐付けできないときは変身と同じく全登録カードを候補にする
  return all
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
  /** 事前に渡す参照。省略時は getCardRefs（変身と同じ登録ライダー）を lazy load */
  cardRefs?: CardRef[]
  /** 変身フロー同様 listRiders → resolveFinalVentCardRefs を想定 */
  getCardRefs?: () => Promise<CardRef[]>
  /** /auth/register で登録した FV ポーズ手順（R2 由来）。lazy load。
   * null/空/失敗時は localStorage 登録 → builtin フォールバックの順で使う（resolveFinalVentRoutine）。 */
  getFinalVentSteps?: () => Promise<CustomStep[] | null>
  riderId?: string
  riderName?: string
}

export function createFinalVentController(
  opts: FinalVentControllerOptions,
): FinalVentController {
  const riderId = opts.riderId ?? ''
  const riderName = opts.riderName ?? riderId
  // 初期値は localStorage 登録／builtin フォールバック。登録ライダーの finalVentSteps（R2）が
  // 届き次第（ensureMatcher 内で card 参照と同時に lazy load）そちらを優先して上書きする。
  let routine: HenshinRoutine = resolveFinalVentRoutine(riderId, riderName).routine
  let poseTimeoutMs = POSE_TIMEOUT_BASE_MS + routine.steps.length * POSE_TIMEOUT_PER_STEP_MS

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
  let targetIds = new Set((opts.cardRefs ?? []).map((r) => r.id))

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
      // 変身フローと同じ登録ライダー画像を参照する（cardRefs 優先、無ければ getCardRefs）
      let refs = opts.cardRefs ?? []
      const loaders: Promise<unknown>[] = []
      if (refs.length === 0 && opts.getCardRefs) {
        loaders.push(opts.getCardRefs().then((r) => (refs = r)))
      }
      // 登録ライダーの FV ポーズ（R2）。取得できたらローカル/builtin より優先して routine を差し替える。
      if (opts.getFinalVentSteps) {
        loaders.push(
          opts
            .getFinalVentSteps()
            .then((steps) => {
              if (steps && steps.length > 0) {
                routine = customToRoutine({ riderId, riderName, steps })
                poseTimeoutMs = POSE_TIMEOUT_BASE_MS + routine.steps.length * POSE_TIMEOUT_PER_STEP_MS
              }
            })
            .catch((err) => console.warn('[finalVent] FV ポーズ手順の取得に失敗:', err)),
        )
      }
      if (loaders.length) await Promise.all(loaders)
      if (!running) {
        loadPromise = null
        return
      }
      if (refs.length === 0) {
        console.warn(
          '[finalVent] カード参照が空です。/auth/register でライダーを登録してください（L/F でバイパス可）',
        )
        loadPromise = null
        return
      }
      targetIds = new Set(refs.map((r) => r.id))
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

  const disarm = () => {
    if (phase === 'idle') return
    setPhase('idle')
  }

  const fire = () => {
    setPhase('fire')
    cooldownUntil = performance.now() + FIRE_COOLDOWN_MS
    opts.onFire()
    setPhase('idle')
  }

  // 満タン中は idle のまま裏でカードを監視する（CARD 待ち UI に閉じ込めない）。
  // かざして認識できた瞬間だけ pose へ進み、そこで初めて全員凍結する。
  const tickCard = (now: number) => {
    if (!meterFull || !matcherReady || !matcher) return
    if (phase !== 'idle' && phase !== 'card') return
    if (performance.now() < cooldownUntil) return
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
    if (phase === 'idle' || phase === 'card') tickCard(now)
  }

  return {
    setMeterFull(full) {
      meterFull = full
      if (!running) return
      if (full) {
        // 解禁だけ。CARD 相へは進めず、通常戦闘＋裏監視を続ける。
        ensureMatcher()
        cardPhaseAt = performance.now()
      } else {
        disarm()
      }
    },

    onLandmarks(lm, now) {
      if (!running || phase !== 'pose') return
      if (now - posePhaseAt >= poseTimeoutMs) {
        // 失敗したら凍結を解き、通常戦闘へ戻す（またかざせば再挑戦できる）
        setPhase('idle')
        return
      }
      ensureRunner()
      const state = runner!.update(lm, now)
      const step = state.steps[0] ?? null
      emitProgress(step)
      if (state.matchedRiderId) fire()
    },

    isCamMuted() {
      // ポーズ中だけガードを止める。満タンの裏監視中はガード継続。
      return phase === 'pose' || phase === 'fire'
    },

    phase() {
      return phase
    },

    start() {
      if (running) return
      running = true
      rafId = requestAnimationFrame(loop)
      if (meterFull) {
        ensureMatcher()
        cardPhaseAt = performance.now()
      }
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
