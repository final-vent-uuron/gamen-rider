import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/bluetooth')({ component: BluetoothTest })

// XIAO ESP32-C3 (BLE) との疎通確認用ページ。
// ファームウェア側の UUID と一致させること（ずれると requestDevice で見つからない）。

// テストするとき：
// ジャンパー線の片方を D0、もう片方を GND に挿して、手で触れさせたり離したりするだけでも「押した・離した」の代わりになります。

const SERVICE_UUID = '12345678-1234-1234-1234-123456789abc'
const CHARACTERISTIC_UUID = '87654321-4321-4321-4321-cba987654321'
const DEVICE_NAME = 'FightGlove-Test'

type Status = 'idle' | 'connecting' | 'connected' | 'error'

type NotifyLog = {
  id: number
  at: string
  value: string
}

function BluetoothTest() {
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('未接続')
  const [deviceLabel, setDeviceLabel] = useState<string | null>(null)
  const [logs, setLogs] = useState<Array<NotifyLog>>([])
  const [lastValue, setLastValue] = useState<string | null>(null)
  // 通知が来た瞬間に光らせるためのフラグ。連打でも再発火するよう key を持たせる。
  const [flash, setFlash] = useState(0)

  const deviceRef = useRef<BluetoothDevice | null>(null)
  const charRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null)
  const logIdRef = useRef(0)

  // navigator.bluetooth は SSR 時に存在しない & Chrome/Edge 以外では未実装。
  const [supported, setSupported] = useState(true)
  useEffect(() => {
    setSupported(typeof navigator !== 'undefined' && 'bluetooth' in navigator)
  }, [])

  const handleNotify = useCallback((event: Event) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic
    const view = target.value
    if (!view) return
    const value = new TextDecoder().decode(view)

    logIdRef.current += 1
    const entry: NotifyLog = {
      id: logIdRef.current,
      at: new Date().toLocaleTimeString('ja-JP', { hour12: false }),
      value,
    }
    setLastValue(value)
    setFlash((n) => n + 1)
    setLogs((prev) => [entry, ...prev].slice(0, 50))
  }, [])

  const disconnect = useCallback(() => {
    charRef.current?.removeEventListener('characteristicvaluechanged', handleNotify)
    charRef.current = null
    const device = deviceRef.current
    deviceRef.current = null
    if (device?.gatt?.connected) device.gatt.disconnect()
    setStatus('idle')
    setMessage('切断しました')
    setDeviceLabel(null)
  }, [handleNotify])

  const connect = useCallback(async () => {
    if (!('bluetooth' in navigator)) return
    setStatus('connecting')
    setMessage('デバイスを選択してください…')
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE_UUID] }],
        optionalServices: [SERVICE_UUID],
      })
      deviceRef.current = device
      device.addEventListener('gattserverdisconnected', () => {
        charRef.current = null
        setStatus('idle')
        setMessage('デバイスが切断されました')
        setDeviceLabel(null)
      })

      setMessage('GATT 接続中…')
      const server = await device.gatt!.connect()
      const service = await server.getPrimaryService(SERVICE_UUID)
      const characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID)

      await characteristic.startNotifications()
      characteristic.addEventListener('characteristicvaluechanged', handleNotify)
      charRef.current = characteristic

      setDeviceLabel(device.name ?? '(名前なし)')
      setStatus('connected')
      setMessage('接続完了。ボタンを押すと通知が届きます。')
    } catch (err) {
      setStatus('error')
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }, [handleNotify])

  useEffect(() => {
    return () => {
      charRef.current?.removeEventListener('characteristicvaluechanged', handleNotify)
      if (deviceRef.current?.gatt?.connected) deviceRef.current.gatt.disconnect()
    }
  }, [handleNotify])

  const statusColor =
    status === 'connected' ? '#34d399' : status === 'error' ? '#f87171' : status === 'connecting' ? '#fbbf24' : '#6b7280'

  return (
    <div style={{ minHeight: '100vh', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem', alignItems: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ margin: 0, fontSize: '1.8rem' }}>Bluetooth 通知テスト</h1>
        <p style={{ margin: '0.4rem 0 0', color: '#9ca3af', fontSize: '0.85rem' }}>
          XIAO ESP32-C3（{DEVICE_NAME}）の notify をブラウザで受け取る
        </p>
      </div>

      {!supported && (
        <div style={{ color: '#f87171', fontSize: '0.9rem' }}>
          このブラウザは Web Bluetooth に未対応です（Chrome / Edge を https か localhost で開いてください）。
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: statusColor, display: 'inline-block' }} />
        <span style={{ color: '#cbd5e1', fontSize: '0.9rem' }}>
          {deviceLabel ? `${deviceLabel}: ${message}` : message}
        </span>
      </div>

      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <button
          type="button"
          onClick={connect}
          disabled={!supported || status === 'connecting' || status === 'connected'}
          style={{
            padding: '0.7rem 1.6rem',
            borderRadius: '10px',
            border: 'none',
            background: 'linear-gradient(135deg, #60a5fa, #2563eb)',
            color: '#fff',
            fontWeight: 'bold',
            cursor: status === 'connected' ? 'default' : 'pointer',
            opacity: !supported || status === 'connecting' || status === 'connected' ? 0.5 : 1,
          }}
        >
          接続する
        </button>
        <button
          type="button"
          onClick={disconnect}
          disabled={status !== 'connected'}
          style={{
            padding: '0.7rem 1.6rem',
            borderRadius: '10px',
            border: '1px solid #374151',
            background: '#111827',
            color: '#9ca3af',
            cursor: status === 'connected' ? 'pointer' : 'default',
            opacity: status === 'connected' ? 1 : 0.5,
          }}
        >
          切断
        </button>
      </div>

      {/* 通知が来たことが一目で分かる大きな表示。key を変えて光らせ直す。 */}
      <div
        key={flash}
        style={{
          width: 'min(560px, 100%)',
          padding: '2rem',
          borderRadius: '16px',
          textAlign: 'center',
          border: `2px solid ${lastValue ? '#a78bfa' : '#1f2937'}`,
          background: lastValue ? 'rgba(167,139,250,0.12)' : '#0b1120',
          animation: lastValue ? 'bt-flash 0.5s ease-out' : undefined,
        }}
      >
        <div style={{ color: '#6b7280', fontSize: '0.75rem', letterSpacing: '0.1em' }}>最新の通知</div>
        <div style={{ fontSize: '2.4rem', fontWeight: 'bold', color: lastValue ? '#e9d5ff' : '#374151', marginTop: '0.5rem' }}>
          {lastValue ?? '—'}
        </div>
        <div style={{ color: '#6b7280', fontSize: '0.8rem', marginTop: '0.5rem' }}>受信回数: {logs.length}</div>
      </div>

      <div style={{ width: 'min(560px, 100%)' }}>
        <div style={{ color: '#4b5563', fontSize: '0.75rem', letterSpacing: '0.1em', marginBottom: '0.4rem' }}>受信ログ</div>
        <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid #1f2937', borderRadius: '8px' }}>
          {logs.length === 0 ? (
            <div style={{ padding: '1rem', color: '#4b5563', fontSize: '0.85rem' }}>まだ通知はありません。</div>
          ) : (
            logs.map((log) => (
              <div
                key={log.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '0.5rem 0.9rem',
                  borderBottom: '1px solid #111827',
                  fontSize: '0.85rem',
                  color: '#cbd5e1',
                }}
              >
                <span style={{ fontFamily: 'monospace' }}>{log.value}</span>
                <span style={{ color: '#6b7280' }}>{log.at}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <style>{`@keyframes bt-flash { from { transform: scale(1.04); background: rgba(167,139,250,0.35); } to { transform: scale(1); } }`}</style>
    </div>
  )
}
