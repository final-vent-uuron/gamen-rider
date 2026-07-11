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

export interface WinnerPresenterOptions {
  riderId: string
  color: number // 0xRRGGBB（バトルの PLAYER_COLORS と対応）
  action?: PlayerAction // 立ちポーズ（既定 idle。'final' で両腕を上げた勝利ポーズ）
  facingDeg?: number // カメラに対する向き（度。既定 -70°＝3/4 のヒーローアングル）
}

export interface WinnerPresenter {
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

  // 立ち姿がちょうど収まる縦長のポートレート・カメラ（キャラ全高 ~2.3、中心 y~1.15）。
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
  scene.add(new THREE.HemisphereLight(0xffe6c2, 0x33241a, 1.05))
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
  const baseYaw = ((opts.facingDeg ?? -70) * Math.PI) / 180

  let raf = 0
  let disposed = false
  const loop = () => {
    if (disposed) return
    const t = performance.now() / 1000
    // 毎フレーム位置をリセットしてから update（box の踏み込み加算が溜まらないように）。
    avatar.root.position.set(0, 0, 0)
    avatar.root.rotation.y = baseYaw + Math.sin(t * 0.6) * 0.12 // 緩いターンテーブル
    avatar.update(synth, t, false)
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
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      avatar.dispose()
      floor.geometry.dispose()
      ;(floor.material as THREE.Material).dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement)
      }
    },
  }
}
