// カード認識（ORB 特徴点マッチング / OpenCV.js）のエンジン。
// detect.tsx から非UI部分をそっくり移設したもの。detect.tsx（調整ラボ）と
// henshin.tsx（変身フロー）が同じ実装・同じパラメータを共有する。
// 精度・距離の調整はこのファイル冒頭のパラメータで行う。

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
export const CAMERA_WIDTH = 1280
export const CAMERA_HEIGHT = 720
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

// OpenCV.js は emscripten モジュールで型が部分的なため any 扱いにする。
export type Cv = any

// カードの参照画像1枚分の定義。url は import した asset を渡す想定。
export interface CardRef {
  id: string
  label: string
  url: string
}
// 確定したマッチ結果。
export interface CardMatch {
  id: string
  label: string
  inliers: number
}

type Signature = { ref: CardRef; kp: any; des: any; w: number; h: number }

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

export interface CardMatcher {
  // 参照画像の特徴量を事前計算し終えると解決する。
  ready: Promise<void>
  // 1フレーム照合する。throttle(DETECT_INTERVAL_MS)＋安定化(STABLE_FRAMES)を内部で行い、
  // 「確定中のマッチ」（無ければ null）を毎フレーム返す。戻り値は安定値なのでチラつかない。
  detect(video: HTMLVideoElement, now: number): CardMatch | null
  // 確定状態を初期化する（Start のたびに呼ぶ）。
  reset(): void
  // OpenCV のリソースを解放する（アンマウント時に呼ぶ）。
  dispose(): void
}

// 参照画像群からカードマッチャを生成する。クライアント（ブラウザ）でのみ呼ぶこと。
export function createCardMatcher(refs: CardRef[]): CardMatcher {
  const proc = document.createElement('canvas')
  let cv: Cv = null
  let orb: any = null
  let signatures: Signature[] = []
  let disposed = false

  // 検出の間引き・安定化用の内部状態。
  let lastDetect = 0
  const stable: { id: string | null; count: number } = { id: null, count: 0 }
  let confirmed: CardMatch | null = null

  const ready = (async () => {
    const loaded = await loadCv()
    if (disposed) return
    cv = loaded
    orb = new cv.ORB(
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

    const scratch = document.createElement('canvas')
    const sigs: Signature[] = []
    for (const ref of refs) {
      const img = await loadImage(ref.url)
      if (disposed) return
      drawScaled(img, img.naturalWidth, img.naturalHeight, REF_MAX_WIDTH, scratch)
      const { kp, des, w, h } = computeFeatures(cv, orb, scratch)
      sigs.push({ ref, kp, des, w, h })
    }
    if (disposed) {
      sigs.forEach((s) => {
        s.kp.delete()
        s.des.delete()
      })
      return
    }
    signatures = sigs
  })()

  function detect(video: HTMLVideoElement, now: number): CardMatch | null {
    if (!cv || !orb || signatures.length === 0 || video.readyState < 2) return confirmed

    // 検出は重いので一定間隔に間引く。間引いている間は確定値をそのまま返す。
    if (now - lastDetect < DETECT_INTERVAL_MS) return confirmed
    lastDetect = now

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
    let best: { ref: CardRef; inliers: number } | null = null
    let second = 0
    if (frameDes.rows > 0) {
      const matcher = new cv.BFMatcher(cv.NORM_HAMMING)
      for (const sig of signatures) {
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

    // 同じ結果が連続したときだけ確定値を更新する。
    if (currentId === stable.id) {
      stable.count++
    } else {
      stable.id = currentId
      stable.count = 1
    }
    if (stable.count === STABLE_FRAMES) {
      confirmed = confident
        ? { id: best!.ref.id, label: best!.ref.label, inliers: best!.inliers }
        : null
    }

    return confirmed
  }

  function reset(): void {
    lastDetect = 0
    stable.id = null
    stable.count = 0
    confirmed = null
  }

  function dispose(): void {
    disposed = true
    signatures.forEach((s) => {
      s.kp.delete()
      s.des.delete()
    })
    signatures = []
    orb?.delete?.()
    orb = null
  }

  return { ready, detect, reset, dispose }
}
