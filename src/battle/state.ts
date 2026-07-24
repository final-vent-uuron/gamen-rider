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
  | 'shot' // 波動弾の発射動作（startMove が kind をそのまま action に入れる）
  | 'final'
  | 'hit'
  | 'down' // KO（HP0）で伏せる
  | 'guard' // ガード構え中
  | 'shield-break' // ガード割れ硬直（攻撃を受けるか時間経過まで行動不可）
  | 'throw' // 掴みかかり中（grasp モーション。まだ当たっていない）
  | 'throw-hit' // 掴み成立（grasp-attack モーション。持続が当たった後の攻撃演出＋硬直）
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
  shield: number // ガード耐久 0..ARENA.shieldMax（スマブラ式。0 で割れる）
  shieldRegenAt: number // この時刻以降、非ガード時に耐久が自然回復する
  stunUntil: number // 被弾/ブロック硬直の終了時刻。この間は行動不可
  freezeUntil: number // ヒットストップ終了時刻。この間は位置・時間が完全停止
  invulnUntil: number // 無敵の終了時刻（あばれ・ストライクベント・ファイナルベントのモーション中）
  comboCount: number // いま受けている連続ヒット数（0 = 非コンボ）
  comboBy: string | null // 誰にコンボされているか（攻撃者 id）
  comboUntil: number // この時刻を過ぎたら comboCount をリセット
  meter: number // 逆転ゲージ 0..ARENA.meterMax（満タンで Final 解禁）
  meterFullAt: number // meter が満タンに達した時刻（0 = 未達）。Final の早撃ちダメージ計算に使う
  finalDamageMul: number // 直近で開始した Final の速度ダメージ倍率（発動時に確定・以後固定。既定 1）
  // --- 技のフレーム状態 ---
  move: MoveKind | null // 実行中の技（null = 素の状態）
  moveSide?: 'left' | 'right' | null // パンチ/キックの左右（GLB クリップの打ち分け。null = ランダム）
  // --- 掴み（遅延ダメージ）---
  throwVictimId?: string | null // 掴んでいる相手（throw-hit 中のみ。ダメージ適用で解除）
  throwDamageAt?: number // 掴みダメージの適用時刻（grasp-attack の中間）
  // --- あばれ（遅延ヒット）---
  abareHitAt?: number // 突き放し（ダメージ）の適用時刻（error-mode モーションの終わりぎわ。0 = 無し）
  // --- ファイナルベント＝暴れ範囲技 ---
  rampageOriginX?: number // 暴れ往復の原点（発動時の x。持続中の位置はここから決定論で決まる）
  rampageNextHitAt?: number // 次の多段ヒット判定時刻（0 = 非発動）
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
  // 乱入者（新規参戦者）の id。クライアントはこの時刻まで乱入者へカメラを寄せる演出に使う。
  intruderId?: string | null
  // カード技（ストライクベント/エラーベント/ファイナルベント）発動のカットイン演出。
  // until まで全員完全停止し、クライアントは発動者へカメラを寄せてバナーを出す。
  // 技のタイムラインは停止ぶん後ろへずらしてあるので、停止明けからモーションが動き出す。
  cutin?: { playerId: string; kind: 'shot' | 'abare' | 'final'; until: number } | null
  // ファイナルベント「溜め」（カード→ポーズ手順）。ストリートファイター SA3 風に
  // until まで全員完全停止し、発動者へカメラを寄せてみんなでポーズを見守る。
  // 発動成功で final 技へ遷移（このフィールドは消える）。タイムアウト／キャンセルでも解除。
  finalVent?: {
    playerId: string
    phase: 'card' | 'pose'
    until: number
  } | null
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
  jumpVy: 7.0, // ジャンプ初速。上げるほど頂点が高くなる
  gravity: 11, // 上昇中の重力。下げるほどふわっと高く上がる（滞空も伸びる）
  fallGravity: 16, // 下降中の重力。下げるほど落下がゆっくり
  // ↑ 現在の弾道: 頂点 ~2.2（正規化）・滞空 ~1.2s。以前(5.6/13/20)は頂点 1.2・滞空 0.78s
  airControl: 1.125, // 空中の水平速度倍率（前方ジャンプ初速・空中制御の両方）。2.25 の半分＝飛距離半減
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
  finalLaunch: 3.0, // Final の締めだけ打ち上げ。地上コンボ重視なので他は打ち上げ無し

  // ファイナルベント＝暴れ範囲技。発動者が原点から左右に暴れ回り（sin 往復）、
  // 触れた相手全員（左右両側）に一定間隔で多段ヒットする。締めの1発だけ打ち上げ。
  finalRampageAmp: 0.18, // 往復の片振れ幅（原点から左右へ。アリーナ幅 0.88 に対する値）
  finalRampageHz: 0.9, // 1秒あたりの往復数
  finalRampageHitGapMs: 380, // 多段ヒットの最短間隔
  finalRampageDamage: 7, // 1ヒットあたり。フルヒット（~5発＋締め）で従来の単発 34 相当
  finalRampageRange: 0.15, // 有効距離（表面間・左右両側）

  // Final の早撃ちボーナス: ゲージが満タンになった瞬間からの経過時間でダメージ倍率を決める。
  // 0ms（満タン即撃ち）で最大、finalSpeedWindowMs 以上待つと最小まで線形減衰。
  // 本番の発動はカード→ポーズの一連の演出を挟むため実測は数秒かかる。それを踏まえ
  // 「できるだけ急いで出す」のを 10 秒目安、のんびり出すと下限、という尺にしてある。
  finalSpeedWindowMs: 10000,
  finalSpeedMaxMul: 1.6,
  finalSpeedMinMul: 0.7,

  // ガード耐久（スマブラ式シールド）
  shieldMax: 60, // 満タン耐久。フル保持で約 5 秒で割れ
  shieldDrainPerSec: 12, // 構え続けているあいだの自然減少
  shieldRegenPerSec: 10, // 構えていないときの自然回復
  shieldRegenDelayMs: 500, // ガード解除後、回復開始までの待ち
  shieldHitMul: 1.15, // 被ガード時の耐久減少 = 技ダメージ × この倍率
  shieldMinToRaise: 8, // これ未満だと構えられない（割れ直後の即ガード防止）
  shieldBreakStunMs: 3200, // 割れ硬直。攻撃を受けるか、この時間が経つまで行動不可
  shieldBreakLaunch: 2.2, // 割れ時に軽く浮かせる（スマブラの割れ演出に寄せる）

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
  shotCost: 40, // 波動弾（I）は 2 ゲージ消費

  // あばれ（エラーモード/バースト）: ゲージ3本で発動する切り返し。無敵で割り込み、両隣を突き放す。
  // 「2人に挟まれて延々殴られる（ハメ）」から抜けるための緊急脱出ボタン。
  abareCost: 60, // = 3 ゲージ
  abareRange: 0.17, // 左右それぞれの有効距離（表面間）
  abareKnockback: 0.12, // 突き放す強さ（間合いを作る）
  abareDamage: 6, // 軽いダメージ（主目的は脱出）
  abareStun: 300, // 突き放した相手の硬直（すぐ殴り返せない）
  abareInvuln: 1800, // 発動者の無敵時間（= モーション全体。error-mode をゆっくり再生する尺）
  abareRecovery: 1800, // 発動〜復帰の実時間（= error-mode モーションの尺。arena3d と対）
  abareHitDelay: 1400, // 発動 → 突き放し（ダメージ）適用までの遅延。モーションの終わりぎわ
  abareHitstop: 80,

  // 乱入（3人目以降の途中参戦）: 全員の時間を止めて WARNING を出す演出時間。
  // クライアントの Intrusion-bgm / WARNING 表示もこの長さに合わせる（元4000ms から少し延長）。
  intrusionFreezeMs: 6000,

  // カード技発動のカットイン演出（全員停止＋カメラ寄せ＋バナー）の時間。
  cutinMs: 1800,

  // ファイナルベント溜め（カード＋ポーズ手順）の最大凍結時間。
  // これを超えるとサーバーが自動解除（カメラ占有の永久フリーズ防止）。
  finalVentMaxMs: 28000,
} as const

