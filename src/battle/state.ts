// バトルの「状態そのもの」。描画にも通信にも依存しない純粋なモデル＋更新関数。
// 設計方針:
//   - ローカル入力     : applyAttack / applyThrow / applyJump / stepBattle を呼ぶ
//   - WebSocket 同期    : 受信メッセージから同じ関数を呼ぶだけで結線できる（サーバー権威）
//   - 描画             : three.js でも 2D でも BattleState を読むだけ
// 数値は ARENA / MOVES にまとめてあるので、調整はここ 1 箇所で行う。
//
// ★ フレームベース戦闘（ちゃんとした格ゲー）:
//   技は「発生(startup)→持続(active)→硬直(recovery)」の時間で進行する。
//   - applyAttack/applyThrow は技を“開始”するだけ（当たり判定はしない）。
//   - 当たり判定は stepBattle の毎 tick で「持続フレーム中の技」に対してのみ行う。
//     → 発生前(startup)に潰されればカウンター、空振れば硬直を晒す＝差し合いが成立。
//   - ヒット/ガードで「キャンセル窓」が開き、軽→重→必殺 をキャンセルで繋げる（コンボ）。
//   - ヒットストップ・ヒットスタン・ガード・投げ・逆転ゲージ・空中慣性 も同居。

export type PlayerAction =
  | 'idle'
  | 'punch'
  | 'kick'
  | 'final'
  | 'hit'
  | 'down' // KO（HP0）で伏せる
  | 'guard' // ガード構え中
  | 'throw' // 投げ動作中
  | 'thrown' // 投げられてダウン（生存）
  | 'abare' // あばれ（ゲージ1本の割り込み。無敵で両隣を突き放す）
export type AttackKind = 'punch' | 'kick' | 'final' | 'shot'
export type MoveKind = 'punch' | 'kick' | 'throw' | 'final' | 'shot'

// 飛び道具（波動弾）。キャラとは別に状態へ持ち、サーバーで飛翔・当たり判定する。
export interface Projectile {
  id: string
  owner: string // 撃った人の id
  x: number // 正規化 x
  y: number // 高さ（胸の高さ付近。ジャンプで避けられる）
  dir: 1 | -1 // 進行方向
  bornAt: number // 生成時刻（寿命判定用）
}

export interface PlayerState {
  id: string
  riderId: string
  riderName: string
  hp: number
  maxHp: number
  x: number // ステージ内の水平位置 0..1（左端 0 / 右端 1）
  y: number // 高さ（0 = 接地。ジャンプ中は正の値。正規化: 頂点 ~1）
  vx: number // 水平速度（空中の慣性用。接地は入力ドリブンなので着地で 0 に）
  vy: number // 垂直速度（ジャンプ・重力用）
  facing: 1 | -1 // 向き（右 +1 / 左 -1）
  action: PlayerAction // 現在のアクション（演出・アニメ用）
  actionUntil: number // 技/被弾アクションの終端時刻(ms)。以後 idle へ
  isSelf: boolean // この端末で操作するローカルプレイヤーか
  // --- ガード / 被弾 / コンボ / ゲージ ---
  guarding: boolean
  stunUntil: number // 被弾/ブロック硬直の終了時刻。この間は行動不可
  freezeUntil: number // ヒットストップ終了時刻。この間は位置・時間が完全停止
  invulnUntil: number // 無敵の終了時刻（あばれ中はこの間ダメージを受けない）
  comboCount: number // いま受けている連続ヒット数（0 = 非コンボ）
  comboBy: string | null // 誰にコンボされているか（攻撃者 id）
  comboUntil: number // この時刻を過ぎたら comboCount をリセット
  meter: number // 逆転ゲージ 0..ARENA.meterMax（満タンで Final 解禁）
  // --- 技のフレーム状態 ---
  move: MoveKind | null // 実行中の技（null = 素の状態）
  moveActiveFrom: number // 持続フレーム開始時刻（= 発生の終わり）
  moveActiveTo: number // 持続フレーム終了時刻
  moveHasHit: boolean // この技が既に当たった（多段防止）
  cancelUntil: number // この時刻まで硬直をキャンセルして次の技を出せる
}

export interface BattleState {
  players: PlayerState[]
  projectiles: Projectile[] // 飛翔中の波動弾
  winnerId: string | null
  // 乱入演出の終了時刻(ms)。3人目以降が参戦した瞬間にサーバーが設定し、
  // この時刻まで全員の時間が完全停止する（クライアントは WARNING を表示する）。
  intrusionUntil?: number
}

