// ポーズ骨格（棒人間）の軽量オーバーレイ描画。
// henshin.tsx は tasks-vision の DrawingUtils を使うが、バトル画面は推論をワーカーに
// 隔離していてメインスレッドに tasks-vision を読み込みたくない（バンドルも実行コストも
// 増える）ため、接続トポロジをローカルに持って canvas 2D で直接描く。

import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

// BlazePose(33点) の接続組。PoseLandmarker.POSE_CONNECTIONS と同じトポロジ。
const POSE_LINES: ReadonlyArray<readonly [number, number]> = [
  // 顔まわり
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  // 腕（左: 11 系 / 右: 12 系）
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  // 胴体〜脚
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
  [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
]

const MIN_VIS = 0.3 // これ未満の関節（画面外など）は描かない

// 正規化座標(0..1)のランドマークを canvas いっぱいに描く。landmarks が null なら消すだけ。
// 左右反転（自撮りミラー）は canvas 側の CSS transform に任せる（映像と同じ変換で揃う）。
export function drawPoseSkeleton(
  canvas: HTMLCanvasElement | null,
  landmarks: NormalizedLandmark[] | null,
  color: string,
): void {
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width: w, height: h } = canvas
  ctx.clearRect(0, 0, w, h)
  if (!landmarks) return

  const visible = (i: number) => (landmarks[i]?.visibility ?? 1) >= MIN_VIS

  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.beginPath()
  for (const [a, b] of POSE_LINES) {
    if (!visible(a) || !visible(b)) continue
    ctx.moveTo(landmarks[a].x * w, landmarks[a].y * h)
    ctx.lineTo(landmarks[b].x * w, landmarks[b].y * h)
  }
  ctx.stroke()

  ctx.fillStyle = '#fff'
  for (let i = 0; i < landmarks.length; i++) {
    if (!visible(i)) continue
    ctx.beginPath()
    ctx.arc(landmarks[i].x * w, landmarks[i].y * h, 2.5, 0, Math.PI * 2)
    ctx.fill()
  }
}
