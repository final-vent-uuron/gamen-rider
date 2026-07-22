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
const ORB_FAST_THRESHOLD = 10
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
const MATCH_MIN_INLIERS = 7
// 1位と2位のインライア差。これ未満なら「どれか曖昧」として未確定にする（似た画像の誤確定防止）。
const MATCH_MARGIN = 6
// インライア「率」（インライア数 / 比率テストを通った対応数）の下限。
// 数だけだと、背景の雑多な特徴点にたまたま多く当たった場合に閾値を超えうる。
// 本物のカードが映っていれば良い対応の大半が1枚の平面変形で説明できる＝率が高くなる。
const MIN_INLIER_RATIO = 0.25
// CLAHE（局所ヒストグラム平坦化）の強さとタイルサイズ。
// 照明ムラ・テカリ・逆光を吸収する。clip を上げすぎるとノイズまで強調されるので 2.0 前後。
const CLAHE_CLIP = 2.0
const CLAHE_TILE = 8
// ラプラシアン分散（画像の「エッジの立ち具合」）の下限。これ未満のフレームはブレ/ピンぼけ
// と見なして検出自体をスキップする。ぼけたフレームは特徴点の記述子が崩れ、誤マッチの温床になる。
// 低すぎると効かず、高すぎると常に弾いて検出不能になるので、/detect の sharpness 表示を見て調整する。
const MIN_SHARPNESS = 25
// 射影した参照画像の四隅がこの面積（処理px²）未満なら退化した変形として捨てる。
const MIN_QUAD_AREA = 256
// 同じ結果がこの回数連続したら確定（チラつき防止）。
const STABLE_FRAMES = 2
// 検出を回す最小間隔(ms)。表示は毎フレーム描くのでプレビューは滑らかなまま、検出だけ間引く。
const DETECT_INTERVAL_MS = 110

// OpenCV.js は emscripten モジュールで型が部分的なため any 扱いにする。
export type Cv = any

// 判定に使っているしきい値を UI に公開する（/detect の調整ラボがグラフの基準線に使う）。
// UI 側で数値を書き写すと調整のたびに二重管理になるので、必ずここを参照させる。
export const THRESHOLDS = {
  ORB_FEATURES,
  MATCH_MIN_INLIERS,
  MATCH_MARGIN,
  MIN_INLIER_RATIO,
  MIN_SHARPNESS,
  RATIO,
} as const

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

// OpenCV.js（13MB超）はバンドルに同梱せず、CDN から <script> で読み込む。
// （npm 同梱だと Cloudflare Workers の容量上限を超えるため。MediaPipe と同様に jsdelivr で版固定。）
const CV_CDN_URL =
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@5.0.0-release.1/dist/opencv.js'

// CDN の opencv.js を1度だけ <script> 注入する。ブラウザでは window.cv に
// （未初期化なら）Promise がセットされる UMD ビルド。
function loadCvScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const w = window as any
    if (w.cv) return resolve()
    const existing = document.querySelector<HTMLScriptElement>('script[data-opencv]')
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('opencv.js load failed')))
      return
    }
    const script = document.createElement('script')
    script.src = CV_CDN_URL
    script.async = true
    script.dataset.opencv = 'true'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('opencv.js load failed'))
    document.head.appendChild(script)
  })
}

