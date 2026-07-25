import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import { SENSOR_PARTS, createKeyboardSource, createSensorHub } from '../battle'
import { playHenshinBgm } from '../battle/bgm'
import type { BattleInput, BleStatus, SensorHub, SensorPartKey } from '../battle'
import type { PresenterAction, WinnerPresenter } from '../battle/winner3d'
import { RIDER_ROUTINES } from '../pose'
import { riderSensorSet } from '../rider-registry'

// センサーペアリング画面（変身成立 → バトルの間のステップ）。
// 右手・左手・右足・左足の計4デバイスを、それぞれ BLE でペアリングして試す。
// 入力が届くと対応するリングが光り、中央のモデルがその技のモーションを再生する
// ＝センサーが通っていることが一目で分かる。
//   - 手/足: 加速度センサー（PunchSensor / KickSensor 系）。パンチ/キック検出。
// 導線: /select・/auth → /pairing → /battle。rider/name は /battle と同じクエリで持ち回す。

export const Route = createFileRoute('/pairing')({
  validateSearch: (search: Record<string, unknown>): { rider?: string; name?: string } => ({
    rider: typeof search.rider === 'string' ? search.rider : undefined,
    name: typeof search.name === 'string' ? search.name : undefined,
  }),
  component: PairingPage,
})

// 部位 → 入力テスト時にモデルへ振らせるモーション。
const ACTION_BY_PART: Record<SensorPartKey, PresenterAction | null> = {
  rightHand: 'punch',
  leftHand: 'punch',
  rightFoot: 'kick',
  leftFoot: 'kick',
}

const PART_TILE_COLOR: Record<SensorPartKey, string> = {
  rightHand: '#f87171',
  leftHand: '#fb923c',
  rightFoot: '#38bdf8',
  leftFoot: '#22d3ee',
}

function emptyStatuses(): Record<SensorPartKey, BleStatus> {
  return {
    rightHand: 'idle',
    leftHand: 'idle',
    rightFoot: 'idle',
    leftFoot: 'idle',
  }
}

