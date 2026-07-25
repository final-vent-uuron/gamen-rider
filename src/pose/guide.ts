// 変身ポーズ認証の「お手本」表示。登録済み（snapshot）ステップの参照ランドマークを、
// カメラのライブ骨格とは別の静止スティックフィギュアとして描く（横に並べて「見て真似る」導線）。
import { LM } from './landmarks'
import { normalizeLandmarks } from './snapshot'
import type { RefPoint } from './snapshot'

// スティックフィギュアの骨（両端の関節 index）。knee を挟むことで脚も自然に曲がって見える。
const GUIDE_EDGES: [number, number][] = [
  [LM.L_SHOULDER, LM.R_SHOULDER],
  [LM.L_SHOULDER, LM.L_ELBOW],
  [LM.L_ELBOW, LM.L_WRIST],
  [LM.R_SHOULDER, LM.R_ELBOW],
  [LM.R_ELBOW, LM.R_WRIST],
  [LM.L_SHOULDER, LM.L_HIP],
  [LM.R_SHOULDER, LM.R_HIP],
  [LM.L_HIP, LM.R_HIP],
  [LM.L_HIP, LM.L_KNEE],
  [LM.L_KNEE, LM.L_ANKLE],
  [LM.R_HIP, LM.R_KNEE],
  [LM.R_KNEE, LM.R_ANKLE],
]

const GUIDE_JOINTS = [...new Set(GUIDE_EDGES.flat())]

/**
 * 参照ランドマーク（登録時に撮った生の33点）から、キャンバスへお手本の棒人間を描く。
 * ref が無い（builtin ポーズ等）ときは何も描かない＝呼び出し側でフォールバック表示を出すこと。
 * 自撮りミラー表示のカメラ映像と向きを合わせるため、左右反転して描く。
 */
export function drawPoseGuide(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  ref: ReadonlyArray<RefPoint> | null | undefined,
): void {
  ctx.clearRect(0, 0, width, height)
  if (!ref || ref.length < 33 || width <= 0 || height <= 0) return

  // snapshot.ts の判定と同じ基準（ヒップ中心・肩-腰スケール）で正規化してから描く。
  const n = normalizeLandmarks(ref)

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const i of GUIDE_JOINTS) {
    const p = n[i]
    if (!p) continue
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  if (!Number.isFinite(minX)) return

  const pad = 0.4 // バウンディングボックスへの余白（正規化単位）
  minX -= pad
  maxX += pad
  minY -= pad
  maxY += pad
  const spanX = Math.max(maxX - minX, 0.5)
  const spanY = Math.max(maxY - minY, 0.5)
  const scale = Math.min(width / spanX, height / spanY)
  const offX = (width - spanX * scale) / 2
  const offY = (height - spanY * scale) / 2

  // ミラー表示: x は (max - x) で反転して、カメラのライブ骨格と同じ向きに揃える。
  const project = (p: RefPoint) => ({
    x: offX + (maxX - p.x) * scale,
    y: offY + (p.y - minY) * scale,
  })

  const accent = '#a78bfa'
  ctx.save()
  ctx.strokeStyle = accent
  ctx.lineWidth = Math.max(2, width * 0.014)
  ctx.lineCap = 'round'
  ctx.beginPath()
  for (const [a, b] of GUIDE_EDGES) {
    const pa = n[a]
    const pb = n[b]
    if (!pa || !pb) continue
    const ca = project(pa)
    const cb = project(pb)
    ctx.moveTo(ca.x, ca.y)
    ctx.lineTo(cb.x, cb.y)
  }
  ctx.stroke()

  // 頭（鼻の位置に円）
  const nose = n[LM.NOSE]
  if (nose) {
    const head = project(nose)
    const headR = Math.max(6, width * 0.05)
    ctx.fillStyle = accent
    ctx.beginPath()
    ctx.arc(head.x, head.y - headR * 0.4, headR, 0, Math.PI * 2)
    ctx.fill()
  }

  // 関節点
  ctx.fillStyle = '#ddd6fe'
  for (const i of GUIDE_JOINTS) {
    const p = n[i]
    if (!p) continue
    const c = project(p)
    ctx.beginPath()
    ctx.arc(c.x, c.y, Math.max(2.5, width * 0.012), 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}
