// バトルステージの 3D 描画（three.js）。React にも通信にも依存しない純粋なレンダラ。
// createArenaRenderer(container) で生成し、毎フレーム render(state) に BattleState を渡すだけ。
//
// キャラは「FighterAvatar」インターフェースで抽象化してある:
//   - createBoxAvatar : box プリミティブの人型プレースホルダ（アセット不要・いま動く）
//   - createGltfAvatar: GLB モデルを読み込むアバター（AnimationMixer でクリップ再生）
// RIDER_MODELS にライダー別の GLB url とクリップ名を登録すれば、box から自動で差し替わる。
// renderer 側は FighterAvatar しか見ないので、モデルを足しても描画ロジックは無変更。

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { BattleState, PlayerState } from './state'

// プレイヤー表示色（battle.tsx の PLAYER_COLORS と対応）。
const PLAYER_COLORS = [0xa78bfa, 0xf87171, 0x34d399, 0xfbbf24, 0x38bdf8]
const WORLD_W = 16 // 正規化 x(0..1) をワールド X(-8..8) に写す（ステージ横幅）
const JUMP_WORLD = 2.4 // 正規化ジャンプ高さ(y) → ワールド高さ

// 格ゲー風フォローカメラの設定。据わった横視点で、ゆっくり pan、ズームは控えめ。
const CAM = {
  fov: 36, // やや望遠（平面的で 2D 格ゲーっぽい見え方）
  y: 2.7, // カメラ高さ（低め＝横視点）
  lookY: 1.3, // 注視点の高さ
  padX: 2.5, // 左右の余白（ワールド）
  halfY: 2.6, // 縦に収める範囲（ジャンプで無理に引かない）
  minDist: 10, // 最接近
  maxDist: 15, // 最遠（ズーム幅を小さくして落ち着かせる）
  damp: 0.045, // 追従の滑らかさ（小さい＝ゆっくり据わる）
}

// アバターのアクション。GLB のアニメクリップ対応付けのキーにも使う。
export type AvatarAction =
  | 'idle'
  | 'walk'
  | 'punch'
  | 'kick'
  | 'hit'
  | 'down'
  | 'final'
  | 'jump'
  | 'guard'
  | 'throw'
  | 'thrown'
  | 'abare'

// ライダー別 GLB モデルの登録。ここに 1 行足すだけで box プレースホルダから差し替わる。
//   例) GLB を用意したら（Vite なら import url from '#/assets/models/ryuki.glb?url'）:
//   export const RIDER_MODELS = {
//     ryuki: {
//       url: ryukiUrl,
//       scale: 1,
//       clips: { idle:'Idle', walk:'Walk', punch:'Punch', kick:'Kick', hit:'Hit', down:'Down', final:'Final', jump:'Jump' },
//     },
//   }
export interface RiderModel {
  url: string
  scale?: number // モデルの拡大率（既定 1）
  yOffset?: number // 足の接地補正（モデル原点が足元でない場合）
  clips?: Partial<Record<AvatarAction, string>> // アクション → GLB 内クリップ名
}

export const RIDER_MODELS: Record<string, RiderModel> = {
  // まだアセット未定のため空。ここに登録されていないライダーは box プレースホルダで描画される。
}

// box でも GLB でも renderer からは同じに見えるアバター。
export interface FighterAvatar {
  root: THREE.Object3D
  // 毎フレーム、プレイヤー状態に合わせて見た目を更新する。
  update(p: PlayerState, tSec: number, moving: boolean): void
  dispose(): void
}

const lerp = THREE.MathUtils.lerp
const loader = new GLTFLoader()

function darken(hex: number, f: number): number {
  const r = Math.floor(((hex >> 16) & 0xff) * f)
  const g = Math.floor(((hex >> 8) & 0xff) * f)
  const b = Math.floor((hex & 0xff) * f)
  return (r << 16) | (g << 8) | b
}

// プレイヤー状態 → アバターのアクション。
function avatarAction(p: PlayerState, moving: boolean): AvatarAction {
  if (p.hp <= 0) return 'down'
  if (p.action === 'hit') return 'hit'
  if (p.action === 'thrown') return 'thrown'
  if (p.action === 'guard') return 'guard'
  if (p.action === 'throw') return 'throw'
  if (p.action === 'abare') return 'abare'
  if (p.action === 'punch') return 'punch'
  if (p.action === 'kick') return 'kick'
  if (p.action === 'final') return 'final'
  if (p.y > 0.001) return 'jump'
  if (moving) return 'walk'
  return 'idle'
}