// バランス・当たり判定パラメータ。ここだけ触れば挙動が変わる。
export const ARENA = {
  minX: 0.06,
  maxX: 0.94,
  moveSpeed: 0.27,
  bodyHalf: 0.031,
  bodyHeight: 0.55,
  reachPunch: 0.05,
  reachKick: 0.075,
  reachFinal: 0.206,
  reachThrow: 0.026,
  jumpVy: 5.6,
  gravity: 13,
  fallGravity: 20,
  airControl: 1.5,
  maxHp: 100,

  // ダメージ
  punchDamage: 5,
  kickDamage: 9,
  finalDamage: 34,
  throwDamage: 14,
  chipDamage: 1,

  // ノックバック・打ち上げ
  knockback: 0.026,
  kickKnockback: 0.05,
  finalKnockback: 0.083,
  throwKnockback: 0.09,
  guardPushback: 0.018,
  finalLaunch: 3.0, // Final だけ打ち上げ（締め）。地上コンボ重視なので他は打ち上げ無し

  // コンボ補正
  comboScaling: 0.82,
  comboMinScale: 0.35,
  comboResetMs: 800,

  // カウンターヒット（相手の発生/持続中に潰した）
  counterDamageMul: 1.25,
  counterStunMul: 1.45,

  // 逆転ゲージ（5 ゲージ制）。1 ゲージ = meterPerStock。満タン(5本)で Final、1本で あばれ。
  meterMax: 100,
  meterPerStock: 20, // 100 / 5 本
  meterOnDeal: 7,
  meterOnTake: 11,
  meterOnBlock: 3,
  meterFinalCost: 100, // Final は 5 ゲージ（満タン）

  // あばれ（バースト）: ゲージ1本で発動する切り返し。無敵で割り込み、両隣を突き放す。
  // 「2人に挟まれて延々殴られる（ハメ）」から抜けるための緊急脱出ボタン。
  abareCost: 20, // = 1 ゲージ（meterPerStock と同じ）
  abareRange: 0.17, // 左右それぞれの有効距離（表面間）
  abareKnockback: 0.12, // 突き放す強さ（間合いを作る）
  abareDamage: 6, // 軽いダメージ（主目的は脱出）
  abareStun: 300, // 突き放した相手の硬直（すぐ殴り返せない）
  abareInvuln: 520, // 発動者の無敵時間
  abareRecovery: 380, // 発動者の後隙
  abareHitstop: 80,

  // 乱入（3人目以降の途中参戦）: 全員の時間を止めて WARNING を出す演出時間。
  // クライアントの Intrusion-bgm / WARNING 表示もこの長さに合わせる。
  intrusionFreezeMs: 4000,
} as const

// 技のフレームデータ（ミリ秒）。startup=発生, active=持続, recovery=硬直。
// cancelInto: この技がヒット/ガードした後、キャンセル窓の間に出せる技。
type MoveDef = {
  startup: number
  active: number
  recovery: number
  recoveryOnHit?: number // ヒット時に硬直を短縮（有利）— 投げ用
  damage: number
  reach: number
  knockback: number
  launch: number
  hitstun: number
  blockstun: number
  hitstop: number
  cancelWindow: number
  cancelInto: MoveKind[]
  blockable: boolean
  isThrow: boolean
}

