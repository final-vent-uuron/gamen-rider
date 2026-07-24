// ファイナルベント専用ポーズ手順の登録（変身と同じ「複数ステップの流れ」）。
// キャラごとに CustomStep[] を localStorage へ保存し、バトルの pose 相で runner 判定する。

import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision'

import {
  FV_POSE_DEFAULT_HOLD_MS,
  FV_POSE_DEFAULT_MIN_SCORE,
  clearFinalVentPose,
  listFinalVentPoses,
  loadFinalVentPose,
  saveFinalVentPose,
} from '../battle/finalVentPose'
import { createPoseLandmarker, poseSimilarity, RIDER_ROUTINES } from '../pose'
import type { CustomStep, RefPoint } from '../pose'
import { drawPoseSkeleton } from '../pose/skeleton'
import { listRiders } from '../rider-registry'

export const Route = createFileRoute('/final-vent-pose')({
  validateSearch: (search: Record<string, unknown>): { rider?: string } => ({
    rider: typeof search.rider === 'string' ? search.rider : undefined,
  }),
  component: FinalVentPosePage,
})

type Status = 'loading' | 'running' | 'error'

interface RiderChoice {
  id: string
  name: string
}

const LANGUAGE_RIDERS: RiderChoice[] = [
  { id: 'arduino', name: 'Arduino' },
  { id: 'swift', name: 'Swift' },
  { id: 'python', name: 'Python' },
  { id: 'flutter', name: 'Flutter' },
]

