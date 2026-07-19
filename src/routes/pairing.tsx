import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import { createBleSensorSource, createKeyboardSource } from '../battle'
import type { BattleInput, BleSensorSource, BleStatus } from '../battle'
import type { WinnerPresenter } from '../battle/winner3d'
import { RIDER_ROUTINES } from '../pose'

// センサーペアリング画面（変身成立 → バトルの間のステップ）。
// 画面中央に変身したライダーの 3D モデルを置き、腕・足のセンサーリングを接続して
// 「どんな入力が届いているか」をバトル前に試せる。入力が届くと対応するリングが光り、
// モデルがその技のモーションを再生する＝センサーが通っていることが一目で分かる。
//   - 腕リング: BLE パンチセンサー（PunchSensor）。実機。
//   - 足リング: センサーは未確定（CLAUDE.md）。今はキーボード（←→/K）で入力だけ試せる。
// 導線: /henshin（変身成立）→ /pairing → /battle。rider/name は /battle と同じクエリで持ち回す。

export const Route = createFileRoute('/pairing')({
  validateSearch: (search: Record<string, unknown>): { rider?: string; name?: string } => ({
    rider: typeof search.rider === 'string' ? search.rider : undefined,
    name: typeof search.name === 'string' ? search.name : undefined,
  }),
  component: PairingPage,
})

