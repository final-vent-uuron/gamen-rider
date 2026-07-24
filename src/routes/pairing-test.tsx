import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import { SENSOR_PARTS, createSensorHub } from '../battle'
import type { BleStatus, SensorHub, SensorPartKey } from '../battle'
import { SensorTile } from '../battle/sensor-tile'
import type { PresenterAction, WinnerPresenter } from '../battle/winner3d'

// センサーペアリングだけを単体で試すページ（/auth・ライダー登録を経由しない）。
// /pairing との違い:
//   - riderId 不問（センサーセット制限なし＝どのライダー名のセンサーでも、旧命名の
//     試作機でも全部候補に出る。これから名前を焼く前の実機を試すのに使う）。
//   - R2 フェッチ・BGM・「バトルへ」導線なし。開いて即・繋いで終わり。
// 本番導線には含めない（他の /battle-test・/detect と同じ位置づけの開発用ページ）。

export const Route = createFileRoute('/pairing-test')({ component: PairingTestPage })

const ACTION_BY_PART: Record<SensorPartKey, PresenterAction | null> = {
  rightHand: 'punch',
  leftHand: 'punch',
  rightFoot: 'kick',
  leftFoot: 'kick',
  belt: null,
}

const PART_TILE_COLOR: Record<SensorPartKey, string> = {
  rightHand: '#f87171',
  leftHand: '#fb923c',
  rightFoot: '#38bdf8',
  leftFoot: '#22d3ee',
  belt: '#a78bfa',
}

function emptyStatuses(): Record<SensorPartKey, BleStatus> {
  return {
    rightHand: 'idle',
    leftHand: 'idle',
    rightFoot: 'idle',
    leftFoot: 'idle',
    belt: 'idle',
  }
}

function PairingTestPage() {
  const hostRef = useRef<HTMLDivElement>(null)
  const presenterRef = useRef<WinnerPresenter | null>(null)
  const idleTimerRef = useRef(0)
  const flashTimerRef = useRef<Partial<Record<SensorPartKey, number>>>({})
  const hubRef = useRef<SensorHub | null>(null)

  const [statuses, setStatuses] = useState<Record<SensorPartKey, BleStatus>>(emptyStatuses)
  const [impacts, setImpacts] = useState<Partial<Record<SensorPartKey, number>>>({})
  const [flash, setFlash] = useState<Partial<Record<SensorPartKey, boolean>>>({})
  const [lastInput, setLastInput] = useState<string | null>(null)

  // 中央の 3D モデル（プレースホルダ box。GLB 未登録の riderId でも box フォールバックで動く）。
  useEffect(() => {
    let disposed = false
    let presenter: WinnerPresenter | null = null
    import('../battle/winner3d').then(({ createWinnerPresenter }) => {
      if (disposed || !hostRef.current) return
      presenter = createWinnerPresenter(hostRef.current, {
        riderId: 'gamen',
        color: 0xa78bfa,
        action: 'idle',
        facingDeg: -20,
      })
      presenterRef.current = presenter
    })
    return () => {
      disposed = true
      presenter?.dispose()
      presenterRef.current = null
    }
  }, [])

  // 入力（5部位の BLE センサー）→ リング発光＋モデルのモーション再生。ライダー名の制限なし。
  useEffect(() => {
    const flashPart = (key: SensorPartKey) => {
      setFlash((f) => ({ ...f, [key]: true }))
      window.clearTimeout(flashTimerRef.current[key])
      flashTimerRef.current[key] = window.setTimeout(
        () => setFlash((f) => ({ ...f, [key]: false })),
        450,
      )
    }
    const triggerVisual = (key: SensorPartKey, action: PresenterAction | null, label: string) => {
      flashPart(key)
      setLastInput(label)
      if (action) {
        presenterRef.current?.setAction(action)
        window.clearTimeout(idleTimerRef.current)
        idleTimerRef.current = window.setTimeout(() => presenterRef.current?.setAction('idle'), 900)
      }
    }

    const hub = createSensorHub(() => {}, {
      onStatus: (key, status) => setStatuses((s) => ({ ...s, [key]: status })),
      onImpact: (key, impact, hit) => {
        setImpacts((m) => ({ ...m, [key]: impact }))
        if (!hit) return
        const def = SENSOR_PARTS.find((p) => p.key === key)
        triggerVisual(key, ACTION_BY_PART[key], `${def?.emoji ?? ''} ${def?.label ?? ''}`)
      },
      sensorSet: () => null, // 制限なし＝どのライダー名のセンサーも試せる
    })
    hubRef.current = hub
    hub.start()

    return () => {
      hub.stop()
      hubRef.current = null
      window.clearTimeout(idleTimerRef.current)
      for (const t of Object.values(flashTimerRef.current)) window.clearTimeout(t)
    }
  }, [])

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
        <h1 style={{ margin: 0, fontSize: '1.15rem' }}>センサーペアリング（単体テスト）</h1>
        <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>
          ライダー・センサーセットの制限なし。どの名前のセンサーでも接続候補に出ます
        </span>
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

      {/* 5部位のセンサータイル */}
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
            reserved={p.emit === null}
            onConnect={() => hubRef.current?.connect(p.key)}
            onRelease={() => hubRef.current?.release(p.key)}
          />
        ))}
      </div>

      <div style={{ padding: '1rem', marginTop: 'auto', fontSize: '0.8rem', color: '#6b7280' }}>
        ここで繋いだ接続はこのページを閉じるまでの単体テスト用です（バトルへは繋がりません）。
      </div>
    </div>
  )
}
