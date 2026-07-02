import type { PoseLandmarker } from '@mediapipe/tasks-vision'

// @mediapipe/tasks-vision モジュール全体の型（DrawingUtils や POSE_CONNECTIONS を使うため）
export type MediaPipeModules = typeof import('@mediapipe/tasks-vision')

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm'
// full モデル: lite よりランドマーク（特に z）が安定し認識精度が上がる
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task'

// MediaPipe PoseLandmarker を生成する。pose.tsx（調整ラボ）と henshin.tsx（変身フロー）が共有する。
// クライアント（ブラウザ）でのみ呼ぶこと。返り値の mp は描画ユーティリティ用に保持する。
export async function createPoseLandmarker(): Promise<{
  mp: MediaPipeModules
  landmarker: PoseLandmarker
}> {
  const mp = await import('@mediapipe/tasks-vision')
  const vision = await mp.FilesetResolver.forVisionTasks(WASM_BASE)
  const landmarker = await mp.PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numPoses: 1,
  })
  return { mp, landmarker }
}
