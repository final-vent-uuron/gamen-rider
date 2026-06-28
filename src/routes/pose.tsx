import { Link, createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision'
import {
  BUILTIN_POSES,
  RIDER_ROUTINES,
  createPoseLandmarker,
  createRoutineRunner,
  customToRoutine,
  describePoses,
  loadCustomRoutines,
  poseSimilarity,
  saveCustomRoutines,
} from '../pose'
import type {
  CustomRoutine,
  CustomStep,
  HenshinRoutine,
  PoseDebug,
  RefPoint,
  RoutineRunner,
  RunnerState,
  RunnerStep,
} from '../pose'

export const Route = createFileRoute('/pose')({ component: PosePage })

type MediaPipeModules = typeof import('@mediapipe/tasks-vision')
type Status = 'loading' | 'ready' | 'running' | 'error'
type Mode = 'detect' | 'capture'
type Matched = { riderId: string; riderName: string }

const DEFAULT_HOLD_MS = 700

// 複数ルーチンを並行評価しているとき、最も進んでいる step を表示用に選ぶ
function primaryStep(state: RunnerState | null): RunnerStep | null {
  if (!state || state.steps.length === 0) return null
  return state.steps.reduce((best, s) =>
    s.stepIndex + s.progress > best.stepIndex + best.progress ? s : best,
  )
}

function PosePage() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const landmarkerRef = useRef<PoseLandmarker | null>(null)
  const mpRef = useRef<MediaPipeModules | null>(null)
  const rafRef = useRef<number>(0)
  const isRunningRef = useRef(false)
  const runnerRef = useRef<RoutineRunner | null>(null)
  const handledMatchRef = useRef<string | null>(null)
  const lastUiRef = useRef(0)
  const fpsCounterRef = useRef({ frames: 0, last: performance.now() })
  const currentLandmarksRef = useRef<NormalizedLandmark[] | null>(null)
  const skeletonActiveRef = useRef(false)
  // detect ループから最新値を読むための ref（state のミラー）
  const modeRef = useRef<Mode>('detect')
  const thresholdRef = useRef(80)
  const verifyRef = useRef<RefPoint[] | null>(null)

  const [status, setStatus] = useState<Status>('loading')
  const [mode, setMode] = useState<Mode>('detect')
  const [fps, setFps] = useState(0)
  const [uiState, setUiState] = useState<RunnerState | null>(null)
  const [matched, setMatched] = useState<Matched | null>(null)
  const [debug, setDebug] = useState<PoseDebug | null>(null)

  // 判定モード
  const [routineKey, setRoutineKey] = useState('builtin')
  const [customRoutines, setCustomRoutines] = useState<CustomRoutine[]>([])

  // ポーズ作成モード
  const [draftName, setDraftName] = useState('マイ変身')
  const [draftSteps, setDraftSteps] = useState<CustomStep[]>([])
  const [threshold, setThreshold] = useState(80)
  const [builtinPick, setBuiltinPick] = useState(BUILTIN_POSES[0]?.id ?? '')
  const [captureSim, setCaptureSim] = useState<number | null>(null)

  // 保存済みルーチンの読み込み（クライアントのみ）
  useEffect(() => {
    setCustomRoutines(loadCustomRoutines())
  }, [])

  useEffect(() => {
    modeRef.current = mode
  }, [mode])
  useEffect(() => {
    thresholdRef.current = threshold
  }, [threshold])
  // 直近のスナップショット step を「ライブ確認の基準ポーズ」にする
  useEffect(() => {
    const last = [...draftSteps].reverse().find((s) => s.kind === 'snapshot')
    verifyRef.current = last && last.kind === 'snapshot' ? last.landmarks : null
  }, [draftSteps])

  useEffect(() => {
    let cancelled = false

    async function init() {
      try {
        const { mp, landmarker } = await createPoseLandmarker()
        if (!cancelled) {
          mpRef.current = mp
          landmarkerRef.current = landmarker
          setStatus('ready')
        } else {
          landmarker.close()
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

  function selectedRoutines(): HenshinRoutine[] {
    if (routineKey !== 'builtin') {
      const c = customRoutines.find((r) => r.riderId === routineKey)
      if (c) return [customToRoutine(c)]
    }
    return RIDER_ROUTINES
  }

  function rebuildRunner() {
    const runner = createRoutineRunner(selectedRoutines())
    runnerRef.current = runner
    handledMatchRef.current = null
    setMatched(null)
    setUiState(runner.getState())
  }

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

    const results = landmarker.detectForVideo(video, performance.now())
    const landmarks: NormalizedLandmark[] | null =
      results.landmarks.length > 0 ? results.landmarks[0] : null
    currentLandmarksRef.current = landmarks

    const now = performance.now()

    if (modeRef.current === 'detect') {
      const runner = runnerRef.current
      if (runner) {
        const state = runner.update(landmarks, now)
        skeletonActiveRef.current = state.steps.some((s) => s.active)

        // 成立イベント（上位フロー結線は後回し。当面は画面表示 + console）
        if (state.matchedRiderId && handledMatchRef.current !== state.matchedRiderId) {
          handledMatchRef.current = state.matchedRiderId
          const st = state.steps.find((s) => s.riderId === state.matchedRiderId)
          setMatched({
            riderId: state.matchedRiderId,
            riderName: st?.riderName ?? state.matchedRiderId,
          })
          console.log('[pose] 変身成立:', state.matchedRiderId)
        }

        if (now - lastUiRef.current >= 100) {
          lastUiRef.current = now
          setUiState(state)
          setDebug(landmarks ? describePoses(landmarks) : null)
        }
      }
    } else {
      // ポーズ作成モード: 基準ポーズとのライブ一致度を表示
      if (now - lastUiRef.current >= 100) {
        lastUiRef.current = now
        setDebug(landmarks ? describePoses(landmarks) : null)
        const ref = verifyRef.current
        if (landmarks && ref) {
          const sim = poseSimilarity(landmarks, ref)
          skeletonActiveRef.current = sim >= thresholdRef.current
          setCaptureSim(sim)
        } else {
          skeletonActiveRef.current = false
          setCaptureSim(null)
        }
      }
    }

    // 自撮りミラー表示（映像と骨格をまとめて左右反転。判定は生座標なので影響なし）
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.translate(canvas.width, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(video, 0, 0)
    if (landmarks) {
      const drawingUtils = new mp.DrawingUtils(ctx)
      drawingUtils.drawConnectors(landmarks, mp.PoseLandmarker.POSE_CONNECTIONS, {
        color: skeletonActiveRef.current ? '#4ade80' : '#22d3ee',
        lineWidth: 3,
      })
      drawingUtils.drawLandmarks(landmarks, { radius: 4, color: '#f87171', fillColor: '#fff' })
    }
    ctx.restore()

    const counter = fpsCounterRef.current
    counter.frames++
    if (now - counter.last >= 1000) {
      setFps(Math.round((counter.frames * 1000) / (now - counter.last)))
      counter.frames = 0
      counter.last = now
    }

    rafRef.current = requestAnimationFrame(detect)
  }, [])

  // 判定対象の切り替え（実行中のみ即反映）
  useEffect(() => {
    if (!isRunningRef.current) return
    if (mode === 'detect') rebuildRunner()
    else {
      setUiState(null)
      setMatched(null)
      handledMatchRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routineKey, mode, customRoutines])

  async function handleStart() {
    if (!videoRef.current) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      videoRef.current.srcObject = stream
      await videoRef.current.play()
      if (mode === 'detect') rebuildRunner()
      isRunningRef.current = true
      setStatus('running')
      setCaptureSim(null)
      fpsCounterRef.current = { frames: 0, last: performance.now() }
      lastUiRef.current = 0
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
    setDebug(null)
    setCaptureSim(null)
    setStatus('ready')
  }

  function handleReset() {
    runnerRef.current?.reset()
    handledMatchRef.current = null
    setMatched(null)
    setUiState(runnerRef.current?.getState() ?? null)
  }

  // ---- ポーズ作成 ----
  function handleCapture() {
    const lm = currentLandmarksRef.current
    if (!lm || lm.length < 33) return
    const landmarks: RefPoint[] = lm.map((p) => ({ x: p.x, y: p.y, z: p.z }))
    const n = draftSteps.length + 1
    const step: CustomStep = {
      kind: 'snapshot',
      id: `s${Date.now()}`,
      label: `ポーズ${n}`,
      minScore: threshold,
      holdMs: DEFAULT_HOLD_MS,
      landmarks,
    }
    setDraftSteps((prev) => [...prev, step])
  }

  function handleAddBuiltin() {
    const b = BUILTIN_POSES.find((x) => x.id === builtinPick)
    if (!b) return
    const step: CustomStep = {
      kind: 'builtin',
      id: `b${Date.now()}`,
      label: b.label,
      holdMs: DEFAULT_HOLD_MS,
      poseId: b.id,
    }
    setDraftSteps((prev) => [...prev, step])
  }

  function handleDeleteStep(index: number) {
    setDraftSteps((prev) => prev.filter((_, i) => i !== index))
  }

  function handleSaveRoutine() {
    if (draftSteps.length === 0) return
    const routine: CustomRoutine = {
      riderId: `custom:${Date.now()}`,
      riderName: draftName.trim() || 'マイ変身',
      steps: draftSteps,
    }
    const next = [...customRoutines, routine]
    setCustomRoutines(next)
    saveCustomRoutines(next)
    setRoutineKey(routine.riderId)
    setDraftSteps([])
  }

  function handleDeleteRoutine(riderId: string) {
    const next = customRoutines.filter((r) => r.riderId !== riderId)
    setCustomRoutines(next)
    saveCustomRoutines(next)
    if (routineKey === riderId) setRoutineKey('builtin')
  }

  const step = primaryStep(uiState)
  const routine = step ? RIDER_ROUTINES.find((r) => r.riderId === step.riderId) : null
  const captureActive = captureSim !== null && captureSim >= threshold

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
        style={{ width: '100%', maxWidth: '800px', display: 'flex', alignItems: 'center', gap: '1rem' }}
      >
        <Link to="/" style={{ color: '#9ca3af', textDecoration: 'none', fontSize: '0.9rem' }}>
          ← Back
        </Link>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>変身ポーズ認証</h1>
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

      {/* モード切り替え */}
      <div style={{ width: '100%', maxWidth: '800px', display: 'flex', gap: '0.5rem' }}>
        {(['detect', 'capture'] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              flex: 1,
              padding: '0.5rem',
              background: mode === m ? '#a78bfa' : '#1f2937',
              color: mode === m ? '#000' : '#9ca3af',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              fontWeight: 'bold',
            }}
          >
            {m === 'detect' ? '判定' : 'ポーズ作成'}
          </button>
        ))}
      </div>

      {/* 判定モード: ルーチン選択 */}
      {mode === 'detect' && (
        <div
          style={{
            width: '100%',
            maxWidth: '800px',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ color: '#9ca3af', fontSize: '0.9rem' }}>判定する手順</span>
          <select
            value={routineKey}
            onChange={(e) => setRoutineKey(e.target.value)}
            style={{
              padding: '0.4rem 0.6rem',
              background: '#1f2937',
              color: '#fff',
              border: '1px solid #374151',
              borderRadius: '6px',
            }}
          >
            <option value="builtin">ビルトイン（全ライダー並行）</option>
            {customRoutines.map((r) => (
              <option key={r.riderId} value={r.riderId}>
                {r.riderName}（{r.steps.length}手順）
              </option>
            ))}
          </select>
          {routineKey !== 'builtin' && (
            <button
              onClick={() => handleDeleteRoutine(routineKey)}
              style={{
                padding: '0.3rem 0.7rem',
                background: 'transparent',
                color: '#f87171',
                border: '1px solid #374151',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '0.8rem',
              }}
            >
              削除
            </button>
          )}
        </div>
      )}

      {/* 判定モード: 進行パネル */}
      {mode === 'detect' && status === 'running' && (
        <div
          style={{
            width: '100%',
            maxWidth: '800px',
            background: matched ? '#064e3b' : '#1f2937',
            borderRadius: '12px',
            padding: '1rem 1.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
            transition: 'background 0.3s',
          }}
        >
          {matched ? (
            <div style={{ fontSize: '1.4rem', fontWeight: 'bold', color: '#4ade80' }}>
              ✅ 変身成立: {matched.riderName}
            </div>
          ) : step ? (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
                <span style={{ color: '#9ca3af', fontSize: '0.85rem', fontFamily: 'monospace' }}>
                  STEP {step.stepIndex + 1} / {step.stepCount}
                </span>
                <span style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>{step.label}</span>
                {step.active && (
                  <span style={{ marginLeft: 'auto', color: '#4ade80', fontSize: '0.85rem' }}>
                    検出中…
                  </span>
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
                    const done = i < step.stepIndex
                    const current = i === step.stepIndex
                    return (
                      <span
                        key={s.id}
                        style={{
                          fontSize: '0.85rem',
                          color: done ? '#4ade80' : current ? '#fff' : '#6b7280',
                          fontWeight: current ? 'bold' : 'normal',
                        }}
                      >
                        {done ? '✅' : current ? '▶' : '○'} {i + 1}. {s.label}
                      </span>
                    )
                  })}
                </div>
              )}
            </>
          ) : (
            <span style={{ color: '#9ca3af' }}>ポーズを取ってください…</span>
          )}
        </div>
      )}

      {/* ポーズ作成モード */}
      {mode === 'capture' && (
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
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="ルーチン名"
              style={{
                padding: '0.4rem 0.6rem',
                background: '#111827',
                color: '#fff',
                border: '1px solid #374151',
                borderRadius: '6px',
              }}
            />
            <label style={{ color: '#9ca3af', fontSize: '0.85rem', display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              一致しきい値 {threshold}%
              <input
                type="range"
                min={50}
                max={95}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
            </label>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              onClick={handleCapture}
              disabled={status !== 'running'}
              style={{
                padding: '0.5rem 1rem',
                background: status === 'running' ? '#4ade80' : '#374151',
                color: status === 'running' ? '#000' : '#6b7280',
                border: 'none',
                borderRadius: '8px',
                cursor: status === 'running' ? 'pointer' : 'not-allowed',
                fontWeight: 'bold',
              }}
            >
              📸 今のポーズを登録
            </button>
            <select
              value={builtinPick}
              onChange={(e) => setBuiltinPick(e.target.value)}
              style={{
                padding: '0.4rem 0.6rem',
                background: '#111827',
                color: '#fff',
                border: '1px solid #374151',
                borderRadius: '6px',
              }}
            >
              {BUILTIN_POSES.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
            <button
              onClick={handleAddBuiltin}
              style={{
                padding: '0.5rem 1rem',
                background: '#60a5fa',
                color: '#000',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: 'bold',
              }}
            >
              ＋ ビルトイン追加
            </button>
          </div>

          {/* ライブ一致度（直近の登録ポーズに対して） */}
          {status === 'running' && verifyRef.current && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <span style={{ color: '#9ca3af', fontSize: '0.85rem' }}>直近ポーズとの一致度</span>
              <div style={{ flex: 1, height: '10px', background: '#374151', borderRadius: '5px', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${captureSim ?? 0}%`,
                    background: captureActive ? '#4ade80' : '#facc15',
                    transition: 'width 0.15s',
                  }}
                />
              </div>
              <span style={{ fontFamily: 'monospace', color: captureActive ? '#4ade80' : '#facc15', minWidth: '4ch', textAlign: 'right' }}>
                {captureSim !== null ? `${captureSim}%` : '--'}
              </span>
            </div>
          )}

          {/* 組み立て中の手順 */}
          {draftSteps.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {draftSteps.map((s, i) => (
                <div
                  key={s.id}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.9rem' }}
                >
                  <span style={{ color: '#9ca3af', fontFamily: 'monospace' }}>{i + 1}.</span>
                  <span>{s.label}</span>
                  <span style={{ color: '#6b7280', fontSize: '0.8rem' }}>
                    {s.kind === 'snapshot' ? `登録ポーズ ${s.minScore}%` : 'ビルトイン'}
                  </span>
                  <button
                    onClick={() => handleDeleteStep(i)}
                    style={{
                      marginLeft: 'auto',
                      padding: '0.2rem 0.5rem',
                      background: 'transparent',
                      color: '#f87171',
                      border: '1px solid #374151',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '0.8rem',
                    }}
                  >
                    削除
                  </button>
                </div>
              ))}
              <button
                onClick={handleSaveRoutine}
                style={{
                  marginTop: '0.4rem',
                  padding: '0.5rem 1rem',
                  background: '#a78bfa',
                  color: '#000',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontWeight: 'bold',
                  alignSelf: 'flex-start',
                }}
              >
                💾 この手順を保存
              </button>
            </div>
          ) : (
            <span style={{ color: '#6b7280', fontSize: '0.85rem' }}>
              カメラを Start して、ポーズを取りながら「今のポーズを登録」で手順を組み立てます。
            </span>
          )}
        </div>
      )}

      {/* デバッグ表示 */}
      {status === 'running' && debug && (
        <div
          style={{
            width: '100%',
            maxWidth: '800px',
            display: 'flex',
            gap: '0.5rem 1rem',
            flexWrap: 'wrap',
            fontFamily: 'monospace',
            fontSize: '0.8rem',
            color: '#9ca3af',
          }}
        >
          {!debug.visible && <span style={{ color: '#f87171' }}>⚠ 両腕が画面に収まっていません</span>}
          <span style={{ color: debug.tpose ? '#4ade80' : '#6b7280' }}>Tポーズ {debug.tpose ? '✓' : '✗'}</span>
          <span style={{ color: debug.thrust ? '#4ade80' : '#6b7280' }}>前突き出し {debug.thrust ? '✓' : '✗'}</span>
          <span>span {debug.span}</span>
          <span>level {debug.level}</span>
          <span>
            arm L{debug.armL} R{debug.armR}
          </span>
          <span>foreshorten {debug.foreshorten}</span>
          <span>zToward {debug.zToward}</span>
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
        {mode === 'detect' && (
          <button
            onClick={handleReset}
            disabled={status !== 'running'}
            style={{
              padding: '0.6rem 2rem',
              fontSize: '1rem',
              background: status === 'running' ? '#a78bfa' : '#374151',
              color: status === 'running' ? '#000' : '#6b7280',
              border: 'none',
              borderRadius: '8px',
              cursor: status === 'running' ? 'pointer' : 'not-allowed',
              fontWeight: 'bold',
            }}
          >
            🔄 リセット
          </button>
        )}
      </div>

      <p style={{ color: '#6b7280', fontSize: '0.8rem', margin: 0 }}>
        MediaPipe PoseLandmarker Full · 幾何ルール ＋ 撮って登録（ハイブリッド）
      </p>
    </div>
  )
}