export function createArenaRenderer(container: HTMLElement): ArenaRenderer {
  const width = () => container.clientWidth || 800
  const height = () => container.clientHeight || 420

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0b1220)
  scene.fog = new THREE.Fog(0x0b1220, 16, 34)

  const camera = new THREE.PerspectiveCamera(CAM.fov, width() / height(), 0.1, 100)
  camera.position.set(0, CAM.y, 12)
  camera.lookAt(0, CAM.lookY, 0)
  const camLook = new THREE.Vector3(0, CAM.lookY, 0) // 現在の注視点（追従で lerp する）
  const camTargetPos = new THREE.Vector3()
  const tmpVec = new THREE.Vector3()

  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(width(), height())
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  container.appendChild(renderer.domElement)

  // ライティング
  scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x1a2233, 0.9))
  const key = new THREE.DirectionalLight(0xffffff, 1.15)
  key.position.set(5, 11, 7)
  key.castShadow = true
  key.shadow.mapSize.set(1024, 1024)
  key.shadow.camera.left = -8
  key.shadow.camera.right = 8
  key.shadow.camera.top = 8
  key.shadow.camera.bottom = -2
  key.shadow.camera.near = 1
  key.shadow.camera.far = 30
  scene.add(key)
  const rim = new THREE.DirectionalLight(0x5577aa, 0.4)
  rim.position.set(0, 4, -6)
  scene.add(rim)

  // 床（グリッド＋受け影プレーン）
  const grid = new THREE.GridHelper(40, 40, 0x38bdf8, 0x1e3a5f)
  const gridMat = grid.material as THREE.Material
  gridMat.transparent = true
  gridMat.opacity = 0.55
  scene.add(grid)
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0x0a1120, roughness: 1, metalness: 0 }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.y = -0.02
  floor.receiveShadow = true
  scene.add(floor)

  // 作り込んだ背景（グラデ空・月・遠景ビル群・ネオンピラー・星・地面グロー）
  const backdrop = buildBackdrop()
  scene.add(backdrop)
  // ファイナルベント演出用の紫ライト（通常は消灯）
  const ventLight = new THREE.PointLight(0xa855f7, 0, 60)
  ventLight.position.set(0, 5, 8)
  scene.add(ventLight)

  const avatars = new Map<string, FighterAvatar>()
  const lastX = new Map<string, number>()
  const worldX = (x: number) => (x - 0.5) * WORLD_W

  // --- FX（ジュース）: 画面シェイク / ヒットスパーク / ズームパンチ ---
  const camBase = new THREE.Vector3(0, CAM.y, 12)
  let shakeMag = 0
  let zoomKick = 0
  let lastFxT = 0
  const sparkTex = makeSparkTexture()
  const sparks: { sprite: THREE.Sprite; mat: THREE.SpriteMaterial; life: number; ttl: number; base: number }[] = []

  function shake(mag: number) {
    shakeMag = Math.min(0.9, Math.max(shakeMag, mag))
  }
  function punch(amount: number) {
    zoomKick = Math.min(2.4, zoomKick + amount)
  }
  function hitSpark(normX: number, normY: number, color = 0xffe08a, big = false) {
    const mat = new THREE.SpriteMaterial({
      map: sparkTex,
      color,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: false,
    })
    const sprite = new THREE.Sprite(mat)
    sprite.position.set(worldX(normX), normY * JUMP_WORLD + 1.2, 0.6)
    const base = big ? 3.4 : 2.0
    sprite.scale.setScalar(base * 0.4)
    scene.add(sprite)
    sparks.push({ sprite, mat, life: 0, ttl: big ? 0.26 : 0.18, base })
  }

  // 短命スパークの時間発展（拡大しながらフェードアウト）＋ シェイク/ズームの減衰。
  function stepFx(dt: number) {
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i]
      s.life += dt
      const k = s.life / s.ttl
      if (k >= 1) {
        scene.remove(s.sprite)
        s.mat.dispose()
        sparks.splice(i, 1)
        continue
      }
      s.sprite.scale.setScalar(s.base * (0.4 + k * 1.0))
      s.mat.opacity = 1 - k
    }
    shakeMag *= 0.86
    zoomKick *= 0.85
    if (shakeMag < 0.0005) shakeMag = 0
    if (zoomKick < 0.002) zoomKick = 0
  }

  // 波動弾のスプライト（エネルギー弾）。projectile.id ごとに 1 枚を出し入れする。
  const projSprites = new Map<string, THREE.Sprite>()

  function ensureAvatar(p: PlayerState, index: number): FighterAvatar {
    let av = avatars.get(p.id)
    if (!av) {
      const color = PLAYER_COLORS[index % PLAYER_COLORS.length]
      const model = RIDER_MODELS[p.riderId]
      av = model ? createGltfAvatar(model, color) : createBoxAvatar(color)
      scene.add(av.root)
      avatars.set(p.id, av)
    }
    return av
  }

  function render(state: BattleState, final = false) {
    // いなくなったプレイヤー（離脱・退出）のアバターを破棄
    for (const [id, av] of avatars) {
      if (!state.players.some((p) => p.id === id)) {
        scene.remove(av.root)
        av.dispose()
        avatars.delete(id)
        lastX.delete(id)
      }
    }

    const t = performance.now() / 1000
    state.players.forEach((p, index) => {
      const av = ensureAvatar(p, index)
      const wx = worldX(p.x)
      av.root.position.x = wx
      av.root.rotation.y = p.facing === 1 ? 0 : Math.PI // 正面(+x) / 背面(-x)
      const prev = lastX.get(p.id) ?? wx
      const moving = Math.abs(wx - prev) > 0.003
      lastX.set(p.id, wx)
      av.update(p, t, moving)
    })

    // 波動弾（エネルギー弾）の描画: 存在する弾にスプライトを割り当て、消えたら破棄。
    const projectiles = state.projectiles ?? []
    const seenProj = new Set<string>()
    for (const pr of projectiles) {
      seenProj.add(pr.id)
      let sp = projSprites.get(pr.id)
      if (!sp) {
        const ownerIdx = state.players.findIndex((p) => p.id === pr.owner)
        const color = PLAYER_COLORS[(ownerIdx < 0 ? 0 : ownerIdx) % PLAYER_COLORS.length]
        const mat = new THREE.SpriteMaterial({
          map: sparkTex,
          color,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          transparent: true,
          fog: false,
        })
        sp = new THREE.Sprite(mat)
        scene.add(sp)
        projSprites.set(pr.id, sp)
      }
      sp.position.set(worldX(pr.x), pr.y * JUMP_WORLD + 0.7, 0.4)
      sp.scale.setScalar(1.5 + Math.sin(t * 22) * 0.18) // 脈動
    }
    for (const [id, sp] of projSprites) {
      if (!seenProj.has(id)) {
        scene.remove(sp)
        ;(sp.material as THREE.SpriteMaterial).dispose()
        projSprites.delete(id)
      }
    }

    // ファイナルベント中は場を紫に寄せ、紫ライトを焚く
    ;(scene.fog as THREE.Fog).color.lerp(new THREE.Color(final ? 0x2a1052 : 0x0b1220), 0.1)
    ;(scene.background as THREE.Color).lerp(new THREE.Color(final ? 0x1a0f3a : 0x070b16), 0.1)
    ventLight.intensity = lerp(ventLight.intensity, final ? 3.2 : 0, 0.12)

    // 格ゲー風フォローカメラ: 生存プレイヤーを画面に収めるよう pan＋zoom
    const shown = state.players.filter((p) => p.hp > 0)
    const xs = (shown.length ? shown : state.players).map((p) => worldX(p.x))
    if (xs.length) {
      // pan の中心は平均位置（端の増減で急に振れないので落ち着く）
      const center = xs.reduce((a, b) => a + b, 0) / xs.length
      const spread = Math.max(...xs) - Math.min(...xs)
      const vHalf = Math.tan((CAM.fov * Math.PI) / 360)
      // 横が収まる距離をクランプ（幅を狭くしてあるのでズームはわずか）。zoomKick で命中時に寄る。
      const needX = (spread / 2 + CAM.padX) / (vHalf * camera.aspect)
      const dist = Math.min(CAM.maxDist, Math.max(CAM.minDist, needX)) - zoomKick
      camTargetPos.set(center, CAM.y, dist)
      camBase.lerp(camTargetPos, CAM.damp)
      camLook.lerp(tmpVec.set(center, CAM.lookY, 0), CAM.damp)
    }

    // FX の時間発展（スパーク・シェイク・ズーム減衰）
    const dtFx = lastFxT ? Math.min(t - lastFxT, 0.05) : 0
    lastFxT = t
    stepFx(dtFx)

    // シェイクは camBase にオフセットを足して描画（次フレームの pan で自己補正）
    camera.position.copy(camBase)
    if (shakeMag > 0) {
      camera.position.x += (Math.random() * 2 - 1) * shakeMag
      camera.position.y += (Math.random() * 2 - 1) * shakeMag * 0.7
    }
    camera.lookAt(camLook)

    renderer.render(scene, camera)
  }

  const resize = () => {
    camera.aspect = width() / height()
    camera.updateProjectionMatrix()
    renderer.setSize(width(), height())
  }
  const ro = new ResizeObserver(resize)
  ro.observe(container)

  return {
    render,
    shake,
    hitSpark,
    punch,
    dispose() {
      ro.disconnect()
      avatars.forEach((av) => av.dispose())
      avatars.clear()
      for (const s of sparks) {
        scene.remove(s.sprite)
        s.mat.dispose()
      }
      sparks.length = 0
      for (const sp of projSprites.values()) {
        scene.remove(sp)
        ;(sp.material as THREE.SpriteMaterial).dispose()
      }
      projSprites.clear()
      sparkTex.dispose()
      floor.geometry.dispose()
      ;(floor.material as THREE.Material).dispose()
      grid.geometry.dispose()
      disposeObject(backdrop)
      renderer.dispose()
      if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement)
    },
  }
}

