import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import appleUrl from '#/assets/refs/apple.png'
import bananaUrl from '#/assets/refs/banana.png'
import grapeUrl from '#/assets/refs/grape.png'
import agonekoUrl from '#/assets/refs/agoneko.png'
import { CAMERA_HEIGHT, CAMERA_WIDTH, createCardMatcher } from '../card'
import type { CardMatch, CardMatcher, CardRef } from '../card'

export const Route = createFileRoute('/detect')({ component: DetectPage })

type Status = 'loading' | 'ready' | 'running' | 'error'

// 照合に使う参照画像。label を変えればそのまま表示名になる。
// 画像を差し替える場合は src/assets/refs/ のファイルを置き換えるだけでよい。
const REFERENCES: CardRef[] = [
  { id: 'apple', label: 'リンゴ', url: appleUrl },
  { id: 'banana', label: 'バナナ', url: bananaUrl },
  { id: 'grape', label: 'ブドウ', url: grapeUrl },
  { id: 'agoneko', label: 'あごねこ', url: agonekoUrl },
]

function DetectPage() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const matcherRef = useRef<CardMatcher | null>(null)
  const rafRef = useRef<number>(0)
  const isRunningRef = useRef(false)
  // 毎フレーム重ねる確定ラベル（matcher が返す安定値）。
  const overlayLabelRef = useRef<string | null>(null)

  const [status, setStatus] = useState<Status>('loading')
  const [match, setMatch] = useState<CardMatch | null>(null)

  // カードマッチャ（OpenCV ロード＋参照画像の特徴量事前計算）を用意する。
  useEffect(() => {
    const matcher = createCardMatcher(REFERENCES)
    matcherRef.current = matcher
    let cancelled = false
    matcher.ready
      .then(() => {
        if (!cancelled) setStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })
    return () => {
      cancelled = true
      isRunningRef.current = false
      cancelAnimationFrame(rafRef.current)
      matcher.dispose()
      matcherRef.current = null
    }
  }, [])

  function detect() {
    if (!isRunningRef.current) return

    const video = videoRef.current
    const canvas = canvasRef.current
    const matcher = matcherRef.current
    if (!video || !canvas || !matcher || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(detect)
      return
    }

    // 表示用：フル解像度で毎フレーム描画（プレビューは常に滑らか）。
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, 0, 0)

    // 検出は matcher が間引き＋安定化して「確定中のマッチ」を返す。
    const current = matcher.detect(video, performance.now())
    const label = current?.label ?? null
    if (label !== overlayLabelRef.current) {
      overlayLabelRef.current = label
      setMatch(current)
    }

    // 最後に確定したラベルを毎フレーム重ねる。
    drawOverlay(ctx, canvas, overlayLabelRef.current)

    rafRef.current = requestAnimationFrame(detect)
  }

  async function handleStart() {
    if (!videoRef.current) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: CAMERA_WIDTH },
          height: { ideal: CAMERA_HEIGHT },
        },
        audio: false,
      })
      videoRef.current.srcObject = stream
      await videoRef.current.play()
      isRunningRef.current = true
      matcherRef.current?.reset()
      overlayLabelRef.current = null
      setMatch(null)
      setStatus('running')
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
    overlayLabelRef.current = null
    setMatch(null)
    setStatus('ready')
  }

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
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>画像検知</h1>
        {status === 'running' && match && (
          <span
            style={{
              marginLeft: 'auto',
              color: '#4ade80',
              fontSize: '0.85rem',
              fontFamily: 'monospace',
            }}
          >
            {match.inliers} pts
          </span>
        )}
      </div>

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

        {status === 'running' && (
          <div
            style={{
              position: 'absolute',
              top: '1rem',
              left: '50%',
              transform: 'translateX(-50%)',
              padding: '0.5rem 1.5rem',
              borderRadius: '999px',
              background: match ? 'rgba(74,222,128,0.9)' : 'rgba(31,41,55,0.8)',
              color: match ? '#000' : '#9ca3af',
              fontSize: '1.4rem',
              fontWeight: 'bold',
              transition: 'background 0.2s',
            }}
          >
            {match ? match.label : '画像をかざしてください…'}
          </div>
        )}

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
            {status === 'loading' && <p style={{ margin: 0 }}>モデルと参照画像を読み込み中...</p>}
            {status === 'ready' && <p style={{ margin: 0 }}>Start を押してカメラを起動</p>}
            {status === 'error' && (
              <p style={{ margin: 0, color: '#f87171' }}>
                エラーが発生しました。カメラの権限を確認してください。
              </p>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '0.75rem' }}>
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
      </div>

      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
        {REFERENCES.map((ref) => (
          <div
            key={ref.id}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem' }}
          >
            <img
              src={ref.url}
              alt={ref.label}
              style={{
                width: 48,
                height: 48,
                objectFit: 'cover',
                borderRadius: 8,
                border:
                  match?.label === ref.label ? '2px solid #4ade80' : '2px solid transparent',
              }}
            />
            <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>{ref.label}</span>
          </div>
        ))}
      </div>

      <p style={{ color: '#6b7280', fontSize: '0.8rem', margin: 0 }}>
        ORB 特徴点マッチング（OpenCV.js）· 用意した画像をカメラにかざしてください（離れていても・斜めでも・背景込みでOK）
      </p>
    </div>
  )
}

/** 検知中ラベルを映像の上に重ねる。 */
function drawOverlay(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  label: string | null,
) {
  if (!label) return
  ctx.save()
  ctx.font = `bold ${Math.round(canvas.height * 0.08)}px sans-serif`
  ctx.textBaseline = 'top'
  const text = label
  const pad = canvas.height * 0.02
  const metrics = ctx.measureText(text)
  ctx.fillStyle = 'rgba(74,222,128,0.85)'
  ctx.fillRect(pad, pad, metrics.width + pad * 2, canvas.height * 0.11)
  ctx.fillStyle = '#000'
  ctx.fillText(text, pad * 2, pad * 1.5)
  ctx.restore()
}
