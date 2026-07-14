import type { PoseLandmarker } from '@mediapipe/tasks-vision'

// @mediapipe/tasks-vision モジュール全体の型（DrawingUtils や POSE_CONNECTIONS を使うため）
export type MediaPipeModules = typeof import('@mediapipe/tasks-vision')

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm'
// full: lite よりランドマーク（特に z）が安定し認識精度が上がる → 変身のポーズ認証用。
// lite: 推論が軽い（メインスレッドを塞ぐ時間が短い）→ バトル中のカメラガード用。
//       ガード判定（両拳が顔の前）は大まかな位置関係しか見ないので lite で足りる。
const MODEL_URLS = {
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
} as const

export type PoseModel = keyof typeof MODEL_URLS

// MediaPipe PoseLandmarker を生成する。pose.tsx（調整ラボ）と henshin.tsx（変身フロー）が共有する。
// クライアント（ブラウザ）でのみ呼ぶこと。返り値の mp は描画ユーティリティ用に保持する。
// delegate:
//   GPU（既定）… 推論が速い。変身フローなど 3D 描画と同居しない画面向け。
//   CPU        … three.js と同居する画面（バトル中のカメラガード）向け。GPU 推論は
//                ワーカーに移しても同じ GPU を奪い合って描画を止めるため、CPU で回す。
export async function createPoseLandmarker(
  model: PoseModel = 'full',
  delegate: 'GPU' | 'CPU' = 'GPU',
): Promise<{
  mp: MediaPipeModules
  landmarker: PoseLandmarker
}> {
  const mp = await import('@mediapipe/tasks-vision')
  const vision = await mp.FilesetResolver.forVisionTasks(WASM_BASE)
  const landmarker = await mp.PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: MODEL_URLS[model],
      delegate,
    },
    runningMode: 'VIDEO',
    numPoses: 1,
  })
  return { mp, landmarker }
}