// 技の合計時間（startup+active+recovery）は GLB アニメの尺（arena3d の ONESHOT_DURATION）に
// 合わせてある。技中（アニメ再生中）は移動・ジャンプ・ガード・次の技がすべてロックされ、
// 例外は「ヒット/ガード時のキャンセル窓」だけ（＝コンボ）。尺を変えるときは両方揃えること。
export const MOVES: Record<MoveKind, MoveDef> = {
  // 軽い先手。発生が速く、ヒットで大きなキャンセル窓 → コンボ始動。
  punch: {
    startup: 75,
    active: 45,
    recovery: 680, // 合計 800ms = punch アニメ 0.8s
    damage: ARENA.punchDamage,
    reach: ARENA.reachPunch,
    knockback: ARENA.knockback,
    launch: 0,
    hitstun: 320,
    blockstun: 200,
    hitstop: 65,
    cancelWindow: 300,
    cancelInto: ['kick', 'shot', 'final'],
    blockable: true,
    isThrow: false,
  },
  // 重い主力。発生は遅いが痛い。Final へキャンセル可。
  kick: {
    startup: 120,
    active: 55,
    recovery: 925, // 合計 1100ms = kick アニメ 1.1s
    damage: ARENA.kickDamage,
    reach: ARENA.reachKick,
    knockback: ARENA.kickKnockback,
    launch: 0,
    hitstun: 340,
    blockstun: 240,
    hitstop: 95,
    cancelWindow: 270,
    cancelInto: ['shot', 'final'],
    blockable: true,
    isThrow: false,
  },
  // 投げ。発生後の持続で掴む。ガード貫通・空振ると長い硬直（打撃で狩られる）。
  throw: {
    startup: 55,
    active: 35,
    recovery: 810, // 合計 900ms = throw アニメ 0.9s
    recoveryOnHit: 810, // ヒット時もアニメ終端までロック（掴んだ瞬間からの残り尺）
    damage: ARENA.throwDamage,
    reach: ARENA.reachThrow,
    knockback: ARENA.throwKnockback,
    launch: 0,
    hitstun: 900, // thrown アニメ 0.9s の間は倒れたまま（投げた側の再行動とほぼ同時に起きる）
    blockstun: 0,
    hitstop: 110,
    cancelWindow: 0,
    cancelInto: [],
    blockable: false,
    isThrow: true, // 掴み: ガード貫通・確定ダウン・空振り硬直
  },
  // 必殺（コンボの締め / 単発）。ゲージ満タンで解禁。広く・痛い・打ち上げ。
  final: {
    startup: 90,
    active: 130,
    recovery: 980, // 合計 1200ms = final アニメ 1.2s
    damage: ARENA.finalDamage,
    reach: ARENA.reachFinal,
    knockback: ARENA.finalKnockback,
    launch: ARENA.finalLaunch,
    hitstun: 520,
    blockstun: 0,
    hitstop: 150,
    cancelWindow: 0,
    cancelInto: [],
    blockable: false,
    isThrow: false,
  },
  // 波動弾。発生後に前方へ弾を撃つ（当たり判定は弾側＝下の PROJECTILE）。
  shot: {
    startup: 140,
    active: 30, // このタイミングで弾を生成
    recovery: 360,
    damage: 0,
    reach: 0,
    knockback: 0,
    launch: 0,
    hitstun: 0,
    blockstun: 0,
    hitstop: 0,
    cancelWindow: 0,
    cancelInto: [],
    blockable: false,
    isThrow: false,
  },
}

// 波動弾（飛翔体）のパラメータ。当たり判定・ダメージは弾側が持つ。
export const PROJECTILE = {
  speed: 0.62, // 1 秒あたりの正規化 x 移動量
  y: 0.2, // 発射高さ（胸〜腹。ジャンプで避けられる）
  radius: 0.028, // 当たり半径（正規化 x）
  lifetimeMs: 2600, // 寿命
  damage: 7,
  knockback: 0.045,
  hitstun: 300,
  blockstun: 190,
  hitstop: 70,
} as const

