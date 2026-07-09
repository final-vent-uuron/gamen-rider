// バトルの「状態そのもの」。描画にも通信にも依存しない純粋なモデル＋更新関数。
// 設計方針（CLAUDE.md / 既存の henshin ポートと同じ思想）:
//   - ローカル入力     : applyAttack / applyThrow / stepBattle を呼ぶ
//   - WebSocket 同期    : 受信メッセージから同じ関数（or setState）を呼ぶだけで結線できる
//   - 描画             : three.js でも 2D でも BattleState を読むだけ
// 位置・向き・HP は正規化した値で持ち、レンダラ側の座標系に依存しない。
// 数値は全て ARENA にまとめてあるので、バランス調整はここ 1 箇所で行う。
//
// 格ゲー化（三すくみ＋コンボ＋ヒットストップ＋逆転ゲージ）:
//   - 打撃(punch/kick) : ヒットで hitstun。punch は硬直短く軽い→コンボ始動。kick は重く打ち上げ。
//   - ガード(guarding) : 正面の打撃をブロック（削りのみ）。ただし投げに弱い。
//   - 投げ(throw)      : ガードを貫通して確定ダウン。短リーチで空振ると硬直（＝打撃に弱い）。
//   - ヒットストップ    : 命中の瞬間、両者を freezeUntil まで完全停止（手応え）。サーバーで行う。
//   - 逆転ゲージ(meter) : 与/被ダメで貯まり、満タンで Final Vent を解禁・消費。

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
  actionUntil: number // 攻撃/被弾アクションをこの時刻(ms)まで保持し、以後 idle へ
  isSelf: boolean // この端末で操作するローカルプレイヤーか
  // --- 格ゲー用の状態 ---
  guarding: boolean // ガード構え中か
  stunUntil: number // 被弾/ブロック硬直の終了時刻。この間は行動不可（ヒットスタン）
  freezeUntil: number // ヒットストップ終了時刻。この間は位置・時間が完全停止
  comboCount: number // いま受けている連続ヒット数（0 = 非コンボ）
  comboBy: string | null // 誰にコンボされているか（攻撃者 id）
  comboUntil: number // この時刻を過ぎたら comboCount をリセット
  meter: number // 逆転ゲージ 0..ARENA.meterMax（満タンで Final 解禁）
}

export interface BattleState {
  players: PlayerState[]
  winnerId: string | null // 決着したら勝者 id、まだなら null
}

