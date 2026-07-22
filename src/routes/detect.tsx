import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import appleUrl from '#/assets/refs/apple.png'
import bananaUrl from '#/assets/refs/banana.png'
import grapeUrl from '#/assets/refs/grape.png'
import agonekoUrl from '#/assets/refs/agoneko.png'
import { CAMERA_HEIGHT, CAMERA_WIDTH, THRESHOLDS, createCardMatcher } from '../card'
import type { CardMatch, CardMatcher, CardRef, MatchStats, RefStat } from '../card'
import { listRiders } from '../rider-registry'
import type { RegisteredRiderWithImage } from '../rider-registry'

export const Route = createFileRoute('/detect')({ component: DetectPage })

type Status = 'loading' | 'ready' | 'running' | 'error'

// プレースホルダの参照画像。登録済みライダー（/auth/register）はこの後ろに合流する。
const PLACEHOLDERS: CardRef[] = [
  { id: 'apple', label: 'リンゴ', url: appleUrl },
  { id: 'banana', label: 'バナナ', url: bananaUrl },
  { id: 'grape', label: 'ブドウ', url: grapeUrl },
  { id: 'agoneko', label: 'あごねこ', url: agonekoUrl },
]

// 落ちた理由の表示名。engine の RejectReason に対応する。
const REASON_LABEL: Record<RefStat['reason'], string> = {
  ok: '',
  'few-good': '対応不足',
  'no-homography': '変形不成立',
  degenerate: '形が退化',
  'low-ratio': '率不足',
}

const C = {
  ok: '#4ade80',
  ng: '#f87171',
  warn: '#fbbf24',
  dim: '#6b7280',
  text: '#9ca3af',
  panel: '#111827',
  bar: '#374151',
} as const

