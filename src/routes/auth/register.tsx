import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ChangeEvent } from 'react'
import type { NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision'

import { createPoseLandmarker, poseSimilarity } from '../../pose'
import type { CustomStep, MediaPipeModules, RefPoint } from '../../pose'
import { RIDER_ROSTER, listRiders, saveRider } from '../../rider-registry'

export const Route = createFileRoute('/auth/register')({ component: RegisterGate })

// 簡易パスワードゲート。画面からの遷移ボタンは無く、URL 直打ち＋パスワードでだけ入れる
// （ハッカソン運用: 来場者が誤ってライダー登録をいじらないための軽い柵。セキュリティ目的ではない）。
const REGISTER_PASSWORD = 'final-ooe'
const UNLOCK_KEY = 'register-unlock' // sessionStorage（タブを閉じるまで再入力不要）

function RegisterGate() {
  const [unlocked, setUnlocked] = useState(
    () => typeof window !== 'undefined' && sessionStorage.getItem(UNLOCK_KEY) === '1',
  )
  const [input, setInput] = useState('')
  const [wrong, setWrong] = useState(false)

  if (unlocked) return <RegisterPage />

  const submit = () => {
    if (input === REGISTER_PASSWORD) {
      sessionStorage.setItem(UNLOCK_KEY, '1')
      setUnlocked(true)
    } else {
      setWrong(true)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1rem',
        background: '#0b1220',
        color: '#fff',
      }}
    >
      <h1 style={{ margin: 0, fontSize: '1.1rem' }}>ライダー登録（運営用）</h1>
      <input
        type="password"
        value={input}
        autoFocus
        placeholder="パスワード"
        onChange={(e) => {
          setInput(e.target.value)
          setWrong(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
        style={{
          padding: '0.6rem 1rem',
          borderRadius: '8px',
          border: `1px solid ${wrong ? '#f87171' : '#334155'}`,
          background: 'rgba(15,23,42,0.8)',
          color: '#fff',
          fontSize: '1rem',
          width: '220px',
          textAlign: 'center',
        }}
      />
      {wrong && <span style={{ color: '#f87171', fontSize: '0.8rem' }}>パスワードが違います</span>}
      <button
        type="button"
        onClick={submit}
        style={{
          padding: '0.55rem 2rem',
          borderRadius: '8px',
          border: 'none',
          background: 'linear-gradient(90deg, #a78bfa, #7c3aed)',
          color: '#fff',
          fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        入る
      </button>
      <Link to="/" style={{ color: '#64748b', fontSize: '0.8rem', textDecoration: 'none' }}>
        ← トップへ戻る
      </Link>
    </div>
  )
}

type Status = 'loading' | 'running' | 'error'
// name: ライダー選択 / image: カード画像登録 / pose: 変身ポーズ登録 /
// final-pose: ファイナルベントポーズ登録 / preview: 確認・確定
type Phase = 'name' | 'image' | 'pose' | 'final-pose' | 'preview'
type ImageSource = 'camera' | 'upload'

// スナップショットポーズの既定値（pose.tsx の作成モードと同じ感覚の値）
const DEFAULT_MIN_SCORE = 80 // 読み取りやすさ優先で 80（一時 85 に上げていたが認証が通りにくくなったため戻した）
const DEFAULT_HOLD_MS = 700

// 選べるセンサーセット名（BLE 名 <ライダー名>_RH/…LF の <ライダー名> 部分。
// ロースターの名前と同じにしてある＝実機ラベルもこの表記に合わせること）
const SENSOR_SETS = RIDER_ROSTER.map((r) => r.name)

const PHASES: Phase[] = ['name', 'image', 'pose', 'final-pose', 'preview']
const PHASE_LABELS: Record<Phase, string> = {
  name: '1. ライダー',
  image: '2. 画像',
  pose: '3. 変身ポーズ',
  'final-pose': '4. FVポーズ',
  preview: '5. 確認',
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
  // ライブ一致度チェックの基準（直近に登録したポーズ）。変身ポーズと FV ポーズで別に持つ。
  const henshinVerifyRef = useRef<RefPoint[] | null>(null)
  const finalVerifyRef = useRef<RefPoint[] | null>(null)
  const lastUiRef = useRef(0)

  const [status, setStatus] = useState<Status>('loading')
  const [phase, setPhaseState] = useState<Phase>('name')
  // ロースター（Arduino / Python / Swift / Flutter）から選ぶ。slug が登録ID＝R2 のファイル名。
  const [slug, setSlug] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [sensorSet, setSensorSet] = useState<string | null>(null)
  // 登録済みライダーの ID（選択ボタンに「上書きになる」印を出すため）。取得失敗は空でよい。
  const [registeredIds, setRegisteredIds] = useState<string[]>([])
  const [imageSource, setImageSource] = useState<ImageSource>('camera')
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const [steps, setSteps] = useState<CustomStep[]>([])
  const [finalSteps, setFinalSteps] = useState<CustomStep[]>([])
  const [captureSim, setCaptureSim] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  function setPhase(p: Phase) {
    phaseRef.current = p
    setPhaseState(p)
  }

  // 登録済み一覧（上書き表示用）。失敗しても登録自体には影響しない。
  useEffect(() => {
    listRiders()
      .then((riders) => setRegisteredIds(riders.map((r) => r.id)))
      .catch(() => {})
  }, [])

  // 直近に登録したポーズを「ライブ一致度」の基準にする（撮れているかの確認用）
  useEffect(() => {
    const last = [...steps].reverse().find((s) => s.kind === 'snapshot')
    henshinVerifyRef.current = last && last.kind === 'snapshot' ? last.landmarks : null
  }, [steps])
  useEffect(() => {
    const last = [...finalSteps].reverse().find((s) => s.kind === 'snapshot')
    finalVerifyRef.current = last && last.kind === 'snapshot' ? last.landmarks : null
  }, [finalSteps])

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

    const posePhase = phaseRef.current === 'pose' || phaseRef.current === 'final-pose'
    if (!posePhase || !video || !canvas || !landmarker || !mp || video.readyState < 2) {
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
    const ref = phaseRef.current === 'final-pose' ? finalVerifyRef.current : henshinVerifyRef.current
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

  // ---- ファイナルベントポーズ登録 ----

  function handleCaptureFinalPose() {
    const lm = landmarksRef.current
    if (!lm || lm.length < 33) return
    const landmarks: RefPoint[] = lm.map((p) => ({ x: p.x, y: p.y, z: p.z }))
    const n = finalSteps.length + 1
    setFinalSteps((prev) => [
      ...prev,
      {
        kind: 'snapshot',
        id: `f${Date.now()}`,
        label: `FVポーズ${n}`,
        minScore: DEFAULT_MIN_SCORE,
        holdMs: DEFAULT_HOLD_MS,
        landmarks,
      },
    ])
  }

  function handleRemoveFinalStep(id: string) {
    setFinalSteps((prev) => prev.filter((s) => s.id !== id))
  }

  // ---- 確定 ----

  async function handleConfirm() {
    if (!imageDataUrl || steps.length === 0 || finalSteps.length === 0 || !slug || !name.trim())
      return
    setSaving(true)
    setSaveError(null)
    try {
      await saveRider({
        data: { id: slug, name: name.trim(), imageDataUrl, steps, finalVentSteps: finalSteps, sensorSet },
      })
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
          display: phase === 'pose' || phase === 'final-pose' ? 'block' : 'none',
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

      {/* ---- 1. ライダー選択 ---- */}
      {phase === 'name' && (
        <div style={panelStyle}>
          <span style={{ color: '#9ca3af', fontSize: '0.9rem' }}>
            登録するライダーを選択（登録済みのライダーを選ぶと上書き登録になります）
          </span>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {RIDER_ROSTER.map((r) => (
              <button
                key={r.slug}
                type="button"
                onClick={() => {
                  setSlug(r.slug)
                  setName(r.name)
                  setSensorSet(r.sensorSet) // 既定のセンサー名（= ライダー名）。下で変更可
                }}
                style={{ ...tabButtonStyle(slug === r.slug), flex: '1 1 140px', padding: '0.9rem' }}
              >
                {r.name}
                <span style={{ display: 'block', fontSize: '0.7rem', marginTop: '2px' }}>
                  {r.sensorSet}
                  {registeredIds.includes(r.slug) ? '・登録済み（上書き）' : ''}
                </span>
              </button>
            ))}
          </div>

          {/* センサーセット（BLE 名の <ライダー名>_ 部分）。選ぶと変身後はそのセンサー名の
              BLE デバイスしか接続候補に出ない */}
          {slug && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <span style={{ color: '#9ca3af', fontSize: '0.9rem' }}>
                センサーセット（実機ラベルの「ライダー名_」部分。近くの他プレイヤーのセンサーを拾わないための紐付け）
              </span>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {SENSOR_SETS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setSensorSet(n)}
                    style={tabButtonStyle(sensorSet === n)}
                  >
                    {n}
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
          )}

          <button
            type="button"
            onClick={() => setPhase('image')}
            disabled={!slug}
            style={primaryButtonStyle(!!slug)}
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
              onClick={() => setPhase('final-pose')}
              disabled={steps.length === 0}
              style={{ ...primaryButtonStyle(steps.length > 0), marginLeft: 'auto' }}
            >
              次へ（FVポーズ登録）
            </button>
          </div>
        </div>
      )}

      {/* ---- 4. ファイナルベントポーズ ---- */}
      {phase === 'final-pose' && (
        <div style={panelStyle}>
          <span style={{ fontSize: '1rem' }}>
            バトル中「ファイナルベント」発動時に取るポーズを登録してください（変身ポーズとは別のポーズにするのがおすすめ）。複数登録すると連続ポーズ（手順）になります。
          </span>
          {captureSim !== null && (
            <span style={{ color: captureSim >= DEFAULT_MIN_SCORE ? '#4ade80' : '#9ca3af', fontSize: '0.9rem' }}>
              直前に登録したポーズとの一致度: {captureSim} / 100（再現チェック用）
            </span>
          )}
          <button
            type="button"
            onClick={handleCaptureFinalPose}
            disabled={status !== 'running'}
            style={primaryButtonStyle(status === 'running')}
          >
            📸 このポーズを登録
          </button>

          {finalSteps.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {finalSteps.map((s, i) => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <span style={{ color: '#a78bfa', fontFamily: 'monospace' }}>{i + 1}.</span>
                  <span>{s.label}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveFinalStep(s.id)}
                    style={{ ...secondaryButtonStyle, marginLeft: 'auto', padding: '0.2rem 0.6rem' }}
                  >
                    ✕ 削除
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button type="button" onClick={() => setPhase('pose')} style={backButtonStyle}>
              ← 戻る
            </button>
            <button
              type="button"
              onClick={() => setPhase('preview')}
              disabled={finalSteps.length === 0}
              style={{ ...primaryButtonStyle(finalSteps.length > 0), marginLeft: 'auto' }}
            >
              次へ（確認）
            </button>
          </div>
        </div>
      )}

      {/* ---- 5. 確認・確定 ---- */}
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
                {slug && registeredIds.includes(slug) && (
                  <span style={{ color: '#fbbf24', fontSize: '0.85rem', marginLeft: '0.5rem' }}>
                    ※ 既存の {name.trim()} を上書きします
                  </span>
                )}
              </span>
              <span style={{ color: '#9ca3af' }}>
                センサーセット: {sensorSet ?? 'なし（制限しない）'}
              </span>
              <span style={{ color: '#9ca3af' }}>変身ポーズ: {steps.length} ステップ</span>
              {steps.map((s, i) => (
                <span key={s.id} style={{ fontSize: '0.9rem' }}>
                  {i + 1}. {s.label}
                </span>
              ))}
              <span style={{ color: '#9ca3af', marginTop: '0.4rem' }}>
                ファイナルベントポーズ: {finalSteps.length} ステップ
              </span>
              {finalSteps.map((s, i) => (
                <span key={s.id} style={{ fontSize: '0.9rem' }}>
                  {i + 1}. {s.label}
                </span>
              ))}
            </div>
          </div>

          {saveError && <span style={{ color: '#f87171' }}>{saveError}</span>}

          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button
              type="button"
              onClick={() => setPhase('final-pose')}
              disabled={saving}
              style={backButtonStyle}
            >
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