// バランス調整・当たり判定のパラメータ。仮の値。ここだけ触れば挙動が変わる。
export const ARENA = {
  minX: 0.06,
  maxX: 0.94,
  moveSpeed: 0.27, // 1 秒あたりの移動量（正規化 x）。格ゲー寄りにゆっくりめ
  // ↓ x 方向のサイズ系（bodyHalf/reach/knockback）は arena3d.ts の WORLD_W とペア。
  //   ステージ幅を変えたら、世界座標での見た目を保つよう同じ比率で調整する。
  bodyHalf: 0.031, // 体の半幅（正規化 x）。押し合い・ヒット判定の基準
  bodyHeight: 0.55, // 体の高さ（正規化 y）。頭を越えれば飛び越せる／殴りが当たらない
  reachPunch: 0.045, // 体表からのパンチ到達距離
  reachKick: 0.072, // キック到達距離
  reachFinal: 0.206, // ファイナルベント到達距離（広い）
  reachThrow: 0.024, // 投げの間合い（短い＝空振りやすい）
  jumpVy: 5.6, // ジャンプ初速（正規化）
  gravity: 13, // 上昇中の重力
  fallGravity: 20, // 下降中の重力（上昇より大きい＝重く速い着地感）
  airControl: 1.5, // 空中の横移動倍率（飛び越しをしやすく）
  maxHp: 100,

  // ダメージ
  punchDamage: 5,
  kickDamage: 9,
  finalDamage: 34,
  throwDamage: 14,
  chipDamage: 1, // ガード時の削り

  // ノックバック・打ち上げ
  knockback: 0.026, // punch のノックバック
  kickKnockback: 0.06, // kick は吹っ飛ばし大きめ
  finalKnockback: 0.083,
  throwKnockback: 0.09,
  guardPushback: 0.018,
  kickLaunch: 1.9, // kick の打ち上げ vy（軽く浮かせてコンボ/飛び越し）
  finalLaunch: 3.0,

  // 硬直（攻撃側 recovery）と ヒットスタン（被弾側）。
  // punch は hitstun > recovery にして punch→次段 が繋がる（コンボ始動）。
  recoveryPunch: 210,
  recoveryKick: 340,
  recoveryFinal: 900,
  throwRecovery: 440, // 投げ空振りの硬直（＝打撃で狩られる）
  throwRecoveryHit: 260, // 投げ成功時は短め（有利）
  hitstunPunch: 300,
  hitstunKick: 300,
  hitstunFinal: 520,
  throwHitstun: 620, // 投げられた側のダウン（起き攻めできる長さ）
  blockstun: 170, // ガードした側の硬直（攻撃側 recovery より短い＝反撃されない）

  // ヒットストップ（命中の瞬間、両者を止める時間）
  hitstopPunch: 65,
  hitstopKick: 95,
  hitstopFinal: 150,
  hitstopThrow: 110,
  hitstopBlock: 55,

  // コンボ補正（段数が上がるほどダメージ減衰。無限ループ防止）
  comboScaling: 0.82,
  comboMinScale: 0.35,
  comboResetMs: 720, // 最後の被弾からこの時間で comboCount リセット

  // 逆転ゲージ
  meterMax: 100,
  meterOnDeal: 7, // 与ダメ1ヒットで攻撃側が得る
  meterOnTake: 11, // 被弾で被弾側が得る（逆転用に多め）
  meterOnBlock: 3,
  meterFinalCost: 100, // Final に必要（= 満タン）
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

// 2 体の縦の占有範囲 [y, y+bodyHeight] が重なるか。
// 重ならない＝相手の頭を越えている → すり抜け（飛び越し）・攻撃が当たらない。
function vertOverlap(a: PlayerState, b: PlayerState): boolean {
  return a.y < b.y + ARENA.bodyHeight && b.y < a.y + ARENA.bodyHeight
}

// コンボ段数 → ダメージ倍率。1 段目(0)=1.0、以降 comboScaling^n で減衰。
function comboScale(n: number): number {
  return Math.max(ARENA.comboMinScale, Math.pow(ARENA.comboScaling, n))
}

// 新規プレイヤーの初期状態（格ゲー用フィールドの既定値もここに集約）。
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
  }
}

// 初期状態を作る。プレイヤーはステージ上に均等配置。
// 人数は固定しない（途中参入あり）。開始時のロスターを inits で渡すだけ。
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

// 途中参入で 1 人追加する。既存プレイヤーは動かさず、空いている一番広い所へ配置。
// WebSocket の「join」受信でそのままこれを呼べば多人数に載る（isSelf は基本 false）。
export function addPlayer(state: BattleState, init: PlayerInit): BattleState {
  if (state.players.some((p) => p.id === init.id)) return state // 二重参加を防ぐ
  const x = spawnX(state.players)
  const player = freshPlayer(init, x, x < 0.5 ? 1 : -1) // 中央を向く
  // 参入で生存者が増えるので決着はいったん解除
  return checkWinner({ ...state, winnerId: null, players: [...state.players, player] })
}

// 離脱で 1 人抜ける（WebSocket の「leave」／切断で呼ぶ想定）。
export function removePlayer(state: BattleState, id: string): BattleState {
  if (!state.players.some((p) => p.id === id)) return state
  return checkWinner({ ...state, players: state.players.filter((p) => p.id !== id) })
}

// 既存プレイヤーと被らない参入位置（両端を含めた最大ギャップの中点）。
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

