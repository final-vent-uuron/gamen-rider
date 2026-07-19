// BLE パンチセンサー（自作 IoT デバイス）の入力ソース。
// Arduino (LIS3DH + ArduinoBLE) 側のファームウェア仕様:
//   - デバイス名: "PunchSensor"
//   - サービス:   12345678-1234-1234-1234-1234567890ab
//   - キャラクタリスティック(Notify): abcdefab-1234-5678-1234-abcdefabcdef
//   - 値(文字列):
//       "Ready"            起動直後
//       "PUNCH,<impact>"   パンチ検出（impact は加速度差分の大きさ）
//       "<impact>"         通常時のインパクト値ストリーム（約20Hz）
// InputSource 契約に沿うので、バトル側はキーボードと同じ InputHandler で受け取れる。
//
// 接続まわりの仕様（ブラウザ制約と運用のバランス）:
//   - 初回のデバイス選択だけは Web Bluetooth の仕様上ユーザーのクリックが必須（connect()）。
//   - 一度許可すれば、以降は getDevices() でダイアログなしに復元し、ページを開くだけで
//     自動接続する（start() 内の autoConnect）。センサーの電源が後から入っても
//     リトライで拾う。切断時も自動で再接続を試み続ける。
//   - 別 PC へ持ち替えるときは release()（切断＋許可の破棄）で手放す。これをしないと
//     このページが開いている限り自動再接続がセンサーを取り合う。

import type { InputHandler, InputSource } from './input'

export const PUNCH_SERVICE_UUID = '12345678-1234-1234-1234-1234567890ab'
export const PUNCH_CHAR_UUID = 'abcdefab-1234-5678-1234-abcdefabcdef'
const DEVICE_NAME_PREFIX = 'PunchSensor' // 個体別名（PunchSensor-1 等）も拾えるよう前方一致
const RETRY_MS = 2000 // 自動再接続の間隔

export type BleStatus =
  | 'idle' // 未接続（初回はボタンから connect() が必要）
  | 'unsupported' // Web Bluetooth 非対応ブラウザ（Chrome/Edge が必要）
  | 'connecting'
  | 'connected'
  | 'disconnected' // 切断中（自動再接続を試行中）
  | 'error'

export interface BleSensorSource extends InputSource {
  // 初回のみ必要。ユーザー操作（ボタンの onClick）から呼ぶこと（デバイス選択ダイアログ）。
  connect(): Promise<void>
  // センサーを手放す: 切断＋自動再接続停止＋許可の破棄。別 PC で使う前に呼ぶ。
  release(): void
}

export interface BleSensorOptions {
  onStatus?: (status: BleStatus) => void
  // 生のインパクト値（センサー調整・しきい値検証用）。punch=true はパンチ検出時。
  onImpact?: (impact: number, punch: boolean) => void
}

// --- Web Bluetooth の最小型定義（lib.dom に未収録のため、使う分だけ定義） ---
interface BleCharacteristic extends EventTarget {
  startNotifications(): Promise<unknown>
  readonly value?: DataView
}
interface BleGattService {
  getCharacteristic(uuid: string): Promise<BleCharacteristic>
}
interface BleGattServer {
  connected: boolean
  connect(): Promise<BleGattServer>
  disconnect(): void
  getPrimaryService(uuid: string): Promise<BleGattService>
}
interface BleDevice extends EventTarget {
  name?: string
  gatt?: BleGattServer
  forget?(): Promise<void> // 許可の破棄（Chrome）。release() で使う
}
interface BluetoothApi {
  requestDevice(options: {
    filters: ({ services: string[] } | { namePrefix: string })[]
    optionalServices: string[]
  }): Promise<BleDevice>
  getDevices?(): Promise<BleDevice[]> // 許可済みデバイスの復元（Chrome）
}

function bluetoothApi(): BluetoothApi | null {
  return (navigator as Navigator & { bluetooth?: BluetoothApi }).bluetooth ?? null
}

// ---- 部位別ペアリング状態 -------------------------------------------------
// 右手/左手/右足/左足の加速度センサーが「このブラウザにペアリング（許可）済みか」。
// バトル画面のステータス表示用。接続はせず、許可済みデバイスの名前を見るだけ。
//
// デバイス名 → 部位の対応（ハード側の命名が確定したらここを合わせる）:
//   - 腕: PunchSensor（既存実機）。個体名 PunchSensor-L を左手、それ以外（無印含む）を右手扱い。
//   - 足: KickSensor-L / KickSensor-*（未実装・命名は仮置き）。
export type LimbKey = 'rightHand' | 'leftHand' | 'rightFoot' | 'leftFoot'

const LIMB_MATCHERS: Record<LimbKey, (name: string) => boolean> = {
  rightHand: (n) => n.startsWith('PunchSensor') && !n.startsWith('PunchSensor-L'),
  leftHand: (n) => n.startsWith('PunchSensor-L'),
  rightFoot: (n) => n.startsWith('KickSensor') && !n.startsWith('KickSensor-L'),
  leftFoot: (n) => n.startsWith('KickSensor-L'),
}

export type PairedLimbs = Record<LimbKey, boolean>

