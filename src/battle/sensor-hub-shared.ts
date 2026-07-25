// BLE センサーハブの共有シングルトン。
//
// /pairing でペアリングした GATT 接続を /battle でもそのまま使うための置き場。
// 以前は各ページが createSensorHub を作り、離脱時に hub.stop()（= GATT 切断）していたため、
// /pairing → /battle の遷移で毎回「切断 → 実機の再アドバタイズ待ち → 再接続」が走り、
// タイミング次第で繋がらず再ペアリングが必要になっていた。
//
// ここではハブをモジュールスコープに1つだけ作り、ページ側は acquire でハンドラを
// 差し替えて使う。離脱時は detach（ハンドラを外すだけ）で、GATT 接続は維持する。
// 「手放す」ボタン（hub.release）や実機の電源断はこれまでどおり機能する。
import { createSensorHub } from './ble'
import type { BleStatus, SensorHub, SensorPartKey } from './ble'
import type { InputHandler } from './input'

export interface SensorHubHandlers {
  onInput?: InputHandler
  onStatus?: (key: SensorPartKey, status: BleStatus) => void
  onImpact?: (key: SensorPartKey, impact: number, hit: boolean) => void
  sensorSet?: () => string | null
  bothHandPunchSuppressMs?: number
}

let hub: SensorHub | null = null
let current: SensorHubHandlers = {}
// 部位ごとの最新ステータス。ページ切り替え直後に「接続済み」を即表示するための控え。
const lastStatuses = new Map<SensorPartKey, BleStatus>()

/**
 * 共有ハブを取得してハンドラを差し替える。自動再接続の開始（hub.start()）は従来どおり
 * 呼び出し側の責務（sensorSet の解決を待ってから始めたいページがあるため）。
 * 2ページ目以降の acquire では、既存接続のステータスを新しいハンドラへ即時再通知する。
 */
export function acquireSensorHub(handlers: SensorHubHandlers): SensorHub {
  current = handlers
  if (!hub) {
    hub = createSensorHub((input) => current.onInput?.(input), {
      onStatus: (key, status) => {
        lastStatuses.set(key, status)
        current.onStatus?.(key, status)
      },
      onImpact: (key, impact, hit) => current.onImpact?.(key, impact, hit),
      sensorSet: () => current.sensorSet?.() ?? null,
      // 値はページごとに違う（/pairing は抑制なし）ので、イベント時点の値を引く getter にする。
      get bothHandPunchSuppressMs() {
        return current.bothHandPunchSuppressMs
      },
    })
  } else {
    for (const [key, status] of lastStatuses) handlers.onStatus?.(key, status)
  }
  return hub
}

/**
 * ページ離脱時の後始末。自分のハンドラだけ外し、GATT 接続はそのまま維持する
 * （他ページが先に acquire 済みならそちらのハンドラは触らない）。
 */
export function detachSensorHub(handlers: SensorHubHandlers): void {
  if (current === handlers) current = {}
}
