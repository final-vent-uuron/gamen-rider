import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import {
  applyAbare,
  applyAttack,
  applyJump,
  applyThrow,
  applyTurn,
  flipMoveIntent,
  createBattle,
  createBleSensorSource,
  createKeyboardSource,
  stepBattle,
} from '../battle'
import type { BattleInput, BattleState, BleSensorSource, BleStatus } from '../battle'
import type { ArenaRenderer } from '../battle/arena3d'

// GLB アバターのバトル検証ページ（オフライン・サーバー不要）。
// 実バトル(/battle)と同じ createArenaRenderer + DEFAULT_RIDER_MODEL 構成を、サーバーなしで
// 単体で回せる場所。モデルやモーションを調整したらまずここで確認してから /battle で対戦する。
// シミュレーションは state.ts の純粋関数（stepBattle 等）をローカルで回すだけ（WebSocket なし）。

export const Route = createFileRoute('/battle-test')({ component: BattleTestPage })

const YOU = 'you'
const BOT_IDS = ['bot1', 'bot2', 'bot3', 'bot4', 'bot5']

// ゲージ満タンで開始（ファイナル/あばれのモーションもすぐ検証できるように）。
function freshState(): BattleState {
  const s = createBattle([
    { id: YOU, riderId: 'test-you', riderName: 'あなた', isSelf: true },
    ...BOT_IDS.map((id, i) => ({
      id,
      riderId: `test-${id}`,
      riderName: `BOT${i + 1}`,
      isSelf: false,
    })),
  ])
  return { ...s, players: s.players.map((p) => ({ ...p, meter: 100 })) }
}