export interface ArenaRenderer {
  render(state: BattleState, final?: boolean): void
  // FX（ジュース）: バトル画面が命中検出時に叩く。
  shake(mag: number): void // 画面シェイク（強さを足し込む）
  hitSpark(normX: number, normY: number, color?: number, big?: boolean): void // 命中位置に火花
  punch(amount: number): void // ズームパンチ（一瞬寄る）
  dispose(): void
}

// ---- box プレースホルダのアバター ----------------------------------------
// 頭・胴・両腕・両脚を box で組んだ人型。肩/股関節をピボットに関節が動く。
// 正式な 3D モデルが決まったら RIDER_MODELS に登録すれば GLB に差し替わる。

function makeBox(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
  m.castShadow = true
  return m
}

// 上端(ピボット)からぶら下がる手足。Group を回すと肩/股関節から振れる。
function makeLimb(len: number, thick: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group()
  const m = makeBox(thick, len, thick, mat)
  m.position.y = -len / 2
  g.add(m)
  return g
}

function createBoxAvatar(color: number): FighterAvatar {
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.35 })
  const limbMat = new THREE.MeshStandardMaterial({
    color: darken(color, 0.7),
    roughness: 0.6,
    metalness: 0.25,
  })
  const root = new THREE.Group()

  const legLen = 0.85
  const torsoH = 0.72
  const hipY = legLen
  const shoulderY = legLen + torsoH - 0.1

  const torso = makeBox(0.52, torsoH, 0.3, bodyMat)
  torso.position.y = legLen + torsoH / 2

  const head = makeBox(0.36, 0.36, 0.36, bodyMat)
  head.position.y = legLen + torsoH + 0.26
  // 仮面ライダー風のバイザー（顔の +x 側）
  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.13, 0.28),
    new THREE.MeshStandardMaterial({ color: 0x101317, emissive: 0xff3b3b, emissiveIntensity: 0.7 }),
  )
  visor.position.set(0.18, 0, 0)
  head.add(visor)

  const legFront = makeLimb(legLen, 0.17, limbMat)
  legFront.position.set(0, hipY, 0.09)
  const legBack = makeLimb(legLen, 0.17, limbMat)
  legBack.position.set(0, hipY, -0.09)

  const armFront = makeLimb(0.64, 0.14, bodyMat)
  armFront.position.set(0, shoulderY, 0.3)
  const armBack = makeLimb(0.64, 0.14, bodyMat)
  armBack.position.set(0, shoulderY, -0.3)

  root.add(torso, head, legFront, legBack, armFront, armBack)

  const pose = { armF: 0.12, armB: 0.12, legF: 0, legB: 0, tilt: 0, glow: 0, lunge: 0, extraY: 0 }

  return {
    root,
    update(p, tSec, moving) {
      const airborne = p.y > 0.001
      let armF = 0.12
      let armB = 0.12
      let legF = 0
      let legB = 0
      let tilt = 0
      let lunge = 0 // facing 方向への踏み込み量（ワールド x）
      let extraY = 0 // 軽い浮き（キック時など）
      let glow = 0
      let glowColor = color
      const bob = Math.abs(Math.sin(tSec * 2.4)) * 0.016

      if (p.hp <= 0 || p.action === 'down') {
        tilt = 1.5 // 倒れる
        legF = 0.25
        legB = -0.25
      } else if (p.action === 'thrown') {
        tilt = 1.2 // 投げられて崩れ落ちる
        lunge = -0.1
        glow = 0.8
        glowColor = 0xff5555
      } else if (p.action === 'hit') {
        tilt = 0.32 // のけぞる
        armF = -0.25
        armB = -0.25
        lunge = -0.08 // 押される
        glow = 0.9
        glowColor = 0xff3333
      } else if (p.action === 'punch') {
        armF = 1.55 // 前腕を鋭く突き出す
        armB = -0.5 // 反対の腕は引く（キレを出す）
        legF = 0.15
        tilt = -0.18 // 踏み込む
        lunge = 0.2
        glow = 0.5
      } else if (p.action === 'kick') {
        legF = 1.6 // 前脚を蹴り上げる
        legB = -0.2
        armF = -0.55 // 腕を振ってバランス
        armB = 0.6
        tilt = 0.2 // 上体を反らす
        lunge = 0.14
        extraY = 0.07 // 軸脚で軽く伸び上がる
        glow = 0.5
      } else if (p.action === 'final') {
        armF = 1.7
        armB = 1.7
        tilt = -0.14
        lunge = 0.14
        glow = 1
        glowColor = 0xffffff
      } else if (p.action === 'throw') {
        armF = 1.25 // 両腕を前に伸ばして掴む
        armB = 1.15
        tilt = -0.1
        lunge = 0.22 // 大きく踏み込む
        glow = 0.5
        glowColor = 0xfbbf24
      } else if (p.action === 'guard') {
        armF = 0.9 // 腕を前に構える
        armB = 0.72
        legF = 0.14 // 軽く腰を落とす
        legB = -0.14
        tilt = -0.1
        glow = 0.55
        glowColor = 0x38bdf8 // 青いガード光
      } else if (p.action === 'abare') {
        armF = -1.0 // 両腕を大きく振り開いて弾き飛ばす
        armB = -1.0
        legF = 0.3
        legB = -0.3
        tilt = -0.05
        extraY = 0.05
        glow = 1
        glowColor = 0xc084fc // 紫のバースト光
      } else if (airborne) {
        // ジャンプ: 膝を抱えて腕を上げる
        legF = 0.6
        legB = 0.85
        armF = -0.7
        armB = -0.7
        tilt = 0.06
      } else if (moving) {
        const s = Math.sin(tSec * 8)
        legF = s * 0.42
        legB = -s * 0.42
        armF = -s * 0.32 + 0.12
        armB = s * 0.32 + 0.12
        tilt = 0.04
      }

      // 攻撃・被弾はキビキビ、待機/歩行は滑らかに。
      const combat =
        p.action === 'punch' ||
        p.action === 'kick' ||
        p.action === 'throw' ||
        p.action === 'final' ||
        p.action === 'abare' ||
        p.action === 'hit' ||
        p.action === 'thrown'
      const k = combat ? 0.5 : 0.28
      pose.armF = lerp(pose.armF, armF, k)
      pose.armB = lerp(pose.armB, armB, k)
      pose.legF = lerp(pose.legF, legF, k)
      pose.legB = lerp(pose.legB, legB, k)
      pose.tilt = lerp(pose.tilt, tilt, k)
      pose.lunge = lerp(pose.lunge, lunge, k)
      pose.extraY = lerp(pose.extraY, extraY, k)
      pose.glow = lerp(pose.glow, glow, 0.35)

      armFront.rotation.z = pose.armF
      armBack.rotation.z = pose.armB
      legFront.rotation.z = pose.legF
      legBack.rotation.z = pose.legB
      root.rotation.z = pose.tilt
      // render 側が毎フレーム root.position.x = worldX(p.x) を設定した直後に呼ばれるので、
      // ここで踏み込み(lunge)を facing 方向へ足す（次フレームで上書きされるため蓄積しない）。
      root.position.x += pose.lunge * p.facing
      root.position.y = p.y * JUMP_WORLD + (airborne ? 0 : bob) + pose.extraY
      bodyMat.emissive.setHex(glowColor)
      bodyMat.emissiveIntensity = pose.glow
    },
    dispose() {
      disposeObject(root)
    },
  }
}

