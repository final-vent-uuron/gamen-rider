// カメラ（MediaPipe Pose）でボクシングの構えを検出するガード入力ソース。
// 右下の FINAL VENT CAM の <video> を共有し（1PC 1カメラ運用のため二重取得しない）、
// 構えを認識している間は guard on、解いたら guard off を発火する ＝ ポーズによる強制ガード。
// InputSource 契約に合わせてあるので、キーボードやセンサーと同列に差し替え・併用できる。

import { createPoseLandmarker } from '../pose/landmarker'
import { isBoxingGuard } from '../pose/poses'
import type { InputSource } from './input'

// 解析周期。detectForVideo はメインスレッドを同期的に塞ぐため、three.js の 60fps 描画と
// 同居するには回数を絞るしかない（lite モデル併用で 1 回あたりの停止時間も短くする）。
const DETECT_INTERVAL_MS = 150
const ON_FRAMES = 2 // 連続何回「構え」を見たら guard on（誤爆防止）
const OFF_FRAMES = 3 // 連続何回見失ったら guard off（ちらつき防止）

export function createCameraGuardSource(
  getVideo: () => HTMLVideoElement | null,
  onGuard: (on: boolean) => void,
): InputSource {
  let running = false
  let rafId = 0
  let landmarker: Awaited<ReturnType<typeof createPoseLandmarker>>['landmarker'] | null = null
  let lastDetectAt = 0
  let lastVideoTime = -1
  let hitStreak = 0
  let missStreak = 0
  let guarding = false

  const setGuard = (on: boolean) => {
    if (guarding === on) return
    guarding = on
    onGuard(on)
  }

  const loop = (t: number) => {
    if (!running) return
    rafId = requestAnimationFrame(loop)
    if (!landmarker || t - lastDetectAt < DETECT_INTERVAL_MS) return

    // 映像がまだ流れていない / 新しいフレームが無いうちはスキップ
    const video = getVideo()
    if (!video || video.readyState < 2 || video.videoWidth === 0) return
    if (video.currentTime === lastVideoTime) return
    lastVideoTime = video.currentTime
    lastDetectAt = t

    const result = landmarker.detectForVideo(video, performance.now())
    const lm = result.landmarks?.[0]
    const posed = !!lm && isBoxingGuard(lm)

    // デバウンス: 単発の誤検出/取りこぼしで on/off が暴れないようにする
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

  return {
    start() {
      if (running) return
      running = true
      // モデルのロードは重いので非同期。stop 済みなら即クローズ。
      // バトル中は描画優先なので軽量な lite モデル（構え判定には十分）。
      createPoseLandmarker('lite')
        .then(({ landmarker: l }) => {
          if (!running) {
            l.close()
            return
          }
          landmarker = l
        })
        .catch(() => {
          // モデル取得失敗（オフライン等）はカメラガード無効のまま静かに継続
        })
      rafId = requestAnimationFrame(loop)
    },
    stop() {
      running = false
      cancelAnimationFrame(rafId)
      setGuard(false) // ガードしっぱなしで抜けない
      landmarker?.close()
      landmarker = null
    },
  }
}