// OpenCV.js（WASM）はクライアントでのみ・一度だけ読み込む。SSR バンドルに載せない。
let cvPromise: Promise<Cv> | null = null
function loadCv(): Promise<Cv> {
  if (cvPromise) return cvPromise
  cvPromise = (async () => {
    await loadCvScript()
    const candidate: any = (window as any).cv
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

/**
 * canvas をグレースケール化し、CLAHE で局所コントラストを整えた Mat を返す（呼び出し側が delete する）。
 * 参照画像とカメラフレームの両方を必ずこの関数に通すこと。前処理が食い違うと、
 * 同じカードでも記述子がずれてマッチしなくなる（前処理の一貫性がそのまま精度になる）。
 * clahe が生成できない環境では equalizeHist（全体平坦化）にフォールバックする。
 */
function toProcessedGray(cv: Cv, clahe: any, canvas: HTMLCanvasElement): any {
  const src = cv.imread(canvas)
  const gray = new cv.Mat()
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
  src.delete()

  const out = new cv.Mat()
  if (clahe) clahe.apply(gray, out)
  else cv.equalizeHist(gray, out)
  gray.delete()
  return out
}

/** CLAHE を生成する。ビルドに含まれていなければ null（呼び出し側が equalizeHist に落ちる）。 */
function createClahe(cv: Cv): any {
  if (typeof cv.CLAHE !== 'function') return null
  try {
    return new cv.CLAHE(CLAHE_CLIP, new cv.Size(CLAHE_TILE, CLAHE_TILE))
  } catch {
    return null
  }
}

/**
 * ラプラシアン分散＝画像のエッジの立ち具合。値が小さいほどブレ・ピンぼけしている。
 * ぼけたフレームは特徴点の記述子が崩れるので、検出に回す前にこれで足切りする。
 */
function sharpness(cv: Cv, gray: any): number {
  const lap = new cv.Mat()
  cv.Laplacian(gray, lap, cv.CV_64F)
  const mean = new cv.Mat()
  const stddev = new cv.Mat()
  cv.meanStdDev(lap, mean, stddev)
  const sd = stddev.data64F[0]
  lap.delete()
  mean.delete()
  stddev.delete()
  return sd * sd
}

/** 前処理済みグレースケール Mat から ORB のキーポイント＋ディスクリプタを抽出する。 */
function computeFeatures(cv: Cv, orb: any, gray: any): { kp: any; des: any } {
  const kp = new cv.KeyPointVector()
  const des = new cv.Mat()
  const mask = new cv.Mat()
  orb.detectAndCompute(gray, mask, kp, des)
  mask.delete()
  return { kp, des }
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
 * インライアが 0 に落とされた理由。/detect の調整ラボが「なぜ通らないか」を出すのに使う。
 * ok=素通り / few-good=比率テスト後の対応が4点未満 / no-homography=変形を求められない
 * degenerate=射影した四隅が潰れている / low-ratio=インライア率が MIN_INLIER_RATIO 未満
 */
export type RejectReason = 'ok' | 'few-good' | 'no-homography' | 'degenerate' | 'low-ratio'

/** 参照画像1枚との照合結果の内訳。 */
export interface RefStat {
  id: string
  label: string
  // 参照画像から抽出できた特徴点の数。カードの「素材としての情報量」。少なすぎるカードは苦しい。
  refKeypoints: number
  // 比率テストを通った対応の数。
  good: number
  // 幾何検算を生き残った対応の数。判定に使うのはこの値。
  inliers: number
  reason: RejectReason
}

type MatchResult = {
  good: number
  inliers: number
  reason: RejectReason
  // インライアになったフレーム側の座標（処理解像度基準）。可視化用に返す。
  inlierPts: number[]
}

/**
 * 現在フレームと参照画像1枚を照合し、幾何的に整合する一致点（インライア）の数と内訳を返す。
 * 比率テストで良い対応を絞り、findHomography(RANSAC) で平面変形として辻褄が合う点だけ数える。
 */
function matchAgainst(
  cv: Cv,
  matcher: any,
  frameDes: any,
  frameKp: any,
  sig: Signature,
): MatchResult {
  const empty: MatchResult = { good: 0, inliers: 0, reason: 'few-good', inlierPts: [] }
  if (frameDes.rows === 0 || sig.des.rows === 0) return empty

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
  if (good < 4) return { good, inliers: 0, reason: 'few-good', inlierPts: [] }

  const src = cv.matFromArray(good, 1, cv.CV_32FC2, refPts)
  const dst = cv.matFromArray(good, 1, cv.CV_32FC2, framePts)
  const mask = new cv.Mat()
  const homography = cv.findHomography(src, dst, cv.RANSAC, RANSAC_REPROJ, mask)

  let inliers = 0
  let reason: RejectReason = 'no-homography'
  let inlierPts: number[] = []
  if (!homography.empty() && mask.rows === good) {
    reason = 'ok'
    for (let i = 0; i < mask.rows; i++) {
      if (!mask.data[i]) continue
      inliers++
      inlierPts.push(framePts[i * 2], framePts[i * 2 + 1])
    }

    // 参照画像の四隅をフレームへ射影し、変形が平面として妥当かを確認する。
    const corners = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, sig.w, 0, sig.w, sig.h, 0, sig.h])
    const projected = new cv.Mat()
    cv.perspectiveTransform(corners, projected, homography)
    const plausible = quadIsPlausible(projected.data32F)
    corners.delete()
    projected.delete()

    // 良い対応のうち幾何的に整合した割合が低い＝カード面ではなく背景に散った偶然の一致。
    if (!plausible) reason = 'degenerate'
    else if (inliers / good < MIN_INLIER_RATIO) reason = 'low-ratio'
    if (reason !== 'ok') {
      inliers = 0
      inlierPts = []
    }
  }

  src.delete()
  dst.delete()
  mask.delete()
  homography.delete()
  return { good, inliers, reason, inlierPts }
}

// 直近1回の検出の内訳。しきい値（MIN_SHARPNESS / MATCH_MIN_INLIERS / MATCH_MARGIN）を
// 実機で詰めるための観測用で、判定そのものには使わない。/detect の調整ラボが表示する。
export interface MatchStats {
  // ラプラシアン分散。MIN_SHARPNESS 未満なら blurred=true で検出をスキップした。
  sharpness: number
  blurred: boolean
  // 1位・2位のインライア数（率のゲートで落ちたものは 0 になっている）。
  bestLabel: string | null
  bestInliers: number
  secondInliers: number
  // フレームから抽出できた特徴点の数。ORB_FEATURES が上限。
  frameKeypoints: number
  // 参照画像ごとの内訳（登録順）。どのカードにどれだけ票が入ったかが分かる。
  refs: RefStat[]
  // 処理解像度。下の座標配列をプレビュー canvas に重ねるときの換算に使う。
  processWidth: number
  processHeight: number
  // 可視化用の座標（処理解像度基準の [x0,y0,x1,y1,...]）。debug 無効時は null。
  // framePoints は検出した全特徴点、bestInlierPoints は1位の参照画像と幾何的に整合した点。
  framePoints: Float32Array | null
  bestInlierPoints: Float32Array | null
}

export interface CardMatcher {
  // 参照画像の特徴量を事前計算し終えると解決する。
  ready: Promise<void>
  // 1フレーム照合する。throttle(DETECT_INTERVAL_MS)＋安定化(STABLE_FRAMES)を内部で行い、
  // 「確定中のマッチ」（無ければ null）を毎フレーム返す。戻り値は安定値なのでチラつかない。
  detect(video: HTMLVideoElement, now: number): CardMatch | null
  // 直近の検出の内訳（間引き中は最後に検出した回の値）。しきい値調整用。
  stats(): MatchStats | null
  // 確定状態を初期化する（Start のたびに呼ぶ）。
  reset(): void
  // OpenCV のリソースを解放する（アンマウント時に呼ぶ）。
  dispose(): void
}

/** 照合まで到達しなかったフレーム（ブレ・特徴点ゼロ）用の空の内訳。 */
function emptyRefStat(sig: Signature): RefStat {
  return {
    id: sig.ref.id,
    label: sig.ref.label,
    refKeypoints: sig.kp.size(),
    good: 0,
    inliers: 0,
    reason: 'few-good',
  }
}

/** KeyPointVector から座標だけを [x0,y0,x1,y1,...] に取り出す（可視化用）。 */
function readKeypoints(kp: any): Float32Array {
  const n = kp.size()
  const out = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    const p = kp.get(i).pt
    out[i * 2] = p.x
    out[i * 2 + 1] = p.y
  }
  return out
}

export interface MatcherOptions {
  // 可視化用の座標（MatchStats.framePoints / bestInlierPoints）を集める。
  // 特徴点1500個の座標取り出しは安くないので、調整ラボ（/detect）だけで有効にする。
  debug?: boolean
}

// 参照画像群からカードマッチャを生成する。クライアント（ブラウザ）でのみ呼ぶこと。
export function createCardMatcher(refs: CardRef[], options: MatcherOptions = {}): CardMatcher {
  const debug = options.debug ?? false
  const proc = document.createElement('canvas')
  let cv: Cv = null
  let orb: any = null
  let clahe: any = null
  let signatures: Signature[] = []
  let disposed = false

  // 検出の間引き・安定化用の内部状態。
  let lastDetect = 0
  const stable: { id: string | null; count: number } = { id: null, count: 0 }
  let confirmed: CardMatch | null = null
  let lastStats: MatchStats | null = null

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
    clahe = createClahe(cv)

    const scratch = document.createElement('canvas')
    const sigs: Signature[] = []
    for (const ref of refs) {
      const img = await loadImage(ref.url)
      if (disposed) return
      drawScaled(img, img.naturalWidth, img.naturalHeight, REF_MAX_WIDTH, scratch)
      // フレーム側とまったく同じ前処理（グレースケール＋CLAHE）を通す。
      const gray = toProcessedGray(cv, clahe, scratch)
      const { kp, des } = computeFeatures(cv, orb, gray)
      gray.delete()
      sigs.push({ ref, kp, des, w: scratch.width, h: scratch.height })
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

    // 処理用：PROCESS_WIDTH に縮小し、参照画像と同じ前処理（グレースケール＋CLAHE）を通す。
    drawScaled(video, video.videoWidth, video.videoHeight, PROCESS_WIDTH, proc)
    const frameGray = toProcessedGray(cv, clahe, proc)

    // ブレ・ピンぼけフレームはここで捨てる。記述子が崩れていて誤マッチしか生まないので、
    // 「判定を保留する」（＝確定値を維持し、安定化カウントも触らない）のが正しい扱い。
    const sharp = sharpness(cv, frameGray)
    if (sharp < MIN_SHARPNESS) {
      lastStats = {
        sharpness: sharp,
        blurred: true,
        bestLabel: null,
        bestInliers: 0,
        secondInliers: 0,
        frameKeypoints: 0,
        refs: signatures.map(emptyRefStat),
        processWidth: proc.width,
        processHeight: proc.height,
        framePoints: null,
        bestInlierPoints: null,
      }
      frameGray.delete()
      return confirmed
    }

    const { kp: frameKp, des: frameDes } = computeFeatures(cv, orb, frameGray)
    const frameKeypoints = frameKp.size()

    // 各参照画像と照合し、インライア上位2件を求める。
    let best: { ref: CardRef; inliers: number; pts: number[] } | null = null
    let second = 0
    const refStats: RefStat[] = []
    if (frameDes.rows > 0) {
      const matcher = new cv.BFMatcher(cv.NORM_HAMMING)
      for (const sig of signatures) {
        const r = matchAgainst(cv, matcher, frameDes, frameKp, sig)
        refStats.push({
          id: sig.ref.id,
          label: sig.ref.label,
          refKeypoints: sig.kp.size(),
          good: r.good,
          inliers: r.inliers,
          reason: r.reason,
        })
        if (!best || r.inliers > best.inliers) {
          if (best) second = best.inliers
          best = { ref: sig.ref, inliers: r.inliers, pts: r.inlierPts }
        } else if (r.inliers > second) {
          second = r.inliers
        }
      }
      matcher.delete()
    } else {
      signatures.forEach((s) => refStats.push(emptyRefStat(s)))
    }

    // 可視化用の座標取り出しは KeyPointVector を1点ずつ舐めるので、debug のときだけ行う。
    const framePoints = debug ? readKeypoints(frameKp) : null

    frameGray.delete()
    frameKp.delete()
    frameDes.delete()

    lastStats = {
      sharpness: sharp,
      blurred: false,
      bestLabel: best?.ref.label ?? null,
      bestInliers: best?.inliers ?? 0,
      secondInliers: second,
      frameKeypoints,
      refs: refStats,
      processWidth: proc.width,
      processHeight: proc.height,
      framePoints,
      bestInlierPoints: debug && best ? Float32Array.from(best.pts) : null,
    }

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

  function stats(): MatchStats | null {
    return lastStats
  }

  function reset(): void {
    lastDetect = 0
    stable.id = null
    stable.count = 0
    confirmed = null
    lastStats = null
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
    clahe?.delete?.()
    clahe = null
  }

  return { ready, detect, stats, reset, dispose }
}
