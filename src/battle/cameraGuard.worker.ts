// カメラガードの MediaPipe 推論を回す Web Worker。
// detectForVideo は呼んだスレッドを同期的に塞ぐため、メインスレッド（three.js の 60fps 描画）
// から切り離してここで実行する。メイン側からフレーム(ImageBitmap)を受け取り、
// 「ボクシングの構えか」の真偽値だけを返す。デバウンスはメイン側（cameraGuard.ts）が行う。

import type { PoseLandmarker } from '@mediapipe/tasks-vision'
import { createPoseLandmarker } from '../pose/landmarker'
import { isBoxingGuard } from '../pose/poses'

export interface FrameMsg {
  t: 'frame'
  bitmap: ImageBitmap
  ts: number // performance.now()（メイン側）。detectForVideo は単調増加のタイムスタンプが必要
}

export type WorkerMsg =
  | { t: 'ready' } // モデルロード完了。メイン側はこれを待ってからフレームを送る
  | { t: 'result'; posed: boolean }
  | { t: 'error' } // モデル取得失敗（オフライン等）。カメラガード無効のまま継続

let landmarker: PoseLandmarker | null = null

// lite + CPU: バトル画面は three.js が GPU を使い切るため、推論も GPU に載せると
// ワーカーからでも描画とぶつかってカクつく。CPU(WASM) 推論ならワーカーのスレッドで完結する。
createPoseLandmarker('lite', 'CPU').then(
  ({ landmarker: l }) => {
    landmarker = l
    postMessage({ t: 'ready' } satisfies WorkerMsg)
  },
  () => postMessage({ t: 'error' } satisfies WorkerMsg),
)

self.onmessage = (ev: MessageEvent<FrameMsg>) => {
  const { bitmap, ts } = ev.data
  if (!landmarker) {
    bitmap.close()
    return
  }
  try {
    const result = landmarker.detectForVideo(bitmap, ts)
    const lm = result.landmarks?.[0]
    postMessage({ t: 'result', posed: !!lm && isBoxingGuard(lm) } satisfies WorkerMsg)
  } catch {
    // 単発の検出失敗はスキップ扱い（busy 解除のため result は返す）
    postMessage({ t: 'result', posed: false } satisfies WorkerMsg)
  } finally {
    bitmap.close()
  }
}
