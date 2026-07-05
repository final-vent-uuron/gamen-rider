// バトルの「状態そのもの」。描画にも通信にも依存しない純粋なモデル＋更新関数。
// 設計方針（CLAUDE.md / 既存の henshin ポートと同じ思想）:
//   - ローカル入力     : applyAttack / stepBattle を呼ぶ
//   - WebSocket 同期    : 受信メッセージから同じ関数（or setState）を呼ぶだけで結線できる
//   - 描画             : three.js でも 2D でも BattleState を読むだけ
// 位置・向き・HP は正規化した値で持ち、レンダラ側の座標系に依存しない。
// 数値は全て ARENA にまとめてあるので、バランス調整はここ 1 箇所で行う。

export type PlayerAction = 'idle' | 'punch' | 'kick' | 'final' | 'hit' | 'down'
export type AttackKind = 'punch' | 'kick' | 'final'

export interface PlayerState {
  id: string
  riderId: string
  riderName: string
  hp: number
  maxHp: number
  x: number // ステージ内の水平位置 0..1（左端 0 / 右端 1）
  y: number // 高さ（0 = 接地。ジャンプ中は正の値。正規化: 頂点 ~1）
  vy: number // 垂直速度（ジャンプ・重力用）
  facing: 1 | -1 // 向き（右 +1 / 左 -1）
  action: PlayerAction // 現在のアクション（演出・アニメ用）
  actionUntil: number // action をこの時刻(ms)まで保持し、以後 idle へ戻す
  isSelf: boolean // この端末で操作するローカルプレイヤーか
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
  reachPunch: 0.041, // 体表からのパンチ到達距離
  reachKick: 0.069, // キック到達距離
  reachFinal: 0.206, // ファイナルベント到達距離（広い）
  knockback: 0.031, // 被弾ノックバック量
  finalKnockback: 0.083,
  jumpVy: 5.6, // ジャンプ初速（正規化）
  gravity: 13, // 上昇中の重力
  fallGravity: 20, // 下降中の重力（上昇より大きい＝重く速い着地感）
  airControl: 1.5, // 空中の横移動倍率（飛び越しをしやすく）
  punchDamage: 6,
  kickDamage: 10,
  finalDamage: 34,
  actionMs: 260, // パンチ / キックの見た目・クールダウン
  finalMs: 900, // ファイナルベントの見た目・クールダウン
  hitMs: 240, // 被弾リアクションの保持時間
  maxHp: 100,
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

// 初期状態を作る。プレイヤーはステージ上に均等配置。
// 人数は固定しない（途中参入あり）。開始時のロスターを inits で渡すだけ。
export function createBattle(inits: PlayerInit[]): BattleState {
  const n = inits.length
  return {
    winnerId: null,
    players: inits.map((p, i) => ({
      id: p.id,
      riderId: p.riderId,
      riderName: p.riderName,
      hp: ARENA.maxHp,
      maxHp: ARENA.maxHp,
      x: n <= 1 ? 0.5 : ARENA.minX + ((ARENA.maxX - ARENA.minX) * i) / (n - 1),
      y: 0,
      vy: 0,
      facing: i === 0 ? 1 : -1,
      action: 'idle',
      actionUntil: 0,
      isSelf: p.isSelf ?? false,
    })),
  }
}

// 途中参入で 1 人追加する。既存プレイヤーは動かさず、空いている一番広い所へ配置。
// WebSocket の「join」受信でそのままこれを呼べば多人数に載る（isSelf は基本 false）。
export function addPlayer(state: BattleState, init: PlayerInit): BattleState {
  if (state.players.some((p) => p.id === init.id)) return state // 二重参加を防ぐ
  const x = spawnX(state.players)
  const player: PlayerState = {
    id: init.id,
    riderId: init.riderId,
    riderName: init.riderName,
    hp: ARENA.maxHp,
    maxHp: ARENA.maxHp,
    x,
    y: 0,
    vy: 0,
    facing: x < 0.5 ? 1 : -1, // 中央を向く
    action: 'idle',
    actionUntil: 0,
    isSelf: init.isSelf ?? false,
  }
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

// 毎フレームの時間発展。移動意図（プレイヤー id → 方向）を反映し、
// 体の押し合い（すり抜け防止）を解決、時間切れのアクションを idle に戻す。純粋関数。
export function stepBattle(
  state: BattleState,
  dtMs: number,
  now: number,
  moveIntent: Record<string, -1 | 0 | 1>,
): BattleState {
  if (state.winnerId) return state
  const dt = Math.min(dtMs, 50) / 1000 // 大きすぎる dt（タブ復帰など）は抑制
  const moved = state.players.map((p) => {
    if (p.hp <= 0)
      return p.action === 'down' ? p : { ...p, y: 0, vy: 0, action: 'down' as const, actionUntil: 0 }
    const dir = moveIntent[p.id] ?? 0
    let { x, facing, y, vy } = p
    if (dir !== 0) {
      const speed = ARENA.moveSpeed * (p.y > 0.001 ? ARENA.airControl : 1) // 空中は横移動を強化
      x = clamp(p.x + dir * speed * dt, ARENA.minX, ARENA.maxX)
      facing = dir
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
    const action: PlayerAction = now >= p.actionUntil ? 'idle' : p.action
    return { ...p, x, facing, y, vy, action }
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

// 攻撃を適用する。攻撃者の正面・リーチ内（体表間の距離で判定）にヒット。
// punch/kick は最も近い 1 体、final は範囲内全員。ヒットでダメージ＋ノックバック。
// クールダウン中（前のアクション保持中）は無視。純粋関数。
export function applyAttack(
  state: BattleState,
  attackerId: string,
  kind: AttackKind,
  now: number,
): BattleState {
  if (state.winnerId) return state
  const attacker = state.players.find((p) => p.id === attackerId)
  if (!attacker || attacker.hp <= 0 || now < attacker.actionUntil) return state

  const damage =
    kind === 'punch' ? ARENA.punchDamage : kind === 'kick' ? ARENA.kickDamage : ARENA.finalDamage
  const reach =
    kind === 'punch' ? ARENA.reachPunch : kind === 'kick' ? ARENA.reachKick : ARENA.reachFinal
  const holdMs = kind === 'final' ? ARENA.finalMs : ARENA.actionMs
  const kb = kind === 'final' ? ARENA.finalKnockback : ARENA.knockback

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
    if (surfaceGap <= reach) {
      if (kind === 'final') targets.add(p.id)
      else if (dx < best) {
        best = dx
        nearestId = p.id
      }
    }
  }
  if (nearestId) targets.add(nearestId)

  const players = state.players.map((p) => {
    if (p.id === attackerId) return { ...p, action: kind, actionUntil: now + holdMs }
    if (targets.has(p.id)) {
      const hp = Math.max(0, p.hp - damage)
      const x = clamp(p.x + attacker.facing * kb, ARENA.minX, ARENA.maxX) // ノックバック
      return {
        ...p,
        hp,
        x,
        action: hp <= 0 ? ('down' as const) : ('hit' as const),
        actionUntil: now + ARENA.hitMs,
      }
    }
    return p
  })

  return checkWinner({ ...state, winnerId: null, players })
}

// ジャンプ。接地中のみ有効（空中での 2 段ジャンプは無し）。純粋関数。
export function applyJump(state: BattleState, playerId: string): BattleState {
  if (state.winnerId) return state
  let changed = false
  const players = state.players.map((p) => {
    if (p.id !== playerId || p.hp <= 0 || p.y > 0.0001 || p.vy > 0) return p
    changed = true
    return { ...p, vy: ARENA.jumpVy }
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