// 毎フレームの時間発展。移動意図（id→方向）とガード意図（id→bool）を反映し、
// 体の押し合い（すり抜け防止）を解決、時間切れのアクションを idle へ戻す。純粋関数。
export function stepBattle(
  state: BattleState,
  dtMs: number,
  now: number,
  moveIntent: Record<string, -1 | 0 | 1>,
  guardIntent: Record<string, boolean> = {},
): BattleState {
  if (state.winnerId) return state
  const dt = Math.min(dtMs, 50) / 1000 // 大きすぎる dt（タブ復帰など）は抑制
  const moved = state.players.map((p) => {
    if (p.hp <= 0)
      return p.action === 'down'
        ? p
        : { ...p, y: 0, vy: 0, action: 'down' as const, actionUntil: 0, guarding: false }

    // ヒットストップ中は完全停止（位置も時間も進めない＝手応え）。
    if (now < p.freezeUntil) return p

    const inStun = now < p.stunUntil // 被弾/ブロック硬直
    const inRecovery = now < p.actionUntil // 攻撃/投げの硬直
    const grounded = p.y <= 0.001 && p.vy === 0
    const canAct = !inStun && !inRecovery

    // ガード: 接地かつ非硬直のときだけ構えられる（移動・攻撃は不可）。
    const guarding = (guardIntent[p.id] ?? false) && grounded && canAct

    let { x, facing, y, vy, vx } = p
    const canMove = canAct && !guarding
    const airborne = p.y > 0.001
    if (airborne) {
      // 空中: 慣性(vx)で進み続ける。攻撃中で入力が切れても横の勢いは死なない。
      // 入力可能なら空中制御で vx を上書きできる（方向転換・伸ばし）。
      if (canMove) {
        const dir = moveIntent[p.id] ?? 0
        if (dir !== 0) {
          vx = dir * ARENA.moveSpeed * ARENA.airControl
          facing = dir
        }
      }
      x = clamp(p.x + vx * dt, ARENA.minX, ARENA.maxX)
    } else {
      // 接地: 入力ドリブンの移動。ジャンプに持ち出す慣性(vx)をここで用意しておく。
      const dir = canMove ? (moveIntent[p.id] ?? 0) : 0
      if (dir !== 0) {
        x = clamp(p.x + dir * ARENA.moveSpeed * dt, ARENA.minX, ARENA.maxX)
        facing = dir
        vx = dir * ARENA.moveSpeed * ARENA.airControl // 走りの勢いを空中へ持ち出す
      } else {
        vx = 0
      }
    }
    // 垂直方向: 上昇と下降で重力を変える（下降を重く＝きびきびした着地感）
    if (y > 0 || vy !== 0) {
      vy -= (vy > 0 ? ARENA.gravity : ARENA.fallGravity) * dt
      y += vy * dt
      if (y <= 0) {
        y = 0
        vy = 0
      }
    }

    // コンボは一定時間 当てが途切れたらリセット
    let { comboCount, comboBy } = p
    if (now > p.comboUntil) {
      comboCount = 0
      comboBy = null
    }

    // アクション表示の解決
    let action = p.action
    if (canAct) action = guarding ? 'guard' : 'idle'

    return { ...p, x, facing, y, vy, vx, guarding, action, comboCount, comboBy }
  })
  return { ...state, players: resolveBodies(moved) }
}

// 生存プレイヤー同士が重ならないよう押し合って分離する（すり抜け防止の当たり判定）。
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
      if (!vertOverlap(players[i], players[j])) continue // 頭を越えていれば押し合わない（飛び越せる）
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

// 技ごとのパラメータ。
const ATTACK = {
  punch: {
    dmg: ARENA.punchDamage,
    reach: ARENA.reachPunch,
    recovery: ARENA.recoveryPunch,
    hitstun: ARENA.hitstunPunch,
    hitstop: ARENA.hitstopPunch,
    kb: ARENA.knockback,
    launch: 0,
  },
  kick: {
    dmg: ARENA.kickDamage,
    reach: ARENA.reachKick,
    recovery: ARENA.recoveryKick,
    hitstun: ARENA.hitstunKick,
    hitstop: ARENA.hitstopKick,
    kb: ARENA.kickKnockback,
    launch: ARENA.kickLaunch,
  },
  final: {
    dmg: ARENA.finalDamage,
    reach: ARENA.reachFinal,
    recovery: ARENA.recoveryFinal,
    hitstun: ARENA.hitstunFinal,
    hitstop: ARENA.hitstopFinal,
    kb: ARENA.finalKnockback,
    launch: ARENA.finalLaunch,
  },
} as const

