import type { CSSProperties } from 'react'

import type { BleStatus } from './ble'

// センサー接続 UI の共通部品（/pairing 本番と /pairing-test 単体テストページで共用）。
// リング（輪）＝実機センサーのイメージ。入力が届いた瞬間に強く発光する。

export function btn(color: string): CSSProperties {
  return {
    padding: '0.3rem 0.9rem',
    borderRadius: '8px',
    border: `2px solid ${color}`,
    background: 'transparent',
    color,
    fontWeight: 'bold',
    fontSize: '0.8rem',
    cursor: 'pointer',
  }
}

export function BleBadge({ status }: { status: BleStatus }) {
  const map: Record<BleStatus, { label: string; color: string }> = {
    idle: { label: '未接続', color: '#9ca3af' },
    unsupported: { label: '非対応ブラウザ', color: '#f87171' },
    connecting: { label: '接続中…', color: '#fbbf24' },
    connected: { label: '接続済み', color: '#34d399' },
    disconnected: { label: '切断（再接続中…）', color: '#fbbf24' },
    error: { label: 'エラー', color: '#f87171' },
  }
  const { label, color } = map[status]
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        fontSize: '0.72rem',
        color,
        border: `1px solid ${color}55`,
        borderRadius: '999px',
        padding: '2px 10px',
      }}
    >
      <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: color }} />
      {label}
    </span>
  )
}

// センサー生値のモニタ。ファームのしきい値(25)を黄線で示し、超えた瞬間が見える。
export function ImpactMeter({ impact, flash }: { impact: number; flash: boolean }) {
  const MAX = 40 // 表示レンジ（m/s^2 相当）
  const THRESHOLD = 25 // Arduino 側 IMPACT_THRESHOLD と合わせる
  const pct = Math.min(100, (impact / MAX) * 100)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
      <span
        style={{
          fontSize: '0.7rem',
          color: '#9ca3af',
          fontFamily: 'monospace',
          width: '2.4em',
          textAlign: 'right',
        }}
      >
        {impact.toFixed(1)}
      </span>
      <span
        style={{
          position: 'relative',
          width: '90px',
          height: '9px',
          background: '#111827',
          borderRadius: '5px',
          overflow: 'hidden',
          display: 'inline-block',
        }}
      >
        <span
          style={{
            position: 'absolute',
            inset: 0,
            width: `${pct}%`,
            background: flash ? '#f87171' : '#38bdf8',
            transition: 'width 0.08s linear',
          }}
        />
        <span
          style={{
            position: 'absolute',
            left: `${(THRESHOLD / MAX) * 100}%`,
            top: 0,
            bottom: 0,
            width: '2px',
            background: '#fbbf24',
          }}
        />
      </span>
    </span>
  )
}

export function SensorTile({
  label,
  emoji,
  color,
  status,
  active,
  impact,
  reserved,
  onConnect,
  onRelease,
}: {
  label: string
  emoji: string
  color: string
  status: BleStatus
  active: boolean
  impact?: number
  reserved?: boolean // バトル入力が未割当の部位（省略時 false）
  onConnect: () => void
  onRelease: () => void
}) {
  const connected = status === 'connected'
  return (
    <div
      style={{
        width: '150px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.45rem',
        padding: '0.7rem 0.5rem',
        borderRadius: '12px',
        border: `1px solid ${connected ? color : '#334155'}`,
        background: connected ? `${color}14` : 'rgba(15,23,42,0.6)',
      }}
    >
      {/* リング（輪） */}
      <div
        style={{
          width: '58px',
          height: '58px',
          borderRadius: '50%',
          border: `6px solid ${color}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '1.5rem',
          boxShadow: active
            ? `0 0 26px ${color}, inset 0 0 14px ${color}`
            : connected
              ? `0 0 8px ${color}66, inset 0 0 4px ${color}44`
              : 'none',
          opacity: connected ? 1 : 0.5,
          transition: 'box-shadow 0.12s, opacity 0.2s',
        }}
      >
        {emoji}
      </div>
      <span style={{ fontWeight: 900, fontSize: '0.95rem', color }}>
        {label}
        {reserved && (
          <span style={{ fontSize: '0.6rem', color: '#9ca3af', marginLeft: '4px' }}>(予約)</span>
        )}
      </span>
      <BleBadge status={status} />
      {connected && !reserved && <ImpactMeter impact={impact ?? 0} flash={active} />}
      {connected ? (
        <button type="button" style={btn('#9ca3af')} onClick={onRelease}>
          手放す
        </button>
      ) : (
        <button
          type="button"
          style={btn(status === 'connecting' ? '#6b7280' : color)}
          disabled={status === 'connecting' || status === 'unsupported'}
          onClick={onConnect}
        >
          {status === 'connecting' ? '接続中…' : '📡 接続'}
        </button>
      )}
    </div>
  )
}
