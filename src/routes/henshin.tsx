import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision'

import { CAMERA_HEIGHT, CAMERA_WIDTH, createCardMatcher } from '../card'
import type { CardMatch, CardMatcher, CardRef } from '../card'
import { RIDER_ROUTINES, createPoseLandmarker, createRoutineRunner, customToRoutine } from '../pose'
import type { HenshinRoutine, MediaPipeModules, RoutineRunner, RunnerState } from '../pose'
import { cardToRiderId, emitHenshin } from '../henshin'
import { listRiders } from '../rider-registry'
import type { RegisteredRiderWithImage } from '../rider-registry'

export const Route = createFileRoute('/henshin')({ component: HenshinPage })

type Status = 'loading' | 'ready' | 'running' | 'error'
// card: カードをかざす / pose: 認証したライダーの変身ポーズ / done: 変身成立
type Phase = 'card' | 'pose' | 'done'
type Rider = { id: string; name: string }

function HenshinPage() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const matcherRef = useRef<CardMatcher | null>(null)
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
  const lastCardIdRef = useRef<string | null>(null)
  // 登録ライダー（/auth/register）から作った変身手順。参照画像と対で読み込む。
  const routinesRef = useRef<HenshinRoutine[]>(RIDER_ROUTINES)

  const [status, setStatus] = useState<Status>('loading')
  // かざせるカードのヒント表示用。読み込み後に確定するので state で持つ。
  const [refs, setRefs] = useState<CardRef[]>([])
  const [phase, setPhase] = useState<Phase>('card')
  const [card, setCard] = useState<CardMatch | null>(null)
  const [rider, setRider] = useState<Rider | null>(null)
  const [uiState, setUiState] = useState<RunnerState | null>(null)

  const navigate = useNavigate()

  // 変身成立の演出を少し見せてから、センサーペアリング画面へ自動遷移。
  // （/pairing でリングの接続・入力テストをしてから「バトルへ →」で /battle に進む）
  // Stop / やり直し で phase が変わると setTimeout はクリーンアップで解除される。
  useEffect(() => {
    if (phase !== 'done' || !rider || status !== 'running') return
    const t = setTimeout(() => {
      navigate({ to: '/pairing', search: { rider: rider.id } })
    }, 1200)
    return () => clearTimeout(t)
  }, [phase, rider, status, navigate])

  // 登録ライダーの参照画像＋変身手順を読み、カードマッチャと PoseLandmarker を並行ロードする。
  useEffect(() => {
    let cancelled = false
    let matcher: CardMatcher | null = null

    async function init() {
      try {
        // 登録済みライダー（/auth/register で作成）が参照画像と変身手順の供給源。
        let registered: RegisteredRiderWithImage[] = []
        try {
          registered = await listRiders()
        } catch {
          registered = [] // 読み込み失敗時（デプロイ先など）はカード認証なしで続行する
        }
        if (cancelled) return

        const cardRefs: CardRef[] = registered.map((r) => ({
          id: r.id,
          label: r.name,
          url: r.imageDataUrl,
        }))
        routinesRef.current = [
          ...RIDER_ROUTINES,
          ...registered.map((r) =>
            customToRoutine({ riderId: r.id, riderName: r.name, steps: r.steps }),
          ),
        ]
        setRefs(cardRefs)
        matcher = createCardMatcher(cardRefs)
        matcherRef.current = matcher

        const [, { mp, landmarker }] = await Promise.all([matcher.ready, createPoseLandmarker()])
        if (cancelled) {
          landmarker.close()
          return
        }
        mpRef.current = mp
        landmarkerRef.current = landmarker
        setStatus('ready')
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
      landmarkerRef.current?.close()
    }
  }, [])

  // カード確定 → そのライダーのポーズ認証へ遷移
  function enterPose(cardId: string) {
    const routines = routinesRef.current
    // 登録ライダーはカードid＝riderId。それ以外は対応表で変換する。
    const riderId = routines.some((r) => r.riderId === cardId) ? cardId : cardToRiderId(cardId)
    if (!riderId) return // 対応するライダーが無いカードは無視
    const routine = routines.find((r) => r.riderId === riderId)
    const r: Rider = { id: riderId, name: routine?.riderName ?? riderId }
    riderRef.current = r
    runnerRef.current = createRoutineRunner(routines, riderId)
    phaseRef.current = 'pose'
    setRider(r)
    setUiState(runnerRef.current.getState())
    setPhase('pose')
  }

  // 変身成立 → 上位（ルーム/バトル担当）へ通知
  function finishHenshin() {
    const r = riderRef.current
    if (!r) return
    phaseRef.current = 'done'
    const result = { riderId: r.id, riderName: r.name }
    console.log('[henshin] emit', result)
    emitHenshin(result)
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
      const id = match?.id ?? null
      if (id !== lastCardIdRef.current) {
        lastCardIdRef.current = id
        setCard(match)
      }
      drawCardOverlay(ctx, canvas, match?.label ?? null)
      // 対応ライダーがあるカードだけ次へ進む。無いカードは表示で明示（下の JSX）。
      if (match) enterPose(match.id)
    } else {
      // ポーズフェーズ / done: 骨格つき自撮りミラー表示
      const landmarker = landmarkerRef.current
      const mp = mpRef.current
      const runner = runnerRef.current
      let landmarks: NormalizedLandmark[] | null = null
      if (landmarker && mp) {
        const results = landmarker.detectForVideo(video, now)
        landmarks = results.landmarks.length > 0 ? results.landmarks[0] : null
      }

      let active = false
      if (phaseRef.current === 'pose' && runner) {
        const state = runner.update(landmarks, now)
        active = state.steps.some((s) => s.active)
        if (state.matchedRiderId && !doneHandledRef.current) {
          doneHandledRef.current = true
          finishHenshin()
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
          color: active || phaseRef.current === 'done' ? '#4ade80' : '#22d3ee',
          lineWidth: 3,
        })
        drawingUtils.drawLandmarks(landmarks, { radius: 4, color: '#f87171', fillColor: '#fff' })
      }
      ctx.restore()
    }

    rafRef.current = requestAnimationFrame(tick)
  }

  async function handleStart() {
    if (!videoRef.current) return
    try {
      // カード認証の精度は取得解像度に直結する（/auth と同じ指定に揃える）。
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: CAMERA_WIDTH }, height: { ideal: CAMERA_HEIGHT } },
        audio: false,
      })
      videoRef.current.srcObject = stream
      await videoRef.current.play()
      // フローを最初（カード認証）から開始
      matcherRef.current?.reset()
      runnerRef.current = null
      riderRef.current = null
      doneHandledRef.current = false
      lastUiRef.current = 0
      lastCardIdRef.current = null
      phaseRef.current = 'card'
      setRider(null)
      setUiState(null)
      setCard(null)
      setPhase('card')
      isRunningRef.current = true
      setStatus('running')
      rafRef.current = requestAnimationFrame(tick)
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
    setStatus('ready')
  }

  // 変身成立後、もう一度カード認証からやり直す（カメラは止めない）
  function handleRestart() {
    matcherRef.current?.reset()
    runnerRef.current = null
    riderRef.current = null
    doneHandledRef.current = false
    lastCardIdRef.current = null
    phaseRef.current = 'card'
    setRider(null)
    setUiState(null)
    setCard(null)
    setPhase('card')
  }

  // カード id → そのライダー名（対応が無ければ null）。表示と分岐判定に使う。
  function riderNameForCard(cardId: string): string | null {
    const routines = routinesRef.current
    const rid = routines.some((r) => r.riderId === cardId) ? cardId : cardToRiderId(cardId)
    if (!rid) return null
    return routines.find((r) => r.riderId === rid)?.riderName ?? rid
  }

  // 対応ライダーが設定済みの「使えるカード」一覧（かざすべきカードのヒント表示用）。
  const supportedCards = refs
    .map((r) => ({ label: r.label, rider: riderNameForCard(r.id) }))
    .filter((c) => c.rider)

  const cardRider = card ? riderNameForCard(card.id) : null
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
        <Link to="/" style={{ color: '#9ca3af', textDecoration: 'none', fontSize: '0.9rem' }}>
          ← Back
        </Link>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>変身フロー</h1>
      </div>

      {/* フェーズインジケータ */}
      <div style={{ width: '100%', maxWidth: '800px', display: 'flex', gap: '0.5rem' }}>
        {(['card', 'pose', 'done'] as Phase[]).map((p, i) => {
          const order: Phase[] = ['card', 'pose', 'done']
          const cur = order.indexOf(phase)
          const done = i < cur
          const current = i === cur
          const labels = { card: '1. カード認証', pose: '2. ポーズ認証', done: '3. 変身成立' }
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
          background: phase === 'done' ? '#064e3b' : '#1f2937',
          borderRadius: '12px',
          padding: '1rem 1.5rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
          transition: 'background 0.3s',
        }}
      >
        {phase === 'card' && (
          <>
            <span style={{ fontSize: '1.1rem' }}>
              {status !== 'running' ? (
                'Start を押してカード認証から開始'
              ) : !card ? (
                'カードをカメラにかざしてください…'
              ) : cardRider ? (
                <span style={{ color: '#4ade80' }}>
                  ✅ {card.label} → {cardRider} に変身！
                </span>
              ) : (
                <span style={{ color: '#facc15' }}>
                  ⚠ 「{card.label}」は未対応のカードです（対応ライダー未設定）
                </span>
              )}
            </span>
            <span style={{ color: '#9ca3af', fontSize: '0.85rem' }}>
              使えるカード:{' '}
              {supportedCards.length > 0
                ? supportedCards.map((c) => `${c.label}（${c.rider}）`).join(' / ')
                : 'なし'}
            </span>
          </>
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

        {phase === 'done' && (
          <div style={{ fontSize: '1.4rem', fontWeight: 'bold', color: '#4ade80' }}>
            ✅ 変身成立: {rider?.name} — バトルへ（onHenshin 発火済み）
          </div>
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
          type="button"
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
          type="button"
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
        {status === 'running' && phase === 'done' && (
          <button
            type="button"
            onClick={handleRestart}
            style={{
              padding: '0.6rem 2rem',
              fontSize: '1rem',
              background: '#a78bfa',
              color: '#000',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              fontWeight: 'bold',
            }}
          >
            🔄 もう一度
          </button>
        )}
      </div>

      <p style={{ color: '#6b7280', fontSize: '0.8rem', margin: 0 }}>
        カード認証（ORB）→ ポーズ認証（MediaPipe）→ 変身成立で onHenshin を発火。ルーム/バトル側はこれを購読して接続する。
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