// ---- GLB モデルのアバター ------------------------------------------------
// ロード完了までは box プレースホルダを表示。完了後にモデル＋AnimationMixer へ差し替え、
// アクションに対応するクリップへクロスフェードする。

function createGltfAvatar(model: RiderModel, color: number): FighterAvatar {
  const root = new THREE.Group()
  const placeholder = createBoxAvatar(color) // ロード中の仮表示
  root.add(placeholder.root)

  let mixer: THREE.AnimationMixer | null = null
  const clipActions = new Map<AvatarAction, THREE.AnimationAction>()
  let current: THREE.AnimationAction | null = null
  let lastAct: AvatarAction | null = null
  let lastT = 0
  let loaded = false

  loader.load(
    model.url,
    (gltf: GLTF) => {
      const obj = gltf.scene
      if (model.scale) obj.scale.setScalar(model.scale)
      if (model.yOffset) obj.position.y += model.yOffset
      obj.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) m.castShadow = true
      })
      root.remove(placeholder.root)
      placeholder.dispose()
      root.add(obj)

      mixer = new THREE.AnimationMixer(obj)
      const byName = new Map(gltf.animations.map((c) => [c.name, c]))
      const oneShot: AvatarAction[] = ['punch', 'kick', 'hit', 'final']
      if (model.clips) {
        for (const [act, name] of Object.entries(model.clips) as [AvatarAction, string][]) {
          const clip = byName.get(name)
          if (!clip) continue
          const action = mixer.clipAction(clip)
          if (oneShot.includes(act)) {
            action.setLoop(THREE.LoopOnce, 1)
            action.clampWhenFinished = true
          }
          clipActions.set(act, action)
        }
      }
      loaded = true
    },
    undefined,
    (err) => {
      // 失敗時は box プレースホルダのまま続行（デモを止めない）
      console.warn('[arena3d] GLB load failed:', model.url, err)
    },
  )

  return {
    root,
    update(p, tSec, moving) {
      if (!loaded || !mixer) {
        placeholder.update(p, tSec, moving)
        return
      }
      root.position.y = p.y * JUMP_WORLD
      const act = avatarAction(p, moving)
      if (act !== lastAct) {
        lastAct = act
        const next = clipActions.get(act) ?? clipActions.get('idle') ?? null
        if (next && next !== current) {
          next.reset().fadeIn(0.15).play()
          current?.fadeOut(0.15)
          current = next
        }
      }
      const dt = lastT ? Math.min(tSec - lastT, 0.05) : 0
      lastT = tSec
      mixer.update(dt)
    },
    dispose() {
      placeholder.dispose()
      mixer?.stopAllAction()
      disposeObject(root)
    },
  }
}