export interface PlayerInit {
  id: string
  riderId: string
  riderName: string
  isSelf?: boolean
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function vertOverlap(a: PlayerState, b: PlayerState): boolean {
  return a.y < b.y + ARENA.bodyHeight && b.y < a.y + ARENA.bodyHeight
}

function comboScale(n: number): number {
  return Math.max(ARENA.comboMinScale, Math.pow(ARENA.comboScaling, n))
}

function freshPlayer(init: PlayerInit, x: number, facing: 1 | -1): PlayerState {
  return {
    id: init.id,
    riderId: init.riderId,
    riderName: init.riderName,
    hp: ARENA.maxHp,
    maxHp: ARENA.maxHp,
    x,
    y: 0,
    vx: 0,
    vy: 0,
    facing,
    action: 'idle',
    actionUntil: 0,
    isSelf: init.isSelf ?? false,
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

export function createBattle(inits: PlayerInit[]): BattleState {
  const n = inits.length
  return {
    winnerId: null,
    projectiles: [],
    players: inits.map((p, i) =>
      freshPlayer(
        p,
        n <= 1 ? 0.5 : ARENA.minX + ((ARENA.maxX - ARENA.minX) * i) / (n - 1),
        i === 0 ? 1 : -1,
      ),
    ),
  }
}

export function addPlayer(state: BattleState, init: PlayerInit, now = Date.now()): BattleState {
  if (state.players.some((p) => p.id === init.id)) return state
  const x = spawnX(state.players)
  const player = freshPlayer(init, x, x < 0.5 ? 1 : -1)
  // 乱入: 対戦中（2人以上）の部屋に途中参戦したら、全員の時間を止めて WARNING 演出へ。
  // 実際の停止は stepBattle / 各 apply 系の intrusionUntil ガードが行う。
  const intrusion = state.players.length >= 2
  return checkWinner({
    ...state,
    winnerId: null,
    players: [...state.players, player],
    // 飛翔中の弾は消す（停止中の無防備な相手へ着弾するのを防ぐ）。
    projectiles: intrusion ? [] : state.projectiles,
    intrusionUntil: intrusion ? now + ARENA.intrusionFreezeMs : state.intrusionUntil,
  })
}

export function removePlayer(state: BattleState, id: string): BattleState {
  if (!state.players.some((p) => p.id === id)) return state
  return checkWinner({
    ...state,
    players: state.players.filter((p) => p.id !== id),
    projectiles: state.projectiles.filter((pr) => pr.owner !== id), // 撃った本人の弾も消す
  })
}

function spawnX(players: PlayerState[]): number {
  if (players.length === 0) return 0.5
  const bounds = [ARENA.minX, ...players.map((p) => p.x).sort((a, b) => a - b), ARENA.maxX]
  let bestGap = -1
  let bestMid = 0.5
  for (let i = 0; i < bounds.length - 1; i++) {
    const gap = bounds[i + 1] - bounds[i]
    if (gap > bestGap) {
      bestGap = gap
      bestMid = (bounds[i] + bounds[i + 1]) / 2
    }
  }
  return bestMid
}

// 毎フレームの時間発展。移動/ガード意図を反映し、押し合いを解決、
// 「持続フレーム中の技」の当たり判定を解決、時間切れの技/アクションを畳む。純粋関数。
export function stepBattle(
  state: BattleState,
  dtMs: number,
  now: number,
  moveIntent: Record<string, -1 | 0 | 1>,
  guardIntent: Record<string, boolean> = {},
): BattleState {
  if (state.winnerId) return state
  // 乱入演出中は全員（弾・物理も含めて）完全停止。時刻ベースなので明け際の tick で自然に再開する。
  if (now < (state.intrusionUntil ?? 0)) return state
  const dt = Math.min(dtMs, 50) / 1000
  const moved = state.players.map((p) => {
    if (p.hp <= 0)
      return p.action === 'down'
        ? p
        : { ...p, y: 0, vy: 0, action: 'down' as const, actionUntil: 0, guarding: false, move: null }

    // ヒットストップ中は完全停止（位置も時間も進めない＝手応え）。
    if (now < p.freezeUntil) return p

    const inStun = now < p.stunUntil
    const inRecovery = now < p.actionUntil
    const grounded = p.y <= 0.001 && p.vy === 0
    const canAct = !inStun && !inRecovery

    const guarding = (guardIntent[p.id] ?? false) && grounded && canAct

    let { x, facing, y, vy, vx } = p
    // 上昇開始直後（y はまだ 0 だが vy > 0）も空中扱いにする。接地ブランチは入力なしで
    // vx を 0 に戻すため、ここを接地扱いにするとジャンプの前方初速が離陸前に消えてしまう。
    const airborne = p.y > 0.001 || p.vy > 0
    const canMove = canAct && !guarding
    if (airborne) {
      if (canMove) {
        const dir = moveIntent[p.id] ?? 0
        if (dir !== 0) {
          vx = dir * ARENA.moveSpeed * ARENA.airControl
          facing = dir
        }
      }
      x = clamp(p.x + vx * dt, ARENA.minX, ARENA.maxX)
    } else {
      const dir = canMove ? (moveIntent[p.id] ?? 0) : 0
      if (dir !== 0) {
        x = clamp(p.x + dir * ARENA.moveSpeed * dt, ARENA.minX, ARENA.maxX)
        facing = dir
        vx = dir * ARENA.moveSpeed * ARENA.airControl
      } else {
        vx = 0
      }
    }
    if (y > 0 || vy !== 0) {
      vy -= (vy > 0 ? ARENA.gravity : ARENA.fallGravity) * dt
      y += vy * dt
      if (y <= 0) {
        y = 0
        vy = 0
      }
    }

    let { comboCount, comboBy } = p
    if (now > p.comboUntil) {
      comboCount = 0
      comboBy = null
    }

    // 技/アクションの畳み: 硬直・被弾が明けたら idle（またはガード）へ、技を解除。
    let action = p.action
    let move = p.move
    if (canAct) {
      action = guarding ? 'guard' : 'idle'
      move = null
    }

    return { ...p, x, facing, y, vy, vx, guarding, action, move, comboCount, comboBy }
  })

  const resolved = resolveBodies(moved)
  const afterHits = resolveActiveHits(resolved, now) // 近接技の持続フレーム当たり判定
  const proj = stepProjectiles(afterHits, state.projectiles ?? [], now, dt) // 波動弾の生成・飛翔・衝突
  return checkWinner({ ...state, players: proj.players, projectiles: proj.projectiles })
}

function resolveBodies(players: PlayerState[]): PlayerState[] {
  const minGap = ARENA.bodyHalf * 2
  const xs = players.map((p) => p.x)
  const alive = players.map((p) => p.hp > 0)
  for (let iter = 0; iter < 3; iter++) {
    const order = players.map((_, i) => i).sort((a, b) => xs[a] - xs[b])
    for (let k = 0; k < order.length - 1; k++) {
      const i = order[k]
      const j = order[k + 1]
      if (!alive[i] || !alive[j]) continue
      if (!vertOverlap(players[i], players[j])) continue
      const gap = xs[j] - xs[i]
      if (gap < minGap) {
        const push = (minGap - gap) / 2
        xs[i] = clamp(xs[i] - push, ARENA.minX, ARENA.maxX)
        xs[j] = clamp(xs[j] + push, ARENA.minX, ARENA.maxX)
      }
    }
  }
  return players.map((p, i) => (xs[i] === p.x ? p : { ...p, x: xs[i] }))
}

// 「持続フレーム中で未ヒットの近接技」を順に当たり判定する（多段は moveHasHit で防止）。
// shot（波動弾）は近接判定を持たず、stepProjectiles 側で弾を出すのでここでは除外。
function resolveActiveHits(players: PlayerState[], now: number): PlayerState[] {
  let result = players
  for (let i = 0; i < players.length; i++) {
    const a = result[i]
    if (!a.move || a.move === 'shot' || a.hp <= 0 || a.moveHasHit) continue
    if (now < a.moveActiveFrom || now > a.moveActiveTo) continue // 持続フレーム外
    result = applyMoveHit(result, a.id, a.move, now)
  }
  return result
}

// 行動可能か（硬直・スタン・ヒットストップ・KO のいずれでもない）。
function canActNow(p: PlayerState, now: number): boolean {
  return p.hp > 0 && now >= p.actionUntil && now >= p.stunUntil && now >= p.freezeUntil
}

// 技を“開始”する（当たり判定はしない）。行動可能、またはキャンセル窓内なら発動。
// applyAttack/applyThrow の共通実装。
function startMove(state: BattleState, id: string, kind: MoveKind, now: number): BattleState {
  if (state.winnerId) return state
  if (now < (state.intrusionUntil ?? 0)) return state // 乱入演出中は行動不可
  const attacker = state.players.find((p) => p.id === id)
  if (!attacker || attacker.hp <= 0) return state

  // Final はゲージ満タン必須。
  if (kind === 'final' && attacker.meter < ARENA.meterFinalCost) return state
  // 波動弾は自分の弾が画面に無いときだけ（連射抑制＝ちゃんとした牽制技）。
  if (kind === 'shot' && (state.projectiles ?? []).some((pr) => pr.owner === id)) return state

  const free = canActNow(attacker, now)
  if (!free) {
    // キャンセル: 直前の技がヒット/ガードでキャンセル窓が開いていて、kind がキャンセル先か。
    const cur = attacker.move
    const canCancel =
      !!cur && now <= attacker.cancelUntil && MOVES[cur].cancelInto.includes(kind)
    if (!canCancel) return state
  }

  const f = MOVES[kind]
  const activeFrom = now + f.startup
  const activeTo = activeFrom + f.active
  const recoveryTo = activeTo + f.recovery

  const players = state.players.map((p) =>
    p.id === id
      ? {
          ...p,
          action: kind === 'throw' ? ('throw' as const) : (kind as PlayerAction),
          move: kind,
          moveActiveFrom: activeFrom,
          moveActiveTo: activeTo,
          moveHasHit: false,
          cancelUntil: 0,
          actionUntil: recoveryTo,
          guarding: false,
          meter:
            kind === 'final' ? clamp(p.meter - ARENA.meterFinalCost, 0, ARENA.meterMax) : p.meter,
        }
      : p,
  )
  return { ...state, players }
}

// 打撃/必殺を開始（worker の 'attack' / クライアント予測から）。
export function applyAttack(
  state: BattleState,
  attackerId: string,
  kind: AttackKind,
  now: number,
): BattleState {
  return startMove(state, attackerId, kind, now)
}

// 投げを開始。
export function applyThrow(state: BattleState, attackerId: string, now: number): BattleState {
  return startMove(state, attackerId, 'throw', now)
}

// 逆転ゲージの本数（0..5）。UI 表示・解禁判定に使う。
export function meterStocks(meter: number): number {
  return Math.floor(meter / ARENA.meterPerStock)
}

// あばれ（バースト）: ゲージ1本を消費し、無敵で割り込んで両隣を突き放す緊急脱出。
// 被弾・コンボ・硬直・ヒットストップの最中でも発動できる（＝ハメ回避）のが唯一の特徴。純粋関数。
export function applyAbare(state: BattleState, playerId: string, now: number): BattleState {
  if (state.winnerId) return state
  if (now < (state.intrusionUntil ?? 0)) return state // 乱入演出中は行動不可
  const self = state.players.find((p) => p.id === playerId)
  if (!self || self.hp <= 0) return state
  if (self.meter < ARENA.abareCost) return state
  if (now < self.invulnUntil) return state // 無敵中の連発は禁止（1本ずつ）
  // 割り込めるのは「やられている側」（被弾・硬直）のみ。自分の技の最中に撃って
  // 技をキャンセルする使い方はさせない（技中ロックの例外にしない）。
  if (self.move !== null && now < self.actionUntil) return state

  const invulnUntil = now + ARENA.abareInvuln
  const players = state.players.map((p) => {
    // 発動者: ゲージを1本消費し、被弾/コンボ/硬直を振り切って無敵＋後隙へ移行する。
    if (p.id === playerId) {
      return {
        ...p,
        meter: clamp(p.meter - ARENA.abareCost, 0, ARENA.meterMax),
        action: 'abare' as const,
        move: null,
        moveHasHit: false,
        cancelUntil: 0,
        guarding: false,
        stunUntil: 0,
        freezeUntil: 0,
        actionUntil: now + ARENA.abareRecovery,
        invulnUntil,
        comboCount: 0,
        comboBy: null,
      }
    }
    // 周囲の生存者（無敵でない）を左右へ突き放し、軽ダメージ＋硬直を与えて間合いを作る。
    if (p.hp <= 0 || now < p.invulnUntil || !vertOverlap(self, p)) return p
    const dx = p.x - self.x
    if (Math.abs(dx) - 2 * ARENA.bodyHalf > ARENA.abareRange) return p
    const dir: 1 | -1 = dx >= 0 ? 1 : -1
    const hp = Math.max(0, p.hp - ARENA.abareDamage)
    return {
      ...p,
      hp,
      x: clamp(p.x + dir * ARENA.abareKnockback, ARENA.minX, ARENA.maxX),
      guarding: false,
      action: hp <= 0 ? ('down' as const) : ('hit' as const),
      move: null,
      moveHasHit: false,
      stunUntil: now + ARENA.abareStun,
      actionUntil: now + ARENA.abareStun,
      freezeUntil: now + ARENA.abareHitstop,
      comboCount: 0,
      comboBy: null,
      meter: clamp(p.meter + ARENA.meterOnTake, 0, ARENA.meterMax),
    }
  })
  return checkWinner({ ...state, players })
}

// 持続フレームに入った技の命中を適用する。1 技 1 ヒット（final は範囲全員）。
function applyMoveHit(
  players: PlayerState[],
  attackerId: string,
  kind: MoveKind,
  now: number,
): PlayerState[] {
  const attacker = players.find((p) => p.id === attackerId)
  if (!attacker) return players
  const f = MOVES[kind]

  // 対象を集める。
  const targets = new Set<string>()
  let nearestId: string | null = null
  let best = Infinity
  for (const p of players) {
    if (p.id === attackerId || p.hp <= 0) continue
    if (now < p.invulnUntil) continue // 無敵（あばれ）中は素通り
    if (f.isThrow && p.y > 0.001) continue // 空中の相手は掴めない
    if (!vertOverlap(attacker, p)) continue
    const dx = (p.x - attacker.x) * attacker.facing
    if (dx <= 0) continue
    const surfaceGap = dx - 2 * ARENA.bodyHalf
    if (surfaceGap <= f.reach) {
      if (kind === 'final') targets.add(p.id)
      else if (dx < best) {
        best = dx
        nearestId = p.id
      }
    }
  }
  if (nearestId) targets.add(nearestId)

  // 空振り: moveHasHit を立てず、持続中は次 tick でまた判定（＝置き/めくり）。
  if (targets.size === 0) return players

  let dealtMeter = 0

  const next = players.map((p) => {
    if (!targets.has(p.id)) return p

    // 投げ: ガード貫通・確定ダウン。
    if (f.isThrow) {
      const hp = Math.max(0, p.hp - f.damage)
      const x = clamp(p.x + attacker.facing * f.knockback, ARENA.minX, ARENA.maxX)
      return {
        ...p,
        hp,
        x,
        guarding: false,
        action: hp <= 0 ? ('down' as const) : ('thrown' as const),
        move: null,
        actionUntil: now + f.hitstun,
        stunUntil: now + f.hitstun,
        freezeUntil: now + f.hitstop,
        comboCount: 0,
        comboBy: null,
        meter: clamp(p.meter + ARENA.meterOnTake, 0, ARENA.meterMax),
      }
    }

    // 打撃: ガード/通常ヒット/カウンターを共通ヘルパで解決（弾からも再利用）。
    const r = strikeTarget(p, attackerId, attacker.facing, f, now)
    dealtMeter += r.attackerMeter
    return r.p
  })

  // 攻撃者側を確定: ヒット確定 → ヒットストップ・キャンセル窓・ゲージ・（投げは硬直短縮）。
  const withAttacker = next.map((p) => {
    if (p.id !== attackerId) return p
    const recoveryOnHit = f.recoveryOnHit ? now + f.recoveryOnHit : p.actionUntil
    return {
      ...p,
      moveHasHit: true,
      cancelUntil: f.cancelWindow > 0 ? now + f.cancelWindow : 0,
      freezeUntil: now + f.hitstop,
      actionUntil: f.recoveryOnHit ? recoveryOnHit : p.actionUntil,
      meter: clamp(p.meter + (kind === 'final' ? 0 : dealtMeter), 0, ARENA.meterMax),
    }
  })

  return withAttacker
}

// 打撃 1 発を対象へ適用する共通処理（近接技・波動弾で共有）。
// fromDir = 攻撃の進行方向（＝相手を押す向き）。ガードは前後どちらを向いていても成立（背後ガード可）。
type StrikeDef = {
  damage: number
  knockback: number
  launch: number
  hitstun: number
  blockstun: number
  hitstop: number
  blockable: boolean
}
function strikeTarget(
  p: PlayerState,
  attackerId: string,
  fromDir: 1 | -1,
  def: StrikeDef,
  now: number,
): { p: PlayerState; attackerMeter: number } {
  const blocked = def.blockable && p.guarding // 前後どちらを向いていてもガード成立
  if (blocked) {
    const hp = Math.max(0, p.hp - ARENA.chipDamage)
    const x = clamp(p.x + fromDir * ARENA.guardPushback, ARENA.minX, ARENA.maxX)
    return {
      p: {
        ...p,
        hp,
        x,
        action: 'guard',
        move: null,
        stunUntil: now + def.blockstun,
        actionUntil: now + def.blockstun,
        freezeUntil: now + Math.min(def.hitstop, 60),
        meter: clamp(p.meter + ARENA.meterOnBlock, 0, ARENA.meterMax),
      },
      attackerMeter: 0,
    }
  }
  // カウンター: 相手の発生/持続中（技を振っている最中）に潰した。
  const counter = p.move !== null && now <= p.moveActiveTo
  const dmg = Math.round(def.damage * comboScale(p.comboCount) * (counter ? ARENA.counterDamageMul : 1))
  const hp = Math.max(0, p.hp - dmg)
  const x = clamp(p.x + fromDir * def.knockback, ARENA.minX, ARENA.maxX)
  const vy = def.launch > 0 && p.y <= 0.001 ? def.launch : p.vy
  const stun = now + Math.round(def.hitstun * (counter ? ARENA.counterStunMul : 1))
  return {
    p: {
      ...p,
      hp,
      x,
      vy,
      guarding: false,
      action: hp <= 0 ? 'down' : 'hit',
      move: null,
      actionUntil: stun,
      stunUntil: stun,
      freezeUntil: now + def.hitstop,
      comboCount: p.comboCount + 1,
      comboBy: attackerId,
      comboUntil: now + ARENA.comboResetMs,
      meter: clamp(p.meter + ARENA.meterOnTake, 0, ARENA.meterMax),
    },
    attackerMeter: ARENA.meterOnDeal,
  }
}

// 波動弾の生成（shot の持続開始で1発）・飛翔・相殺・プレイヤー衝突を毎 tick で解決。
const PROJ_STRIKE: StrikeDef = {
  damage: PROJECTILE.damage,
  knockback: PROJECTILE.knockback,
  launch: 0,
  hitstun: PROJECTILE.hitstun,
  blockstun: PROJECTILE.blockstun,
  hitstop: PROJECTILE.hitstop,
  blockable: true,
}
function stepProjectiles(
  players: PlayerState[],
  projectiles: Projectile[],
  now: number,
  dt: number,
): { players: PlayerState[]; projectiles: Projectile[] } {
  // 1) 生成: shot が持続に入って未生成なら前方へ弾を出す（moveHasHit を「生成済み」に流用）。
  const spawned: Projectile[] = []
  let outPlayers = players.map((p) => {
    if (p.move === 'shot' && !p.moveHasHit && now >= p.moveActiveFrom && p.hp > 0) {
      spawned.push({
        id: `${p.id}_${Math.round(now)}_${spawned.length}`,
        owner: p.id,
        x: clamp(p.x + p.facing * (ARENA.bodyHalf + 0.012), ARENA.minX, ARENA.maxX),
        y: PROJECTILE.y,
        dir: p.facing,
        bornAt: now,
      })
      return { ...p, moveHasHit: true }
    }
    return p
  })

  // 2) 飛翔＋寿命/場外で消滅。
  const live = [...projectiles, ...spawned]
    .map((pr) => ({ ...pr, x: pr.x + pr.dir * PROJECTILE.speed * dt }))
    .filter(
      (pr) =>
        pr.x > ARENA.minX - 0.06 &&
        pr.x < ARENA.maxX + 0.06 &&
        now - pr.bornAt < PROJECTILE.lifetimeMs,
    )

  // 3) 弾同士の相殺（別 owner が重なったら両方消す）。
  const dead = new Set<number>()
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      if (dead.has(i) || dead.has(j)) continue
      if (live[i].owner !== live[j].owner && Math.abs(live[i].x - live[j].x) < PROJECTILE.radius * 2) {
        dead.add(i)
        dead.add(j)
      }
    }
  }

  // 4) プレイヤー衝突（当たったら弾は消え、撃った人にゲージ）。
  const meterAdd: Record<string, number> = {}
  const remaining: Projectile[] = []
  for (let i = 0; i < live.length; i++) {
    if (dead.has(i)) continue
    const pr = live[i]
    let consumed = false
    outPlayers = outPlayers.map((p) => {
      if (consumed || p.id === pr.owner || p.hp <= 0 || now < p.invulnUntil) return p
      const vHit = p.y <= pr.y && pr.y < p.y + ARENA.bodyHeight // ジャンプで避けられる
      if (!vHit || Math.abs(p.x - pr.x) > ARENA.bodyHalf + PROJECTILE.radius) return p
      consumed = true
      const r = strikeTarget(p, pr.owner, pr.dir, PROJ_STRIKE, now)
      meterAdd[pr.owner] = (meterAdd[pr.owner] ?? 0) + r.attackerMeter
      return r.p
    })
    if (!consumed) remaining.push(pr)
  }
  if (Object.keys(meterAdd).length > 0) {
    outPlayers = outPlayers.map((p) =>
      meterAdd[p.id] ? { ...p, meter: clamp(p.meter + meterAdd[p.id], 0, ARENA.meterMax) } : p,
    )
  }

  return { players: outPlayers, projectiles: remaining }
}

// ジャンプ。接地中かつ行動可能（非硬直・非ガード）のみ有効。純粋関数。
// 跳んだ瞬間に向いている方向へ自動で前進する（前方ジャンプ）。空中の慣性(vx)に
// 初速を入れるだけなので、空中で逆入力すれば airControl で軌道は変えられる。
export function applyJump(state: BattleState, playerId: string, now: number): BattleState {
  if (state.winnerId) return state
  if (now < (state.intrusionUntil ?? 0)) return state // 乱入演出中は行動不可
  let changed = false
  const players = state.players.map((p) => {
    if (p.id !== playerId) return p
    if (!canActNow(p, now) || p.y > 0.0001 || p.vy > 0 || p.guarding) return p
    changed = true
    return {
      ...p,
      vy: ARENA.jumpVy,
      vx: p.facing * ARENA.moveSpeed * ARENA.airControl,
      guarding: false,
    }
  })
  return changed ? { ...state, players } : state
}

function checkWinner(state: BattleState): BattleState {
  if (state.players.length < 2) return state
  const alive = state.players.filter((p) => p.hp > 0)
  if (alive.length <= 1) return { ...state, winnerId: alive[0]?.id ?? null }
  return state
}
