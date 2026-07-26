// カメラ（MediaPipe Pose）でボクシングの構えを検出するガード入力ソース。
// 右下の FINAL VENT CAM の <video> を共有し（1PC 1カメラ運用のため二重取得しない）、
// 構えを認識している間は guard on、解いたら guard off を発火する ＝ ポーズによる強制ガード。
// InputSource 契約に合わせてあるので、キーボードやセンサーと同列に差し替え・併用できる。
//
// 推論は Web Worker（cameraGuard.worker.ts）で実行する。メインスレッド側の仕事は
// 「一定間隔で ImageBitmap を切り出して転送する」だけなので、three.js の 60fps 描画を塞がない。

import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import type { BodyFacing } from '../pose/poses'
import type { FrameMsg, WorkerMsg } from './cameraGuard.worker'
import type { InputSource } from './input'

const DETECT_INTERVAL_MS = 66 // 解析周期（~15fps）。推論は別スレッドの CPU なので描画への影響はない
const BITMAP_WIDTH = 320 // 転送前に縮小（lite モデルの入力は小さいので精度への影響なし・転送も軽い）
const ON_FRAMES = 2 // 連続何回「構え」を見たら guard on（誤爆防止）
const OFF_FRAMES = 3 // 連続何回見失ったら guard off（ちらつき防止）
const FACING_FRAMES = 3 // 向き（正面/横）の切り替えに必要な連続フレーム数

// ポーズ解析パイプラインの状態。UI に出して「なぜ骨格が出ないか」を見えるようにする。
export type CameraGuardStatus = 'loading' | 'ready' | 'error'

export function createCameraGuardSource(
  getVideo: () => HTMLVideoElement | null,
  onGuard: (on: boolean) => void,
  // 検出結果ごとに呼ぶ（未検出は null）。プレビューの骨格オーバーレイ用。
  // 第2引数はデバウンス後の現在のガード状態（線の色分けに使う）。
  onLandmarks?: (lm: NormalizedLandmark[] | null, guarding: boolean) => void,
  // ワーカー/モデルの読み込み状態（loading → ready / error）。表示用。
  onStatus?: (status: CameraGuardStatus) => void,
  // 体の向き（true = 横向き）。デバウンス後の変化時のみ呼ぶ。
  onFacingSide?: (side: boolean) => void,
): InputSource {
  let running = false
  let rafId = 0
  let worker: Worker | null = null
  let workerReady = false
  let busy = false // 結果が返るまで次のフレームを送らない（ワーカー側に詰まらせない）
  let lastDetectAt = 0
  let lastVideoTime = -1
  let hitStreak = 0
  let missStreak = 0
  let guarding = false
  let facingStreak = 0 // 同じ向きを連続で見た回数
  let lastFacing: BodyFacing | null = null
  let facingSide = false

  const setGuard = (on: boolean) => {
    if (guarding === on) return
    guarding = on
    onGuard(on)
  }

  // デバウンス: 単発の誤検出/取りこぼしで on/off が暴れないようにする
  const onResult = (posed: boolean) => {
    if (posed) {
      hitStreak++
      missStreak = 0
      if (hitStreak >= ON_FRAMES) setGuard(true)
    } else {
      missStreak++
      hitStreak = 0
      if (missStreak >= OFF_FRAMES) setGuard(false)
    }
  }

  // 向きのデバウンス。null（見失い・低可視性）は現状維持でストリークだけリセットする。
  const onFacingResult = (facing: BodyFacing | null) => {
    if (!facing) {
      facingStreak = 0
      lastFacing = null
      return
    }
    facingStreak = facing === lastFacing ? facingStreak + 1 : 1
    lastFacing = facing
    if (facingStreak < FACING_FRAMES) return
    const side = facing === 'side'
    if (side !== facingSide) {
      facingSide = side
      onFacingSide?.(side)
    }
  }

  const loop = (t: number) => {
    if (!running) return
    rafId = requestAnimationFrame(loop)
    if (!workerReady || busy || t - lastDetectAt < DETECT_INTERVAL_MS) return

    // 映像がまだ流れていない / 新しいフレームが無いうちはスキップ
    const video = getVideo()
    if (!video || video.readyState < 2 || video.videoWidth === 0) return
    if (video.currentTime === lastVideoTime) return
    lastVideoTime = video.currentTime
    lastDetectAt = t

    busy = true
    // フレームの切り出し（デコード・縮小はブラウザ側で非同期）→ ワーカーへ所有権ごと転送。
    createImageBitmap(video, {
      resizeWidth: BITMAP_WIDTH,
      resizeQuality: 'low',
    }).then(
      (bitmap) => {
        if (!running || !worker) {
          bitmap.close()
          busy = false
          return
        }
        const msg: FrameMsg = { t: 'frame', bitmap, ts: performance.now() }
        worker.postMessage(msg, [bitmap])
      },
      () => {
        busy = false // 切り出し失敗（タブ非表示等）は次の周期で再試行
      },
    )
  }

  return {
    start() {
      if (running) return
      running = true
      onStatus?.('loading')
      worker = new Worker(new URL('./cameraGuard.worker.ts', import.meta.url), {
        type: 'module',
      })
      worker.onmessage = (ev: MessageEvent<WorkerMsg>) => {
        const msg = ev.data
        if (msg.t === 'ready') {
          workerReady = true
          onStatus?.('ready')
        } else if (msg.t === 'result') {
          busy = false
          onResult(msg.posed)
          onFacingResult(msg.facing)
          onLandmarks?.(msg.landmarks, guarding)
        } else if (msg.t === 'error') {
          // モデル/WASM の取得失敗等。カメラガードは無効のまま継続（キーボードガードは生きている）
          console.warn('[cameraGuard] pose init failed in worker:', msg.detail)
          onStatus?.('error')
        }
      }
      worker.onerror = () => {
        // ワーカー自体の起動失敗も無効のまま継続
        workerReady = false
        onStatus?.('error')
      }
      rafId = requestAnimationFrame(loop)
    },
    stop() {
      running = false
      cancelAnimationFrame(rafId)
      setGuard(false) // ガードしっぱなしで抜けない
      if (facingSide) {
        facingSide = false
        onFacingSide?.(false) // 「横向き」表示が残らないように戻す
      }
      onLandmarks?.(null, false) // オーバーレイも消す
      worker?.terminate()
      worker = null
      workerReady = false
      busy = false
    },
  }
}
