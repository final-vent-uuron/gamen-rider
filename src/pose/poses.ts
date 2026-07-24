import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { LM, allVisible, angleAt, angleAt3d, dist2d, shoulderWidth } from './landmarks'

// ポーズ判定の共通インターフェース。幾何ルールもスナップショット類似度もこの形に揃える。
export type PoseTest = (lm: NormalizedLandmark[]) => boolean

// ---- 判定しきい値（調整しやすいよう冒頭に集約）----
const ARM_STRAIGHT_MIN_DEG = 150 // 肘がほぼ伸びている
const MIN_VIS = 0.35 // この可視性未満の関節があると判定しない（腕が画面外など）

// Tポーズ
const TPOSE_WRIST_LEVEL_TOL = 0.7 // 手首と肩の高さ差の許容（肩幅比）
const TPOSE_SPAN_MIN = 1.8 // 左右手首の開き幅（肩幅比）。腕を下げていると小さくなる。

// 片腕を前（カメラ手前）へ突き出す
const THRUST_FORESHORTEN_MAX = 0.6 // 肩→手首の2D長 / 腕の2D全長。小さいほどカメラ軸方向。
const THRUST_Z_MARGIN = 0.05 // 手首が肩よりカメラ手前にある量（z）。z はノイズが多いので向きの判定のみ。
const THRUST_SIDE_MAX = 0.8 // 突き出し手首が横へ開きすぎない上限（肩幅比）

// ボクシングガード（両拳を顔の前に構える）
// バトル中の実用入力なので認証ポーズよりだいぶ緩い（「肘を曲げて両手を上げていれば」成立）。
// lite モデル＋CPU 推論は z がノイジーで、厳しくすると構えているのに通らない。
const GUARD_MIN_VIS = 0.2 // ガード専用の可視性下限（拳がカメラに近く画面端でも判定できるよう緩め）
const GUARD_ELBOW_BEND_MAX_DEG = 130 // 肘がしっかり曲がっていること（伸ばし気味の腕は不成立）
const GUARD_WRIST_ABOVE_ELBOW = 0 // 手首は肘と同じ高さ以上（下がっていたら不成立）
const GUARD_WRIST_DROP_TOL = 0.5 // 手首が肩より下がってよい量（肩幅比）。拳は顔〜胸の高さ。
const GUARD_WRIST_SIDE_MAX = 1.0 // 手首が体の中心から横へ開きすぎない上限（肩幅比）

const ARM_IDS = [
  LM.L_SHOULDER,
  LM.R_SHOULDER,
  LM.L_ELBOW,
  LM.R_ELBOW,
  LM.L_WRIST,
  LM.R_WRIST,
]

type Lm = NormalizedLandmark[]
// [shoulder, elbow, wrist] のインデックス組
type Arm = readonly [number, number, number]

const L_ARM: Arm = [LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST]
const R_ARM: Arm = [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST]
const ARMS: readonly Arm[] = [L_ARM, R_ARM]

// 肘の伸展角（2D, 度）。横に広げた腕は画面平面内なので 2D が正確で安定。
function armStraightness2d(lm: Lm, [s, e, w]: Arm): number {
  return angleAt(lm[s], lm[e], lm[w])
}

// 肘の伸展角（3D, 度）。カメラ軸方向へ伸びた腕は 2D だと点が重なり不安定なので 3D を使う。
function armStraightness3d(lm: Lm, [s, e, w]: Arm): number {
  return angleAt3d(lm[s], lm[e], lm[w])
}

// 肩→手首の2D直線距離 / 腕の2D全長(肩→肘→手首)。
// 腕が伸びていてもカメラ軸方向を向くと小さくなる（foreshortening）。
function armForeshorten(lm: Lm, [s, e, w]: Arm): number {
  const full = dist2d(lm[s], lm[e]) + dist2d(lm[e], lm[w])
  if (full < 1e-4) return 1
  return dist2d(lm[s], lm[w]) / full
}