export async function getPairedLimbs(): Promise<PairedLimbs> {
  const out: PairedLimbs = {
    rightHand: false,
    leftHand: false,
    rightFoot: false,
    leftFoot: false,
  }
  const bt = bluetoothApi()
  if (!bt?.getDevices) return out // 非対応ブラウザは全部「未ペアリング」扱い
  try {
    const names = (await bt.getDevices()).map((d) => d.name ?? '')
    for (const limb of Object.keys(LIMB_MATCHERS) as LimbKey[]) {
      out[limb] = names.some((n) => LIMB_MATCHERS[limb](n))
    }
  } catch {
    // getDevices 失敗（権限ポリシー等）も未ペアリング扱いのまま
  }
  return out
}

export function createBleSensorSource(
  onInput: InputHandler,
  opts: BleSensorOptions = {},
): BleSensorSource {
  let active = false // start()〜stop() の間だけ入力イベント・自動再接続を有効にする
  let device: BleDevice | null = null
  let characteristic: BleCharacteristic | null = null
  let attaching = false // attach の多重実行防止（手動＋リトライの競合）
  let retryTimer = 0
  const decoder = new TextDecoder()

  const setStatus = (s: BleStatus) => opts.onStatus?.(s)

  // Notify 受信 → プロトコル解析 → バトル入力へ変換。
  const onValue = (e: Event) => {
    const dv = (e.target as BleCharacteristic).value
    if (!dv) return
    const text = decoder.decode(dv).trim()
    if (text.startsWith('PUNCH')) {
      const impact = Number.parseFloat(text.split(',')[1] ?? '')
      opts.onImpact?.(Number.isFinite(impact) ? impact : 0, true)
      if (active) onInput({ kind: 'punch' })
    } else {
      // "Ready" などの非数値は無視。通常はインパクト値ストリーム。
      const impact = Number.parseFloat(text)
      if (Number.isFinite(impact)) opts.onImpact?.(impact, false)
    }
  }

  // 保持中のデバイスへ GATT 接続＋Notify 購読。成功で true。
  const attach = async (): Promise<boolean> => {
    if (!device?.gatt || attaching) return false
    attaching = true
    try {
      setStatus('connecting')
      const server = await device.gatt.connect()
      const service = await server.getPrimaryService(PUNCH_SERVICE_UUID)
      characteristic = await service.getCharacteristic(PUNCH_CHAR_UUID)
      characteristic.addEventListener('characteristicvaluechanged', onValue)
      await characteristic.startNotifications()
      setStatus('connected')
      return true
    } catch (err) {
      // センサー電源オフ・圏外・他 PC が接続中など。リトライ側で拾い直す。
      console.warn('[ble] attach failed:', err)
      setStatus('disconnected')
      return false
    } finally {
      attaching = false
    }
  }

  // 自動再接続: release() で手放すまで一定間隔で粘る。
  const scheduleRetry = () => {
    if (!active || !device) return
    window.clearTimeout(retryTimer)
    retryTimer = window.setTimeout(async () => {
      if (!active || !device || device.gatt?.connected) return
      const ok = await attach()
      if (!ok) scheduleRetry()
    }, RETRY_MS)
  }

  const onDisconnected = () => {
    characteristic = null
    setStatus('disconnected')
    scheduleRetry()
  }

  const adopt = (d: BleDevice) => {
    device = d
    d.addEventListener('gattserverdisconnected', onDisconnected)
  }

  const dropDevice = () => {
    window.clearTimeout(retryTimer)
    characteristic?.removeEventListener('characteristicvaluechanged', onValue)
    characteristic = null
    if (device) {
      device.removeEventListener('gattserverdisconnected', onDisconnected)
      device.gatt?.disconnect()
      device = null
    }
  }

  // 過去に許可済みのセンサーへダイアログなしで自動接続（初回許可後の 2 回目以降）。
  const autoConnect = async () => {
    const bt = bluetoothApi()
    if (!bt?.getDevices || device) return
    try {
      const granted = await bt.getDevices()
      const target = granted.find((d) => d.name?.startsWith(DEVICE_NAME_PREFIX))
      if (!target || !active) return
      adopt(target)
      const ok = await attach()
      if (!ok) scheduleRetry() // 電源がまだ入っていなくても、入り次第拾う
    } catch (err) {
      console.warn('[ble] auto connect failed:', err)
    }
  }

  return {
    async connect() {
      const bt = bluetoothApi()
      if (!bt) {
        setStatus('unsupported')
        return
      }
      try {
        if (!device) {
          setStatus('connecting')
          // サービス UUID（アドバタイズ済み）か名前のどちらかで見つける
          const d = await bt.requestDevice({
            filters: [{ services: [PUNCH_SERVICE_UUID] }, { namePrefix: DEVICE_NAME_PREFIX }],
            optionalServices: [PUNCH_SERVICE_UUID],
          })
          adopt(d)
        }
        const ok = await attach()
        if (!ok) scheduleRetry()
      } catch (err) {
        // 選択ダイアログのキャンセルもここに来る。デバイス未保持なら idle に戻す。
        console.warn('[ble] connect failed:', err)
        setStatus(device ? 'disconnected' : 'idle')
        if (device) scheduleRetry()
      }
    },
    release() {
      const d = device
      dropDevice()
      d?.forget?.().catch(() => {}) // 許可も破棄（自動接続の取り合い防止）。非対応なら無視
      setStatus('idle')
    },
    start() {
      active = true
      void autoConnect()
    },
    stop() {
      active = false
      dropDevice()
    },
  }
}