// 行動可能か（硬直・スタン・ヒットストップ・KO のいずれでもない）。
function canStartAction(p: PlayerState | undefined, now: number): p is PlayerState {
  return (
    !!p && p.hp > 0 && now >= p.actionUntil && now >= p.stunUntil && now >= p.freezeUntil
  )
}

// 攻撃を適用する。攻撃者の正面・リーチ内（体表間の距離で判定）にヒット。
// punch/kick は最も近い 1 体、final は範囲内全員。ガード中の正面打撃はブロック（削りのみ）。
// ヒットで hitstun＋ノックバック＋ヒットストップ＋コンボ加算＋ゲージ加算。純粋関数。
export function applyAttack(
  state: BattleState,
  attackerId: string,
  kind: AttackKind,
  now: number,
): BattleState {
  if (state.winnerId) return state
  const attacker = state.players.find((p) => p.id === attackerId)
  if (!canStartAction(attacker, now)) return state
  // Final はゲージ満タンでのみ発動。
  if (kind === 'final' && attacker.meter < ARENA.meterFinalCost) return state

  const a = ATTACK[kind]

  // 正面・リーチ内の相手を集める（final は全員、他は最も近い 1 体）。
  const targets = new Set<string>()
  let nearestId: string | null = null
  let best = Infinity
  for (const p of state.players) {
    if (p.id === attackerId || p.hp <= 0) continue
    if (!vertOverlap(attacker, p)) continue // 高さがズレていれば当たらない（見た目通り）
    const dx = (p.x - attacker.x) * attacker.facing // 正面方向を正に
    if (dx <= 0) continue
    const surfaceGap = dx - 2 * ARENA.bodyHalf // 体表どうしの隙間
    if (surfaceGap <= a.reach) {
      if (kind === 'final') targets.add(p.id)
      else if (dx < best) {
        best = dx
        nearestId = p.id
      }
    }
  }
  if (nearestId) targets.add(nearestId)

  const hit = targets.size > 0
  let dealtMeter = 0

  const players = state.players.map((p) => {
    if (p.id === attackerId) return p // 攻撃者は後で確定（ゲージ計算のため）
    if (!targets.has(p.id)) return p

    // ガード判定: 構え中 かつ 攻撃者が正面（back を向けていない）ならブロック。
    const attackerInFront = Math.sign(attacker.x - p.x) === p.facing
    const blocked = p.guarding && attackerInFront && kind !== 'final' // final はガード不可（演出）

    if (blocked) {
      const hpB = Math.max(0, p.hp - ARENA.chipDamage)
      const x = clamp(p.x + attacker.facing * ARENA.guardPushback, ARENA.minX, ARENA.maxX)
      return {
        ...p,
        hp: hpB,
        x,
        action: 'guard' as const,
        stunUntil: now + ARENA.blockstun,
        actionUntil: now + ARENA.blockstun,
        freezeUntil: now + ARENA.hitstopBlock,
        meter: clamp(p.meter + ARENA.meterOnBlock, 0, ARENA.meterMax),
      }
    }

    // 通常ヒット: コンボ補正込みダメージ、hitstun、ノックバック、打ち上げ、ヒットストップ。
    const dmg = Math.round(a.dmg * comboScale(p.comboCount))
    const hp = Math.max(0, p.hp - dmg)
    const x = clamp(p.x + attacker.facing * a.kb, ARENA.minX, ARENA.maxX)
    const vy = a.launch > 0 && p.y <= 0.001 ? a.launch : p.vy // 接地時のみ打ち上げ
    dealtMeter += ARENA.meterOnDeal
    return {
      ...p,
      hp,
      x,
      vy,
      guarding: false,
      action: hp <= 0 ? ('down' as const) : ('hit' as const),
      actionUntil: now + a.hitstun,
      stunUntil: now + a.hitstun,
      freezeUntil: now + a.hitstop,
      comboCount: p.comboCount + 1,
      comboBy: attackerId,
      comboUntil: now + ARENA.comboResetMs,
      meter: clamp(p.meter + ARENA.meterOnTake, 0, ARENA.meterMax),
    }
  })

  // 攻撃者を確定: アクション・硬直・（当たったら）ヒットストップ、ゲージの増減。
  const finalMeterDelta = kind === 'final' ? -ARENA.meterFinalCost : dealtMeter
  const withAttacker = players.map((p) =>
    p.id === attackerId
      ? {
          ...p,
          guarding: false,
          action: kind,
          actionUntil: now + a.recovery,
          freezeUntil: hit ? now + a.hitstop : p.freezeUntil,
          meter: clamp(p.meter + finalMeterDelta, 0, ARENA.meterMax),
        }
      : p,
  )

  return checkWinner({ ...state, winnerId: null, players: withAttacker })
}

