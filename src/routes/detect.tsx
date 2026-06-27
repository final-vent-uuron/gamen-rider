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

// --- 検出パラメータ（精度・距離はここで調整する） ---
// 1画像から抽出する特徴点の最大数。多いほど遠く・小さく映っても拾えるが重くなる。
const ORB_FEATURES = 1500
// ORB 画像ピラミッドの倍率と段数。段数が多いほどスケール差（遠近）に強い。
const ORB_SCALE_FACTOR = 1.2
const ORB_LEVELS = 10
// FAST コーナー検出のしきい値。低いほど薄い模様・遠くの画像でも点を拾える（=遠距離に有利）。
const ORB_FAST_THRESHOLD = 12
// 参照画像・カメラフレームを処理する解像度（横px）。大きいほど遠くまで効くが重い。
const REF_MAX_WIDTH = 600
const PROCESS_WIDTH = 960
// カメラに要求する取得解像度。高いほど遠くの画像のディテールが残る（距離に最も効く）。
const CAMERA_WIDTH = 1280
const CAMERA_HEIGHT = 720
// 比率テスト：1位の距離が2位の distance * RATIO より近い対応だけ「良い一致」とする。
const RATIO = 0.75
// findHomography(RANSAC) の再投影誤差しきい値（px）。
const RANSAC_REPROJ = 5
// 幾何的に整合する一致点（インライア）がこの数以上ならマッチ候補とする。
const MATCH_MIN_INLIERS = 12
// 1位と2位のインライア差。これ未満なら「どれか曖昧」として未確定にする（似た画像の誤確定防止）。
const MATCH_MARGIN = 6
// 射影した参照画像の四隅がこの面積（処理px²）未満なら退化した変形として捨てる。
const MIN_QUAD_AREA = 256
// 同じ結果がこの回数連続したら確定（チラつき防止）。
const STABLE_FRAMES = 4
// 検出を回す最小間隔(ms)。表示は毎フレーム描くのでプレビューは滑らかなまま、検出だけ間引く。
const DETECT_INTERVAL_MS = 110

type Reference = (typeof REFERENCES)[number]
// OpenCV.js は emscripten モジュールで型が部分的なため any 扱いにする。
type Cv = any
type Signature = { ref: Reference; kp: any; des: any; w: number; h: number }

// OpenCV.js（WASM）はクライアントでのみ・一度だけ読み込む。SSR バンドルに載せない。
let cvPromise: Promise<Cv> | null = null
function loadCv(): Promise<Cv> {
  if (cvPromise) return cvPromise
  cvPromise = (async () => {
    const mod: any = await import('@techstark/opencv-js')
    const candidate = mod.default ?? mod
    const cv = candidate instanceof Promise ? await candidate : candidate
    if (cv.Mat) return cv
    await new Promise<void>((resolve) => {
      cv.onRuntimeInitialized = () => resolve()
    })
    return cv
  })()
  return cvPromise
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

/** 画像ソースを maxWidth に収まるよう縮小して canvas に描く。 */
function drawScaled(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  maxWidth: number,
  canvas: HTMLCanvasElement,
): void {
  const scale = Math.min(1, maxWidth / srcW)
  canvas.width = Math.round(srcW * scale)
  canvas.height = Math.round(srcH * scale)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
}

/** グレースケール化した canvas から ORB のキーポイント＋ディスクリプタを抽出する。 */
function computeFeatures(
  cv: Cv,
  orb: any,
  canvas: HTMLCanvasElement,
): { kp: any; des: any; w: number; h: number } {
  const src = cv.imread(canvas)
  const gray = new cv.Mat()
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
  const kp = new cv.KeyPointVector()
  const des = new cv.Mat()
  const mask = new cv.Mat()
  orb.detectAndCompute(gray, mask, kp, des)
  mask.delete()
  src.delete()
  gray.delete()
  return { kp, des, w: canvas.width, h: canvas.height }
}

/**
 * 射影した参照画像の四隅が「凸かつ十分な面積」を持つかを調べる。
 * 偶然の一致が作る退化した（潰れ・反転・ねじれた）ホモグラフィを弾くための妥当性チェック。
 * pts = [x0,y0, x1,y1, x2,y2, x3,y3]（参照画像の四隅を順に射影したもの）。
 */
function quadIsPlausible(pts: ArrayLike<number>): boolean {
  let area = 0
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    area += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1]
  }
  if (Math.abs(area) / 2 < MIN_QUAD_AREA) return false

  // 連続する3頂点の外積符号がすべて揃っていれば凸。
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = i
    const b = (i + 1) % 4
    const c = (i + 2) % 4
    const abx = pts[b * 2] - pts[a * 2]
    const aby = pts[b * 2 + 1] - pts[a * 2 + 1]
    const bcx = pts[c * 2] - pts[b * 2]
    const bcy = pts[c * 2 + 1] - pts[b * 2 + 1]
    const cross = abx * bcy - aby * bcx
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1
      if (sign === 0) sign = s
      else if (s !== sign) return false
    }
  }
  return true
}

