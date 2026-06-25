import { Link, createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'

import appleUrl from '#/assets/refs/apple.png'
import bananaUrl from '#/assets/refs/banana.png'
import grapeUrl from '#/assets/refs/grape.png'
import agonekoUrl from '#/assets/refs/agoneko.png'

export const Route = createFileRoute('/detect')({ component: DetectPage })

type Status = 'loading' | 'ready' | 'running' | 'error'

// 照合に使う参照画像。label を変えればそのまま表示名になる。
// 画像を差し替える場合は src/assets/refs/ のファイルを置き換えるだけでよい。
const REFERENCES = [
  { id: 'apple', label: 'リンゴ', url: appleUrl },
  { id: 'banana', label: 'バナナ', url: bananaUrl },
  { id: 'grape', label: 'ブドウ', url: grapeUrl },
  { id: 'agoneko', label: 'あごねこ', url: agonekoUrl },
] as const

// 特徴量の解像度（GRID×GRID セルの平均色ベクトル）。
const GRID = 12
const FEATURE_LEN = GRID * GRID * 3
// マッチと判定する最低コサイン類似度。
const MATCH_THRESHOLD = 0.9
// 1位と2位の差。これ未満なら「どれか曖昧」として未確定にする。
const MATCH_MARGIN = 0.02
// 同じ結果がこの回数連続したら確定（チラつき防止）。
const STABLE_FRAMES = 5

type Reference = (typeof REFERENCES)[number]
type RefSignature = { ref: Reference; feature: Float32Array }

/** canvas/画像を GRID×GRID に縮小し、L2 正規化した平均色ベクトルにする。 */
function signatureFrom(
  source: CanvasImageSource,
  scratch: HTMLCanvasElement,
): Float32Array {
  const ctx = scratch.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(source, 0, 0, GRID, GRID)
  const { data } = ctx.getImageData(0, 0, GRID, GRID)

  const feature = new Float32Array(FEATURE_LEN)
  for (let i = 0; i < GRID * GRID; i++) {
    feature[i * 3] = data[i * 4]
    feature[i * 3 + 1] = data[i * 4 + 1]
    feature[i * 3 + 2] = data[i * 4 + 2]
  }

  let norm = 0
  for (let i = 0; i < FEATURE_LEN; i++) norm += feature[i] * feature[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < FEATURE_LEN; i++) feature[i] /= norm
  return feature
}

/** 正規化済みベクトル同士のコサイン類似度（= 内積）。 */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < FEATURE_LEN; i++) dot += a[i] * b[i]
  return dot
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })
}

function DetectPage() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scratchRef = useRef<HTMLCanvasElement | null>(null)
  const signaturesRef = useRef<RefSignature[]>([])
  const rafRef = useRef<number>(0)
  const isRunningRef = useRef(false)
  const stableRef = useRef<{ id: string | null; count: number }>({ id: null, count: 0 })

  const [status, setStatus] = useState<Status>('loading')
  const [match, setMatch] = useState<{ label: string; score: number } | null>(null)

  // 参照画像を読み込んで特徴量を事前計算する。
  useEffect(() => {
    let cancelled = false
    const scratch = document.createElement('canvas')
    scratch.width = GRID
    scratch.height = GRID
    scratchRef.current = scratch

    async function init() {
      try {
        const signatures = await Promise.all(
          REFERENCES.map(async (ref) => ({
            ref,
            feature: signatureFrom(await loadImage(ref.url), scratch),
          })),
        )
        if (!cancelled) {
          signaturesRef.current = signatures
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
    }
  }, [])

  const detect = useCallback(() => {
    if (!isRunningRef.current) return

    const video = videoRef.current
    const canvas = canvasRef.current
    const scratch = scratchRef.current
    if (!video || !canvas || !scratch || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(detect)
      return
    }

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, 0, 0)

    // 現在フレームの特徴量を各参照画像と照合し、最良・次点を求める。
    const frame = signatureFrom(video, scratch)
    let best: { ref: Reference; score: number } | null = null
    let second = -1
    for (const { ref, feature } of signaturesRef.current) {
      const score = cosine(frame, feature)
      if (!best || score > best.score) {
        if (best) second = best.score
        best = { ref, score }
      } else if (score > second) {
        second = score
      }
    }

    const confident =
      best !== null && best.score >= MATCH_THRESHOLD && best.score - second >= MATCH_MARGIN
    const currentId = confident ? best!.ref.id : null

    // 同じ結果が連続したときだけ表示を更新する。
    const stable = stableRef.current
    if (currentId === stable.id) {
      stable.count++
    } else {
      stable.id = currentId
      stable.count = 1
    }
    if (stable.count === STABLE_FRAMES) {
      setMatch(confident ? { label: best!.ref.label, score: best!.score } : null)
    }

    drawOverlay(ctx, canvas, confident ? best!.ref.label : null)

    rafRef.current = requestAnimationFrame(detect)
  }, [])

  async function handleStart() {
    if (!videoRef.current) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      videoRef.current.srcObject = stream
      await videoRef.current.play()
      isRunningRef.current = true
      stableRef.current = { id: null, count: 0 }
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
            {(match.score * 100).toFixed(1)}%
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
            {status === 'loading' && <p style={{ margin: 0 }}>参照画像を読み込み中...</p>}
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
        参照画像とのカラー特徴照合（コサイン類似度）· 用意した画像をカメラ全体に大きく映してください
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
