// 勝者の立ち絵を 3D で見せるプレゼンタ（勝者ページ /result 用）。
//
// 設計の肝: バトルのアリーナ（arena3d）とまったく同じ FighterAvatar 抽象を流用する。
//   - いまは createBoxAvatar の box プレースホルダが立つ（アセット不要で動く）。
//   - arena3d の RIDER_MODELS にライダー別 GLB を1行登録すれば、バトルと同時にこの
//     勝者画面も自動で 3D モデルに差し替わる（このファイルは無変更）。
//
// React には依存しない純粋なレンダラ。createWinnerPresenter(container, opts) で生成し、
// dispose() で片付けるだけ（バトルの createArenaRenderer と同じ使い勝手）。背景は透過なので、
// 勝者ページ側の CSS（夕景・後光）の上に 3D キャラだけが合成される。

import * as THREE from 'three'
import { createAvatar } from './arena3d'
import type { FighterAvatar } from './arena3d'
import type { PlayerAction, PlayerState } from './state'
import { ARENA } from './state'

export interface WinnerPresenterOptions {
  riderId: string
  color: number // 0xRRGGBB（バトルの PLAYER_COLORS と対応）
  action?: PlayerAction // 立ちポーズ（既定 idle。'final' で両腕を上げた勝利ポーズ）
  facingDeg?: number // カメラに対する向き（度。既定 -70°＝3/4 のヒーローアングル）
}

// setAction に渡せるアクション。'walk'/'jump' は PlayerState の action には無い
// 見た目だけの疑似アクション（moving フラグ・y>0 でアバターの該当クリップを引き出す）。
export type PresenterAction = PlayerAction | 'walk' | 'jump'

export interface WinnerPresenter {
  // 立ちポーズを差し替える（ペアリング画面の入力テストでパンチ等を再生する用）。
  // GLB のクリップは一回再生系（punch/kick 等）でもアバター側が idle へ戻す判断をしないため、
  // 呼び出し側で少し待って 'idle' に戻すこと。
  setAction(action: PresenterAction): void
  dispose(): void
}

// 立ちポーズを描かせるためのダミー PlayerState（アバターの update に渡す）。
function standPose(riderId: string, action: PlayerAction): PlayerState {
  return {
    id: 'winner',
    riderId,
    riderName: '',
    hp: 100,
    maxHp: 100,
    x: 0.5,
    y: 0,
    vx: 0,
    vy: 0,
    facing: 1,
    action,
    actionUntil: 0,
    isSelf: false,
    guarding: false,
    shield: ARENA.shieldMax,
    shieldRegenAt: 0,
    stunUntil: 0,
    freezeUntil: 0,
    invulnUntil: 0,
    comboCount: 0,
    comboBy: null,
    comboUntil: 0,
    meter: 0,
    move: null,
    moveActiveFrom: 0,
    moveActiveTo: 0,
    moveHasHit: false,
    cancelUntil: 0,
  }
}

