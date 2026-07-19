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
const SMOOTH_TAU_MS = 70 // 補間の時定数。検出(~15fps)の間を 60fps で軟着させる（小さいほど機敏）

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

  // MediaPipe の DrawingUtils 風の見た目（太い接続線＋白い関節ドット＋発光）。
  // サイズは canvas 幅に比例させ、プレビューの拡大縮小でも太さの見た目を保つ。
  const lineW = Math.max(2, w / 90)
  const jointR = Math.max(2.5, w / 80)

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.shadowColor = color
  ctx.shadowBlur = lineW * 2

  ctx.strokeStyle = color
  ctx.lineWidth = lineW
  ctx.beginPath()
  for (const [a, b] of POSE_LINES) {
    if (!visible(a) || !visible(b)) continue
    ctx.moveTo(landmarks[a].x * w, landmarks[a].y * h)
    ctx.lineTo(landmarks[b].x * w, landmarks[b].y * h)
  }
  ctx.stroke()

  // 関節: 白丸＋色付きの縁取り（MediaPipe のランドマーク表示に寄せる）
  ctx.shadowBlur = 0
  ctx.fillStyle = '#fff'
  ctx.lineWidth = Math.max(1.5, lineW * 0.6)
  for (let i = 0; i < landmarks.length; i++) {
    if (!visible(i)) continue
    ctx.beginPath()
    ctx.arc(landmarks[i].x * w, landmarks[i].y * h, jointR, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
  ctx.restore()
}

// ---- 補間つき骨格描画 -----------------------------------------------------
// 検出は ~15fps（ワーカー側の推論周期）だが、表示は独自の rAF ループ（60fps）で
// 前回表示位置 → 最新検出位置へ指数関数的に軟着させて描く。検出のカクつきが消えて
// /pose（毎フレーム検出）と同等以上の滑らかさに見える。
// push(lm, color) を検出結果ごとに呼ぶだけ。lm=null で消灯、stop() で完全停止。

export interface SkeletonSmoother {
  push(lm: NormalizedLandmark[] | null, color: string): void
  stop(): void
}

export function createSkeletonSmoother(
  getCanvas: () => HTMLCanvasElement | null,
): SkeletonSmoother {
  let target: NormalizedLandmark[] | null = null // 最新の検出結果（目標位置）
  let shown: NormalizedLandmark[] | null = null // いま画面に描いている位置（毎フレーム目標へ寄せる）
  let color = '#4ade80'
  let raf = 0
  let running = false
  let lastT = 0

  const loop = (t: number) => {
    if (!running) return
    const dt = lastT ? Math.min(t - lastT, 100) : 16
    lastT = t
    if (!target) {
      // 見失った: 消してループを止める（次の push で再開）。追跡が残ると誤誘導になる。
      drawPoseSkeleton(getCanvas(), null, color)
      shown = null
      running = false
      return
    }
    if (!shown || shown.length !== target.length) {
      shown = target.map((p) => ({ ...p })) // 初回・関節数変化はスナップ
    } else {
      const k = 1 - Math.exp(-dt / SMOOTH_TAU_MS)
      for (let i = 0; i < shown.length; i++) {
        const s = shown[i]
        const g = target[i]
        s.x += (g.x - s.x) * k
        s.y += (g.y - s.y) * k
        s.z += (g.z - s.z) * k
        s.visibility += ((g.visibility ?? 1) - (s.visibility ?? 1)) * k
      }
    }
    drawPoseSkeleton(getCanvas(), shown, color)
    raf = requestAnimationFrame(loop)
  }

  const ensureLoop = () => {
    if (running) return
    running = true
    lastT = 0
    raf = requestAnimationFrame(loop)
  }

  return {
    push(lm, c) {
      color = c
      target = lm
      ensureLoop()
    },
    stop() {
      running = false
      cancelAnimationFrame(raf)
      target = null
      shown = null
      drawPoseSkeleton(getCanvas(), null, color) // 消灯
    },
  }
}
