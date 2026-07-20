// 入力の抽象化レイヤ。
// CLAUDE.md 方針: 加速度センサーのハード/接続方式は未確定。まず move / punch / kick /
// guard / throw / final をイベントとして受け取る共通インターフェース（InputSource）を用意し、
// 入力ソースを差し替え可能にする。
//   - 現状      : キーボード（ダミー入力）
//   - 将来      : 腕・足の加速度センサー、または WebSocket 経由の相手プレイヤー入力
// どのソースでも InputSource を実装すれば、バトル画面側は一切変更不要。

// 左右どちらの腕/足か。GLB の left-punch / right-punch 等の打ち分けに使う。
// センサー入力（腕・足それぞれのデバイス）とも自然に対応する。省略時はランダム再生。
export type LimbSide = 'left' | 'right'

export type BattleInput =
  | { kind: 'move'; dir: -1 | 0 | 1 } // 移動意図（0 = 停止）
  | { kind: 'jump' }
  | { kind: 'punch'; side?: LimbSide }
  | { kind: 'kick'; side?: LimbSide }
  | { kind: 'guard'; on: boolean } // ガード（押しっぱ状態を送る）
  | { kind: 'throw' }
  | { kind: 'shot' } // 波動弾
  | { kind: 'abare' } // あばれ（ゲージ1本の割り込み）
  | { kind: 'turn' } // 振り向き（facing 反転。カメラの向き検出と同じ操作のキー版）
  | { kind: 'final-vent' }

export type InputHandler = (input: BattleInput) => void

// 入力ソースの共通契約。start で購読開始、stop で解除。
export interface InputSource {
  start(): void
  stop(): void
}

// どのキーがどの操作に対応するか。ダミー入力用なので分かりやすさ優先。
export interface KeyBindings {
  left: string[]
  right: string[]
  jump: string[]
  punchLeft: string[]
  punchRight: string[]
  kickLeft: string[]
  kickRight: string[]
  guard: string[]
  throw: string[]
  shot: string[]
  abare: string[]
  turn: string[]
  finalVent: string[]
}

export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  left: ['ArrowLeft', 'a', 'A'],
  right: ['ArrowRight', 'd', 'D'],
  jump: ['ArrowUp', 'w', 'W', ' '],
  punchLeft: ['j', 'J'], // 左パンチ（GLB: left-punch）
  punchRight: ['k', 'K'], // 右パンチ（GLB: right-punch）
  kickLeft: ['n', 'N'], // 左キック（GLB: left-kick）
  kickRight: ['m', 'M'], // 右キック（GLB: right-kick）
  guard: ['Shift', 's', 'S', 'ArrowDown'], // ホールドでガード
  throw: ['u', 'U'],
  shot: ['i', 'I'], // 波動弾
  abare: ['e', 'E'], // あばれ（割り込み・被弾中でも出せる）
  turn: ['t', 'T'], // 振り向き（カメラの向き検出のキー版）
  finalVent: ['l', 'L', 'f', 'F'],
}

// キーボードをバトル入力に変換するダミーソース。
// 左右は押下状態から現在の移動方向を算出（両押し / 離しで停止）。
// ガードは「押しっぱ状態」を on/off で送る（複数キーのどれかが押されていれば on）。
export function createKeyboardSource(
  onInput: InputHandler,
  bindings: KeyBindings = DEFAULT_KEY_BINDINGS,
): InputSource {
  let leftDown = false
  let rightDown = false
  const guardKeys = new Set<string>() // 現在押されているガードキー

  const dir = (): -1 | 0 | 1 => (leftDown === rightDown ? 0 : leftDown ? -1 : 1)

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return
    if (bindings.left.includes(e.key)) {
      leftDown = true
      onInput({ kind: 'move', dir: dir() })
    } else if (bindings.right.includes(e.key)) {
      rightDown = true
      onInput({ kind: 'move', dir: dir() })
    } else if (bindings.jump.includes(e.key)) {
      onInput({ kind: 'jump' })
    } else if (bindings.punchLeft.includes(e.key)) {
      onInput({ kind: 'punch', side: 'left' })
    } else if (bindings.punchRight.includes(e.key)) {
      onInput({ kind: 'punch', side: 'right' })
    } else if (bindings.kickLeft.includes(e.key)) {
      onInput({ kind: 'kick', side: 'left' })
    } else if (bindings.kickRight.includes(e.key)) {
      onInput({ kind: 'kick', side: 'right' })
    } else if (bindings.throw.includes(e.key)) {
      onInput({ kind: 'throw' })
    } else if (bindings.shot.includes(e.key)) {
      onInput({ kind: 'shot' })
    } else if (bindings.abare.includes(e.key)) {
      onInput({ kind: 'abare' })
    } else if (bindings.turn.includes(e.key)) {
      onInput({ kind: 'turn' })
    } else if (bindings.guard.includes(e.key)) {
      const was = guardKeys.size > 0
      guardKeys.add(e.key)
      if (!was) onInput({ kind: 'guard', on: true })
    } else if (bindings.finalVent.includes(e.key)) {
      onInput({ kind: 'final-vent' })
    } else {
      return
    }
    e.preventDefault()
  }

  const onKeyUp = (e: KeyboardEvent) => {
    if (bindings.left.includes(e.key)) {
      leftDown = false
      onInput({ kind: 'move', dir: dir() })
    } else if (bindings.right.includes(e.key)) {
      rightDown = false
      onInput({ kind: 'move', dir: dir() })
    } else if (bindings.guard.includes(e.key)) {
      guardKeys.delete(e.key)
      if (guardKeys.size === 0) onInput({ kind: 'guard', on: false })
    } else {
      return
    }
    e.preventDefault()
  }

  return {
    start() {
      window.addEventListener('keydown', onKeyDown)
      window.addEventListener('keyup', onKeyUp)
    },
    stop() {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    },
  }
}
