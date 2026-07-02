// 変身成立の「受け渡し口」。認識フロー（カード＋ポーズ）はここに結果を emit するだけ。
// ルーム参加・状態同期・バトル画面などの上位レイヤーは onHenshin で購読するだけ。
// サーバー/DB/画面遷移の方法に一切依存しないので、決まり次第そちらで自由に結線できる。

export interface HenshinResult {
  riderId: string
  riderName: string
}

type Listener = (r: HenshinResult) => void

const listeners = new Set<Listener>()

// 変身成立を購読する。戻り値を呼ぶと購読解除。
export function onHenshin(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// 変身成立を通知する。
export function emitHenshin(r: HenshinResult): void {
  for (const l of listeners) l(r)
}
