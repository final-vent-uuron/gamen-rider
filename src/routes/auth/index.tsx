import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision'

import { playHenshinBgm } from '../../battle/bgm'
import { CAMERA_HEIGHT, CAMERA_WIDTH, createCardMatcher } from '../../card'
import type { CardMatcher, CardRef, MatchStats } from '../../card'
import {
  RIDER_ROUTINES,
  createPoseLandmarker,
  createRoutineRunner,
  customToRoutine,
  drawPoseGuide,
} from '../../pose'
import type { HenshinRoutine, MediaPipeModules, RoutineRunner, RunnerState } from '../../pose'
import { cardToRiderId, emitHenshin } from '../../henshin'
import { listRiders } from '../../rider-registry'
import type { RegisteredRiderWithImage } from '../../rider-registry'

export const Route = createFileRoute('/auth/')({ component: AuthPage })

type Status = 'loading' | 'running' | 'error'
// card: カードをかざす / pose: 認証したライダーの変身ポーズ / done: 認証成功
type Phase = 'card' | 'pose' | 'done'
// imageDataUrl は登録ライダーのみ（RIDER_ROUTINES の既定ライダーには無い）。
// 成功画面でのカード演出に使う。無ければアイコンにフォールバックする。
type Rider = { id: string; name: string; imageDataUrl?: string }

// 説明表示（フェーズインジケータ・ステータス文言・ステップ一覧）の ON/OFF。
// 既定は OFF（シンプルに変身するだけ）。ON にした状態は端末ごとに localStorage で覚えておく。
const SHOW_EXPLAIN_KEY = 'gamen-rider:auth-show-explain'
function getStoredShowExplain(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(SHOW_EXPLAIN_KEY) === '1'
  } catch {
    return false
  }
}
function setStoredShowExplain(v: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SHOW_EXPLAIN_KEY, v ? '1' : '0')
  } catch {
    /* quota / private mode */
  }
}