function BattleTestPage() {
  const hostRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<ArenaRenderer | null>(null)
  const stateRef = useRef<BattleState>(freshState())
  const moveDirRef = useRef<-1 | 0 | 1>(0)
  const guardRef = useRef(false)
  const lastTRef = useRef(0)
  const [hud, setHud] = useState({ you: 100, bots: BOT_IDS.map(() => 100) })

  // BLE パンチセンサー（自作 IoT）。接続はユーザー操作必須なのでボタンから connect()。
  const bleRef = useRef<BleSensorSource | null>(null)
  const [bleStatus, setBleStatus] = useState<BleStatus>('idle')
  const [impact, setImpact] = useState(0) // センサー生値（しきい値検証用）
  const [sensorPunch, setSensorPunch] = useState(false) // PUNCH 受信の一瞬フラッシュ
  const punchFlashRef = useRef(0)

  // three.js レンダラ初期化（SSR 回避のため動的 import。検証用 GLB を fallback に指定）。
  useEffect(() => {
    let disposed = false
    let renderer: ArenaRenderer | null = null
    import('../battle/arena3d').then(({ createArenaRenderer, DEFAULT_RIDER_MODEL }) => {
      if (disposed || !hostRef.current) return
      renderer = createArenaRenderer(hostRef.current, { fallbackModel: DEFAULT_RIDER_MODEL })
      rendererRef.current = renderer
    })
    return () => {
      disposed = true
      renderer?.dispose()
      rendererRef.current = null
    }
  }, [])

  // 入力 → ローカル状態へ直接適用（/battle と同じ操作系・サーバーなし）。
  // キーボード（ダミー）と BLE パンチセンサー（実機）が同じハンドラを共有する。
  // 本番も InputSource を差し替える/並べるだけで同じ形になる。
  useEffect(() => {
    const handleInput = (input: BattleInput) => {
      const now = Date.now()
      const s = stateRef.current
      switch (input.kind) {
        case 'move':
          moveDirRef.current = input.dir
          break
        case 'jump':
          stateRef.current = applyJump(s, YOU, now)
          break
        case 'punch':
          stateRef.current = applyAttack(s, YOU, 'punch', now, input.side)
          break
        case 'kick':
          stateRef.current = applyAttack(s, YOU, 'kick', now, input.side)
          break
        case 'shot':
          stateRef.current = applyAttack(s, YOU, 'shot', now)
          break
        case 'final-vent':
          stateRef.current = applyAttack(s, YOU, 'final', now)
          break
        case 'throw':
          stateRef.current = applyThrow(s, YOU, now)
          break
        case 'abare':
          stateRef.current = applyAbare(s, YOU, now)
          break
        case 'turn': {
          const { state, turned } = applyTurn(s, YOU, now)
          stateRef.current = state
          if (turned) moveDirRef.current = flipMoveIntent(moveDirRef.current)
          break
        }
        case 'guard':
          guardRef.current = input.on
          break
      }
    }

    const keyboard = createKeyboardSource(handleInput)
    const ble = createBleSensorSource(handleInput, {
      onStatus: setBleStatus,
      onImpact: (v, punch) => {
        setImpact(v)
        if (punch) {
          setSensorPunch(true)
          window.clearTimeout(punchFlashRef.current)
          punchFlashRef.current = window.setTimeout(() => setSensorPunch(false), 450)
        }
      },
    })
    keyboard.start()
    ble.start()
    bleRef.current = ble
    return () => {
      keyboard.stop()
      ble.stop()
      bleRef.current = null
      window.clearTimeout(punchFlashRef.current)
    }
  }, [])

  // シミュレーション＋描画ループ。stepBattle をそのまま回す（winner 判定も本物と同じ）。
  useEffect(() => {
    let raf = 0
    let lastHud = 0
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const now = Date.now()
      const dt = lastTRef.current ? now - lastTRef.current : 0
      lastTRef.current = now
      stateRef.current = stepBattle(
        stateRef.current,
        dt,
        now,
        { [YOU]: moveDirRef.current },
        { [YOU]: guardRef.current },
      )
      const s = stateRef.current
      // ファイナル演出（背景の紫寄せ）は誰かが final 中かどうかで簡易判定
      rendererRef.current?.render(s, s.players.some((p) => p.action === 'final'))
      if (now - lastHud > 150) {
        lastHud = now
        setHud({
          you: s.players.find((p) => p.id === YOU)?.hp ?? 0,
          bots: BOT_IDS.map((id) => s.players.find((p) => p.id === id)?.hp ?? 0),
        })
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  // 検証用ショートカット: KO で death モーション、リセットで最初から。
  function ko(id: string) {
    stateRef.current = {
      ...stateRef.current,
      players: stateRef.current.players.map((p) => (p.id === id ? { ...p, hp: 0 } : p)),
    }
  }
  function koNextBot() {
    const target = stateRef.current.players.find((p) => p.id !== YOU && p.hp > 0)
    if (target) ko(target.id)
  }
  function reset() {
    stateRef.current = freshState()
  }
  function refillMeter() {
    stateRef.current = {
      ...stateRef.current,
      players: stateRef.current.players.map((p) => ({ ...p, meter: 100 })),
    }
  }

  const btn = (color: string): React.CSSProperties => ({
    padding: '0.4rem 1rem',
    borderRadius: '8px',
    border: `2px solid ${color}`,
    background: 'transparent',
    color,
    fontWeight: 'bold',
    fontSize: '0.85rem',
    cursor: 'pointer',
  })

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        padding: '1rem',
        gap: '0.75rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <Link to="/" style={{ color: '#9ca3af', textDecoration: 'none', fontSize: '0.9rem' }}>
          ← Back
        </Link>
        <h1 style={{ margin: 0, fontSize: '1.3rem' }}>バトル移植検証（GLB・オフライン）</h1>
        <span style={{ fontSize: '0.9rem', color: '#a78bfa' }}>
          あなた HP {hud.you} / BOT HP {hud.bots.join(' · ')}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
          <button type="button" style={btn('#f87171')} onClick={koNextBot}>
            BOTをKO（1体ずつ）
          </button>
          <button type="button" style={btn('#f87171')} onClick={() => ko(YOU)}>
            自分をKO
          </button>
          <button type="button" style={btn('#38bdf8')} onClick={refillMeter}>
            ゲージMAX
          </button>
          <button type="button" style={btn('#4ade80')} onClick={reset}>
            🔄 リセット
          </button>
        </div>
      </div>

      {/* BLE パンチセンサー（自作 IoT）。初回だけボタンで許可し、以降はページを開くだけで
          自動接続（切断時も自動リトライ）。接続すると生のインパクト値も見える */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        {bleStatus === 'idle' && (
          <button type="button" style={btn('#a78bfa')} onClick={() => bleRef.current?.connect()}>
            📡 センサー接続（初回のみ）
          </button>
        )}
        {(bleStatus === 'connected' || bleStatus === 'disconnected') && (
          <button type="button" style={btn('#9ca3af')} onClick={() => bleRef.current?.release()}>
            手放す（別PCで使う）
          </button>
        )}
        <BleBadge status={bleStatus} />
        {bleStatus === 'connected' && <ImpactMeter impact={impact} flash={sensorPunch} />}
        {bleStatus === 'idle' && (
          <span style={{ fontSize: '0.8rem', color: '#9ca3af' }}>
            一度許可すれば、次からはページを開くだけで自動接続されます
          </span>
        )}
        {bleStatus === 'unsupported' && (
          <span style={{ fontSize: '0.85rem', color: '#fca5a5' }}>
            このブラウザは Web Bluetooth 非対応です（Chrome / Edge を使ってください）
          </span>
        )}
      </div>

      {/* ステージ（/battle と同じ arena3d レンダラ・同じ GLB アバター） */}
      <div
        style={{
          position: 'relative',
          flex: 1,
          minHeight: '420px',
          borderRadius: '12px',
          overflow: 'hidden',
          background: '#0b1220',
        }}
      >
        <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      </div>

      <div style={{ fontSize: '0.85rem', color: '#cbd5e1', lineHeight: 1.8 }}>
        <strong>操作:</strong> ← → 移動 / W ジャンプ / J K 左右パンチ / N M 左右キック /
        I ストライクベント / U 掴み / E エラーベント / T 振り向き / L ファイナルベント /
        Shift ガード（パンチは BLE センサーからも発動）
        <br />
        <span style={{ color: '#9ca3af' }}>
          チェック項目: サイズ感・向き・接地 / idle↔技の切り替わり / 技の尺（振り切って戻るか）/
          KO で death を再生して倒れたままになるか（被弾はクリップ未収録のため idle 代用）/
          Shift ガードで青いシールドが正面に出るか /
          センサー接続 → 腕を振って PUNCH が出るか・しきい値(黄線=25)は適切か
        </span>
      </div>
    </div>
  )
}

// ---- BLE センサー UI -------------------------------------------------------

function BleBadge({ status }: { status: BleStatus }) {
  const map: Record<BleStatus, { label: string; color: string }> = {
    idle: { label: 'センサー未接続', color: '#9ca3af' },
    unsupported: { label: '非対応ブラウザ', color: '#f87171' },
    connecting: { label: '接続中…', color: '#fbbf24' },
    connected: { label: 'センサー接続済み', color: '#34d399' },
    disconnected: { label: '切断（自動再接続中…）', color: '#fbbf24' },
    error: { label: 'エラー', color: '#f87171' },
  }
  const { label, color } = map[status]
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        fontSize: '0.8rem',
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
      <span style={{ fontSize: '0.8rem', color: '#9ca3af', fontFamily: 'monospace' }}>
        impact {impact.toFixed(1)}
      </span>
      <span
        style={{
          position: 'relative',
          width: '160px',
          height: '10px',
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
      {flash && (
        <span style={{ color: '#f87171', fontWeight: 900, fontSize: '0.9rem' }}>👊 PUNCH!</span>
      )}
    </span>
  )
}