// 入力テストの表示ラベル（届いた入力の種類 → リングと表示名）
const INPUT_LABELS: Partial<Record<BattleInput['kind'], { label: string; limb: 'arm' | 'leg' }>> = {
  punch: { label: '👊 パンチ', limb: 'arm' },
  kick: { label: '🦵 キック', limb: 'leg' },
  move: { label: '🏃 移動', limb: 'leg' },
  jump: { label: '🦘 ジャンプ', limb: 'leg' },
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
  const flashTimerRef = useRef<Record<'arm' | 'leg', number>>({ arm: 0, leg: 0 })

  const [bleStatus, setBleStatus] = useState<BleStatus>('idle')
  const [impact, setImpact] = useState(0)
  const [flash, setFlash] = useState<{ arm: boolean; leg: boolean }>({ arm: false, leg: false })
  const [lastInput, setLastInput] = useState<string | null>(null)
  const bleRef = useRef<BleSensorSource | null>(null)

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

  // 入力（BLE センサー＋キーボード）→ リング発光＋モデルのモーション再生。
  useEffect(() => {
    const trigger = (kind: BattleInput['kind']) => {
      const meta = INPUT_LABELS[kind]
      if (!meta) return
      setLastInput(meta.label)
      // リング発光（短時間で消す）
      setFlash((f) => ({ ...f, [meta.limb]: true }))
      window.clearTimeout(flashTimerRef.current[meta.limb])
      flashTimerRef.current[meta.limb] = window.setTimeout(
        () => setFlash((f) => ({ ...f, [meta.limb]: false })),
        450,
      )
      // モデルに技を振らせて idle へ戻す（walk はその場走りが一瞬入る）
      const action =
        kind === 'punch' ? 'punch' : kind === 'kick' ? 'kick' : kind === 'jump' ? 'jump' : 'walk'
      presenterRef.current?.setAction(action)
      window.clearTimeout(idleTimerRef.current)
      idleTimerRef.current = window.setTimeout(
        () => presenterRef.current?.setAction('idle'),
        900,
      )
    }

    const handleInput = (input: BattleInput) => {
      if (input.kind === 'move') {
        if (input.dir !== 0) trigger('move')
        return
      }
      if (input.kind === 'guard') return // 押しっぱなし系はテスト対象外
      trigger(input.kind)
    }

    const keyboard = createKeyboardSource(handleInput)
    const ble = createBleSensorSource(handleInput, {
      onStatus: setBleStatus,
      onImpact: (v) => setImpact(v),
    })
    keyboard.start()
    ble.start()
    bleRef.current = ble
    return () => {
      keyboard.stop()
      ble.stop()
      bleRef.current = null
      window.clearTimeout(idleTimerRef.current)
      window.clearTimeout(flashTimerRef.current.arm)
      window.clearTimeout(flashTimerRef.current.leg)
    }
  }, [])

  const toBattle = () => navigate({ to: '/battle', search: { rider: riderId, name: riderName } })

  return (
    <div
      style={{
        position: 'relative',
        height: '100vh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        color: '#fff',
        background: 'radial-gradient(ellipse at 50% 30%, #1e2a4a 0%, #0b1220 65%, #070b16 100%)',
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
        <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: '#9ca3af' }}>
          リングを着けて、腕を振って入力が届くか試そう
        </span>
      </div>

      {/* 中央: 3D モデル ＋ 左右のリングインジケータ */}
      <div
        style={{
          position: 'relative',
          flex: 1,
          width: 'min(92vw, 900px)',
          display: 'flex',
          alignItems: 'stretch',
          justifyContent: 'center',
        }}
      >
        {/* 腕リング（左側・BLE 実機） */}
        <RingPanel
          side="left"
          title="腕リング"
          desc="パンチ検出（実機センサー）"
          active={flash.arm}
          color="#f87171"
        >
          <BleBadge status={bleStatus} />
          {bleStatus === 'connected' && <ImpactMeter impact={impact} flash={flash.arm} />}
          {bleStatus === 'idle' && (
            <button type="button" style={btn('#a78bfa')} onClick={() => bleRef.current?.connect()}>
              📡 センサー接続
            </button>
          )}
          {(bleStatus === 'connected' || bleStatus === 'disconnected') && (
            <button type="button" style={btn('#9ca3af')} onClick={() => bleRef.current?.release()}>
              手放す
            </button>
          )}
        </RingPanel>

        {/* 3D モデル（中央） */}
        <div style={{ position: 'relative', width: 'min(46vw, 420px)' }}>
          <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
          {/* 最後に届いた入力（モデルの頭上に一瞬出す） */}
          {lastInput && (
            <span
              key={lastInput + String(flash.arm) + String(flash.leg)}
              style={{
                position: 'absolute',
                top: '6%',
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

        {/* 足リング（右側・センサー未確定のためキーボードで試す） */}
        <RingPanel
          side="right"
          title="足リング"
          desc="移動・キック（センサーは準備中）"
          active={flash.leg}
          color="#38bdf8"
        >
          <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>
            いまはキーボードで入力を試せます
            <br />← → 移動 / K キック / W ジャンプ
          </span>
        </RingPanel>
      </div>

      {/* フッター: バトルへ */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.9rem',
          padding: '1rem',
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

// ---- リングインジケータ（腕/足） ------------------------------------------
// 光る輪＝リング本体のイメージ。入力が届いた瞬間に強く発光する。

function RingPanel({
  side,
  title,
  desc,
  active,
  color,
  children,
}: {
  side: 'left' | 'right'
  title: string
  desc: string
  active: boolean
  color: string
  children?: React.ReactNode
}) {
  return (
    <div
      style={{
        width: 'clamp(180px, 24vw, 260px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: side === 'left' ? 'flex-end' : 'flex-start',
        justifyContent: 'center',
        gap: '0.6rem',
        padding: '0 1rem',
        textAlign: side === 'left' ? 'right' : 'left',
      }}
    >
      {/* リング（輪） */}
      <div
        style={{
          width: '86px',
          height: '86px',
          borderRadius: '50%',
          border: `7px solid ${color}`,
          boxShadow: active
            ? `0 0 30px ${color}, inset 0 0 18px ${color}`
            : `0 0 8px ${color}55, inset 0 0 4px ${color}33`,
          opacity: active ? 1 : 0.55,
          transition: 'box-shadow 0.12s, opacity 0.12s',
          alignSelf: 'center',
        }}
      />
      <span style={{ fontWeight: 900, fontSize: '1rem', alignSelf: 'center', color }}>
        {title}
      </span>
      <span style={{ fontSize: '0.75rem', color: '#9ca3af', alignSelf: 'center', textAlign: 'center' }}>
        {desc}
      </span>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.4rem',
          alignItems: 'center',
          alignSelf: 'center',
        }}
      >
        {children}
      </div>
    </div>
  )
}

// ---- 小物（battle-test と同系の BLE 表示） --------------------------------

function btn(color: string): React.CSSProperties {
  return {
    padding: '0.35rem 0.9rem',
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
        fontSize: '0.75rem',
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
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
      <span style={{ fontSize: '0.75rem', color: '#9ca3af', fontFamily: 'monospace' }}>
        {impact.toFixed(1)}
      </span>
      <span
        style={{
          position: 'relative',
          width: '120px',
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