// 手首が肩よりどれだけカメラ手前か（z は手前ほど小さい → 正なら手前）
function armForwardZ(lm: Lm, [s, , w]: Arm): number {
  return lm[s].z - lm[w].z
}

// 片腕がカメラ手前へ真っ直ぐ突き出されているか
function isThrustArm(lm: Lm, arm: Arm): boolean {
  const [s, , w] = arm
  const sw = shoulderWidth(lm)
  // 1) 腕が画面内で短く写っている（カメラ軸方向）
  if (armForeshorten(lm, arm) > THRUST_FORESHORTEN_MAX) return false
  // 2) 3Dで肘が伸びている（曲げた腕も2Dは短くなるので3D伸展で除外）
  if (armStraightness3d(lm, arm) < ARM_STRAIGHT_MIN_DEG) return false
  // 3) 奥ではなく手前向き
  if (armForwardZ(lm, arm) < THRUST_Z_MARGIN) return false
  // 4) 真横（Tポーズ）ではなく前方
  if (Math.abs(lm[w].x - lm[s].x) > THRUST_SIDE_MAX * sw) return false
  return true
}

// Tポーズ: 両腕を真横に伸ばして水平
export function isTPose(lm: Lm): boolean {
  if (!allVisible(lm, ARM_IDS, MIN_VIS)) return false
  const sw = shoulderWidth(lm)
  const centerX = (lm[LM.L_SHOULDER].x + lm[LM.R_SHOULDER].x) / 2

  // 左右手首が十分に開いている（腕を下げていると小さい）
  if (dist2d(lm[LM.L_WRIST], lm[LM.R_WRIST]) < TPOSE_SPAN_MIN * sw) return false

  return ARMS.every((arm) => {
    const [s, , w] = arm
    // 手首が肩とほぼ同じ高さ
    if (Math.abs(lm[w].y - lm[s].y) > TPOSE_WRIST_LEVEL_TOL * sw) return false
    // 手首が肩より外側（体の中心から見て肩より遠い）
    if (Math.abs(lm[w].x - centerX) <= Math.abs(lm[s].x - centerX)) return false
    // 肘が伸びている（2D）
    return armStraightness2d(lm, arm) >= ARM_STRAIGHT_MIN_DEG
  })
}

// 片腕を前（カメラ手前）に突き出す。左右どちらの腕でも成立。
export function isArmThrustForward(lm: Lm): boolean {
  if (!allVisible(lm, ARM_IDS, MIN_VIS)) return false
  return ARMS.some((arm) => isThrustArm(lm, arm))
}

// ボクシングのガード: 両拳（手首）を顔〜胸の高さまで上げ、肘を曲げて体の前に構える。
// バトル中のカメラガード（構えている間ガード状態）に使う。左右対称なので鏡像表示の影響なし。
export function isBoxingGuard(lm: Lm): boolean {
  if (!allVisible(lm, ARM_IDS, GUARD_MIN_VIS)) return false
  const sw = shoulderWidth(lm)
  const centerX = (lm[LM.L_SHOULDER].x + lm[LM.R_SHOULDER].x) / 2
  return ARMS.every((arm) => {
    const [s, e, w] = arm
    // 肘が伸び切っていない（伸びた腕は構えではない）
    if (armStraightness3d(lm, arm) > GUARD_ELBOW_BEND_MAX_DEG) return false
    // 拳が肘のあたりより上（y は下向き正。多少下がっても許容）
    if (lm[w].y > lm[e].y - GUARD_WRIST_ABOVE_ELBOW * sw) return false
    // 拳が顔〜胸の高さ（肩より大きく下がっていない）
    if (lm[w].y > lm[s].y + GUARD_WRIST_DROP_TOL * sw) return false
    // 拳が体の前（真横へ開いていない）
    if (Math.abs(lm[w].x - centerX) > GUARD_WRIST_SIDE_MAX * sw) return false
    return true
  })
}