// 技のフレームデータ（ミリ秒）。startup=発生, active=持続, recovery=硬直。
// cancelInto: この技がヒット/ガードした後、キャンセル窓の間に出せる技。
type MoveDef = {
  startup: number
  active: number
  recovery: number
  recoveryOnHit?: number // ヒット時に硬直を短縮（有利）— 投げ用
  hitDelay?: number // 掴み成立からダメージ適用までの遅延（投げ用。grasp-attack の中間で入れる）
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
  // 軽い先手。当たりはモーションの半分（腕が伸びるあたり）に同期。
  punch: {
    startup: 400, // = 合計の 50%（モーションの伸び切りにダメージを同期）
    active: 45,
    recovery: 355, // 合計 800ms = punch アニメ 0.8s
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
    startup: 700, // = 合計の 50%（足が伸びるあたりにダメージを同期）
    active: 55,
    recovery: 645, // 合計 1400ms = kick アニメ 1.4s（素の尺 ~1.7s。早回し感を抑えた尺）
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
  // 2 段階: 掴みかかり（grasp。ダメージ無し）→ 当たったら grasp-attack（action: throw-hit）へ
  // 切り替え、その中間（hitDelay 後）でダメージが入る。それまで相手は掴まれて動けない。
  throw: {
    startup: 600, // = 合計の 50%（掴みかかるあたりに判定を同期）
    active: 35,
    recovery: 565, // 合計 1200ms = 空振り時 throw(grasp) アニメ 1.2s
    recoveryOnHit: 1800, // 掴んだ瞬間から grasp-attack アニメ 1.8s ぶんロック
    hitDelay: 900, // 掴み成立 → grasp-attack の中間でダメージ適用
    damage: ARENA.throwDamage,
    reach: ARENA.reachThrow,
    knockback: ARENA.throwKnockback,
    launch: 0,
    hitstun: 1200, // ダメージ適用時点から。投げ側（残り 900ms）より約 0.3s 遅れて起きる（投げ側有利）
    blockstun: 0,
    hitstop: 110,
    cancelWindow: 0,
    cancelInto: [],
    blockable: false,
    isThrow: true, // 掴み: ガード貫通・確定ダウン・空振り硬直
  },
  // 必殺（暴れ範囲技）。ゲージ満タンで解禁。持続中は resolveFinalRampage が
  // 左右往復の移動と多段ヒットを受け持つ（damage/reach 等の単発値はここでは使わない。
  // 実数値は ARENA.finalRampage*）。
  final: {
    startup: 600, // カットイン明け → 暴れ開始までの溜め
    active: 2000, // 暴れ（往復＋多段ヒット）の持続
    recovery: 500, // 合計 3100ms = final(special) アニメ 3.1s（arena3d ONESHOT_DURATION と対）
    damage: ARENA.finalRampageDamage,
    reach: ARENA.finalRampageRange,
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
    startup: 500, // = 合計の 50%（固有技モーションの放つ瞬間に弾生成を同期）
    active: 30, // このタイミングで弾を生成
    recovery: 470, // 合計 1000ms = skill アニメ 1.0s（素の尺 2.6s。速すぎない程度に圧縮）
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

// ガード割れ: 耐久 0 で長硬直。攻撃を受ける（通常ヒットで上書き）か、時間が経つまで行動不可。
function breakShield(
  p: PlayerState,
  now: number,
): Pick<
  PlayerState,
  | 'shield'
  | 'shieldRegenAt'
  | 'guarding'
  | 'action'
  | 'move'
  | 'stunUntil'
  | 'actionUntil'
  | 'freezeUntil'
  | 'y'
  | 'vy'
  | 'vx'
> {
  const stun = now + ARENA.shieldBreakStunMs
  const grounded = p.y <= 0.001
  return {
    shield: 0,
    shieldRegenAt: stun, // 硬直明けから回復開始
    guarding: false,
    action: 'shield-break',
    move: null,
    stunUntil: stun,
    actionUntil: stun,
    freezeUntil: now + 80,
    y: p.y,
    vy: grounded ? ARENA.shieldBreakLaunch : p.vy,
    vx: 0,
  }
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
    shield: ARENA.shieldMax,
    shieldRegenAt: 0,
    stunUntil: 0,
    freezeUntil: 0,
    invulnUntil: 0,
    comboCount: 0,
    comboBy: null,
    comboUntil: 0,
    meter: 0,
    meterFullAt: 0,
    finalDamageMul: 1,
    move: null,
    moveSide: null,
    throwVictimId: null,
    throwDamageAt: 0,
    abareHitAt: 0,
    rampageOriginX: 0,
    rampageNextHitAt: 0,
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
    intruderId: intrusion ? init.id : state.intruderId,
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
  // カード技のカットイン演出中も同様に完全停止（カメラ寄せ＋バナーの間）。
  if (now < (state.cutin?.until ?? 0)) return state
  // ファイナルベント溜めの期限切れを掃除してから、有効なら完全停止。
  if (state.finalVent && now >= state.finalVent.until) {
    state = { ...state, finalVent: null }
  }
  if (state.finalVent && now < state.finalVent.until) return state
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
    const shieldBroken = p.action === 'shield-break' && inStun

    // ガード開始は行動可能かつ耐久が最低値以上のときだけ。
    // 一度構えたらブロック硬直中も押しっぱで維持し、耐久は 0（割れ）まで減らせる。
    const holdIntent = (guardIntent[p.id] ?? false) && grounded && !shieldBroken
    const canKeepGuard = p.action === 'guard' || p.guarding
    const guarding =
      holdIntent &&
      ((canKeepGuard && p.shield > 0) || (canAct && p.shield >= ARENA.shieldMinToRaise))

    let { x, facing, y, vy, vx, shield, shieldRegenAt } = p
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

    let action = p.action
    let move = p.move
    if (guarding) {
      shield = Math.max(0, shield - ARENA.shieldDrainPerSec * dt)
      shieldRegenAt = now + ARENA.shieldRegenDelayMs
      if (shield <= 0) {
        const broken = breakShield(p, now)
        return {
          ...p,
          ...broken,
          x,
          facing,
          y: broken.y ?? y,
          vy: broken.vy ?? vy,
          vx: 0,
          comboCount,
          comboBy,
        }
      }
    } else if (!shieldBroken && now >= shieldRegenAt) {
      shield = Math.min(ARENA.shieldMax, shield + ARENA.shieldRegenPerSec * dt)
    }

    // 技/アクションの畳み: 硬直・被弾が明けたら idle（またはガード）へ、技を解除。
    // 割れ硬直中は action を shield-break のまま維持（攻撃を受けるか時間経過で解除）。
    if (shieldBroken) {
      action = 'shield-break'
      move = null
    } else if (canAct) {
      action = guarding ? 'guard' : 'idle'
      move = null
    }

    return {
      ...p,
      x,
      facing,
      y,
      vy,
      vx,
      guarding,
      shield,
      shieldRegenAt,
      action,
      move,
      comboCount,
      comboBy,
    }
  })

  const resolved = resolveBodies(moved)
  const afterHits = resolveActiveHits(resolved, now) // 近接技の持続フレーム当たり判定
  const afterRampage = resolveFinalRampage(afterHits, now) // FV 暴れ（往復移動＋多段の範囲ヒット）
  const afterThrows = resolvePendingThrows(afterRampage, now) // 掴みの遅延ダメージ（grasp-attack 中間）
  const afterAbare = resolvePendingAbare(afterThrows, now) // あばれの遅延ヒット（モーション終わりぎわ）
  const proj = stepProjectiles(afterAbare, state.projectiles ?? [], now, dt) // 波動弾の生成・飛翔・衝突
  const players = trackMeterFullAt(proj.players, now) // meter 満タン到達時刻の記録（Final 早撃ち判定用）
  return checkWinner({ ...state, players, projectiles: proj.projectiles })
}

// 掴みの遅延ダメージ。掴み成立（throw-hit）から hitDelay 経過した時点で、
// grasp-attack の中間に同期してダメージ・投げ飛ばしを入れる。
// 掴んだ側が途中で潰されて throw-hit でなくなっていたら不発＝掴み解放（ダメージ無し）。
function resolvePendingThrows(players: PlayerState[], now: number): PlayerState[] {
  let out = players
  for (const a of players) {
    if (!a.throwVictimId || now < (a.throwDamageAt ?? 0)) continue
    const f = MOVES.throw
    const live = a.action === 'throw-hit'
    out = out.map((p) => {
      if (p.id === a.id) return { ...p, throwVictimId: null }
      if (!live || p.id !== a.throwVictimId || p.hp <= 0) return p
      const hp = Math.max(0, p.hp - f.damage)
      return {
        ...p,
        hp,
        x: clamp(p.x + a.facing * f.knockback, ARENA.minX, ARENA.maxX),
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
    })
  }
  return out
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
// shot（波動弾）は弾側判定（stepProjectiles）、final（暴れ）は resolveFinalRampage が
// 移動＋多段ヒットを受け持つので、どちらもここでは除外。
function resolveActiveHits(players: PlayerState[], now: number): PlayerState[] {
  let result = players
  for (let i = 0; i < players.length; i++) {
    const a = result[i]
    if (!a.move || a.move === 'shot' || a.move === 'final' || a.hp <= 0 || a.moveHasHit) continue
    if (now < a.moveActiveFrom || now > a.moveActiveTo) continue // 持続フレーム外
    result = applyMoveHit(result, a.id, a.move, now)
  }
  return result
}

// ファイナルベント＝暴れ範囲技の本体。持続中、発動者を原点まわりの sin 往復で左右に
// 暴れさせ、一定間隔で「左右両側・範囲内の全員」へ多段ヒットを入れる。
// 位置は moveActiveFrom からの経過時間だけで決まる決定論なので、サーバーと
// クライアント予測（stepBattle 共有）で一致する。締めの1発だけ打ち上げて派手に終わる。
// Final の早撃ちダメージ倍率。meterFullAt=0（満タン未記録=旧データ等）は即撃ち扱い（最大倍率）。
function finalSpeedMultiplier(meterFullAt: number, now: number): number {
  const elapsed = meterFullAt > 0 ? Math.max(0, now - meterFullAt) : 0
  const t = Math.min(1, elapsed / ARENA.finalSpeedWindowMs)
  return ARENA.finalSpeedMaxMul + (ARENA.finalSpeedMinMul - ARENA.finalSpeedMaxMul) * t
}

// meter が満タンに達した/割った瞬間を記録する（早撃ちダメージ計算の起点）。
// meter の増減箇所は複数あるため、毎 tick 末尾でまとめて判定する。
function trackMeterFullAt(players: PlayerState[], now: number): PlayerState[] {
  return players.map((p) => {
    const full = p.meter >= ARENA.meterFinalCost
    if (full && !p.meterFullAt) return { ...p, meterFullAt: now }
    if (!full && p.meterFullAt) return { ...p, meterFullAt: 0 }
    return p
  })
}

function resolveFinalRampage(players: PlayerState[], now: number): PlayerState[] {
  let out = players
  for (const src of players) {
    if (src.move !== 'final' || src.hp <= 0) continue
    if (now < src.moveActiveFrom || now > src.moveActiveTo) continue
    // 往復移動＋進行方向を向く（見た目が「暴れて」見える）
    const t = (now - src.moveActiveFrom) / 1000
    const phase = 2 * Math.PI * ARENA.finalRampageHz * t
    const origin = src.rampageOriginX ?? src.x
    const x = clamp(origin + ARENA.finalRampageAmp * Math.sin(phase), ARENA.minX, ARENA.maxX)
    const facing: 1 | -1 = Math.cos(phase) >= 0 ? 1 : -1
    out = out.map((p) => (p.id === src.id ? { ...p, x, facing } : p))

    const a = out.find((p) => p.id === src.id)!
    if (now < (a.rampageNextHitAt ?? a.moveActiveFrom)) continue
    const isFinisher = now + ARENA.finalRampageHitGapMs > a.moveActiveTo
    const def: StrikeDef = {
      damage: ARENA.finalRampageDamage * (a.finalDamageMul ?? 1),
      knockback: isFinisher ? ARENA.finalKnockback : ARENA.knockback * 2,
      launch: isFinisher ? ARENA.finalLaunch : 0,
      hitstun: isFinisher ? 520 : 420,
      blockstun: 0,
      hitstop: 90,
      blockable: false, // ガード不可（カード技）
    }
    out = out.map((p) => {
      if (p.id === a.id || p.hp <= 0) return p
      if (now < p.invulnUntil) return p // 無敵（あばれ等）中は素通り
      if (!vertOverlap(a, p)) return p
      const dx = p.x - a.x
      if (Math.abs(dx) - 2 * ARENA.bodyHalf > ARENA.finalRampageRange) return p
      const fromDir: 1 | -1 = dx >= 0 ? 1 : -1 // 攻撃者から離す向き
      return strikeTarget(p, a.id, fromDir, def, now).p
    })
    // 空振りでも間隔は消費する（毎 tick 判定の吸い付き防止）。
    out = out.map((p) =>
      p.id === a.id ? { ...p, rampageNextHitAt: now + ARENA.finalRampageHitGapMs } : p,
    )
  }
  return out
}

// 行動可能か（硬直・スタン・ヒットストップ・KO のいずれでもない）。
function canActNow(p: PlayerState, now: number): boolean {
  return p.hp > 0 && now >= p.actionUntil && now >= p.stunUntil && now >= p.freezeUntil
}

// 技を“開始”する（当たり判定はしない）。行動可能、またはキャンセル窓内なら発動。
// applyAttack/applyThrow の共通実装。
function startMove(
  state: BattleState,
  id: string,
  kind: MoveKind,
  now: number,
  side?: 'left' | 'right',
): BattleState {
  if (state.winnerId) return state
  if (now < (state.intrusionUntil ?? 0)) return state // 乱入演出中は行動不可
  if (now < (state.cutin?.until ?? 0)) return state // カットイン演出中は行動不可
  // FV 溜め中は発動者の final だけ通す（ポーズ完走 → 必殺）。他は全部拒否。
  const venting =
    state.finalVent &&
    now < state.finalVent.until &&
    state.finalVent.playerId === id
  if (state.finalVent && now < state.finalVent.until && !(venting && kind === 'final')) {
    return state
  }
  const attacker = state.players.find((p) => p.id === id)
  if (!attacker || attacker.hp <= 0) return state

  // Final はゲージ満タン必須。
  if (kind === 'final' && attacker.meter < ARENA.meterFinalCost) return state
  // 波動弾は 2 ゲージ消費 ＋ 自分の弾が画面に無いときだけ（連射抑制＝ちゃんとした牽制技）。
  if (kind === 'shot' && attacker.meter < ARENA.shotCost) return state
  if (kind === 'shot' && (state.projectiles ?? []).some((pr) => pr.owner === id)) return state

  // 技の最中（発生〜硬直が明けるまで）は他の技コマンドを一切受け付けない。
  // 以前はヒット/ガード時のキャンセル窓（cancelInto）でコンボ接続を許していたが、
  // 「技を出している間は他の技が打てない」仕様に変更して無効化した。
  if (!canActNow(attacker, now)) return state

  const f = MOVES[kind]
  // カード技（shot/final）はカットイン演出（cutinMs の全員停止）を挟むため、
  // 技のタイムラインを停止ぶん後ろへずらす（停止明けからモーションが動き出す）。
  // FV 溜めから入った final はすでに長めの停止を見せたのでカットインを短めに。
  const fromVent = !!(venting && kind === 'final')
  const cutinDelay =
    kind === 'shot' ? ARENA.cutinMs : kind === 'final' ? (fromVent ? 900 : ARENA.cutinMs) : 0
  const activeFrom = now + cutinDelay + f.startup
  const activeTo = activeFrom + f.active
  const recoveryTo = activeTo + f.recovery
  // Final は満タンになってからの経過時間で威力が決まる（早撃ちほど強い）。発動時に確定して固定。
  const finalMul = kind === 'final' ? finalSpeedMultiplier(attacker.meterFullAt, now) : 1

  const players = state.players.map((p) =>
    p.id === id
      ? {
          ...p,
          action: kind === 'throw' ? ('throw' as const) : (kind as PlayerAction),
          move: kind,
          moveSide: side ?? null,
          finalDamageMul: kind === 'final' ? finalMul : p.finalDamageMul,
          // ストライクベント（shot）/ ファイナルベント（final）はモーション中無敵
          // （あばれ = エラーモードも発動時に全編無敵。カード技は潰されない）。
          invulnUntil:
            kind === 'shot' || kind === 'final'
              ? Math.max(p.invulnUntil, recoveryTo)
              : p.invulnUntil,
          moveActiveFrom: activeFrom,
          moveActiveTo: activeTo,
          moveHasHit: false,
          // final = 暴れ範囲技。往復の原点と多段ヒットの初回時刻を仕込む。
          rampageOriginX: kind === 'final' ? p.x : p.rampageOriginX,
          rampageNextHitAt: kind === 'final' ? activeFrom : p.rampageNextHitAt,
          cancelUntil: 0,
          actionUntil: recoveryTo,
          guarding: false,
          meter:
            kind === 'final'
              ? clamp(p.meter - ARENA.meterFinalCost, 0, ARENA.meterMax)
              : kind === 'shot'
                ? clamp(p.meter - ARENA.shotCost, 0, ARENA.meterMax)
                : p.meter,
        }
      : p,
  )
  return {
    ...state,
    players,
    // 溜め状態は技開始で解除（以降は通常の cutin 演出）
    finalVent: fromVent ? null : state.finalVent,
    cutin: cutinDelay
      ? { playerId: id, kind: kind as 'shot' | 'final', until: now + cutinDelay }
      : state.cutin,
  }
}

// 打撃/必殺を開始（worker の 'attack' / クライアント予測から）。
export function applyAttack(
  state: BattleState,
  attackerId: string,
  kind: AttackKind,
  now: number,
  side?: 'left' | 'right', // パンチ/キックの左右（GLB クリップの打ち分け）
): BattleState {
  return startMove(state, attackerId, kind, now, side)
}

// 投げを開始。
export function applyThrow(state: BattleState, attackerId: string, now: number): BattleState {
  return startMove(state, attackerId, 'throw', now)
}

// 逆転ゲージの本数（0..5）。UI 表示・解禁判定に使う。
export function meterStocks(meter: number): number {
  return Math.floor(meter / ARENA.meterPerStock)
}

// あばれ（エラーモード）: ゲージ3本を消費し、無敵で割り込む緊急脱出。
// 被弾・コンボ・硬直・ヒットストップの最中でも発動できる（＝ハメ回避）のが唯一の特徴。
// 発動時は無敵化のみで、突き放し（ダメージ）は error-mode モーションの終わりぎわ
// （abareHitDelay 後、resolvePendingAbare）に入る。純粋関数。
export function applyAbare(state: BattleState, playerId: string, now: number): BattleState {
  if (state.winnerId) return state
  if (now < (state.intrusionUntil ?? 0)) return state // 乱入演出中は行動不可
  if (now < (state.cutin?.until ?? 0)) return state // カットイン演出中は行動不可
  if (isFinalVentActive(state, now)) return state // FV 溜め中は行動不可
  const self = state.players.find((p) => p.id === playerId)
  if (!self || self.hp <= 0) return state
  if (self.meter < ARENA.abareCost) return state
  if (now < self.invulnUntil) return state // 無敵中の連発は禁止（1本ずつ）
  // 割り込めるのは「やられている側」（被弾・硬直）のみ。自分の技の最中に撃って
  // 技をキャンセルする使い方はさせない（技中ロックの例外にしない）。
  if (self.move !== null && now < self.actionUntil) return state

  // 発動者: ゲージを消費し、被弾/コンボ/硬直を振り切って無敵へ移行する。
  // カットイン演出（cutinMs の全員停止）を挟むため、タイムラインは停止ぶん後ろへずらす。
  const cd = ARENA.cutinMs
  const players = state.players.map((p) =>
    p.id === playerId
      ? {
          ...p,
          meter: clamp(p.meter - ARENA.abareCost, 0, ARENA.meterMax),
          action: 'abare' as const,
          move: null,
          moveHasHit: false,
          cancelUntil: 0,
          guarding: false,
          stunUntil: 0,
          freezeUntil: 0,
          actionUntil: now + cd + ARENA.abareRecovery,
          invulnUntil: now + cd + ARENA.abareInvuln,
          abareHitAt: now + cd + ARENA.abareHitDelay,
          comboCount: 0,
          comboBy: null,
        }
      : p,
  )
  return {
    ...state,
    players,
    cutin: { playerId, kind: 'abare' as const, until: now + cd },
  }
}

// あばれの遅延ヒット。発動から abareHitDelay 経過した時点（モーションの終わりぎわ）で、
// 周囲の生存者（無敵でない）を左右へ突き放し、軽ダメージ＋硬直を与えて間合いを作る。
function resolvePendingAbare(players: PlayerState[], now: number): PlayerState[] {
  let out = players
  for (const a of players) {
    if (!a.abareHitAt || now < a.abareHitAt) continue
    const live = a.action === 'abare' && a.hp > 0
    out = out.map((p) => {
      if (p.id === a.id) return { ...p, abareHitAt: 0 }
      if (!live || p.hp <= 0 || now < p.invulnUntil || !vertOverlap(a, p)) return p
      const dx = p.x - a.x
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
  }
  return out
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

    // 投げ: ガード貫通。掴み成立の時点ではダメージ無し＝拘束のみ。
    // ダメージ・投げ飛ばしは grasp-attack の中間（hitDelay 後、resolvePendingThrows）で入る。
    if (f.isThrow) {
      const holdUntil = now + (f.hitDelay ?? 0) + 150 // ダメージ適用まで＋余裕（適用時に上書き）
      return {
        ...p,
        guarding: false,
        action: 'hit' as const, // 掴まれリアクション（small-reaction）
        move: null,
        actionUntil: holdUntil,
        stunUntil: holdUntil,
        freezeUntil: now + f.hitstop,
      }
    }

    // 打撃: ガード/通常ヒット/カウンターを共通ヘルパで解決（弾からも再利用）。
    const r = strikeTarget(p, attackerId, attacker.facing, f, now)
    dealtMeter += r.attackerMeter
    return r.p
  })

  // 攻撃者側を確定: ヒット確定 → ヒットストップ・キャンセル窓・ゲージ。
  // 掴みは 2 段階目へ: grasp（掴みかかり）が当たったので grasp-attack（throw-hit）に切り替え、
  // recoveryOnHit ぶん（= grasp-attack アニメの尺）ロックする。
  const withAttacker = next.map((p) => {
    if (p.id !== attackerId) return p
    const recoveryOnHit = f.recoveryOnHit ? now + f.recoveryOnHit : p.actionUntil
    return {
      ...p,
      action: f.isThrow ? ('throw-hit' as const) : p.action,
      // 掴み成立: 相手と適用時刻を覚え、resolvePendingThrows が遅延ダメージを入れる
      throwVictimId: f.isThrow ? nearestId : (p.throwVictimId ?? null),
      throwDamageAt: f.isThrow ? now + (f.hitDelay ?? 0) : (p.throwDamageAt ?? 0),
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
    // 被ガードでシールド耐久を削る。0 以下なら割れ硬直（チップダメージは入れる）。
    const cost = Math.max(1, Math.round(def.damage * ARENA.shieldHitMul))
    const nextShield = p.shield - cost
    const hp = Math.max(0, p.hp - ARENA.chipDamage)
    if (nextShield <= 0 || hp <= 0) {
      if (hp <= 0) {
        return {
          p: {
            ...p,
            hp: 0,
            shield: 0,
            guarding: false,
            action: 'down',
            move: null,
            stunUntil: 0,
            actionUntil: 0,
          },
          attackerMeter: 0,
        }
      }
      const broken = breakShield(p, now)
      return {
        p: {
          ...p,
          ...broken,
          hp,
          x: clamp(p.x + fromDir * ARENA.guardPushback, ARENA.minX, ARENA.maxX),
        },
        attackerMeter: 0,
      }
    }
    const x = clamp(p.x + fromDir * ARENA.guardPushback, ARENA.minX, ARENA.maxX)
    return {
      p: {
        ...p,
        hp,
        x,
        shield: nextShield,
        shieldRegenAt: now + ARENA.shieldRegenDelayMs,
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
  // ガード割れ硬直中に殴られた場合もここへ来る → 割れ硬直がヒットで上書きされ行動再開のきっかけになる。
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
  if (now < (state.cutin?.until ?? 0)) return state // カットイン演出中は行動不可
  if (isFinalVentActive(state, now)) return state // FV 溜め中は行動不可
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

// 振り向き（facing 反転）。カメラの体の向き検出（正面 → 横向き）から呼ぶ。
// 位置は変えず向きだけ反転する。行動可能時のみ（硬直・被弾中は無効）。
// 移動中は stepBattle が moveIntent で facing を上書きするため、実質は静止中の入力。
export function applyTurn(state: BattleState, playerId: string, now: number): BattleState {
  if (state.winnerId) return state
  if (now < (state.intrusionUntil ?? 0)) return state // 乱入演出中は行動不可
  if (now < (state.cutin?.until ?? 0)) return state // カットイン演出中は行動不可
  if (isFinalVentActive(state, now)) return state // FV 溜め中は行動不可
  let changed = false
  const players = state.players.map((p) => {
    if (p.id !== playerId) return p
    if (!canActNow(p, now)) return p
    changed = true
    return { ...p, facing: (p.facing === 1 ? -1 : 1) as 1 | -1 }
  })
  return changed ? { ...state, players } : state
}

function checkWinner(state: BattleState): BattleState {
  if (state.players.length < 2) return state
  const alive = state.players.filter((p) => p.hp > 0)
  if (alive.length <= 1) return { ...state, winnerId: alive[0]?.id ?? null }
  return state
}

function isFinalVentActive(state: BattleState, now: number): boolean {
  return !!(state.finalVent && now < state.finalVent.until)
}

// ファイナルベント溜め開始／フェーズ更新（SA3 風の全員停止）。
// 他プレイヤーが既に溜め中なら拒否。同一プレイヤーの phase 更新は until を延長せず維持。
export function beginFinalVent(
  state: BattleState,
  playerId: string,
  phase: 'card' | 'pose',
  now: number,
): BattleState {
  if (state.winnerId) return state
  if (now < (state.intrusionUntil ?? 0)) return state
  if (now < (state.cutin?.until ?? 0)) return state
  const self = state.players.find((p) => p.id === playerId)
  if (!self || self.hp <= 0) return state
  if (self.meter < ARENA.meterFinalCost) return state

  const current = state.finalVent
  if (current && now < current.until && current.playerId !== playerId) {
    return state // 他人の溜めを奪わない
  }
  if (current && now < current.until && current.playerId === playerId) {
    if (current.phase === phase) return state
    return { ...state, finalVent: { ...current, phase } }
  }
  return {
    ...state,
    finalVent: {
      playerId,
      phase,
      until: now + ARENA.finalVentMaxMs,
    },
  }
}

// ファイナルベント溜めの解除（タイムアウト・キャンセル・切断時）。
export function endFinalVent(
  state: BattleState,
  playerId?: string,
): BattleState {
  if (!state.finalVent) return state
  if (playerId && state.finalVent.playerId !== playerId) return state
  return { ...state, finalVent: null }
}