function FinalVentPosePage() {
  const { rider: riderFromSearch } = Route.useSearch()
  const navigate = Route.useNavigate()

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const landmarkerRef = useRef<PoseLandmarker | null>(null)
  const rafRef = useRef(0)
  const runningRef = useRef(false)
  const landmarksRef = useRef<NormalizedLandmark[] | null>(null)
  const stepsRef = useRef<CustomStep[]>([])
  const lastUiRef = useRef(0)

  const [choices, setChoices] = useState<RiderChoice[]>(() => [
    ...LANGUAGE_RIDERS,
    ...RIDER_ROUTINES.map((r) => ({ id: r.riderId, name: r.riderName })),
  ])
  const [riderId, setRiderId] = useState(
    () => riderFromSearch ?? LANGUAGE_RIDERS[0]?.id ?? 'python',
  )
  const [status, setStatus] = useState<Status>('loading')
  const [steps, setSteps] = useState<CustomStep[]>(() => {
    const id = riderFromSearch ?? LANGUAGE_RIDERS[0]?.id ?? 'python'
    return loadFinalVentPose(id)?.steps ?? []
  })
  const [registeredIds, setRegisteredIds] = useState<Set<string>>(
    () => new Set(listFinalVentPoses().map((p) => p.riderId)),
  )
  const [liveScore, setLiveScore] = useState<number | null>(null)
  const [minScore, setMinScore] = useState(FV_POSE_DEFAULT_MIN_SCORE)
  const [holdMs, setHoldMs] = useState(FV_POSE_DEFAULT_HOLD_MS)
  const [message, setMessage] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  const riderName = useMemo(
    () => choices.find((c) => c.id === riderId)?.name ?? riderId,
    [choices, riderId],
  )

  useEffect(() => {
    stepsRef.current = steps
  }, [steps])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const registered = await listRiders()
        if (cancelled) return
        setChoices((base) => {
          const next = [...base]
          for (const r of registered) {
            if (!next.some((c) => c.id === r.id)) {
              next.push({ id: r.id, name: r.name })
            }
          }
          return next
        })
      } catch {
        // noop
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const rec = loadFinalVentPose(riderId)
    setSteps(rec?.steps ?? [])
    setDirty(false)
    setLiveScore(null)
    setMessage(null)
  }, [riderId])

  useEffect(() => {
    if (riderFromSearch && riderFromSearch !== riderId) {
      setRiderId(riderFromSearch)
    }
  }, [riderFromSearch])

  function selectRider(id: string) {
    setRiderId(id)
    navigate({ search: { rider: id }, replace: true })
  }

  useEffect(() => {
    let cancelled = false

    async function init() {
      try {
        const { landmarker } = await createPoseLandmarker('lite', 'GPU')
        if (cancelled) {
          landmarker.close()
          return
        }
        landmarkerRef.current = landmarker

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        })
        const video = videoRef.current
        if (cancelled || !video) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        video.srcObject = stream
        await video.play()
        runningRef.current = true
        setStatus('running')
        rafRef.current = requestAnimationFrame(tick)
      } catch {
        if (!cancelled) setStatus('error')
      }
    }
    init()

    return () => {
      cancelled = true
      runningRef.current = false
      cancelAnimationFrame(rafRef.current)
      landmarkerRef.current?.close()
      landmarkerRef.current = null
      const video = videoRef.current
      const s = video?.srcObject as MediaStream | null
      s?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  function tick(now: number) {
    if (!runningRef.current) return
    rafRef.current = requestAnimationFrame(tick)

    const video = videoRef.current
    const canvas = canvasRef.current
    const landmarker = landmarkerRef.current
    if (!video || !canvas || !landmarker || video.readyState < 2) return

    const result = landmarker.detectForVideo(video, now)
    const lm = result.landmarks[0] ?? null
    landmarksRef.current = lm

    const w = video.videoWidth || 640
    const h = video.videoHeight || 480
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    drawPoseSkeleton(canvas, lm, '#a78bfa')

    if (now - lastUiRef.current < 100) return
    lastUiRef.current = now

    // 直近ステップとのライブ一致度（撮れているかの確認）
    const last = [...stepsRef.current].reverse().find((s) => s.kind === 'snapshot')
    if (lm && last && last.kind === 'snapshot') {
      setLiveScore(poseSimilarity(lm, last.landmarks))
    } else {
      setLiveScore(null)
    }
  }

  function handleCapture() {
    const lm = landmarksRef.current
    if (!lm || lm.length < 33) {
      setMessage('骨格が見えていません。全身が映るようにしてから撮ってください。')
      return
    }
    const landmarks: RefPoint[] = lm.map((p) => ({ x: p.x, y: p.y, z: p.z }))
    const n = steps.length + 1
    setSteps((prev) => [
      ...prev,
      {
        kind: 'snapshot',
        id: `s${Date.now()}`,
        label: `ポーズ${n}`,
        minScore,
        holdMs,
        landmarks,
      },
    ])
    setDirty(true)
    setMessage(`ポーズ${n} を追加しました。必要なだけ撮ってから保存してください。`)
  }

  function handleRemoveStep(id: string) {
    setSteps((prev) => {
      const next = prev.filter((s) => s.id !== id)
      // ラベルを ポーズ1,2… に振り直す
      return next.map((s, i) =>
        s.kind === 'snapshot' ? { ...s, label: `ポーズ${i + 1}` } : s,
      )
    })
    setDirty(true)
  }

  function handleSave() {
    if (!riderId || steps.length === 0) return
    saveFinalVentPose({
      riderId,
      riderName,
      steps,
    })
    setDirty(false)
    setRegisteredIds(new Set(listFinalVentPoses().map((p) => p.riderId)))
    setMessage(`${riderName} の手順（${steps.length} ステップ）を保存しました。`)
  }

  function handleClear() {
    if (!riderId) return
    clearFinalVentPose(riderId)
    setSteps([])
    setDirty(false)
    setLiveScore(null)
    setRegisteredIds(new Set(listFinalVentPoses().map((p) => p.riderId)))
    setMessage(`${riderName} の登録を削除しました（未登録時は前突き出し 1 ステップ）。`)
  }

  const scoreOk =
    liveScore != null &&
    liveScore >=
      (([...steps].reverse().find((s) => s.kind === 'snapshot') as
        | Extract<CustomStep, { kind: 'snapshot' }>
        | undefined)?.minScore ?? minScore)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        boxSizing: 'border-box',
        padding: '1rem',
        minHeight: '100vh',
        gap: '0.85rem',
        background: '#0b1220',
        color: '#e2e8f0',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '720px',
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <Link to="/" style={{ color: '#94a3b8', textDecoration: 'none', fontSize: '0.9rem' }}>
          ← トップ
        </Link>
        <h1 style={{ margin: 0, fontSize: '1.35rem', fontStyle: 'italic' }}>
          ファイナルベント ポーズ登録
        </h1>
      </div>

      <p
        style={{
          width: '100%',
          maxWidth: '720px',
          margin: 0,
          fontSize: '0.9rem',
          color: '#94a3b8',
          lineHeight: 1.5,
        }}
      >
        変身と同じく、複数ポーズを順番に登録します。バトルではカード認識のあと、この手順を完走するとファイナルベントが発動します。
      </p>

      <div
        style={{
          width: '100%',
          maxWidth: '640px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.4rem',
        }}
      >
        {choices.map((c) => {
          const active = c.id === riderId
          const hasPose = registeredIds.has(c.id)
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => selectRider(c.id)}
              style={{
                padding: '0.35rem 0.75rem',
                borderRadius: '999px',
                border: active ? '2px solid #a78bfa' : '1px solid #334155',
                background: active ? 'rgba(167,139,250,0.25)' : 'rgba(15,23,42,0.8)',
                color: active ? '#e9d5ff' : '#94a3b8',
                fontWeight: active ? 800 : 600,
                fontSize: '0.8rem',
                cursor: 'pointer',
              }}
            >
              {c.name}
              {hasPose ? ' ✓' : ''}
            </button>
          )
        })}
      </div>

      <div style={{ position: 'relative', width: '100%', maxWidth: '640px' }}>
        <video
          ref={videoRef}
          playsInline
          muted
          style={{
            width: '100%',
            aspectRatio: '4/3',
            objectFit: 'cover',
            background: '#1e293b',
            borderRadius: '12px',
            transform: 'scaleX(-1)',
            display: 'block',
          }}
        />
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            borderRadius: '12px',
            transform: 'scaleX(-1)',
            pointerEvents: 'none',
            border: scoreOk ? '3px solid #a78bfa' : '2px solid transparent',
            boxSizing: 'border-box',
          }}
        />
        {status !== 'running' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              background: 'rgba(0,0,0,0.55)',
              borderRadius: '12px',
              color: status === 'error' ? '#fecaca' : '#cbd5e1',
            }}
          >
            {status === 'error' ? 'カメラを許可してください' : '準備中…'}
          </div>
        )}
        {liveScore != null && (
          <span
            style={{
              position: 'absolute',
              right: '10px',
              top: '10px',
              fontWeight: 900,
              fontSize: '1.1rem',
              color: scoreOk ? '#1e1b4b' : '#fff',
              background: scoreOk ? '#a78bfa' : 'rgba(0,0,0,0.55)',
              padding: '4px 10px',
              borderRadius: '8px',
            }}
          >
            {liveScore}%
          </span>
        )}
      </div>

      <div
        style={{
          width: '100%',
          maxWidth: '640px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.75rem',
          alignItems: 'center',
        }}
      >
        <label style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
          一致しきい値
          <input
            type="number"
            min={50}
            max={95}
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value) || FV_POSE_DEFAULT_MIN_SCORE)}
            style={inputStyle}
          />
        </label>
        <label style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
          保持(ms)
          <input
            type="number"
            min={200}
            max={2000}
            step={50}
            value={holdMs}
            onChange={(e) => setHoldMs(Number(e.target.value) || FV_POSE_DEFAULT_HOLD_MS)}
            style={inputStyle}
          />
        </label>
        <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
          ※ 次に追加するステップに適用
        </span>
      </div>

      {/* 手順一覧 */}
      <div
        style={{
          width: '100%',
          maxWidth: '640px',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.4rem',
        }}
      >
        {steps.length === 0 ? (
          <div
            style={{
              padding: '0.75rem 1rem',
              background: 'rgba(15,23,42,0.8)',
              border: '1px dashed #334155',
              borderRadius: '8px',
              color: '#64748b',
              fontSize: '0.85rem',
            }}
          >
            まだステップがありません。「いまのポーズを撮る」で追加してください。
          </div>
        ) : (
          steps.map((s, i) => (
            <div
              key={s.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.55rem 0.85rem',
                background: 'rgba(15,23,42,0.9)',
                border: '1px solid #334155',
                borderRadius: '8px',
                fontSize: '0.85rem',
              }}
            >
              <span
                style={{
                  width: '1.6rem',
                  height: '1.6rem',
                  borderRadius: '999px',
                  background: '#a78bfa',
                  color: '#1e1b4b',
                  fontWeight: 900,
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}
              >
                {i + 1}
              </span>
              <span style={{ flex: 1, color: '#e2e8f0', fontWeight: 700 }}>{s.label}</span>
              <span style={{ color: '#94a3b8' }}>
                {s.kind === 'snapshot'
                  ? `${s.minScore}% / ${s.holdMs}ms`
                  : `${s.holdMs}ms`}
              </span>
              <button
                type="button"
                onClick={() => handleRemoveStep(s.id)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#f87171',
                  cursor: 'pointer',
                  fontWeight: 700,
                }}
              >
                削除
              </button>
            </div>
          ))
        )}
      </div>

      <div
        style={{
          width: '100%',
          maxWidth: '640px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.5rem',
        }}
      >
        <button type="button" onClick={handleCapture} style={btnStyle('#a78bfa', '#1e1b4b')}>
          いまのポーズを撮る（追加）
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={steps.length === 0 || !dirty}
          style={btnStyle(
            steps.length > 0 && dirty ? '#34d399' : '#334155',
            steps.length > 0 && dirty ? '#064e3b' : '#64748b',
          )}
        >
          {riderName} の手順を保存
        </button>
        <button
          type="button"
          onClick={handleClear}
          disabled={steps.length === 0 && !registeredIds.has(riderId)}
          style={btnStyle('#475569', '#e2e8f0')}
        >
          このキャラの登録を消す
        </button>
        <Link
          to="/battle"
          search={{ rider: riderId, name: riderName }}
          style={{ ...btnStyle('#1e293b', '#cbd5e1'), textDecoration: 'none' }}
        >
          このキャラでバトルへ
        </Link>
      </div>

      {message && (
        <p style={{ margin: 0, maxWidth: '640px', color: '#c4b5fd', fontSize: '0.9rem' }}>
          {message}
        </p>
      )}

      <div
        style={{
          width: '100%',
          maxWidth: '640px',
          padding: '0.85rem 1rem',
          background: 'rgba(15,23,42,0.8)',
          border: '1px solid #334155',
          borderRadius: '10px',
          fontSize: '0.85rem',
          color: '#94a3b8',
        }}
      >
        <div style={{ color: '#e2e8f0', fontWeight: 700 }}>
          対象: {riderName} — {steps.length} ステップ
          {dirty ? '（未保存の変更あり）' : ''}
        </div>
        <div>
          {steps.length === 0
            ? '未登録（バトルでは片腕前突き出し 1 ステップ）'
            : steps.map((s) => s.label).join(' → ')}
        </div>
      </div>
    </div>
  )
}

const inputStyle: CSSProperties = {
  marginLeft: '0.4rem',
  width: '4.5rem',
  background: '#1e293b',
  color: '#e2e8f0',
  border: '1px solid #334155',
  borderRadius: '6px',
  padding: '0.25rem 0.4rem',
}

function btnStyle(bg: string, color: string): CSSProperties {
  return {
    padding: '0.55rem 1rem',
    background: bg,
    color,
    border: 'none',
    borderRadius: '8px',
    fontWeight: 800,
    cursor: 'pointer',
    fontSize: '0.9rem',
  }
}