function DetectPage() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const matcherRef = useRef<CardMatcher | null>(null)
  const rafRef = useRef<number>(0)
  const isRunningRef = useRef(false)
  const overlayLabelRef = useRef<string | null>(null)
  // 特徴点の重ね描きは毎フレーム行うので、最後の stats を ref でも保持する。
  const lastStatsRef = useRef<MatchStats | null>(null)
  const showPointsRef = useRef(true)

  const [status, setStatus] = useState<Status>('loading')
  const [match, setMatch] = useState<CardMatch | null>(null)
  const [stats, setStats] = useState<MatchStats | null>(null)
  const [refs, setRefs] = useState<CardRef[]>(PLACEHOLDERS)
  const [showPoints, setShowPoints] = useState(true)
  const lastStatsUiRef = useRef(0)

  // 登録済みライダーを参照画像に合流させたうえでマッチャを用意する（debug 有効）。
  useEffect(() => {
    let cancelled = false
    let matcher: CardMatcher | null = null

    async function init() {
      let registered: RegisteredRiderWithImage[] = []
      try {
        registered = await listRiders()
      } catch {
        registered = [] // 読み込めない環境ではプレースホルダだけで続行する
      }
      if (cancelled) return

      const all: CardRef[] = [
        ...PLACEHOLDERS,
        ...registered.map((r) => ({ id: r.id, label: r.name, url: r.imageDataUrl })),
      ]
      setRefs(all)
      matcher = createCardMatcher(all, { debug: true })
      matcherRef.current = matcher
      try {
        await matcher.ready
        if (!cancelled) setStatus('ready')
      } catch {
        if (!cancelled) setStatus('error')
      }
    }
    init()

    return () => {
      cancelled = true
      isRunningRef.current = false
      cancelAnimationFrame(rafRef.current)
      matcher?.dispose()
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

    const now = performance.now()
    const current = matcher.detect(video, now)
    const label = current?.label ?? null
    if (label !== overlayLabelRef.current) {
      overlayLabelRef.current = label
      setMatch(current)
    }

    // 特徴点は毎フレーム重ねたいので ref に、パネルは 200ms ごとに state へ。
    const s = matcher.stats()
    lastStatsRef.current = s
    if (now - lastStatsUiRef.current > 200) {
      lastStatsUiRef.current = now
      setStats(s)
    }

    if (showPointsRef.current) drawPoints(ctx, canvas, lastStatsRef.current)
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
      lastStatsRef.current = null
      setMatch(null)
      setStats(null)
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
    lastStatsRef.current = null
    setMatch(null)
    setStats(null)
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
        style={{ width: '100%', maxWidth: 900, display: 'flex', alignItems: 'center', gap: '1rem' }}
      >
        <Link to="/" style={{ color: C.text, textDecoration: 'none', fontSize: '0.9rem' }}>
          ← Back
        </Link>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>画像検知ラボ</h1>
        <label
          style={{
            marginLeft: 'auto',
            fontSize: '0.8rem',
            color: C.text,
            display: 'flex',
            alignItems: 'center',
            gap: '0.35rem',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={showPoints}
            onChange={(e) => {
              setShowPoints(e.target.checked)
              showPointsRef.current = e.target.checked
            }}
          />
          特徴点を重ねる
        </label>
      </div>

      <div
        style={{
          position: 'relative',
          background: '#1f2937',
          borderRadius: 12,
          overflow: 'hidden',
          width: '100%',
          maxWidth: 900,
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
              borderRadius: 999,
              background: match ? 'rgba(74,222,128,0.9)' : 'rgba(31,41,55,0.8)',
              color: match ? '#000' : C.text,
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
              color: C.text,
            }}
          >
            {status === 'loading' && <p style={{ margin: 0 }}>参照画像を読み込み中...</p>}
            {status === 'ready' && <p style={{ margin: 0 }}>Start を押してカメラを起動</p>}
            {status === 'error' && (
              <p style={{ margin: 0, color: C.ng }}>
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
          style={buttonStyle(status === 'ready', C.ok)}
        >
          Start
        </button>
        <button
          onClick={handleStop}
          disabled={status !== 'running'}
          style={buttonStyle(status === 'running', C.ng)}
        >
          Stop
        </button>
      </div>

      <ScorePanel stats={stats} refs={refs} />

      <p style={{ color: C.dim, fontSize: '0.8rem', margin: 0, maxWidth: 900, textAlign: 'center' }}>
        灰色の点＝ORB が拾った特徴点 / 緑の点＝1位の参照画像と幾何的に整合した点（インライア）。
        緑がカード上に集まっていれば正しく効いており、灰色ばかりが背景に散っていれば
        特徴点が無駄撃ちされている。
      </p>
    </div>
  )
}

/** 参照画像ごとのスコアと、判定ゲートの通過状況を表示する。 */
function ScorePanel({ stats, refs }: { stats: MatchStats | null; refs: CardRef[] }) {
  if (!stats) {
    return (
      <div style={{ width: '100%', maxWidth: 900, color: C.dim, fontSize: '0.85rem' }}>
        Start するとここにスコアが出ます（参照画像 {refs.length} 枚）
      </div>
    )
  }

  const margin = stats.bestInliers - stats.secondInliers
  // good が伸びているのに inliers が伸びない、が一目で分かるよう両方を同じ物差しで描く。
  const scale = Math.max(THRESHOLDS.MATCH_MIN_INLIERS * 2, ...stats.refs.map((r) => r.good), 1)

  return (
    <div
      style={{
        width: '100%',
        maxWidth: 900,
        background: C.panel,
        borderRadius: 12,
        padding: '0.9rem 1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.7rem',
        fontFamily: 'monospace',
        fontSize: '0.8rem',
      }}
    >
      <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap' }}>
        <Gate
          label="sharp"
          value={stats.sharpness.toFixed(0)}
          need={`>= ${THRESHOLDS.MIN_SHARPNESS}`}
          pass={!stats.blurred}
        />
        <Gate
          label="特徴点"
          value={`${stats.frameKeypoints}`}
          need={`/ ${THRESHOLDS.ORB_FEATURES}`}
          pass={stats.frameKeypoints > 0}
        />
        <Gate
          label="1位"
          value={`${stats.bestInliers}`}
          need={`>= ${THRESHOLDS.MATCH_MIN_INLIERS}`}
          pass={stats.bestInliers >= THRESHOLDS.MATCH_MIN_INLIERS}
        />
        <Gate
          label="2位との差"
          value={`${margin}`}
          need={`>= ${THRESHOLDS.MATCH_MARGIN}`}
          pass={margin >= THRESHOLDS.MATCH_MARGIN}
        />
      </div>

      {stats.blurred ? (
        <div style={{ color: C.warn }}>ブレ検出のため照合をスキップしました</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          {stats.refs.map((r) => (
            <ScoreRow
              key={r.id}
              stat={r}
              scale={scale}
              isBest={r.label === stats.bestLabel && r.inliers > 0}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function Gate({
  label,
  value,
  need,
  pass,
}: {
  label: string
  value: string
  need: string
  pass: boolean
}) {
  return (
    <span style={{ color: C.text }}>
      {label} <strong style={{ color: pass ? C.ok : C.ng, fontSize: '1rem' }}>{value}</strong>{' '}
      <span style={{ color: C.dim }}>{need}</span>
    </span>
  )
}

/** 1参照画像ぶんの棒グラフ。薄い棒=good（比率テスト通過）、濃い棒=inliers（幾何検算通過）。 */
function ScoreRow({ stat, scale, isBest }: { stat: RefStat; scale: number; isBest: boolean }) {
  const pct = (n: number) => `${Math.min(100, (n / scale) * 100)}%`
  const ratio = stat.good > 0 ? stat.inliers / stat.good : 0
  const reason = REASON_LABEL[stat.reason]

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
      <span
        style={{
          width: 110,
          flexShrink: 0,
          color: isBest ? C.ok : C.text,
          fontWeight: isBest ? 'bold' : 'normal',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={stat.label}
      >
        {stat.label}
      </span>

      <div style={{ position: 'relative', flex: 1, height: 16, background: C.bar, borderRadius: 3 }}>
        {/* good（対応がついた総数）を薄く */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            width: pct(stat.good),
            background: 'rgba(148,163,184,0.45)',
            borderRadius: 3,
          }}
        />
        {/* inliers（幾何的に整合した数）を濃く */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            width: pct(stat.inliers),
            background: isBest ? C.ok : '#64748b',
            borderRadius: 3,
          }}
        />
        {/* MATCH_MIN_INLIERS の位置に基準線 */}
        <div
          style={{
            position: 'absolute',
            top: -2,
            bottom: -2,
            left: pct(THRESHOLDS.MATCH_MIN_INLIERS),
            width: 2,
            background: C.warn,
          }}
          title={`MATCH_MIN_INLIERS = ${THRESHOLDS.MATCH_MIN_INLIERS}`}
        />
      </div>

      <span style={{ width: 150, flexShrink: 0, color: C.dim, textAlign: 'right' }}>
        {stat.inliers}/{stat.good} 率{(ratio * 100).toFixed(0)}%
        {reason && <span style={{ color: C.warn }}> {reason}</span>}
      </span>
      <span style={{ width: 60, flexShrink: 0, color: C.dim, textAlign: 'right' }}>
        kp {stat.refKeypoints}
      </span>
    </div>
  )
}

function buttonStyle(enabled: boolean, color: string) {
  return {
    padding: '0.6rem 2rem',
    fontSize: '1rem',
    background: enabled ? color : '#374151',
    color: enabled ? '#000' : C.dim,
    border: 'none',
    borderRadius: 8,
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontWeight: 'bold',
  } as const
}

/**
 * ORB が拾った特徴点と、1位の参照画像と整合した点をプレビューに重ねる。
 * 座標は処理解像度（stats.processWidth）基準なので canvas サイズへ換算する。
 */
function drawPoints(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  stats: MatchStats | null,
) {
  if (!stats || !stats.framePoints || !stats.processWidth) return
  const k = canvas.width / stats.processWidth
  const r = Math.max(1.5, canvas.width / 500)

  ctx.save()
  // 特徴点は最大 ORB_FEATURES 個あり毎フレーム描くので、円ではなく矩形で塗る（arc より大幅に軽い）。
  ctx.fillStyle = 'rgba(148,163,184,0.55)'
  const all = stats.framePoints
  const d = r * 2
  for (let i = 0; i < all.length; i += 2) {
    ctx.fillRect(all[i] * k - r, all[i + 1] * k - r, d, d)
  }

  const inl = stats.bestInlierPoints
  if (inl && inl.length > 0) {
    ctx.fillStyle = '#4ade80'
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'
    ctx.lineWidth = 1
    for (let i = 0; i < inl.length; i += 2) {
      ctx.beginPath()
      ctx.arc(inl[i] * k, inl[i + 1] * k, r * 2, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
  }
  ctx.restore()
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
  const pad = canvas.height * 0.02
  const metrics = ctx.measureText(label)
  ctx.fillStyle = 'rgba(74,222,128,0.85)'
  ctx.fillRect(pad, pad, metrics.width + pad * 2, canvas.height * 0.11)
  ctx.fillStyle = '#000'
  ctx.fillText(label, pad * 2, pad * 1.5)
  ctx.restore()
}