export function createWinnerPresenter(
  container: HTMLElement,
  opts: WinnerPresenterOptions,
): WinnerPresenter {
  const width = () => container.clientWidth || 320
  const height = () => container.clientHeight || 480

  const scene = new THREE.Scene()

  // 縦長のポートレート・カメラ。初期値は仮置きで、実際の構図はループ内の自動フィットが
  // キャラの実寸（box ≈1.9 / GLB は height 指定で ~0.5 とモデルごとに全高が違う）に合わせる。
  const camera = new THREE.PerspectiveCamera(30, width() / height(), 0.1, 100)
  camera.position.set(0, 1.35, 4.4)
  camera.lookAt(0, 1.1, 0)

  // 背景透過（CSS の夕景に 3D キャラだけ乗せる）。
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(width(), height())
  renderer.setClearColor(0x000000, 0)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  container.appendChild(renderer.domElement)

  // ライティング（box の MeshStandardMaterial を立たせる）。
  // Webワールド（電脳空間）の背景に合わせた寒色系（リザルト・ペアリングとも共通）。
  scene.add(new THREE.HemisphereLight(0xcfe2ff, 0x1a2233, 1.05))
  const key = new THREE.DirectionalLight(0xffffff, 1.5)
  key.position.set(2.4, 5, 4)
  key.castShadow = true
  key.shadow.mapSize.set(1024, 1024)
  key.shadow.camera.left = -3
  key.shadow.camera.right = 3
  key.shadow.camera.top = 5
  key.shadow.camera.bottom = -1
  key.shadow.camera.near = 0.5
  key.shadow.camera.far = 20
  scene.add(key)
  const rim = new THREE.DirectionalLight(opts.color, 0.6)
  rim.position.set(-3, 2.5, -2)
  scene.add(rim)

  // 足元の接地影だけを拾う透明フロア（背景は透けたまま影が落ちる）。
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 10),
    new THREE.ShadowMaterial({ opacity: 0.32 }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.receiveShadow = true
  scene.add(floor)

  // 勝者アバター（バトルと共有の抽象。GLB 登録で自動差し替え）。
  const avatar: FighterAvatar = createAvatar(opts.riderId, opts.color)
  scene.add(avatar.root)

  const synth = standPose(opts.riderId, opts.action ?? 'idle')
  // 'down'（倒れる）はアバター側が hp<=0 で判定するため、action 指定だけでなく hp も落とす
  // （リザルトの敗者表示: death クリップを一度再生して倒れたまま止まる）。
  if (synth.action === 'down') synth.hp = 0
  let moving = false // 'walk' 疑似アクション用（update の moving フラグで走りクリップを出す）
  const baseYaw = ((opts.facingDeg ?? -70) * Math.PI) / 180

  // --- カメラの全身フィット ---
  // GLB は非同期ロード＋モデルごとに全高が違う（自動フィットの height 指定）ため、
  // 固定カメラだと頭が切れたり豆粒になったりする。毎フレーム実寸を測って軟着させる。
  // スキンメッシュは Box3.setFromObject だと骨格のスケールを拾えないので、
  // arena3d のロード時計測と同じくボーンのワールド座標から測る。
  const fitBox = new THREE.Box3()
  const fitVec = new THREE.Vector3()
  const lookTarget = new THREE.Vector3(0, 1.1, 0)
  const measure = () => {
    fitBox.makeEmpty()
    let bones = 0
    avatar.root.traverse((o) => {
      if ((o as THREE.Bone).isBone) {
        bones++
        fitBox.expandByPoint(o.getWorldPosition(fitVec))
      }
    })
    if (bones === 0) fitBox.setFromObject(avatar.root)
  }
  const fitCamera = () => {
    scene.updateMatrixWorld(true)
    measure()
    const size = fitBox.getSize(fitVec)
    // 縦だけでなく横も収める（倒れたポーズ＝横に長い場合はアスペクト換算で引く）。
    const h = Math.max(size.y, size.x / Math.max(0.3, camera.aspect))
    if (!(h > 0.01) || !Number.isFinite(h)) return
    const cx = (fitBox.min.x + fitBox.max.x) / 2
    const cy = (fitBox.min.y + fitBox.max.y) / 2
    const cz = (fitBox.min.z + fitBox.max.z) / 2
    // ボーン基準の箱は頭頂・手先のメッシュ分だけ実際より小さいので余白を持たせる。
    // 係数は見た目調整: 大きいほどカメラが引く（1.45 では寄りすぎたため 1.9）。
    const fitH = h * 1.9
    const dist = fitH / 2 / Math.tan((camera.fov * Math.PI) / 360)
    // 軟着（アニメで箱が揺れてもカメラがガタつかない）。
    // 横位置(x/z)もキャラの実位置を追う: death のようにルートモーションで移動する
    // クリップだと、原点固定のままではキャラがフレーム外へずれていく。
    camera.position.x += (cx - camera.position.x) * 0.08
    camera.position.y += (cy + h * 0.08 - camera.position.y) * 0.08
    camera.position.z += (cz + Math.max(0.8, dist) - camera.position.z) * 0.08
    lookTarget.x += (cx - lookTarget.x) * 0.08
    lookTarget.y += (cy - lookTarget.y) * 0.08
    lookTarget.z += (cz - lookTarget.z) * 0.08
    camera.lookAt(lookTarget)
  }

  let raf = 0
  let disposed = false
  const loop = () => {
    if (disposed) return
    const t = performance.now() / 1000
    // 毎フレーム位置をリセットしてから update（box の踏み込み加算が溜まらないように）。
    avatar.root.position.set(0, 0, 0)
    avatar.root.rotation.y = baseYaw + Math.sin(t * 0.6) * 0.12 // 緩いターンテーブル
    avatar.update(synth, t, moving)
    fitCamera()
    renderer.render(scene, camera)
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)

  const resize = () => {
    camera.aspect = width() / height()
    camera.updateProjectionMatrix()
    renderer.setSize(width(), height())
  }
  const ro = new ResizeObserver(resize)
  ro.observe(container)

  return {
    setAction(action) {
      if (action === 'walk') {
        synth.action = 'idle'
        synth.y = 0
        moving = true
      } else if (action === 'jump') {
        // p.y > 0 でアバターが jump クリップに切り替わる（root も少し浮く）
        synth.action = 'idle'
        synth.y = 0.25
        moving = false
      } else {
        synth.action = action
        synth.y = 0
        moving = false
      }
      synth.hp = action === 'down' ? 0 : 100 // down はアバターが hp<=0 で判定する
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      avatar.dispose()
      floor.geometry.dispose()
      ;(floor.material as THREE.Material).dispose()
      renderer.dispose()
      // dispose() だけでは WebGL コンテキストが残るので明示破棄（勝者画面を何度も開くと積み上がるため）。
      renderer.forceContextLoss()
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement)
      }
    },
  }
}
