import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision'

import appleUrl from '#/assets/refs/apple.png'
import bananaUrl from '#/assets/refs/banana.png'
import grapeUrl from '#/assets/refs/grape.png'
import agonekoUrl from '#/assets/refs/agoneko.png'
import { createCardMatcher } from '../../card'
import type { CardMatcher, CardRef } from '../../card'
import { RIDER_ROUTINES, createPoseLandmarker, createRoutineRunner, customToRoutine } from '../../pose'
import type { HenshinRoutine, MediaPipeModules, RoutineRunner, RunnerState } from '../../pose'
import { cardToRiderId, emitHenshin } from '../../henshin'
import { listRiders } from '../../rider-registry'
import type { RegisteredRiderWithImage } from '../../rider-registry'

export const Route = createFileRoute('/auth/')({ component: AuthPage })

type Status = 'loading' | 'running' | 'error'
// card: カードをかざす / pose: 認証したライダーの変身ポーズ / done: 認証成功
type Phase = 'card' | 'pose' | 'done'
type Rider = { id: string; name: string }

// カード認証に使う参照画像（henshin.tsx と同じ果物プレースホルダを当面流用）。
// 実カード確定時は src/assets/refs/ の差し替え＋ src/henshin/cards.ts の対応更新で対応する。
const REFERENCES: CardRef[] = [
  { id: 'apple', label: 'リンゴ', url: appleUrl },
  { id: 'banana', label: 'バナナ', url: bananaUrl },
  { id: 'grape', label: 'ブドウ', url: grapeUrl },
  { id: 'agoneko', label: 'あごねこ', url: agonekoUrl },
]