function AuthPage() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const guideCanvasRef = useRef<HTMLCanvasElement>(null)
  const lastGuideKeyRef = useRef<string | null>(null)
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
  // riderId → 登録カード画像（data URL）。成功画面でのカード演出用。init で確定。
  const riderImagesRef = useRef<Record<string, string>>({})
  const doneHandledRef = useRef(false)
  const lastUiRef = useRef(0)
  const lastCardLabelRef = useRef<string | null>(null)
  const lastStatsUiRef = useRef(0)

  const [status, setStatus] = useState<Status>('loading')
  const [phase, setPhase] = useState<Phase>('card')
  const [cardLabel, setCardLabel] = useState<string | null>(null)
  // カード認証の内訳（sharpness / インライア数）。しきい値調整と「なぜ通らないか」の把握用。
  const [cardStats, setCardStats] = useState<MatchStats | null>(null)
  const [rider, setRider] = useState<Rider | null>(null)
  const [uiState, setUiState] = useState<RunnerState | null>(null)
  // お手本パネルにフォールバック文言を出すかどうか（canvas への描画自体は tick から命令的に行う）。
  const [hasGuide, setHasGuide] = useState(false)
  // 説明表示（フェーズインジケータ・ステータス文言）の ON/OFF。既定 OFF はここで localStorage から
  // 同期的に読む（lazy initializer なので SSR は false、クライアントでは即座に前回値が反映される）。
  const [showExplain, setShowExplain] = useState(() => getStoredShowExplain())

  const navigate = useNavigate()

  // バトルで使う GLB（R2 配信・20MB 級）を認証中に裏で先読みしておく。
  // arena3d 側の gltfCache に載るので、/battle 到達時にはロード/パース済みで即表示される。
  // dynamic import なので three.js のチャンクもここで温まる。
  useEffect(() => {
    import('../../battle/arena3d').then((m) => m.preloadRiderModels())
  }, [])

  // 変身フロー BGM（ループ）。画面を離れたら停止する。
  useEffect(() => playHenshinBgm(), [])

  // 認証成功の演出を少し見せてから、センサーペアリング画面へ自動遷移（本番フロー）。
  // /pairing がライダーの GR セットで BLE を絞り、そこから /battle へ進む。
  useEffect(() => {
    if (phase !== 'done' || !rider) return
    const t = setTimeout(() => {
      navigate({ to: '/pairing', search: { rider: rider.id, name: rider.name } })
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

        const refs: CardRef[] = registered.map((r) => ({
          id: r.id,
          label: r.name,
          url: r.imageDataUrl,
        }))
        riderImagesRef.current = Object.fromEntries(registered.map((r) => [r.id, r.imageDataUrl]))
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

        // 解像度はカード認証の精度（＝どこまで離してかざせるか）に直結するので明示的に要求する。
        // facingMode は指定しない：同じカメラでポーズ認証（自分が映る必要がある）も行うため。
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: CAMERA_WIDTH }, height: { ideal: CAMERA_HEIGHT } },
          audio: false,
        })
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
    const r: Rider = { id: riderId, name: routine.riderName, imageDataUrl: riderImagesRef.current[riderId] }
    riderRef.current = r
    runnerRef.current = createRoutineRunner(routines, riderId)
    lastGuideKeyRef.current = null
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
      // 内訳は毎フレーム setState すると重いので 200ms ごとに反映する。
      if (now - lastStatsUiRef.current >= 200) {
        lastStatsUiRef.current = now
        setCardStats(matcherRef.current?.stats() ?? null)
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

        // お手本パネル: ステップが変わったときだけ再描画する（毎フレーム描き直す必要は無い）。
        const curStepIndex = state.steps[0]?.stepIndex ?? -1
        const guideKey = `${riderRef.current?.id ?? ''}:${curStepIndex}`
        if (guideKey !== lastGuideKeyRef.current) {
          lastGuideKeyRef.current = guideKey
          const routine = riderRef.current
            ? routinesRef.current.find((r) => r.riderId === riderRef.current!.id)
            : null
          const guide = routine?.steps[curStepIndex]?.guide ?? null
          setHasGuide(!!guide)
          const gc = guideCanvasRef.current
          if (gc && gc.clientWidth > 0 && gc.clientHeight > 0) {
            gc.width = gc.clientWidth
            gc.height = gc.clientHeight
            const gctx = gc.getContext('2d')
            if (gctx) drawPoseGuide(gctx, gc.width, gc.height, guide)
          }
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
  // /pairing への自動遷移は 1400ms 後（別 useEffect）。進捗バーもその長さに合わせてある。
  if (phase === 'done') {
    return (
      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          gap: '1.2rem',
          overflow: 'hidden',
          background: 'radial-gradient(ellipse at 50% 45%, #0d3b2e 0%, #022c22 55%, #01120e 100%)',
        }}
      >
        {/* 背景の光の輪（発動の瞬間に一気に広がって消える） */}
        <div
          style={{
            position: 'absolute',
            width: '60vmin',
            height: '60vmin',
            borderRadius: '50%',
            border: '2px solid #4ade80',
            animation: 'henshinRingBurst 1s ease-out both',
            pointerEvents: 'none',
          }}
        />
        <div
          style={{
            position: 'absolute',
            width: '60vmin',
            height: '60vmin',
            borderRadius: '50%',
            border: '2px solid #a78bfa',
            animation: 'henshinRingBurst 1s ease-out 0.15s both',
            pointerEvents: 'none',
          }}
        />

        {/* カード（登録画像があれば実物、無ければアイコン） */}
        <div
          style={{
            position: 'relative',
            animation: 'winnerPop 0.6s cubic-bezier(0.2, 0.9, 0.3, 1.2) both',
          }}
        >
          {rider?.imageDataUrl ? (
            <img
              src={rider.imageDataUrl}
              alt={rider.name}
              style={{
                width: '180px',
                height: '180px',
                objectFit: 'cover',
                borderRadius: '16px',
                border: '3px solid #4ade80',
                color: '#4ade80', // henshinGlow の currentColor 参照先
                animation: 'henshinGlow 1.6s ease-in-out infinite',
              }}
            />
          ) : (
            <div
              style={{
                fontSize: '5rem',
                color: '#4ade80',
                animation: 'henshinGlow 1.6s ease-in-out infinite',
              }}
            >
              ✅
            </div>
          )}
        </div>

        <h1
          style={{
            margin: 0,
            fontSize: '2.5rem',
            color: '#4ade80',
            animation: 'winnerPop 0.6s 0.1s cubic-bezier(0.2, 0.9, 0.3, 1.2) both',
          }}
        >
          変身完了
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: '1.5rem',
            color: '#fff',
            animation: 'winnerPop 0.6s 0.15s cubic-bezier(0.2, 0.9, 0.3, 1.2) both',
          }}
        >
          <strong style={{ color: '#a78bfa' }}>{rider?.name}</strong> にライダーチェンジ！
        </p>

        {/* バトルへの移行待ちを可視化する進捗バー（1400ms = 自動遷移までの時間と同期） */}
        <div
          style={{
            width: '220px',
            height: '5px',
            borderRadius: '3px',
            background: 'rgba(255,255,255,0.15)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              background: 'linear-gradient(90deg, #4ade80, #a78bfa)',
              animation: 'henshinProgress 1.4s linear both',
            }}
          />
        </div>
        <p style={{ margin: 0, color: '#9ca3af', fontSize: '0.9rem' }}>
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
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '1.5rem',
        minHeight: '100vh',
        gap: '1rem',
      }}
    >
      {/* 説明表示の ON/OFF（右上）。既定は OFF＝シンプルに変身するだけ。値は localStorage に覚える。 */}
      <button
        type="button"
        onClick={() => {
          setShowExplain((v) => {
            const next = !v
            setStoredShowExplain(next)
            return next
          })
        }}
        style={{
          position: 'fixed',
          top: '10px',
          right: '10px',
          zIndex: 5,
          background: 'rgba(0,0,0,0.45)',
          color: '#e5e7eb',
          border: '1px solid #334155',
          borderRadius: '6px',
          padding: '2px 10px',
          fontSize: '0.78rem',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        説明 {showExplain ? 'ON' : 'OFF'}
      </button>

      {/* フェーズインジケータ（説明 ON のときだけ） */}
      {showExplain && (
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
      )}

      {/* ステータスパネル（説明 ON のときだけ） */}
      {showExplain && (
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
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem' }}>
            <span style={{ fontSize: '1.1rem' }}>
              {status === 'running'
                ? cardLabel
                  ? `カード認識中: ${cardLabel}`
                  : 'カードをカメラにかざしてください…'
                : '準備中…'}
            </span>
            {status === 'running' && cardStats && (
              <span
                style={{
                  marginLeft: 'auto',
                  fontFamily: 'monospace',
                  fontSize: '0.85rem',
                  color: cardStats.blurred ? '#fbbf24' : cardLabel ? '#4ade80' : '#9ca3af',
                }}
              >
                {cardStats.blurred
                  ? `ブレ検出 (sharp ${cardStats.sharpness.toFixed(0)})`
                  : `sharp ${cardStats.sharpness.toFixed(0)} · ${cardStats.bestInliers}/${cardStats.secondInliers} pts`}
              </span>
            )}
          </div>
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
      )}

      {/* カメラ映像。お手本パネルはカメラの右にはみ出す形で添えるだけにして、
          カメラ自体の中心位置がフェーズによってズレないようにしてある。 */}
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: '780px',
        }}
      >
        <div
          style={{
            position: 'relative',
            background: '#1f2937',
            borderRadius: '12px',
            overflow: 'hidden',
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

        {phase === 'pose' && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: '100%',
              marginLeft: '1rem',
              width: '260px',
              background: '#1f2937',
              borderRadius: '12px',
              padding: '0.75rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
            }}
          >
            <span style={{ color: '#a78bfa', fontWeight: 'bold', fontSize: '0.9rem' }}>
              👉 お手本ポーズ（上半身）
            </span>
            <div
              style={{
                position: 'relative',
                aspectRatio: '4/3',
                background: '#111827',
                borderRadius: '8px',
                overflow: 'hidden',
              }}
            >
              <canvas ref={guideCanvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
              {!hasGuide && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#6b7280',
                    fontSize: '0.8rem',
                    textAlign: 'center',
                    padding: '0.5rem',
                  }}
                >
                  お手本なし
                  <br />
                  ラベルの指示に従ってください
                </div>
              )}
            </div>
            <span style={{ color: '#9ca3af', fontSize: '0.8rem' }}>このポーズを真似してください</span>
          </div>
        )}
      </div>
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
