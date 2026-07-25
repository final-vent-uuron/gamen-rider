import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import { SENSOR_PARTS, acquireSensorHub, createKeyboardSource, detachSensorHub } from '../battle'
import { playHenshinBgm } from '../battle/bgm'
import type { BattleInput, BleStatus, SensorHub, SensorPartKey } from '../battle'
import { SensorTile } from '../battle/sensor-tile'
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

    // BLE センサー（4部位）。共有ハブ（sensor-hub-shared）を使い、ここで繋いだ接続を
    // /battle へそのまま持ち越す。各部位の接続は下のタイルの「接続」ボタン（hub.connect(key)）から。
    const handlers = {
      // onInput はモデルの向き等に使わず、per 部位の onImpact 側で見た目を焚くので未指定。
      onStatus: (key: SensorPartKey, status: BleStatus) =>
        setStatuses((s) => ({ ...s, [key]: status })),
      onImpact: (key: SensorPartKey, impact: number, hit: boolean) => {
        setImpacts((m) => ({ ...m, [key]: impact }))
        if (!hit) return
        const def = SENSOR_PARTS.find((p) => p.key === key)
        triggerVisual(key, ACTION_BY_PART[key], `${def?.emoji ?? ''} ${def?.label ?? ''}`)
      },
      sensorSet: () => sensorSetRef.current,
    }
    const hub = acquireSensorHub(handlers)
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
      // hub.stop() はしない: GATT を切らずに /battle へ持ち越す（sensor-hub-shared 参照）。
      detachSensorHub(handlers)
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

