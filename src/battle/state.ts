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
export type AttackKind = 'punch' | 'kick' | 'final'
export type MoveKind = 'punch' | 'kick' | 'throw' | 'final'

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
  winnerId: string | null
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

  // 逆転ゲージ
  meterMax: 100,
  meterOnDeal: 7,
  meterOnTake: 11,
  meterOnBlock: 3,
  meterFinalCost: 100,
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

export const MOVES: Record<MoveKind, MoveDef> = {
  // 軽い先手。発生が速く、ヒットで大きなキャンセル窓 → コンボ始動。
  punch: {
    startup: 75,
    active: 45,
    recovery: 135,
    damage: ARENA.punchDamage,
    reach: ARENA.reachPunch,
    knockback: ARENA.knockback,
    launch: 0,
    hitstun: 320,
    blockstun: 200,
    hitstop: 65,
    cancelWindow: 300,
    cancelInto: ['kick', 'final'],
    blockable: true,
    isThrow: false,
  },
  // 重い主力。発生は遅いが痛い。Final へキャンセル可。
  kick: {
    startup: 120,
    active: 55,
    recovery: 250,
    damage: ARENA.kickDamage,
    reach: ARENA.reachKick,
    knockback: ARENA.kickKnockback,
    launch: 0,
    hitstun: 340,
    blockstun: 240,
    hitstop: 95,
    cancelWindow: 270,
    cancelInto: ['final'],
    blockable: true,
    isThrow: false,
  },
  // 投げ。発生後の持続で掴む。ガード貫通・空振ると長い硬直（打撃で狩られる）。
  throw: {
    startup: 55,
    active: 35,
    recovery: 440,
    recoveryOnHit: 240,
    damage: ARENA.throwDamage,
    reach: ARENA.reachThrow,
    knockback: ARENA.throwKnockback,
    launch: 0,
    hitstun: 620,
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
    recovery: 680,
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
}

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
    players: inits.map((p, i) =>
      freshPlayer(
        p,
        n <= 1 ? 0.5 : ARENA.minX + ((ARENA.maxX - ARENA.minX) * i) / (n - 1),
        i === 0 ? 1 : -1,
      ),
    ),
  }
}

export function addPlayer(state: BattleState, init: PlayerInit): BattleState {
  if (state.players.some((p) => p.id === init.id)) return state
  const x = spawnX(state.players)
  const player = freshPlayer(init, x, x < 0.5 ? 1 : -1)
  return checkWinner({ ...state, winnerId: null, players: [...state.players, player] })
}

export function removePlayer(state: BattleState, id: string): BattleState {
  if (!state.players.some((p) => p.id === id)) return state
  return checkWinner({ ...state, players: state.players.filter((p) => p.id !== id) })
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
    const airborne = p.y > 0.001
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
  const afterHits = resolveActiveHits(resolved, now) // ← 持続フレームの当たり判定
  return checkWinner({ ...state, players: afterHits })
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

// 「持続フレーム中で未ヒットの技」を順に当たり判定する（多段は moveHasHit で防止）。
function resolveActiveHits(players: PlayerState[], now: number): PlayerState[] {
  let result = players
  for (let i = 0; i < players.length; i++) {
    const a = result[i]
    if (!a.move || a.hp <= 0 || a.moveHasHit) continue
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
  const attacker = state.players.find((p) => p.id === id)
  if (!attacker || attacker.hp <= 0) return state

  // Final はゲージ満タン必須。
  if (kind === 'final' && attacker.meter < ARENA.meterFinalCost) return state

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

    // ガード判定（正面・ブロック可能な技のみ）。
    const attackerInFront = Math.sign(attacker.x - p.x) === p.facing
    const blocked = f.blockable && p.guarding && attackerInFront
    if (blocked) {
      const hp = Math.max(0, p.hp - ARENA.chipDamage)
      const x = clamp(p.x + attacker.facing * ARENA.guardPushback, ARENA.minX, ARENA.maxX)
      return {
        ...p,
        hp,
        x,
        action: 'guard' as const,
        move: null,
        stunUntil: now + f.blockstun,
        actionUntil: now + f.blockstun,
        freezeUntil: now + Math.min(f.hitstop, 60),
        meter: clamp(p.meter + ARENA.meterOnBlock, 0, ARENA.meterMax),
      }
    }

    // 通常ヒット（カウンター補正・コンボ補正込み）。
    const counter = p.move !== null && now <= p.moveActiveTo // 相手の発生/持続中に潰した
    const dmg = Math.round(
      f.damage * comboScale(p.comboCount) * (counter ? ARENA.counterDamageMul : 1),
    )
    const hp = Math.max(0, p.hp - dmg)
    const x = clamp(p.x + attacker.facing * f.knockback, ARENA.minX, ARENA.maxX)
    const vy = f.launch > 0 && p.y <= 0.001 ? f.launch : p.vy
    const stun = now + Math.round(f.hitstun * (counter ? ARENA.counterStunMul : 1))
    dealtMeter += ARENA.meterOnDeal
    return {
      ...p,
      hp,
      x,
      vy,
      guarding: false,
      action: hp <= 0 ? ('down' as const) : ('hit' as const),
      move: null,
      actionUntil: stun,
      stunUntil: stun,
      freezeUntil: now + f.hitstop,
      comboCount: p.comboCount + 1,
      comboBy: attackerId,
      comboUntil: now + ARENA.comboResetMs,
      meter: clamp(p.meter + ARENA.meterOnTake, 0, ARENA.meterMax),
    }
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

// ジャンプ。接地中かつ行動可能（非硬直・非ガード）のみ有効。純粋関数。
export function applyJump(state: BattleState, playerId: string, now: number): BattleState {
  if (state.winnerId) return state
  let changed = false
  const players = state.players.map((p) => {
    if (p.id !== playerId) return p
    if (!canActNow(p, now) || p.y > 0.0001 || p.vy > 0 || p.guarding) return p
    changed = true
    return { ...p, vy: ARENA.jumpVy, guarding: false }
  })
  return changed ? { ...state, players } : state
}

function checkWinner(state: BattleState): BattleState {
  if (state.players.length < 2) return state
  const alive = state.players.filter((p) => p.hp > 0)
  if (alive.length <= 1) return { ...state, winnerId: alive[0]?.id ?? null }
  return state
}
