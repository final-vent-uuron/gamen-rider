import type { PoseLandmarker } from '@mediapipe/tasks-vision'
// WASM は node_modules から Vite の ?url アセットとして取り込む（ビルドに同梱され、
// パッケージ更新にも自動追従する）。以前は jsdelivr CDN 直参照で、会場のネット事情や
// 広告ブロッカーで無言で失敗するとポーズ検出が一切動かなくなった。
// ※ public/ に置いた JS は Vite がソースからの import を禁止しているため ?url を使う。
import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url'
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url'

// @mediapipe/tasks-vision モジュール全体の型（DrawingUtils や POSE_CONNECTIONS を使うため）
export type MediaPipeModules = typeof import('@mediapipe/tasks-vision')

// モデル（.task）は public/mediapipe/ に同梱して自前配信（fetch されるだけなので public で OK）。
// full: lite よりランドマーク（特に z）が安定し認識精度が上がる → 変身のポーズ認証用。
// lite: 推論が軽い（メインスレッドを塞ぐ時間が短い）→ バトル中のカメラガード用。
//       ガード判定（両拳が顔の前）は大まかな位置関係しか見ないので lite で足りる。
const MODEL_URLS = {
  full: '/mediapipe/pose_landmarker_full.task',
  lite: '/mediapipe/pose_landmarker_lite.task',
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
  // FilesetResolver.forVisionTasks(basePath) は使わず fileset を自前で組む。
  // （SIMD 判定をして nosimd 版へフォールバックする仕組みだが、対象は数年前のブラウザのみ。
  //   常に SIMD 版を指す。）
  const vision = { wasmLoaderPath: wasmLoaderUrl, wasmBinaryPath: wasmBinaryUrl }
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
