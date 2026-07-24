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

import type { BattleInput, InputHandler, InputSource } from './input'

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

// Notify の文字列を解析する。ファーム2系統のフォーマットを吸収する:
//   旧: "PUNCH,<impact>" / "<impact>"            （PunchSensor 系）
//   新: "<ID>,PUNCH,<impact>" / "<ID>,<impact>"  （Punch_RF 等・先頭にデバイスID）
// PUNCH トークンの有無で検出を判定し、impact は末尾の数値トークンを採る。
// "Ready" 等の非数値メッセージは null（無視）。
function parseSensorMessage(raw: string): { impact: number; punch: boolean } | null {
  const tokens = raw.trim().split(',')
  const punch = tokens.includes('PUNCH')
  const impact = Number.parseFloat(tokens[tokens.length - 1] ?? '')
  if (!Number.isFinite(impact)) return punch ? { impact: 0, punch: true } : null
  return { impact, punch }
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

// ===========================================================================
// 5部位（両手・両足・ベルト）マルチデバイス版
// ===========================================================================
// 上の createBleSensorSource は「1本の PunchSensor だけ」を扱う旧 API（battle-test 用に残す）。
// こちらは右手/左手/右足/左足/ベルトの計5デバイスを同時に扱い、部位ごとにバトル入力へ
// マッピングする。各リングは BLE 名で部位を判別するため、ファーム書き込み時に部位ごとの
// 名前を付ける必要がある（下表）。UUID は当面すべて PunchSensor と同じ想定（同ファーム流用）。
//
//   部位     BLE 名                                     バトル入力
//   右手     <ライダー名>_RH / PunchSensor              パンチ（右）
//   左手     <ライダー名>_LH / PunchSensor-L            パンチ（左）
//   右足     <ライダー名>_RF / KickSensor / Punch_RF    キック（右）
//   左足     <ライダー名>_LF / KickSensor-L / Punch_LF  キック（左）
//   ベルト   <ライダー名>_BELT / BeltSensor             （未割当。変身/ファイナルベント検出用に予約）
//
// 命名規則（<ライダー名>_<部位コード>。例: Arduino_LF）が本番の量産センサーの正式命名。
// <ライダー名> は登録ライダーの sensorSet（R2 保存。例: "Arduino"）と紐づき、SensorHub の
// sensorSet オプションで「自分のライダー名以外のデバイスは選択・自動接続できない」ように絞れる。
// 比較は大文字小文字を無視する（現場でファーム書き込み時の表記ゆれを吸収するため）。
// 旧命名（PunchSensor / KickSensor / Punch_RF 等）はライダー名を持たないので制限の対象外（試作機用）。
//
// ※ ハード/動作は未確定（CLAUDE.md）。入力の割り当ては SENSOR_PARTS の emit 1 か所で変えられる。

export type SensorPartKey = 'rightHand' | 'leftHand' | 'rightFoot' | 'leftFoot' | 'belt'

export interface SensorPartDef {
  key: SensorPartKey
  label: string // 表示名（右手 等）
  emoji: string // タイル用アイコン
  partCode: string // <ライダー名>_<部位コード> 命名の部位コード（Arduino_RH の RH 部分）
  namePrefix: string | string[] // BLE 名の前方一致（複数命名を許容: 例 KickSensor / Punch_RF）
  excludePrefix?: string // 同名衝突の除外（右手=PunchSensor は PunchSensor-L を除外）
  serviceUuid: string
  charUuid: string
  // PUNCH 通知 → バトル入力（null = 入力にしない・ペアリング/表示のみ）。
  // 入力の割り当てを変えたいときはここだけ触ればよい。
  emit: ((impact: number) => BattleInput) | null
}

export const SENSOR_PARTS: SensorPartDef[] = [
  {
    key: 'rightHand',
    label: '右手',
    emoji: '🤜',
    partCode: 'RH',
    namePrefix: 'PunchSensor',
    excludePrefix: 'PunchSensor-L',
    serviceUuid: PUNCH_SERVICE_UUID,
    charUuid: PUNCH_CHAR_UUID,
    emit: () => ({ kind: 'punch', side: 'right' }),
  },
  {
    key: 'leftHand',
    label: '左手',
    emoji: '🤛',
    partCode: 'LH',
    namePrefix: 'PunchSensor-L',
    serviceUuid: PUNCH_SERVICE_UUID,
    charUuid: PUNCH_CHAR_UUID,
    emit: () => ({ kind: 'punch', side: 'left' }),
  },
  {
    key: 'rightFoot',
    label: '右足',
    emoji: '🦵',
    partCode: 'RF',
    namePrefix: ['KickSensor', 'Punch_RF'], // Punch_RF = Right Foot ファーム（DEVICE_NAME）
    excludePrefix: 'KickSensor-L',
    serviceUuid: PUNCH_SERVICE_UUID,
    charUuid: PUNCH_CHAR_UUID,
    emit: () => ({ kind: 'kick', side: 'right' }),
  },
  {
    key: 'leftFoot',
    label: '左足',
    emoji: '🦶',
    partCode: 'LF',
    namePrefix: ['KickSensor-L', 'Punch_LF'], // Punch_LF = Left Foot ファーム（DEVICE_NAME）
    serviceUuid: PUNCH_SERVICE_UUID,
    charUuid: PUNCH_CHAR_UUID,
    emit: () => ({ kind: 'kick', side: 'left' }),
  },
  {
    key: 'belt',
    label: 'ベルト',
    emoji: '🔶',
    partCode: 'BELT',
    namePrefix: 'BeltSensor',
    serviceUuid: PUNCH_SERVICE_UUID,
    charUuid: PUNCH_CHAR_UUID,
    emit: null, // 変身/ファイナルベント検出用に予約（バトル入力は未割当）
  },
]

export type PairedParts = Record<SensorPartKey, boolean>

function emptyPaired(): PairedParts {
  return { rightHand: false, leftHand: false, rightFoot: false, leftFoot: false, belt: false }
}

// namePrefix を配列へ正規化（単一文字列も許容）。
function namePrefixes(def: SensorPartDef): string[] {
  return Array.isArray(def.namePrefix) ? def.namePrefix : [def.namePrefix]
}

// <ライダー名>_<部位コード> 命名（例: Arduino_LF）の解析。
const SENSOR_NAME_RE = /^([A-Za-z]+)_(RH|LH|RF|LF|BELT)/

export function parseSensorName(name: string): { rider: string; key: SensorPartKey } | null {
  const m = SENSOR_NAME_RE.exec(name)
  if (!m) return null
  const def = SENSOR_PARTS.find((p) => p.partCode === m[2])
  return def ? { rider: m[1], key: def.key } : null
}

// BLE 名 → 部位定義。<ライダー名>_<部位コード> 命名を優先し、旧命名は前方一致（＋除外）で判別する。
function partForName(name: string): SensorPartDef | null {
  const parsed = parseSensorName(name)
  if (parsed) return partDef(parsed.key)
  for (const p of SENSOR_PARTS) {
    if (!namePrefixes(p).some((pre) => name.startsWith(pre))) continue
    if (p.excludePrefix && name.startsWith(p.excludePrefix)) continue
    return p
  }
  return null
}

// ライダー名制限の判定。riderPrefix 指定時、他ライダー名を持つデバイスだけを弾く
// （<ライダー名>_ 命名でない旧センサーはライダー情報が無いので通す）。大文字小文字は無視する。
function nameAllowed(name: string, riderPrefix: string | null): boolean {
  if (riderPrefix == null) return true
  const parsed = parseSensorName(name)
  return !parsed || parsed.rider.toLowerCase() === riderPrefix.toLowerCase()
}

function partDef(key: SensorPartKey): SensorPartDef {
  const d = SENSOR_PARTS.find((p) => p.key === key)
  if (!d) throw new Error(`unknown sensor part: ${key}`)
  return d
}

// 5部位それぞれの「ペアリング（許可）済みか」。接続はせず、許可済みデバイスの名前を見るだけ。
// sensorSet（ライダー名。例: "Arduino"）を渡すと他ライダー名のデバイスは数えない。
export async function getPairedParts(sensorSet: string | null = null): Promise<PairedParts> {
  const out = emptyPaired()
  const bt = bluetoothApi()
  if (!bt?.getDevices) return out
  try {
    for (const d of await bt.getDevices()) {
      if (!nameAllowed(d.name ?? '', sensorSet)) continue
      const def = partForName(d.name ?? '')
      if (def) out[def.key] = true
    }
  } catch {
    // getDevices 失敗（権限ポリシー等）は未ペアリング扱いのまま
  }
  return out
}

export interface SensorHubOptions {
  onStatus?: (key: SensorPartKey, status: BleStatus) => void
  // 生のインパクト値（メーター用）。hit=true はパンチ/キック検出時。
  onImpact?: (key: SensorPartKey, impact: number, hit: boolean) => void
  // 自分のセンサーセット名（<ライダー名>_<部位> 命名のライダー名部分。登録ライダーの
  // sensorSet。例: "Arduino"）。指定すると他ライダー名のデバイスは選択ダイアログ・
  // 自動接続の両方から除外される（大文字小文字は無視）。
  // 値は R2 から非同期に決まるため getter で渡す（呼び出し時点の値を見る）。null = 制限なし。
  sensorSet?: () => string | null
  // 両手ほぼ同時ヒットの誤パンチ抑制（振り向きジェスチャー対策）。指定すると、片手の PUNCH
  // 検出をこの ms だけ遅らせて発火し、その間にもう片方の手も検出されていたら（＝両手を
  // 同時に振った＝振り向きジェスチャーとみなし）両方ともパンチを出さない（emit を呼ばない。
  // ヒットの記録自体＝onImpact は遅延なく従来どおり呼ぶので、振り向きの AND 判定には影響しない）。
  // 片手だけなら delay 分だけ遅れて通常どおり発火する。対象は rightHand/leftHand のみ。
  // 省略時は従来どおり即時発火（pairing 等、この抑制が要らないページはオプトアウトされる）。
  bothHandPunchSuppressMs?: number
}

// 5部位を同時に扱うセンサーハブ。部位ごとに GATT 接続を保持し、届いた PUNCH 通知を
// SENSOR_PARTS.emit でバトル入力へ変換して onInput へ流す（キーボードと同じ InputHandler）。
export interface SensorHub extends InputSource {
  // 特定部位を接続（初回のみ必要・ユーザー操作から）。選ばれた実機の名前で部位を自動振り分け。
  connect(key: SensorPartKey): Promise<void>
  // どの部位でもよいので1台追加（バトル HUD 用。選択した実機の名前で部位へ振り分ける）。
  connectAny(): Promise<void>
  release(key: SensorPartKey): void
  releaseAll(): void
}

export function createSensorHub(
  onInput: InputHandler,
  opts: SensorHubOptions = {},
): SensorHub {
  let active = false
  const decoder = new TextDecoder()

  interface Conn {
    def: SensorPartDef
    device: BleDevice | null
    characteristic: BleCharacteristic | null
    attaching: boolean
    retryTimer: number
    onValue: (e: Event) => void
    onDisconnected: () => void
  }
  const conns = new Map<SensorPartKey, Conn>()
  const setStatus = (key: SensorPartKey, s: BleStatus) => opts.onStatus?.(key, s)

  // 両手同時サスペンド用: 直近の片手パンチ検出時刻（rightHand/leftHand のみ使う）。
  const lastHandPunchAt: Record<'rightHand' | 'leftHand', number> = {
    rightHand: 0,
    leftHand: 0,
  }
  const isHandKey = (k: SensorPartKey): k is 'rightHand' | 'leftHand' =>
    k === 'rightHand' || k === 'leftHand'
  const otherHandKey = (k: 'rightHand' | 'leftHand') =>
    k === 'rightHand' ? 'leftHand' : 'rightHand'

  const makeConn = (def: SensorPartDef): Conn => {
    const c: Conn = {
      def,
      device: null,
      characteristic: null,
      attaching: false,
      retryTimer: 0,
      onValue: () => {},
      onDisconnected: () => {},
    }
    c.onValue = (e) => {
      const dv = (e.target as BleCharacteristic).value
      if (!dv) return
      const msg = parseSensorMessage(decoder.decode(dv))
      if (!msg) return // "Ready" 等の非数値は無視
      opts.onImpact?.(def.key, msg.impact, msg.punch)
      if (!msg.punch || !active || !def.emit) return
      const suppressMs = opts.bothHandPunchSuppressMs
      if (suppressMs && isHandKey(def.key)) {
        const key = def.key
        const hitAt = Date.now()
        lastHandPunchAt[key] = hitAt
        window.setTimeout(() => {
          if (!active) return
          const otherAt = lastHandPunchAt[otherHandKey(key)]
          if (Math.abs(otherAt - hitAt) < suppressMs) return // 両手ほぼ同時＝振り向きジェスチャー扱い
          onInput(def.emit!(msg.impact))
        }, suppressMs)
      } else {
        onInput(def.emit(msg.impact))
      }
    }
    c.onDisconnected = () => {
      c.characteristic = null
      setStatus(def.key, 'disconnected')
      scheduleRetry(c)
    }
    return c
  }
  const getConn = (key: SensorPartKey): Conn => {
    let c = conns.get(key)
    if (!c) {
      c = makeConn(partDef(key))
      conns.set(key, c)
    }
    return c
  }

  const attach = async (c: Conn): Promise<boolean> => {
    if (!c.device?.gatt || c.attaching) return false
    c.attaching = true
    try {
      setStatus(c.def.key, 'connecting')
      const server = await c.device.gatt.connect()
      const service = await server.getPrimaryService(c.def.serviceUuid)
      c.characteristic = await service.getCharacteristic(c.def.charUuid)
      c.characteristic.addEventListener('characteristicvaluechanged', c.onValue)
      await c.characteristic.startNotifications()
      setStatus(c.def.key, 'connected')
      return true
    } catch (err) {
      console.warn(`[ble] attach failed (${c.def.key}):`, err)
      setStatus(c.def.key, 'disconnected')
      return false
    } finally {
      c.attaching = false
    }
  }
  const scheduleRetry = (c: Conn) => {
    if (!active || !c.device) return
    window.clearTimeout(c.retryTimer)
    c.retryTimer = window.setTimeout(async () => {
      if (!active || !c.device || c.device.gatt?.connected) return
      const ok = await attach(c)
      if (!ok) scheduleRetry(c)
    }, RETRY_MS)
  }
  const adopt = (c: Conn, d: BleDevice) => {
    c.device = d
    d.addEventListener('gattserverdisconnected', c.onDisconnected)
  }
  const dropConn = (c: Conn) => {
    window.clearTimeout(c.retryTimer)
    c.characteristic?.removeEventListener('characteristicvaluechanged', c.onValue)
    c.characteristic = null
    if (c.device) {
      c.device.removeEventListener('gattserverdisconnected', c.onDisconnected)
      c.device.gatt?.disconnect()
      c.device = null
    }
  }

  const mySet = () => opts.sensorSet?.() ?? null

  // 選ばれた（または許可済みの）デバイスを名前で部位へ振り分けて接続する。
  // 採用した部位キーを返す（他ライダー名のデバイス等、採用しなかったときは null）。
  const adoptAndAttach = async (d: BleDevice): Promise<SensorPartKey | null> => {
    const name = d.name ?? ''
    const def = partForName(name)
    if (!def || !nameAllowed(name, mySet())) return null
    const c = getConn(def.key)
    if (c.device && c.device !== d) dropConn(c)
    adopt(c, d)
    const ok = await attach(c)
    if (!ok) scheduleRetry(c)
    return def.key
  }

  // 許可済みデバイスをダイアログ無しで自動再接続（ページを開くだけで復元）。
  // 5部位を並列で接続する（直列だと GATT 接続の待ち時間が台数倍になり、/pairing → /battle の
  // 画面遷移直後に「まだ何も繋がってない」空白時間が体感できるほど伸びていたため）。
  const autoConnectAll = async () => {
    const bt = bluetoothApi()
    if (!bt?.getDevices) return
    try {
      const devices = await bt.getDevices()
      await Promise.all(
        devices.map((d) => {
          if (!active) return undefined
          if (!nameAllowed(d.name ?? '', mySet())) return undefined
          const def = partForName(d.name ?? '')
          if (!def || getConn(def.key).device) return undefined
          return adoptAndAttach(d)
        }),
      )
    } catch (err) {
      console.warn('[ble] autoConnectAll failed:', err)
    }
  }

  const requestAndAttach = async (
    key: SensorPartKey | null,
    filters: ({ services: string[] } | { namePrefix: string })[],
    services: string[],
  ) => {
    const bt = bluetoothApi()
    if (!bt) {
      if (key) setStatus(key, 'unsupported')
      return
    }
    try {
      if (key) setStatus(key, 'connecting')
      const d = await bt.requestDevice({ filters, optionalServices: services })
      const adoptedKey = await adoptAndAttach(d)
      // 選ばれた実機が別部位・他セットだった場合、押した部位のステータスを戻す。
      if (key && adoptedKey !== key) setStatus(key, conns.get(key)?.device ? 'disconnected' : 'idle')
    } catch (err) {
      console.warn(`[ble] request failed (${key ?? 'any'}):`, err)
      if (key) setStatus(key, conns.get(key)?.device ? 'disconnected' : 'idle')
    }
  }

  const releaseKey = (key: SensorPartKey) => {
    const c = conns.get(key)
    if (!c) return
    const d = c.device
    dropConn(c)
    d?.forget?.().catch(() => {}) // 許可も破棄（自動接続の取り合い防止）。非対応なら無視
    setStatus(key, 'idle')
  }

  return {
    connect(key) {
      const def = partDef(key)
      const set = mySet()
      // セット制限中はサービス UUID フィルタを外す（UUID は全ライダー共通なので、
      // 入れると他ライダー名のデバイスまでダイアログに並んでしまう）。
      const filters = [
        ...(set != null
          ? [{ namePrefix: `${set}_${def.partCode}` }]
          : [{ services: [def.serviceUuid] }]),
        ...namePrefixes(def).map((namePrefix) => ({ namePrefix })),
      ]
      return requestAndAttach(key, filters, [def.serviceUuid])
    },
    connectAny() {
      const services = [...new Set(SENSOR_PARTS.map((p) => p.serviceUuid))]
      const set = mySet()
      // セット制限中は "<ライダー名>_" 前方一致、無制限時はサービス UUID で広く拾う
      // （<ライダー名> は任意文字列なので、制限が無いときの共通マーカーが無い）。
      const filters = [
        ...(set != null ? [{ namePrefix: `${set}_` }] : [{ services }]),
        ...SENSOR_PARTS.flatMap((p) => namePrefixes(p).map((namePrefix) => ({ namePrefix }))),
      ]
      return requestAndAttach(null, filters, services)
    },
    release: releaseKey,
    releaseAll() {
      for (const key of conns.keys()) releaseKey(key)
    },
    start() {
      active = true
      void autoConnectAll()
    },
    stop() {
      active = false
      for (const c of conns.values()) dropConn(c)
    },
  }
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
    const msg = parseSensorMessage(decoder.decode(dv))
    if (!msg) return // "Ready" などの非数値は無視
    opts.onImpact?.(msg.impact, msg.punch)
    if (msg.punch && active) onInput({ kind: 'punch' })
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