/**
 * 現在フレームと参照画像1枚を照合し、幾何的に整合する一致点（インライア）数を返す。
 * 比率テストで良い対応を絞り、findHomography(RANSAC) で平面変形として辻褄が合う点だけ数える。
 */
function matchAgainst(
  cv: Cv,
  matcher: any,
  frameDes: any,
  frameKp: any,
  sig: Signature,
): number {
  if (frameDes.rows === 0 || sig.des.rows === 0) return 0

  const knn = new cv.DMatchVectorVector()
  matcher.knnMatch(sig.des, frameDes, knn, 2)

  const refPts: number[] = []
  const framePts: number[] = []
  for (let i = 0; i < knn.size(); i++) {
    const pair = knn.get(i)
    if (pair.size() < 2) continue
    const m = pair.get(0)
    const n = pair.get(1)
    if (m.distance < RATIO * n.distance) {
      const r = sig.kp.get(m.queryIdx).pt
      const f = frameKp.get(m.trainIdx).pt
      refPts.push(r.x, r.y)
      framePts.push(f.x, f.y)
    }
  }
  knn.delete()

  const good = refPts.length / 2
  // findHomography には最低4点必要。それ未満はマッチ扱いしない。
  if (good < 4) return good

  const src = cv.matFromArray(good, 1, cv.CV_32FC2, refPts)
  const dst = cv.matFromArray(good, 1, cv.CV_32FC2, framePts)
  const mask = new cv.Mat()
  const homography = cv.findHomography(src, dst, cv.RANSAC, RANSAC_REPROJ, mask)

  let inliers = 0
  if (!homography.empty() && mask.rows === good) {
    for (let i = 0; i < mask.rows; i++) inliers += mask.data[i] ? 1 : 0

    // 参照画像の四隅をフレームへ射影し、変形が平面として妥当かを確認する。
    const corners = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, sig.w, 0, sig.w, sig.h, 0, sig.h])
    const projected = new cv.Mat()
    cv.perspectiveTransform(corners, projected, homography)
    if (!quadIsPlausible(projected.data32F)) inliers = 0
    corners.delete()
    projected.delete()
  }

  src.delete()
  dst.delete()
  mask.delete()
  homography.delete()
  return inliers
}