// 投げ。短リーチで正面の 1 体を掴む。ガードを貫通して確定ダメージ＋ダウン＋吹っ飛ばし。
// 空振ると長い硬直（＝打撃で狩られる）。三すくみ: 投げ＞ガード / 打撃＞投げ / ガード＞打撃。
export function applyThrow(state: BattleState, attackerId: string, now: number): BattleState {
  if (state.winnerId) return state
  const attacker = state.players.find((p) => p.id === attackerId)
  if (!canStartAction(attacker, now)) return state

  // 正面・投げ間合い内の最も近い相手（接地している相手のみ掴める）。
  let targetId: string | null = null
  let best = Infinity
  for (const p of state.players) {
    if (p.id === attackerId || p.hp <= 0) continue
    if (p.y > 0.001) continue // 空中の相手は掴めない
    const dx = (p.x - attacker.x) * attacker.facing
    if (dx <= 0) continue
    const surfaceGap = dx - 2 * ARENA.bodyHalf
    if (surfaceGap <= ARENA.reachThrow && dx < best) {
      best = dx
      targetId = p.id
    }
  }

  const players = state.players.map((p) => {
    if (p.id === attackerId) {
      return {
        ...p,
        guarding: false,
        action: 'throw' as const,
        // 成功時は短い硬直（有利）、空振りは長い硬直（狩られる）
        actionUntil: now + (targetId ? ARENA.throwRecoveryHit : ARENA.throwRecovery),
        freezeUntil: targetId ? now + ARENA.hitstopThrow : p.freezeUntil,
        meter: clamp(p.meter + (targetId ? ARENA.meterOnDeal : 0), 0, ARENA.meterMax),
      }
    }
    if (p.id === targetId) {
      const hp = Math.max(0, p.hp - ARENA.throwDamage)
      const x = clamp(p.x + attacker.facing * ARENA.throwKnockback, ARENA.minX, ARENA.maxX)
      return {
        ...p,
        hp,
        x,
        guarding: false,
        action: hp <= 0 ? ('down' as const) : ('thrown' as const),
        actionUntil: now + ARENA.throwHitstun,
        stunUntil: now + ARENA.throwHitstun,
        freezeUntil: now + ARENA.hitstopThrow,
        comboCount: 0, // 投げはコンボにしない（仕切り直し）
        comboBy: null,
        meter: clamp(p.meter + ARENA.meterOnTake, 0, ARENA.meterMax),
      }
    }
    return p
  })

  return checkWinner({ ...state, winnerId: null, players })
}

// ジャンプ。接地中かつ行動可能（非硬直・非ガード）のみ有効。純粋関数。
export function applyJump(state: BattleState, playerId: string, now: number): BattleState {
  if (state.winnerId) return state
  let changed = false
  const players = state.players.map((p) => {
    if (p.id !== playerId) return p
    if (!canStartAction(p, now) || p.y > 0.0001 || p.vy > 0 || p.guarding) return p
    changed = true
    return { ...p, vy: ARENA.jumpVy, guarding: false }
  })
  return changed ? { ...state, players } : state
}

// 生存者が 1 人以下になったら決着。
function checkWinner(state: BattleState): BattleState {
  if (state.players.length < 2) return state
  const alive = state.players.filter((p) => p.hp > 0)
  if (alive.length <= 1) return { ...state, winnerId: alive[0]?.id ?? null }
  return state
}