// アバターを1体作る（ライダー別 GLB があれば GLB、無ければ box プレースホルダ）。
// バトルのアリーナ（createArenaRenderer）と勝者画面（winner3d）で同じ見た目・同じ
// 差し替え点を共有するためのヘルパ。RIDER_MODELS に登録すれば両方が自動で 3D 化する。
export function createAvatar(riderId: string, color: number): FighterAvatar {
  const model = RIDER_MODELS[riderId]
  return model ? createGltfAvatar(model, color) : createBoxAvatar(color)
}

// ---- 背景の作り込み ------------------------------------------------------

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a)
}

// 空・月・星・遠景ビル群・ネオンピラー・地面グローをまとめたグループを作る。
function buildBackdrop(): THREE.Group {
  const group = new THREE.Group()

  // グラデーションの夜空（大きな板）
  const sky = new THREE.Mesh(
    new THREE.PlaneGeometry(240, 90),
    new THREE.MeshBasicMaterial({ map: makeGradientTexture(), fog: false, depthWrite: false }),
  )
  sky.position.set(0, 22, -45)
  group.add(sky)

  // 月 ＋ ハロー
  const moon = new THREE.Mesh(
    new THREE.CircleGeometry(5, 48),
    new THREE.MeshBasicMaterial({ color: 0xcfe0ff, fog: false }),
  )
  moon.position.set(-18, 25, -43)
  const halo = new THREE.Mesh(
    new THREE.CircleGeometry(9, 48),
    new THREE.MeshBasicMaterial({
      color: 0x7fa8ff,
      fog: false,
      transparent: true,
      opacity: 0.25,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  halo.position.set(-18, 25, -43.5)
  group.add(halo, moon)

  // 星
  group.add(makeStars())

  // 遠景ビル群（2 列でパララックス）。窓の発光テクスチャを共有。
  const windows = makeWindowTexture()
  group.add(makeCity(-34, 22, 55, 0x0a1428, windows, 3, 11))
  group.add(makeCity(-24, 18, 42, 0x0d1a30, windows, 2, 7))

  // 左右のネオンピラー（ステージのフレーム）
  group.add(makePillar(-8.2, 0x38bdf8))
  group.add(makePillar(8.2, 0xf472b6))

  // 地面のスポットグロー
  group.add(makeGroundGlow())

  return group
}

function makeGradientTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 8
  c.height = 256
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 0, 256)
  g.addColorStop(0.0, '#04060d')
  g.addColorStop(0.5, '#0a1730')
  g.addColorStop(0.75, '#1b2f5e')
  g.addColorStop(0.88, '#3a2a66')
  g.addColorStop(1.0, '#0b1020')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 8, 256)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeWindowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 32
  c.height = 64
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#070b14'
  ctx.fillRect(0, 0, 32, 64)
  for (let y = 4; y < 64; y += 6) {
    for (let x = 4; x < 32; x += 7) {
      if (Math.random() < 0.5) continue
      ctx.fillStyle = Math.random() < 0.5 ? '#ffd27a' : '#8fd6ff'
      ctx.fillRect(x, y, 3, 4)
    }
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeCity(
  z: number,
  count: number,
  spread: number,
  color: number,
  windows: THREE.Texture,
  minH: number,
  maxH: number,
): THREE.Group {
  const g = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: 0xffffff,
    emissiveMap: windows,
    emissiveIntensity: 0.9,
    roughness: 0.95,
    metalness: 0.1,
  })
  for (let i = 0; i < count; i++) {
    const w = rand(1.6, 3.6)
    const h = rand(minH, maxH)
    const d = rand(1.6, 3)
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
    b.position.set(rand(-spread, spread), h / 2, z + rand(-4, 4))
    g.add(b)
  }
  return g
}