function DetectPage() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const procRef = useRef<HTMLCanvasElement | null>(null)
  const cvRef = useRef<Cv>(null)
  const orbRef = useRef<any>(null)
  const signaturesRef = useRef<Signature[]>([])
  const rafRef = useRef<number>(0)
  const isRunningRef = useRef(false)
  const stableRef = useRef<{ id: string | null; count: number }>({ id: null, count: 0 })
  // 検出の間引き用タイムスタンプと、毎フレーム重ねる確定ラベル。
  const lastDetectRef = useRef(0)
  const overlayLabelRef = useRef<string | null>(null)

  const [status, setStatus] = useState<Status>('loading')
  const [match, setMatch] = useState<{ label: string; inliers: number } | null>(null)

  // OpenCV.js をロードし、参照画像の特徴点を事前計算する。
  useEffect(() => {
    let cancelled = false
    const proc = document.createElement('canvas')
    procRef.current = proc
    const scratch = document.createElement('canvas')

    async function init() {
      try {
        const cv = await loadCv()
        if (cancelled) return
        cvRef.current = cv
        const orb = new cv.ORB(
          ORB_FEATURES,
          ORB_SCALE_FACTOR,
          ORB_LEVELS,
          31,
          0,
          2,
          cv.ORB_HARRIS_SCORE,
          31,
          ORB_FAST_THRESHOLD,
        )
        orbRef.current = orb

        const signatures: Signature[] = []
        for (const ref of REFERENCES) {
          const img = await loadImage(ref.url)
          if (cancelled) return
          drawScaled(img, img.naturalWidth, img.naturalHeight, REF_MAX_WIDTH, scratch)
          const { kp, des, w, h } = computeFeatures(cv, orb, scratch)
          signatures.push({ ref, kp, des, w, h })
        }

        if (cancelled) {
          signatures.forEach((s) => {
            s.kp.delete()
            s.des.delete()
          })
          return
        }
        signaturesRef.current = signatures
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
      signaturesRef.current.forEach((s) => {
        s.kp.delete()
        s.des.delete()
      })
      signaturesRef.current = []
      orbRef.current?.delete?.()
    }
  }, [])

  const detect = useCallback(() => {
    if (!isRunningRef.current) return

    const cv = cvRef.current
    const video = videoRef.current
    const canvas = canvasRef.current
    const proc = procRef.current
    const orb = orbRef.current
    if (!cv || !video || !canvas || !proc || !orb || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(detect)
      return
    }

    // 表示用：フル解像度で毎フレーム描画（プレビューは常に滑らか）。
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, 0, 0)

    // 検出は重いので一定間隔に間引く。
    const now = performance.now()
    if (now - lastDetectRef.current >= DETECT_INTERVAL_MS) {
      lastDetectRef.current = now

      // 処理用：PROCESS_WIDTH に縮小して特徴点抽出。
      drawScaled(video, video.videoWidth, video.videoHeight, PROCESS_WIDTH, proc)
      const frameSrc = cv.imread(proc)
      const frameGray = new cv.Mat()
      cv.cvtColor(frameSrc, frameGray, cv.COLOR_RGBA2GRAY)
      const frameKp = new cv.KeyPointVector()
      const frameDes = new cv.Mat()
      const emptyMask = new cv.Mat()
      orb.detectAndCompute(frameGray, emptyMask, frameKp, frameDes)
      emptyMask.delete()

      // 各参照画像と照合し、インライア上位2件を求める。
      let best: { ref: Reference; inliers: number } | null = null
      let second = 0
      if (frameDes.rows > 0) {
        const matcher = new cv.BFMatcher(cv.NORM_HAMMING)
        for (const sig of signaturesRef.current) {
          const inliers = matchAgainst(cv, matcher, frameDes, frameKp, sig)
          if (!best || inliers > best.inliers) {
            if (best) second = best.inliers
            best = { ref: sig.ref, inliers }
          } else if (inliers > second) {
            second = inliers
          }
        }
        matcher.delete()
      }

      frameSrc.delete()
      frameGray.delete()
      frameKp.delete()
      frameDes.delete()

      // 閾値を超え、かつ2位と十分差がついていれば確定候補。
      const confident =
        best !== null && best.inliers >= MATCH_MIN_INLIERS && best.inliers - second >= MATCH_MARGIN
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
        overlayLabelRef.current = confident ? best!.ref.label : null
        setMatch(confident ? { label: best!.ref.label, inliers: best!.inliers } : null)
      }
    }

    // 最後に確定したラベルを毎フレーム重ねる。
    drawOverlay(ctx, canvas, overlayLabelRef.current)

    rafRef.current = requestAnimationFrame(detect)
  }, [])

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
      stableRef.current = { id: null, count: 0 }
      lastDetectRef.current = 0
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
