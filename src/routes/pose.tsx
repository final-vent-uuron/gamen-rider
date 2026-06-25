import { Link, createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision'

export const Route = createFileRoute('/pose')({ component: PosePage })

type MediaPipeModules = typeof import('@mediapipe/tasks-vision')
type Status = 'loading' | 'ready' | 'running' | 'error'

// ヒップ中心・体幹スケールで正規化してポーズを比較できるようにする
function normalizeLandmarks(landmarks: NormalizedLandmark[]) {
  const lHip = landmarks[23]
  const rHip = landmarks[24]
  const lShoulder = landmarks[11]
  const rShoulder = landmarks[12]

  const cx = (lHip.x + rHip.x) / 2
  const cy = (lHip.y + rHip.y) / 2
  const cz = (lHip.z + rHip.z) / 2

  const shoulderMidY = (lShoulder.y + rShoulder.y) / 2
  const scale = Math.max(Math.abs(cy - shoulderMidY), 0.01)

  return landmarks.map((lm) => ({
    x: (lm.x - cx) / scale,
    y: (lm.y - cy) / scale,
    z: (lm.z - cz) / scale,
  }))
}

function calcSimilarity(a: NormalizedLandmark[], b: NormalizedLandmark[]): number {
  const na = normalizeLandmarks(a)
  const nb = normalizeLandmarks(b)
  let sum = 0
  for (let i = 0; i < na.length; i++) {
    const dx = na[i].x - nb[i].x
    const dy = na[i].y - nb[i].y
    const dz = na[i].z - nb[i].z
    sum += Math.sqrt(dx * dx + dy * dy + dz * dz)
  }
  const avgDist = sum / na.length
  // dist=0 → 100%, dist>=2 → 0%
  return Math.max(0, Math.round((1 - avgDist / 2) * 100))
}

function scoreColor(score: number) {
  if (score >= 80) return '#4ade80'
  if (score >= 50) return '#facc15'
  return '#f87171'
}

function PosePage() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const landmarkerRef = useRef<PoseLandmarker | null>(null)
  const mpRef = useRef<MediaPipeModules | null>(null)
  const rafRef = useRef<number>(0)
  const isRunningRef = useRef(false)
  const currentLandmarksRef = useRef<NormalizedLandmark[] | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [fps, setFps] = useState(0)
  const [refPose, setRefPose] = useState<NormalizedLandmark[] | null>(null)
  const [similarity, setSimilarity] = useState<number | null>(null)
  const fpsCounterRef = useRef({ frames: 0, last: performance.now() })

  useEffect(() => {
    let cancelled = false

    async function init() {
      try {
        const mp = await import('@mediapipe/tasks-vision')
        mpRef.current = mp

        const vision = await mp.FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm',
        )
        const landmarker = await mp.PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numPoses: 1,
        })

        if (!cancelled) {
          landmarkerRef.current = landmarker
          setStatus('ready')
        }
      } catch {
        if (!cancelled) setStatus('error')
      }
    }

    init()
    return () => {
      cancelled = true
      isRunningRef.current = false
      cancelAnimationFrame(rafRef.current)
      landmarkerRef.current?.close()
    }
  }, [])

  const detect = useCallback(() => {
    if (!isRunningRef.current) return

    const video = videoRef.current
    const canvas = canvasRef.current
    const landmarker = landmarkerRef.current
    const mp = mpRef.current

    if (!video || !canvas || !landmarker || !mp || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(detect)
      return
    }

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, 0, 0)

    const results = landmarker.detectForVideo(video, performance.now())

    if (results.landmarks.length > 0) {
      const landmarks = results.landmarks[0]
      currentLandmarksRef.current = landmarks

      const drawingUtils = new mp.DrawingUtils(ctx)
      drawingUtils.drawConnectors(landmarks, mp.PoseLandmarker.POSE_CONNECTIONS, {
        color: '#22d3ee',
        lineWidth: 3,
      })
      drawingUtils.drawLandmarks(landmarks, {
        radius: 4,
        color: '#f87171',
        fillColor: '#fff',
      })
    } else {
      currentLandmarksRef.current = null
    }

    const counter = fpsCounterRef.current
    counter.frames++
    const now = performance.now()
    if (now - counter.last >= 1000) {
      setFps(Math.round((counter.frames * 1000) / (now - counter.last)))
      counter.frames = 0
      counter.last = now

      // 類似度は1秒ごとに更新（毎フレームのsetStateを避ける）
      if (currentLandmarksRef.current && refPose) {
        setSimilarity(calcSimilarity(currentLandmarksRef.current, refPose))
      } else {
        setSimilarity(null)
      }
    }

    rafRef.current = requestAnimationFrame(detect)
  }, [refPose])

  // refPoseが変わったらdetectループを再起動
  useEffect(() => {
    if (!isRunningRef.current) return
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(detect)
  }, [detect, refPose])

  async function handleStart() {
    if (!videoRef.current) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      videoRef.current.srcObject = stream
      await videoRef.current.play()
      isRunningRef.current = true
      setStatus('running')
      fpsCounterRef.current = { frames: 0, last: performance.now() }
      rafRef.current = requestAnimationFrame(detect)
    } catch {
      setStatus('error')
    }
  }

  function handleStop() {
    isRunningRef.current = false
    cancelAnimationFrame(rafRef.current)
    const video = videoRef.current
    if (video?.srcObject) {
      ;(video.srcObject as MediaStream).getTracks().forEach((t) => t.stop())
      video.srcObject = null
    }
    const canvas = canvasRef.current
    if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
    setFps(0)
    setSimilarity(null)
    setStatus('ready')
  }

  function handleRegisterPose() {
    const landmarks = currentLandmarksRef.current
    if (!landmarks) return
    setRefPose([...landmarks])
    setSimilarity(100)
  }

  function handleClearPose() {
    setRefPose(null)
    setSimilarity(null)
  }

  const canRegister = status === 'running' && currentLandmarksRef.current !== null

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '1.5rem',
        minHeight: '100vh',
        gap: '1rem',
      }}
    >
      {/* ヘッダー */}
      <div
        style={{
          width: '100%',
          maxWidth: '800px',
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
        }}
      >
        <Link to="/" style={{ color: '#9ca3af', textDecoration: 'none', fontSize: '0.9rem' }}>
          ← Back
        </Link>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>Pose Detection</h1>
        {status === 'running' && (
          <span
            style={{
              marginLeft: 'auto',
              color: '#4ade80',
              fontSize: '0.85rem',
              fontFamily: 'monospace',
            }}
          >
            {fps} FPS
          </span>
        )}
      </div>

      {/* 類似度スコア */}
      {refPose && (
        <div
          style={{
            width: '100%',
            maxWidth: '800px',
            background: '#1f2937',
            borderRadius: '12px',
            padding: '1rem 1.5rem',
            display: 'flex',
            alignItems: 'center',
            gap: '1.5rem',
          }}
        >
          <span style={{ color: '#9ca3af', fontSize: '0.9rem', whiteSpace: 'nowrap' }}>
            基準ポーズとの一致度
          </span>
          <div
            style={{
              flex: 1,
              height: '12px',
              background: '#374151',
              borderRadius: '6px',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${similarity ?? 0}%`,
                background: scoreColor(similarity ?? 0),
                borderRadius: '6px',
                transition: 'width 0.3s, background 0.3s',
              }}
            />
          </div>
          <span
            style={{
              fontSize: '1.5rem',
              fontWeight: 'bold',
              fontFamily: 'monospace',
              color: scoreColor(similarity ?? 0),
              minWidth: '4ch',
              textAlign: 'right',
            }}
          >
            {similarity !== null ? `${similarity}%` : '--'}
          </span>
          <button
            onClick={handleClearPose}
            style={{
              padding: '0.3rem 0.8rem',
              background: 'transparent',
              color: '#6b7280',
              border: '1px solid #374151',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '0.8rem',
            }}
          >
            解除
          </button>
        </div>
      )}

      {/* カメラ映像 */}
      <div
        style={{
          position: 'relative',
          background: '#1f2937',
          borderRadius: '12px',
          overflow: 'hidden',
          width: '100%',
          maxWidth: '800px',
          aspectRatio: '4/3',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <video ref={videoRef} style={{ display: 'none' }} playsInline muted />
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />

        {status !== 'running' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              gap: '0.75rem',
              color: '#9ca3af',
            }}
          >
            {status === 'loading' && <p style={{ margin: 0 }}>MediaPipe モデルを読み込み中...</p>}
            {status === 'ready' && <p style={{ margin: 0 }}>Start を押してカメラを起動</p>}
            {status === 'error' && (
              <p style={{ margin: 0, color: '#f87171' }}>
                エラーが発生しました。カメラの権限を確認してください。
              </p>
            )}
          </div>
        )}
      </div>

      {/* コントロール */}
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
        <button
          onClick={handleStart}
          disabled={status !== 'ready'}
          style={{
            padding: '0.6rem 2rem',
            fontSize: '1rem',
            background: status === 'ready' ? '#4ade80' : '#374151',
            color: status === 'ready' ? '#000' : '#6b7280',
            border: 'none',
            borderRadius: '8px',
            cursor: status === 'ready' ? 'pointer' : 'not-allowed',
            fontWeight: 'bold',
          }}
        >
          Start
        </button>
        <button
          onClick={handleStop}
          disabled={status !== 'running'}
          style={{
            padding: '0.6rem 2rem',
            fontSize: '1rem',
            background: status === 'running' ? '#f87171' : '#374151',
            color: status === 'running' ? '#000' : '#6b7280',
            border: 'none',
            borderRadius: '8px',
            cursor: status === 'running' ? 'pointer' : 'not-allowed',
            fontWeight: 'bold',
          }}
        >
          Stop
        </button>
        <button
          onClick={handleRegisterPose}
          disabled={!canRegister}
          style={{
            padding: '0.6rem 2rem',
            fontSize: '1rem',
            background: canRegister ? '#a78bfa' : '#374151',
            color: canRegister ? '#000' : '#6b7280',
            border: 'none',
            borderRadius: '8px',
            cursor: canRegister ? 'pointer' : 'not-allowed',
            fontWeight: 'bold',
          }}
        >
          {refPose ? '🔄 ポーズ更新' : '📌 ポーズ登録'}
        </button>
      </div>

      <p style={{ color: '#6b7280', fontSize: '0.8rem', margin: 0 }}>
        MediaPipe PoseLandmarker Lite · 33 landmarks · GPU delegate
      </p>
    </div>
  )
}