// 体の向き（正面 / 横向き）。見かけの肩幅と胴の長さの比で判定する。
// 正面では肩幅が広く写り、横を向くほど肩幅が潰れて写る。胴の縦の長さ（肩中点→腰中点）は
// 体のヨー回転でほぼ変わらないので、スケールの基準に使う（カメラとの距離にも影響されない）。
export type BodyFacing = 'front' | 'side'
const FACING_MIN_VIS = 0.4 // 手前側（よく見えている方）の肩に要求する可視性。これ未満は判定しない
const FACING_HIDDEN_VIS = 0.3 // 奥側の肩がこれ未満 = 体に隠れている ＝ それ自体が横向きの証拠
const FACING_SIDE_RATIO = 0.5 // 肩幅 / 胴長 がこれ未満なら横向き（正面はおおむね 0.7 前後）
const FACING_SIDE_YAW_DEG = 50 // 肩の z 差から出すヨー角がこれ以上なら横向き（正面 ~0-30°）

// 向き判定に使う生の計測値。UI のデバッグ表示・しきい値調整用に公開する。
export interface FacingMetrics {
  ratio: number // 見かけの肩幅 / 胴長。正面 ~0.7、横向きほど小さい
  yawDeg: number // 肩の z 差から出す体のヨー角（度）。正面 ~0、真横 ~90
  leftVis: number // 左肩の可視性
  rightVis: number // 右肩の可視性
}

export function facingMetrics(lm: Lm): FacingMetrics | null {
  const ls = lm[LM.L_SHOULDER]
  const rs = lm[LM.R_SHOULDER]
  const lh = lm[LM.L_HIP]
  const rh = lm[LM.R_HIP]
  if (!ls || !rs || !lh || !rh) return null
  const torso = Math.hypot(
    (ls.x + rs.x) / 2 - (lh.x + rh.x) / 2,
    (ls.y + rs.y) / 2 - (lh.y + rh.y) / 2,
  )
  if (torso < 1e-3) return null
  const vis = (p: NormalizedLandmark) => p.visibility ?? 1
  return {
    // 腰は上半身だけ映る画角だと可視性がほぼ 0 になるため、可視性は肩だけで見る。
    // 腰の「位置」はフレーム外でもモデルが推定するので、胴長（比の分母）にはそのまま使える。
    ratio: Math.abs(ls.x - rs.x) / torso,
    // 横を向くと片方の肩がカメラに近づき z の差が開く。x の見かけ幅より浅い回転にも反応する。
    yawDeg:
      (Math.atan2(Math.abs(ls.z - rs.z), Math.abs(ls.x - rs.x)) * 180) /
      Math.PI,
    leftVis: vis(ls),
    rightVis: vis(rs),
  }
}

export function bodyFacing(lm: Lm): BodyFacing | null {
  const m = facingMetrics(lm)
  if (!m) return null
  // 横向きでは奥側の肩・腰が体に隠れて可視性が落ちるため、「4点全部見えている」を
  // 要求すると横向きほど判定不能(null)になる。左右を分けて、手前側だけ可視性を要求し、
  // 奥側の可視性低下はむしろ横向きの証拠として使う。
  if (Math.max(m.leftVis, m.rightVis) < FACING_MIN_VIS) return null // 体ごと見失い → 現状維持
  if (Math.min(m.leftVis, m.rightVis) < FACING_HIDDEN_VIS) return 'side' // 片側が隠れている
  if (m.yawDeg >= FACING_SIDE_YAW_DEG) return 'side' // 肩の奥行き差が大きい（浅い横向きも拾う）
  return m.ratio < FACING_SIDE_RATIO ? 'side' : 'front'
}

// 幾何ルールで定義済みのポーズ一覧。ポーズ作成 UI でステップとして選べる。
export const BUILTIN_POSES: { id: string; label: string; test: PoseTest }[] = [
  { id: 'tpose', label: 'Tポーズ', test: isTPose },
  { id: 'thrust', label: '前突き出し', test: isArmThrustForward },
  { id: 'boxing-guard', label: 'ボクシングガード', test: isBoxingGuard },
]

