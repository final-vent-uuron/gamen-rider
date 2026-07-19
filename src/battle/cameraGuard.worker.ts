// カメラガードの MediaPipe 推論を回す Web Worker。
// detectForVideo は呼んだスレッドを同期的に塞ぐため、メインスレッド（three.js の 60fps 描画）
// から切り離してここで実行する。メイン側からフレーム(ImageBitmap)を受け取り、
// 「ボクシングの構えか」の真偽値だけを返す。デバウンスはメイン側（cameraGuard.ts）が行う。

import type { NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision'
import { createPoseLandmarker } from '../pose/landmarker'
import { bodyFacing, isBoxingGuard } from '../pose/poses'
import type { BodyFacing } from '../pose/poses'

export interface FrameMsg {
  t: 'frame'
  bitmap: ImageBitmap
  ts: number // performance.now()（メイン側）。detectForVideo は単調増加のタイムスタンプが必要
}

export type WorkerMsg =
  | { t: 'ready' } // モデルロード完了。メイン側はこれを待ってからフレームを送る
  // landmarks はプレビューの骨格オーバーレイ用（正規化座標の素の配列。未検出は null）
  // facing は体の向き（肩の左右関係。横向き・見失いは null = 判定保留）
  | {
      t: 'result'
      posed: boolean
      facing: BodyFacing | null
      landmarks: NormalizedLandmark[] | null
    }
  | { t: 'error'; detail: string } // モデル/WASM 初期化失敗。カメラガード無効のまま継続

let landmarker: PoseLandmarker | null = null

// lite + CPU: バトル画面は three.js が GPU を使い切るため、推論も GPU に載せると
// ワーカーからでも描画とぶつかってカクつく。CPU(WASM) 推論ならワーカーのスレッドで完結する。
createPoseLandmarker('lite', 'CPU').then(
  ({ landmarker: l }) => {
    landmarker = l
    postMessage({ t: 'ready' } satisfies WorkerMsg)
  },
  (err) => {
    // 失敗理由はページの console にも出す（原因調査用。UI には 'error' 状態だけ渡す）
    console.error('[cameraGuard.worker] pose init failed:', err)
    postMessage({ t: 'error', detail: String(err) } satisfies WorkerMsg)
  },
)

self.onmessage = (ev: MessageEvent<FrameMsg>) => {
  const { bitmap, ts } = ev.data
  if (!landmarker) {
    bitmap.close()
    return
  }
  try {
    const result = landmarker.detectForVideo(bitmap, ts)
    const lm = result.landmarks?.[0] ?? null
    postMessage({
      t: 'result',
      posed: !!lm && isBoxingGuard(lm),
      facing: lm ? bodyFacing(lm) : null,
      // 構造化クローンできる素のオブジェクト配列に落とす（クラスインスタンス対策）
      landmarks: lm
        ? lm.map(({ x, y, z, visibility }) => ({ x, y, z, visibility }))
        : null,
    } satisfies WorkerMsg)
  } catch {
    // 単発の検出失敗はスキップ扱い（busy 解除のため result は返す）
    postMessage({
      t: 'result',
      posed: false,
      facing: null,
      landmarks: null,
    } satisfies WorkerMsg)
  } finally {
    bitmap.close()
  }
}