function PairingPage() {
  const { rider, name } = Route.useSearch()
  const navigate = useNavigate()
  const known = RIDER_ROUTINES.find((r) => r.riderId === rider)
  const riderId = rider ?? RIDER_ROUTINES[0].riderId
  const riderName = name ?? known?.riderName ?? RIDER_ROUTINES[0].riderName

  const hostRef = useRef<HTMLDivElement>(null)
  const presenterRef = useRef<WinnerPresenter | null>(null)
  const idleTimerRef = useRef(0)
  const flashTimerRef = useRef<Partial<Record<SensorPartKey, number>>>({})
  const hubRef = useRef<SensorHub | null>(null)
  // 登録ライダーに紐づくセンサーセット名（<ライダー名>）。R2 から非同期に決まるので ref + 表示用 state。
  const sensorSetRef = useRef<string | null>(null)

  // 変身フロー BGM（ループ）。/auth から続けて鳴らす（画面を離れたら停止する）。
  useEffect(() => playHenshinBgm(), [])

  const [sensorSet, setSensorSet] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<Record<SensorPartKey, BleStatus>>(emptyStatuses)
  const [impacts, setImpacts] = useState<Partial<Record<SensorPartKey, number>>>({})
  const [flash, setFlash] = useState<Partial<Record<SensorPartKey, boolean>>>({})
  const [lastInput, setLastInput] = useState<string | null>(null)

  // 中央の 3D モデル（勝者画面と同じプレゼンタ。GLB 登録済みならそのライダーの姿）。
  useEffect(() => {
    let disposed = false
    let presenter: WinnerPresenter | null = null
    import('../battle/winner3d').then(({ createWinnerPresenter }) => {
      if (disposed || !hostRef.current) return
      presenter = createWinnerPresenter(hostRef.current, {
        riderId,
        color: 0xa78bfa,
        action: 'idle',
        facingDeg: -20, // ほぼ正面（入力テストの動きが見やすい向き）
      })
      presenterRef.current = presenter
    })
    return () => {
      disposed = true
      presenter?.dispose()
      presenterRef.current = null
    }
  }, [riderId])

  // 入力（4部位の BLE センサー＋キーボード）→ リング発光＋モデルのモーション再生。
  useEffect(() => {
    // 部位のタイルを一瞬光らせる。
    const flashPart = (key: SensorPartKey) => {
      setFlash((f) => ({ ...f, [key]: true }))
      window.clearTimeout(flashTimerRef.current[key])
      flashTimerRef.current[key] = window.setTimeout(
        () => setFlash((f) => ({ ...f, [key]: false })),
        450,
      )
    }
    // タイル発光＋モデルモーション＋頭上ラベルをまとめて焚く。
    const triggerVisual = (key: SensorPartKey | null, action: PresenterAction | null, label: string) => {
      if (key) flashPart(key)
      setLastInput(label)
      if (action) {
        presenterRef.current?.setAction(action)
        window.clearTimeout(idleTimerRef.current)
        idleTimerRef.current = window.setTimeout(
          () => presenterRef.current?.setAction('idle'),
          900,
        )
      }
    }

    // BLE センサー（4部位）。ペアリング済みなら start で自動再接続。各部位の接続は下のタイルの
    // 「接続」ボタン（hub.connect(key)）から。届いた入力はモデルとタイルへ反映する。
    const hub = createSensorHub(
      // onInput はモデルの向き等に使わず、per 部位の onImpact 側で見た目を焚くのでここは空。
      () => {},
      {
        onStatus: (key, status) => setStatuses((s) => ({ ...s, [key]: status })),
        onImpact: (key, impact, hit) => {
          setImpacts((m) => ({ ...m, [key]: impact }))
          if (!hit) return
          const def = SENSOR_PARTS.find((p) => p.key === key)
          triggerVisual(key, ACTION_BY_PART[key], `${def?.emoji ?? ''} ${def?.label ?? ''}`)
        },
        sensorSet: () => sensorSetRef.current,
      },
    )
    hubRef.current = hub
    // 自分のライダーのセンサーセット名を R2 から引いてから自動接続を始める
    //（先に始めると他ライダー名の許可済みデバイスを拾い得るため）。
    let cancelled = false
    void riderSensorSet(riderId).then((set) => {
      sensorSetRef.current = set
      setSensorSet(set)
      if (!cancelled) hub.start()
    })

    // キーボード（センサー無しでもモデル・タイルを試せるダミー入力）。
    const kbHandler = (input: BattleInput) => {
      switch (input.kind) {
        case 'punch': {
          const key: SensorPartKey = input.side === 'left' ? 'leftHand' : 'rightHand'
          triggerVisual(key, 'punch', '🥊 パンチ')
          break
        }
        case 'kick': {
          const key: SensorPartKey = input.side === 'left' ? 'leftFoot' : 'rightFoot'
          triggerVisual(key, 'kick', '🦵 キック')
          break
        }
        case 'jump':
          triggerVisual(null, 'jump', '🦘 ジャンプ')
          break
        case 'move':
          if (input.dir !== 0) triggerVisual(null, 'walk', '🏃 移動')
          break
      }
    }
    const keyboard = createKeyboardSource(kbHandler)
    keyboard.start()

    return () => {
      cancelled = true
      keyboard.stop()
      hub.stop()
      hubRef.current = null
      window.clearTimeout(idleTimerRef.current)
      for (const t of Object.values(flashTimerRef.current)) window.clearTimeout(t)
    }
  }, [riderId])

  // 解決済みの sensorSet をそのまま /battle へ渡す（null は空文字にして必ず値を持たせる）。
  // /battle 側はこれが付いていれば R2 への再フェッチをせず即座に自動再接続を始められる
  // （フェッチ待ちで「まだ何も繋がってない」空白時間ができ、体感で切断されたように見えていた）。
  const toBattle = () =>
    navigate({
      to: '/battle',
      search: { rider: riderId, name: riderName, sensorSet: sensorSetRef.current ?? '' },
    })

  const connectedCount = SENSOR_PARTS.filter((p) => statuses[p.key] === 'connected').length

  return (
    <div
      style={{
        position: 'relative',
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        color: '#fff',
        background: 'radial-gradient(ellipse at 50% 25%, #1e2a4a 0%, #0b1220 65%, #070b16 100%)',
      }}
    >
      {/* ヘッダー */}
      <div
        style={{
          alignSelf: 'stretch',
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          padding: '0.8rem 1rem',
        }}
      >
        <Link to="/" style={{ color: '#9ca3af', textDecoration: 'none', fontSize: '0.85rem' }}>
          ← Back
        </Link>
        <h1 style={{ margin: 0, fontSize: '1.15rem' }}>センサーペアリング</h1>
        <span style={{ color: '#a78bfa', fontWeight: 'bold' }}>{riderName}</span>
        {sensorSet != null && (
          <span
            style={{
              fontSize: '0.75rem',
              color: '#34d399',
              border: '1px solid #34d39955',
              borderRadius: '999px',
              padding: '2px 10px',
            }}
          >
            センサーセット {sensorSet}（他は選択不可）
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: '#9ca3af' }}>
          接続済み {connectedCount}/{SENSOR_PARTS.length} 部位
        </span>
      </div>

      {/* 中央: 3D モデル */}
      <div style={{ position: 'relative', width: 'min(46vw, 360px)', height: 'min(38vh, 320px)' }}>
        <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
        {lastInput && (
          <span
            key={lastInput + Object.values(flash).join('')}
            style={{
              position: 'absolute',
              top: '4%',
              left: '50%',
              transform: 'translateX(-50%)',
              fontSize: '1.3rem',
              fontWeight: 900,
              textShadow: '0 2px 8px #000',
              whiteSpace: 'nowrap',
              animation: 'comboPop 0.25s ease-out',
            }}
          >
            {lastInput}
          </span>
        )}
      </div>

      {/* 4部位のセンサータイル */}
      <div
        style={{
          display: 'flex',
          gap: '0.7rem',
          flexWrap: 'wrap',
          justifyContent: 'center',
          maxWidth: '860px',
          padding: '0.4rem 1rem',
        }}
      >
        {SENSOR_PARTS.map((p) => (
          <SensorTile
            key={p.key}
            label={p.label}
            emoji={p.emoji}
            color={PART_TILE_COLOR[p.key]}
            status={statuses[p.key]}
            active={!!flash[p.key]}
            impact={impacts[p.key]}
            onConnect={() => hubRef.current?.connect(p.key)}
            onRelease={() => hubRef.current?.release(p.key)}
          />
        ))}
      </div>

      {/* フッター: バトルへ */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.9rem',
          padding: '1rem',
          marginTop: 'auto',
        }}
      >
        <span style={{ fontSize: '0.8rem', color: '#9ca3af' }}>
          （センサーが無くてもバトルはキーボードで遊べます）
        </span>
        <button
          type="button"
          onClick={toBattle}
          style={{
            padding: '0.7rem 2.4rem',
            background: 'linear-gradient(90deg, #a78bfa, #7c3aed)',
            color: '#fff',
            border: 'none',
            borderRadius: '10px',
            fontSize: '1.05rem',
            fontWeight: 900,
            cursor: 'pointer',
            boxShadow: '0 4px 16px rgba(167,139,250,0.45)',
          }}
        >
          バトルへ →
        </button>
      </div>
    </div>
  )
}

