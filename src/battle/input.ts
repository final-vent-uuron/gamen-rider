// 入力の抽象化レイヤ。
// CLAUDE.md 方針: 加速度センサーのハード/接続方式は未確定。まず move / punch / kick /
// guard / throw / final をイベントとして受け取る共通インターフェース（InputSource）を用意し、
// 入力ソースを差し替え可能にする。
//   - 現状      : キーボード（ダミー入力）
//   - 将来      : 腕・足の加速度センサー、または WebSocket 経由の相手プレイヤー入力
// どのソースでも InputSource を実装すれば、バトル画面側は一切変更不要。

export type BattleInput =
  | { kind: 'move'; dir: -1 | 0 | 1 } // 移動意図（0 = 停止）
  | { kind: 'jump' }
  | { kind: 'punch' }
  | { kind: 'kick' }
  | { kind: 'guard'; on: boolean } // ガード（押しっぱ状態を送る）
  | { kind: 'throw' }
  | { kind: 'shot' } // 波動弾
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
  punch: string[]
  kick: string[]
  guard: string[]
  throw: string[]
  shot: string[]
  finalVent: string[]
}

export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  left: ['ArrowLeft', 'a', 'A'],
  right: ['ArrowRight', 'd', 'D'],
  jump: ['ArrowUp', 'w', 'W', ' '],
  punch: ['j', 'J'],
  kick: ['k', 'K'],
  guard: ['Shift', 's', 'S', 'ArrowDown'], // ホールドでガード
  throw: ['u', 'U'],
  shot: ['i', 'I'], // 波動弾
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
    } else if (bindings.punch.includes(e.key)) {
      onInput({ kind: 'punch' })
    } else if (bindings.kick.includes(e.key)) {
      onInput({ kind: 'kick' })
    } else if (bindings.throw.includes(e.key)) {
      onInput({ kind: 'throw' })
    } else if (bindings.shot.includes(e.key)) {
      onInput({ kind: 'shot' })
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
