import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ChangeEvent } from 'react'
import type { NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision'

import { createPoseLandmarker, poseSimilarity } from '../../pose'
import type { CustomStep, MediaPipeModules, RefPoint } from '../../pose'
import { saveRider } from '../../rider-registry'

export const Route = createFileRoute('/auth/register')({ component: RegisterPage })

type Status = 'loading' | 'running' | 'error'
// name: 名前入力 / image: カード画像登録 / pose: 変身ポーズ登録 / preview: 確認・確定
type Phase = 'name' | 'image' | 'pose' | 'preview'
type ImageSource = 'camera' | 'upload'

// スナップショットポーズの既定値（pose.tsx の作成モードと同じ感覚の値）
const DEFAULT_MIN_SCORE = 80
const DEFAULT_HOLD_MS = 700

// 選べるセンサーセット番号（BLE 名 GR<n>_RH/…LF/…BELT の n。実機ラベルと合わせる）
const SENSOR_SETS = [1, 2, 3, 4]

const PHASES: Phase[] = ['name', 'image', 'pose', 'preview']
const PHASE_LABELS: Record<Phase, string> = {
  name: '1. 名前',
  image: '2. 画像',
  pose: '3. ポーズ',
  preview: '4. 確認',
}

function RegisterPage() {
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const landmarkerRef = useRef<PoseLandmarker | null>(null)
  const mpRef = useRef<MediaPipeModules | null>(null)
  const rafRef = useRef<number>(0)
  const isRunningRef = useRef(false)
  // rAF ループから最新値を読むための ref（state のミラー）
  const phaseRef = useRef<Phase>('name')
  const landmarksRef = useRef<NormalizedLandmark[] | null>(null)
  const verifyRef = useRef<RefPoint[] | null>(null)
  const lastUiRef = useRef(0)

  const [status, setStatus] = useState<Status>('loading')
  const [phase, setPhaseState] = useState<Phase>('name')
  const [name, setName] = useState('')
  const [sensorSet, setSensorSet] = useState<number | null>(null)
  const [imageSource, setImageSource] = useState<ImageSource>('camera')
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const [steps, setSteps] = useState<CustomStep[]>([])
  const [captureSim, setCaptureSim] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  function setPhase(p: Phase) {
    phaseRef.current = p
    setPhaseState(p)
  }

  // 直近に登録したポーズを「ライブ一致度」の基準にする（撮れているかの確認用）
  useEffect(() => {
    const last = [...steps].reverse().find((s) => s.kind === 'snapshot')
    verifyRef.current = last && last.kind === 'snapshot' ? last.landmarks : null
  }, [steps])

  // ロード後すぐカメラを起動（撮影とポーズ登録の両方で同じストリームを使う）
  useEffect(() => {
    let cancelled = false

    async function init() {
      try {
        const { mp, landmarker } = await createPoseLandmarker()
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
      const video = videoRef.current
      if (video?.srcObject) {
        ;(video.srcObject as MediaStream).getTracks().forEach((t) => t.stop())
        video.srcObject = null
      }
      landmarkerRef.current?.close()
    }
  }, [])

  // ポーズフェーズのときだけ骨格検出＋ミラー描画を行う（他フェーズは素通し）
  function tick() {
    if (!isRunningRef.current) return
    const video = videoRef.current
    const canvas = canvasRef.current
    const landmarker = landmarkerRef.current
    const mp = mpRef.current

    if (
      phaseRef.current !== 'pose' ||
      !video ||
      !canvas ||
      !landmarker ||
      !mp ||
      video.readyState < 2
    ) {
      rafRef.current = requestAnimationFrame(tick)
      return
    }

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')!
    const now = performance.now()

    const results = landmarker.detectForVideo(video, now)
    const landmarks: NormalizedLandmark[] | null =
      results.landmarks.length > 0 ? results.landmarks[0] : null
    landmarksRef.current = landmarks

    // 直近登録ポーズとのライブ一致度（登録したポーズが再現できるかその場で確認する用）
    let active = false
    const ref = verifyRef.current
    if (landmarks && ref) {
      const sim = poseSimilarity(landmarks, ref)
      active = sim >= DEFAULT_MIN_SCORE
      if (now - lastUiRef.current >= 100) {
        lastUiRef.current = now
        setCaptureSim(sim)
      }
    } else if (now - lastUiRef.current >= 100) {
      lastUiRef.current = now
      setCaptureSim(null)
    }

    // 自撮りミラー（映像と骨格をまとめて左右反転。保存する座標は生値なので影響なし）
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.translate(canvas.width, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(video, 0, 0)
    if (landmarks) {
      const drawingUtils = new mp.DrawingUtils(ctx)
      drawingUtils.drawConnectors(landmarks, mp.PoseLandmarker.POSE_CONNECTIONS, {
        color: active ? '#4ade80' : '#22d3ee',
        lineWidth: 3,
      })
      drawingUtils.drawLandmarks(landmarks, { radius: 4, color: '#f87171', fillColor: '#fff' })
    }
    ctx.restore()

    rafRef.current = requestAnimationFrame(tick)
  }

  // ---- 画像登録 ----

  // web カメラの現フレームをそのまま（ミラーなしで）切り出す。ORB 照合用なので生画像でよい。
  function handleShutter() {
    const video = videoRef.current
    if (!video || video.readyState < 2) return
    const c = document.createElement('canvas')
    c.width = video.videoWidth
    c.height = video.videoHeight
    c.getContext('2d')!.drawImage(video, 0, 0)
    setImageDataUrl(c.toDataURL('image/png'))
  }

  function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = () => setImageDataUrl(reader.result as string)
    reader.readAsDataURL(file)
  }

  // ---- ポーズ登録 ----

  function handleCapturePose() {
    const lm = landmarksRef.current
    if (!lm || lm.length < 33) return
    const landmarks: RefPoint[] = lm.map((p) => ({ x: p.x, y: p.y, z: p.z }))
    const n = steps.length + 1
    setSteps((prev) => [
      ...prev,
      {
        kind: 'snapshot',
        id: `s${Date.now()}`,
        label: `ポーズ${n}`,
        minScore: DEFAULT_MIN_SCORE,
        holdMs: DEFAULT_HOLD_MS,
        landmarks,
      },
    ])
  }

  function handleRemoveStep(id: string) {
    setSteps((prev) => prev.filter((s) => s.id !== id))
  }

  // ---- 確定 ----

  async function handleConfirm() {
    if (!imageDataUrl || steps.length === 0 || !name.trim()) return
    setSaving(true)
    setSaveError(null)
    try {
      await saveRider({ data: { name: name.trim(), imageDataUrl, steps, sensorSet } })
      navigate({ to: '/auth' })
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : '保存に失敗しました。通信環境を確認してください。')
      setSaving(false)
    }
  }

  const cur = PHASES.indexOf(phase)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        boxSizing: 'border-box',
        padding: '1rem',
        minHeight: '100vh',
        gap: '0.75rem',
      }}
    >
      {/* ヘッダー */}
      <div style={{ width: '100%', maxWidth: '800px', display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <Link to="/auth" style={{ color: '#9ca3af', textDecoration: 'none', fontSize: '0.9rem' }}>
          ← 認証へ戻る
        </Link>
        <h1 style={{ margin: 0, fontSize: '1.3rem' }}>ライダー登録</h1>
      </div>

      {/* フェーズインジケータ */}
      <div style={{ width: '100%', maxWidth: '800px', display: 'flex', gap: '0.5rem' }}>
        {PHASES.map((p, i) => (
          <div
            key={p}
            style={{
              flex: 1,
              padding: '0.5rem',
              textAlign: 'center',
              borderRadius: '8px',
              background: i === cur ? '#a78bfa' : i < cur ? '#064e3b' : '#1f2937',
              color: i === cur ? '#000' : i < cur ? '#4ade80' : '#6b7280',
              fontWeight: 'bold',
              fontSize: '0.9rem',
            }}
          >
            {PHASE_LABELS[p]}
          </div>
        ))}
      </div>

      {/* カメラ映像は常時マウントしておき、フェーズに応じて表示を切り替える。
          高さをビューポート基準（最大50vh）で決め、幅は 4/3 から導く＝縦にはみ出さない。 */}
      <video
        ref={videoRef}
        playsInline
        muted
        style={{
          display: phase === 'image' && imageSource === 'camera' && !imageDataUrl ? 'block' : 'none',
          height: 'min(50vh, 480px)',
          maxWidth: '100%',
          aspectRatio: '4/3',
          objectFit: 'contain',
          background: '#1f2937',
          borderRadius: '12px',
        }}
      />
      <canvas
        ref={canvasRef}
        style={{
          display: phase === 'pose' ? 'block' : 'none',
          height: 'min(50vh, 480px)',
          maxWidth: '100%',
          aspectRatio: '4/3',
          objectFit: 'contain',
          background: '#1f2937',
          borderRadius: '12px',
        }}
      />

      {status === 'error' && (
        <p style={{ margin: 0, color: '#f87171' }}>
          エラーが発生しました。カメラの権限を確認してください。
        </p>
      )}

      {/* ---- 1. 名前 ---- */}
      {phase === 'name' && (
        <div style={panelStyle}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <span style={{ color: '#9ca3af', fontSize: '0.9rem' }}>ライダー名</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: 龍騎"
              style={{
                padding: '0.6rem 0.8rem',
                fontSize: '1.1rem',
                borderRadius: '8px',
                border: '1px solid #374151',
                background: '#111827',
                color: '#fff',
              }}
            />
          </label>

          {/* センサーセット（GR 番号）。選ぶと変身後はそのセットの BLE デバイスしか接続候補に出ない */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <span style={{ color: '#9ca3af', fontSize: '0.9rem' }}>
              センサーセット（実機ラベルの GR 番号。近くの他プレイヤーのセンサーを拾わないための紐付け）
            </span>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {SENSOR_SETS.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setSensorSet(n)}
                  style={tabButtonStyle(sensorSet === n)}
                >
                  GR{n}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setSensorSet(null)}
                style={tabButtonStyle(sensorSet === null)}
              >
                なし（制限しない）
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setPhase('image')}
            disabled={!name.trim()}
            style={primaryButtonStyle(!!name.trim())}
          >
            次へ（画像登録）
          </button>
        </div>
      )}

      {/* ---- 2. 画像 ---- */}
      {phase === 'image' && (
        <div style={panelStyle}>
          {!imageDataUrl && (
            <>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => setImageSource('camera')}
                  style={tabButtonStyle(imageSource === 'camera')}
                >
                  📷 カメラで撮影
                </button>
                <button
                  type="button"
                  onClick={() => setImageSource('upload')}
                  style={tabButtonStyle(imageSource === 'upload')}
                >
                  📁 ファイルをアップロード
                </button>
              </div>

              {imageSource === 'camera' ? (
                <button
                  type="button"
                  onClick={handleShutter}
                  disabled={status !== 'running'}
                  style={primaryButtonStyle(status === 'running')}
                >
                  📷 シャッター
                </button>
              ) : (
                <input type="file" accept="image/*" onChange={handleUpload} style={{ color: '#9ca3af' }} />
              )}
            </>
          )}

          {imageDataUrl && (
            <>
              <img
                src={imageDataUrl}
                alt="登録するカード画像"
                style={{ maxWidth: '100%', maxHeight: '320px', borderRadius: '8px', alignSelf: 'center' }}
              />
              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
                <button type="button" onClick={() => setImageDataUrl(null)} style={secondaryButtonStyle}>
                  🔄 撮り直す / 選び直す
                </button>
                <button type="button" onClick={() => setPhase('pose')} style={primaryButtonStyle(true)}>
                  次へ（ポーズ登録）
                </button>
              </div>
            </>
          )}

          <button type="button" onClick={() => setPhase('name')} style={backButtonStyle}>
            ← 戻る
          </button>
        </div>
      )}

      {/* ---- 3. ポーズ ---- */}
      {phase === 'pose' && (
        <div style={panelStyle}>
          <span style={{ fontSize: '1rem' }}>
            カメラの前で変身ポーズを取り「このポーズを登録」を押してください。複数登録すると連続ポーズ（手順）になります。
          </span>
          {captureSim !== null && (
            <span style={{ color: captureSim >= DEFAULT_MIN_SCORE ? '#4ade80' : '#9ca3af', fontSize: '0.9rem' }}>
              直前に登録したポーズとの一致度: {captureSim} / 100（再現チェック用）
            </span>
          )}
          <button
            type="button"
            onClick={handleCapturePose}
            disabled={status !== 'running'}
            style={primaryButtonStyle(status === 'running')}
          >
            📸 このポーズを登録
          </button>

          {steps.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {steps.map((s, i) => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <span style={{ color: '#a78bfa', fontFamily: 'monospace' }}>{i + 1}.</span>
                  <span>{s.label}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveStep(s.id)}
                    style={{ ...secondaryButtonStyle, marginLeft: 'auto', padding: '0.2rem 0.6rem' }}
                  >
                    ✕ 削除
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button type="button" onClick={() => setPhase('image')} style={backButtonStyle}>
              ← 戻る
            </button>
            <button
              type="button"
              onClick={() => setPhase('preview')}
              disabled={steps.length === 0}
              style={{ ...primaryButtonStyle(steps.length > 0), marginLeft: 'auto' }}
            >
              次へ（確認）
            </button>
          </div>
        </div>
      )}

      {/* ---- 4. 確認・確定 ---- */}
      {phase === 'preview' && (
        <div style={panelStyle}>
          <h2 style={{ margin: 0, fontSize: '1.2rem' }}>登録内容の確認</h2>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {imageDataUrl && (
              <img
                src={imageDataUrl}
                alt="カード画像"
                style={{ width: '200px', borderRadius: '8px' }}
              />
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <span>
                名前: <strong style={{ color: '#a78bfa', fontSize: '1.2rem' }}>{name.trim()}</strong>
              </span>
              <span style={{ color: '#9ca3af' }}>
                センサーセット: {sensorSet != null ? `GR${sensorSet}` : 'なし（制限しない）'}
              </span>
              <span style={{ color: '#9ca3af' }}>変身ポーズ: {steps.length} ステップ</span>
              {steps.map((s, i) => (
                <span key={s.id} style={{ fontSize: '0.9rem' }}>
                  {i + 1}. {s.label}
                </span>
              ))}
            </div>
          </div>

          {saveError && <span style={{ color: '#f87171' }}>{saveError}</span>}

          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button type="button" onClick={() => setPhase('pose')} disabled={saving} style={backButtonStyle}>
              ← 戻る
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={saving}
              style={{ ...primaryButtonStyle(!saving), marginLeft: 'auto' }}
            >
              {saving ? '保存中…' : '✅ 登録を確定'}
            </button>
          </div>
        </div>
      )}

      <p style={{ color: '#6b7280', fontSize: '0.8rem', margin: 0 }}>
        登録データは Cloudflare R2 に保存され、どの PC の /auth からもカード認証・ポーズ認証にすぐ使えます。
      </p>
    </div>
  )
}

const panelStyle: CSSProperties = {
  width: '100%',
  maxWidth: '800px',
  background: '#1f2937',
  borderRadius: '12px',
  padding: '1rem 1.5rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
}

function primaryButtonStyle(enabled: boolean): CSSProperties {
  return {
    padding: '0.6rem 2rem',
    fontSize: '1rem',
    background: enabled ? '#4ade80' : '#374151',
    color: enabled ? '#000' : '#6b7280',
    border: 'none',
    borderRadius: '8px',
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontWeight: 'bold',
  }
}

const secondaryButtonStyle: CSSProperties = {
  padding: '0.6rem 1.2rem',
  fontSize: '0.9rem',
  background: '#374151',
  color: '#fff',
  border: 'none',
  borderRadius: '8px',
  cursor: 'pointer',
}

const backButtonStyle: CSSProperties = {
  ...secondaryButtonStyle,
  alignSelf: 'flex-start',
}

function tabButtonStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    padding: '0.6rem',
    fontSize: '0.95rem',
    background: active ? '#a78bfa' : '#111827',
    color: active ? '#000' : '#9ca3af',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontWeight: active ? 'bold' : 'normal',
  }
}