function AuthPage() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const matcherRef = useRef<CardMatcher | null>(null)
  // 認証対象の全手順（既定＋登録済みライダー）。init で確定し以後変わらない。
  const routinesRef = useRef<HenshinRoutine[]>(RIDER_ROUTINES)
  const landmarkerRef = useRef<PoseLandmarker | null>(null)
  const mpRef = useRef<MediaPipeModules | null>(null)
  const runnerRef = useRef<RoutineRunner | null>(null)
  const rafRef = useRef<number>(0)
  const isRunningRef = useRef(false)
  // rAF ループから最新フェーズ／ライダーを読むための ref（state のミラー）
  const phaseRef = useRef<Phase>('card')
  const riderRef = useRef<Rider | null>(null)
  const doneHandledRef = useRef(false)
  const lastUiRef = useRef(0)
  const lastCardLabelRef = useRef<string | null>(null)

  const [status, setStatus] = useState<Status>('loading')
  const [phase, setPhase] = useState<Phase>('card')
  const [cardLabel, setCardLabel] = useState<string | null>(null)
  const [rider, setRider] = useState<Rider | null>(null)
  const [uiState, setUiState] = useState<RunnerState | null>(null)

  const navigate = useNavigate()

  // バトルで使う GLB（R2 配信・20MB 級）を認証中に裏で先読みしておく。
  // arena3d 側の gltfCache に載るので、/battle 到達時にはロード/パース済みで即表示される。
  // dynamic import なので three.js のチャンクもここで温まる。
  useEffect(() => {
    import('../../battle/arena3d').then((m) => m.preloadRiderModels())
  }, [])

  // 認証成功の演出を少し見せてから、そのライダーでバトル画面へ自動遷移（本番フロー）。
  // /henshin と同じ受け渡し（search.rider）で /battle に入る。
  useEffect(() => {
    if (phase !== 'done' || !rider) return
    const t = setTimeout(() => {
      navigate({ to: '/battle', search: { rider: rider.id } })
    }, 1400)
    return () => clearTimeout(t)
  }, [phase, rider, navigate])

  // ロード完了後すぐカメラを起動してカード認証から開始する（Start ボタンなし）
  useEffect(() => {
    let cancelled = false

    async function init() {
      try {
        // 登録済みライダー（/auth/register で作成）を参照画像と変身手順に合流させる。
        // 読み込み失敗時（デプロイ先など）はプレースホルダのみで続行する。
        let registered: RegisteredRiderWithImage[] = []
        try {
          registered = await listRiders()
        } catch {
          registered = []
        }
        if (cancelled) return

        const refs: CardRef[] = [
          ...REFERENCES,
          ...registered.map((r) => ({ id: r.id, label: r.name, url: r.imageDataUrl })),
        ]
        routinesRef.current = [
          ...RIDER_ROUTINES,
          ...registered.map((r) =>
            customToRoutine({ riderId: r.id, riderName: r.name, steps: r.steps }),
          ),
        ]
        const matcher = createCardMatcher(refs)
        matcherRef.current = matcher

        const [, { mp, landmarker }] = await Promise.all([matcher.ready, createPoseLandmarker()])
        if (cancelled) {
          landmarker.close()
          return
        }
        mpRef.current = mp
        landmarkerRef.current = landmarker

        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        const video = videoRef.current
        if (cancelled || !video) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        video.srcObject = stream
        await video.play()
        isRunningRef.current = true
        setStatus('running')
        rafRef.current = requestAnimationFrame(tick)
      } catch {
        if (!cancelled) setStatus('error')
      }
    }
    init()

    return () => {
      cancelled = true
      isRunningRef.current = false
      cancelAnimationFrame(rafRef.current)
      stopCamera()
      matcherRef.current?.dispose()
      matcherRef.current = null
      landmarkerRef.current?.close()
    }
  }, [])

  function stopCamera() {
    const video = videoRef.current
    if (video?.srcObject) {
      ;(video.srcObject as MediaStream).getTracks().forEach((t) => t.stop())
      video.srcObject = null
    }
  }

  // カード確定 → そのライダーのポーズ認証へ遷移
  function enterPose(cardId: string) {
    const routines = routinesRef.current
    // 登録ライダーはカードid＝riderId。プレースホルダ（果物）は対応表で変換する。
    const riderId = routines.some((r) => r.riderId === cardId) ? cardId : cardToRiderId(cardId)
    if (!riderId) return // 対応するライダーが無いカード（果物の他種など）は無視
    const routine = routines.find((r) => r.riderId === riderId)
    if (!routine) return
    const r: Rider = { id: riderId, name: routine.riderName }
    riderRef.current = r
    runnerRef.current = createRoutineRunner(routines, riderId)
    phaseRef.current = 'pose'
    setRider(r)
    setUiState(runnerRef.current.getState())
    setPhase('pose')
  }

  // 認証成功 → 上位（ルーム/バトル担当）へ通知し、カメラを止めて成功画面へ
  function finishAuth() {
    const r = riderRef.current
    if (!r) return
    phaseRef.current = 'done'
    const result = { riderId: r.id, riderName: r.name }
    console.log('[auth] emit', result)
    emitHenshin(result)
    isRunningRef.current = false
    cancelAnimationFrame(rafRef.current)
    stopCamera()
    setPhase('done')
  }

  function tick() {
    if (!isRunningRef.current) return
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(tick)
      return
    }

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')!
    const now = performance.now()

    if (phaseRef.current === 'card') {
      // カードフェーズ: 等倍プレビュー＋ラベル。検出は matcher 任せ（間引き＋安定化済み）。
      ctx.drawImage(video, 0, 0)
      const match = matcherRef.current?.detect(video, now) ?? null
      const label = match?.label ?? null
      if (label !== lastCardLabelRef.current) {
        lastCardLabelRef.current = label
        setCardLabel(label)
      }
      drawCardOverlay(ctx, canvas, label)
      if (match) enterPose(match.id)
    } else if (phaseRef.current === 'pose') {
      // ポーズフェーズ: 骨格つき自撮りミラー表示
      const landmarker = landmarkerRef.current
      const mp = mpRef.current
      const runner = runnerRef.current
      let landmarks: NormalizedLandmark[] | null = null
      if (landmarker && mp) {
        const results = landmarker.detectForVideo(video, now)
        landmarks = results.landmarks.length > 0 ? results.landmarks[0] : null
      }

      let active = false
      if (runner) {
        const state = runner.update(landmarks, now)
        active = state.steps.some((s) => s.active)
        if (state.matchedRiderId && !doneHandledRef.current) {
          doneHandledRef.current = true
          finishAuth()
          return
        }
        if (now - lastUiRef.current >= 100) {
          lastUiRef.current = now
          setUiState(state)
        }
      }

      // 自撮りミラー（映像と骨格をまとめて左右反転。判定は生座標なので影響なし）
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.translate(canvas.width, 0)
      ctx.scale(-1, 1)
      ctx.drawImage(video, 0, 0)
      if (landmarks && mp) {
        const drawingUtils = new mp.DrawingUtils(ctx)
        drawingUtils.drawConnectors(landmarks, mp.PoseLandmarker.POSE_CONNECTIONS, {
          color: active ? '#4ade80' : '#22d3ee',
          lineWidth: 3,
        })
        drawingUtils.drawLandmarks(landmarks, { radius: 4, color: '#f87171', fillColor: '#fff' })
      }
      ctx.restore()
    }

    rafRef.current = requestAnimationFrame(tick)
  }

  // ---- 認証成功画面（同一ページ内で切替） ----
  if (phase === 'done') {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          gap: '1.5rem',
          background: '#022c22',
        }}
      >
        <div style={{ fontSize: '5rem' }}>✅</div>
        <h1 style={{ margin: 0, fontSize: '2.5rem', color: '#4ade80' }}>認証成功</h1>
        <p style={{ margin: 0, fontSize: '1.5rem', color: '#fff' }}>
          変身: <strong style={{ color: '#a78bfa' }}>{rider?.name}</strong>
        </p>
        <p style={{ margin: 0, color: '#9ca3af', fontSize: '1rem' }}>
          まもなくバトルへ移行します…
        </p>
      </div>
    )
  }

  const step = uiState?.steps[0] ?? null
  const routine = rider ? routinesRef.current.find((r) => r.riderId === rider.id) : null

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
      <div style={{ width: '100%', maxWidth: '800px', display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>ライダー認証</h1>
        <Link
          to="/auth/register"
          style={{
            marginLeft: 'auto',
            padding: '0.4rem 1rem',
            background: '#a78bfa',
            color: '#000',
            borderRadius: '8px',
            textDecoration: 'none',
            fontWeight: 'bold',
            fontSize: '0.9rem',
          }}
        >
          ➕ ライダー登録
        </Link>
      </div>

      {/* フェーズインジケータ */}
      <div style={{ width: '100%', maxWidth: '800px', display: 'flex', gap: '0.5rem' }}>
        {(['card', 'pose', 'done'] as Phase[]).map((p, i) => {
          const order: Phase[] = ['card', 'pose', 'done']
          const cur = order.indexOf(phase)
          const done = i < cur
          const current = i === cur
          const labels = { card: '1. カード認証', pose: '2. ポーズ認証', done: '3. 認証成功' }
          return (
            <div
              key={p}
              style={{
                flex: 1,
                padding: '0.5rem',
                textAlign: 'center',
                borderRadius: '8px',
                background: current ? '#a78bfa' : done ? '#064e3b' : '#1f2937',
                color: current ? '#000' : done ? '#4ade80' : '#6b7280',
                fontWeight: 'bold',
                fontSize: '0.9rem',
              }}
            >
              {labels[p]}
            </div>
          )
        })}
      </div>

      {/* ステータスパネル */}
      <div
        style={{
          width: '100%',
          maxWidth: '800px',
          background: '#1f2937',
          borderRadius: '12px',
          padding: '1rem 1.5rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
        }}
      >
        {phase === 'card' && (
          <span style={{ fontSize: '1.1rem' }}>
            {status === 'running'
              ? cardLabel
                ? `カード認識中: ${cardLabel}`
                : 'カードをカメラにかざしてください…'
              : '準備中…'}
          </span>
        )}

        {phase === 'pose' && step && (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
              <span style={{ color: '#a78bfa', fontWeight: 'bold' }}>{rider?.name}</span>
              <span style={{ color: '#9ca3af', fontSize: '0.85rem', fontFamily: 'monospace' }}>
                STEP {step.stepIndex + 1} / {step.stepCount}
              </span>
              <span style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>{step.label}</span>
              {step.active && (
                <span style={{ marginLeft: 'auto', color: '#4ade80', fontSize: '0.85rem' }}>検出中…</span>
              )}
            </div>
            <div style={{ height: '12px', background: '#374151', borderRadius: '6px', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${Math.round(step.progress * 100)}%`,
                  background: step.active ? '#4ade80' : '#6b7280',
                  borderRadius: '6px',
                  transition: 'width 0.1s linear, background 0.2s',
                }}
              />
            </div>
            {routine && (
              <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                {routine.steps.map((s, i) => {
                  const sdone = i < step.stepIndex
                  const scurrent = i === step.stepIndex
                  return (
                    <span
                      key={s.id}
                      style={{
                        fontSize: '0.85rem',
                        color: sdone ? '#4ade80' : scurrent ? '#fff' : '#6b7280',
                        fontWeight: scurrent ? 'bold' : 'normal',
                      }}
                    >
                      {sdone ? '✅' : scurrent ? '▶' : '○'} {i + 1}. {s.label}
                    </span>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>

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
            {status === 'loading' && <p style={{ margin: 0 }}>カード認識とポーズ認識を準備中...</p>}
            {status === 'error' && (
              <p style={{ margin: 0, color: '#f87171' }}>
                エラーが発生しました。カメラの権限を確認してください。
              </p>
            )}
          </div>
        )}
      </div>

      <p style={{ color: '#6b7280', fontSize: '0.8rem', margin: 0 }}>
        カード認証（ORB）→ ポーズ認証（MediaPipe）→ 認証成功で onHenshin を発火。
      </p>
    </div>
  )
}

/** カードフェーズ: 認識中ラベルを映像の上に重ねる。 */
function drawCardOverlay(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, label: string | null) {
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