function makePillar(x: number, neonColor: number): THREE.Group {
  const g = new THREE.Group()
  const post = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 10, 0.7),
    new THREE.MeshStandardMaterial({ color: 0x0e1524, metalness: 0.6, roughness: 0.35 }),
  )
  post.position.set(x, 5, -2)
  post.castShadow = true
  const neon = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 9, 0.16),
    new THREE.MeshBasicMaterial({ color: neonColor, fog: false }),
  )
  neon.position.set(x + (x < 0 ? 0.36 : -0.36), 5, -1.66)
  g.add(post, neon)
  return g
}

function makeStars(): THREE.Points {
  const n = 320
  const pos = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    pos[i * 3] = rand(-70, 70)
    pos[i * 3 + 1] = rand(8, 45)
    pos[i * 3 + 2] = rand(-46, -18)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const mat = new THREE.PointsMaterial({
    color: 0x9fc6ff,
    size: 0.18,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.85,
    fog: false,
  })
  return new THREE.Points(geo, mat)
}

function makeGroundGlow(): THREE.Mesh {
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 128
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  g.addColorStop(0, 'rgba(120,180,255,0.55)')
  g.addColorStop(1, 'rgba(120,180,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 128, 128)
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(22, 12),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(c),
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    }),
  )
  m.rotation.x = -Math.PI / 2
  m.position.y = 0.02
  return m
}

// ヒットスパーク用テクスチャ（白＋十字フレア。色は SpriteMaterial.color で着色）。
function makeSparkTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.3, 'rgba(255,255,255,0.7)')
  g.addColorStop(0.7, 'rgba(255,255,255,0.18)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  // 十字のフレア（ヒットっぽさ）
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'
  ctx.lineWidth = 2.5
  ctx.beginPath()
  ctx.moveTo(32, 3)
  ctx.lineTo(32, 61)
  ctx.moveTo(3, 32)
  ctx.lineTo(61, 32)
  ctx.stroke()
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.geometry) m.geometry.dispose()
    const mat = m.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
    else if (mat) mat.dispose()
  })
}
