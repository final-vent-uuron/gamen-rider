// ファイナルベント専用ポーズ手順のフォールバック。
// 本体は /auth/register で登録し R2（rider-registry の finalVentSteps）に載る
// （finalVentCam.ts の getFinalVentSteps が最優先で読む）。ここはその手前の read-only な
// 保険 2 段: localStorage に残っている旧登録（過去の /final-vent-pose、廃止済み）→
// それも無ければ片腕前突き出し 1 ステップの builtin。

import { customToRoutine, type CustomRoutine, type CustomStep } from '../pose/custom'
import { isArmThrustForward } from '../pose/poses'
import type { HenshinRoutine } from '../pose/routine'
import type { RefPoint } from '../pose/snapshot'

const STORAGE_KEY = 'gamen-rider:final-vent-poses'
const LEGACY_STORAGE_KEY = 'gamen-rider:final-vent-pose'

export const FV_POSE_DEFAULT_MIN_SCORE = 80
export const FV_POSE_DEFAULT_HOLD_MS = 500

export interface FinalVentPoseRecord {
  riderId: string
  riderName: string
  steps: CustomStep[]
  updatedAt: string
}

type PoseMap = Record<string, FinalVentPoseRecord>

function isSnapshotStep(s: unknown): s is Extract<CustomStep, { kind: 'snapshot' }> {
  if (!s || typeof s !== 'object') return false
  const x = s as Extract<CustomStep, { kind: 'snapshot' }>
  return (
    x.kind === 'snapshot' &&
    Array.isArray(x.landmarks) &&
    x.landmarks.length >= 33 &&
    typeof x.holdMs === 'number'
  )
}

function isBuiltinStep(s: unknown): s is Extract<CustomStep, { kind: 'builtin' }> {
  if (!s || typeof s !== 'object') return false
  const x = s as Extract<CustomStep, { kind: 'builtin' }>
  return x.kind === 'builtin' && typeof x.poseId === 'string' && typeof x.holdMs === 'number'
}

function isValidStep(s: unknown): s is CustomStep {
  return isSnapshotStep(s) || isBuiltinStep(s)
}

function migrateLegacyRecord(id: string, raw: unknown): FinalVentPoseRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  // 新形式
  if (Array.isArray(r.steps) && r.steps.length > 0 && r.steps.every(isValidStep)) {
    return {
      riderId: (typeof r.riderId === 'string' && r.riderId) || id,
      riderName: typeof r.riderName === 'string' ? r.riderName : id,
      steps: r.steps as CustomStep[],
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date().toISOString(),
    }
  }
  // 旧: 単一 landmarks
  if (Array.isArray(r.landmarks) && (r.landmarks as RefPoint[]).length >= 33) {
    const landmarks = r.landmarks as RefPoint[]
    const step: CustomStep = {
      kind: 'snapshot',
      id: `legacy-${id}`,
      label: typeof r.label === 'string' ? r.label : 'ポーズ1',
      minScore:
        typeof r.minScore === 'number' ? r.minScore : FV_POSE_DEFAULT_MIN_SCORE,
      holdMs: typeof r.holdMs === 'number' ? r.holdMs : FV_POSE_DEFAULT_HOLD_MS,
      landmarks,
    }
    return {
      riderId: (typeof r.riderId === 'string' && r.riderId) || id,
      riderName: typeof r.label === 'string' ? r.label : id,
      steps: [step],
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date().toISOString(),
    }
  }
  return null
}

function readMap(): PoseMap {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: PoseMap = {}
        for (const [id, rec] of Object.entries(parsed)) {
          const migrated = migrateLegacyRecord(id, rec)
          if (migrated) out[id] = migrated
        }
        return out
      }
    }
  } catch {
    // fall through
  }

  try {
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (legacy) localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    // noop
  }
  return {}
}

export function loadFinalVentPose(riderId: string): FinalVentPoseRecord | null {
  if (!riderId) return null
  return readMap()[riderId] ?? null
}

function builtinFallback(riderId: string): HenshinRoutine {
  return {
    riderId: riderId || 'default',
    riderName: riderId || 'default',
    steps: [
      {
        id: 'thrust',
        label: '片腕を前に突き出す',
        test: isArmThrustForward,
        holdMs: FV_POSE_DEFAULT_HOLD_MS,
      },
    ],
  }
}

// バトル用: 登録手順があれば HenshinRoutine 化、なければ突き出し 1 ステップ。
export function resolveFinalVentRoutine(
  riderId: string,
  riderName?: string,
): { routine: HenshinRoutine; source: 'registered' | 'builtin' } {
  const rec = loadFinalVentPose(riderId)
  if (rec && rec.steps.length > 0) {
    const custom: CustomRoutine = {
      riderId: rec.riderId,
      riderName: riderName || rec.riderName,
      steps: rec.steps,
    }
    return { routine: customToRoutine(custom), source: 'registered' }
  }
  return { routine: builtinFallback(riderId), source: 'builtin' }
}