// ---- センサータイル（部位ごとの接続 UI＋入力テスト） ----------------------
// リング（輪）＝リング本体のイメージ。入力が届いた瞬間に強く発光する。

function SensorTile({
  label,
  emoji,
  color,
  status,
  active,
  impact,
  onConnect,
  onRelease,
}: {
  label: string
  emoji: string
  color: string
  status: BleStatus
  active: boolean
  impact?: number
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
      <span style={{ fontWeight: 900, fontSize: '0.95rem', color }}>{label}</span>
      <BleBadge status={status} />
      {connected && <ImpactMeter impact={impact ?? 0} flash={active} />}
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

// ---- 小物（battle-test と同系の BLE 表示） --------------------------------

function btn(color: string): React.CSSProperties {
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

function BleBadge({ status }: { status: BleStatus }) {
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
function ImpactMeter({ impact, flash }: { impact: number; flash: boolean }) {
  const MAX = 40 // 表示レンジ（m/s^2 相当）
  const THRESHOLD = 25 // Arduino 側 IMPACT_THRESHOLD と合わせる
  const pct = Math.min(100, (impact / MAX) * 100)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
      <span style={{ fontSize: '0.7rem', color: '#9ca3af', fontFamily: 'monospace', width: '2.4em', textAlign: 'right' }}>
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
