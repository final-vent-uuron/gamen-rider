import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'

import { RIDER_ROUTINES } from '../pose'
import { battleCardsFor, connectBattle, createKeyboardSource } from '../battle'
import type { BattleCard, BattleNet, BattleState, NetStatus, PlayerState } from '../battle'
import type { ArenaRenderer } from '../battle/arena3d'

// rider をクエリで受け取り、無ければ先頭ルーチンを既定にする（/battle 単体でも動作確認できる）。
// 変身フロー（/henshin）からは navigate({ to:'/battle', search:{ rider } }) で遷移してくる想定。
export const Route = createFileRoute('/battle')({
  validateSearch: (search: Record<string, unknown>): { rider?: string } => ({
    rider: typeof search.rider === 'string' ? search.rider : undefined,
  }),
  component: BattlePage,
})

// プレイヤーの表示色（1P〜5P）。HP バーと placeholder の色に使う。
const PLAYER_COLORS = ['#a78bfa', '#f87171', '#34d399', '#fbbf24', '#38bdf8']

// サーバーから最初の状態が届くまでの初期値（空のロスター）。
const EMPTY_BATTLE: BattleState = { players: [], winnerId: null }

function BattlePage() {
  const { rider } = Route.useSearch()

  // 自分のライダーを解決。未指定 / 未対応なら先頭ルーチンで代用。
  const routine = useMemo(
    () => RIDER_ROUTINES.find((r) => r.riderId === rider) ?? RIDER_ROUTINES[0],
    [rider],
  )

  const cards = battleCardsFor(routine.riderId)

  const [battle, setBattle] = useState<BattleState>(EMPTY_BATTLE)
  const [finalActive, setFinalActive] = useState(false)
  const [status, setStatus] = useState<NetStatus>('connecting')

  const battleRef = useRef(battle)
  battleRef.current = battle
  const youIdRef = useRef('') // 自分のプレイヤー id（サーバーが welcome で通知）
  const rafRef = useRef(0)
  const finalTimerRef = useRef(0)
  const arenaHostRef = useRef<HTMLDivElement>(null) // three.js canvas のホスト
  const rendererRef = useRef<ArenaRenderer | null>(null)
  const finalActiveRef = useRef(false) // rAF ループから読む finalActive のミラー
  const netRef = useRef<BattleNet | null>(null)

  function flashFinal() {
    setFinalActive(true)
    finalActiveRef.current = true
    window.clearTimeout(finalTimerRef.current)
    finalTimerRef.current = window.setTimeout(() => {
      setFinalActive(false)
      finalActiveRef.current = false
    }, 1300)
  }

  // WebSocket 接続。シミュレーションは権威サーバー側で回っているので、
  // ここは「自分の入力を送る」「受け取った状態を描く」だけ（→ 4人/2PC で共有）。
  useEffect(() => {
    const net = connectBattle({
      riderId: routine.riderId,
      riderName: routine.riderName,
      onStatus: setStatus,
      onState: (state, youId) => {
        youIdRef.current = youId
        const prev = battleRef.current
        // isSelf は端末ごとに違う（youId と一致する人が自分）。ここで付け直す。
        const players = state.players.map((p) => ({ ...p, isSelf: p.id === youId }))
        const next: BattleState = { ...state, players }
        // 誰か（自分/相手）が新たにファイナルベントへ入った瞬間に演出を焚く。
        const wasFinal = new Set(
          prev.players.filter((p) => p.action === 'final').map((p) => p.id),
        )
        if (players.some((p) => p.action === 'final' && !wasFinal.has(p.id))) flashFinal()
        battleRef.current = next
        setBattle(next)
      },
    })
    netRef.current = net

    // キーボード（＝センサーのダミー入力）→ サーバーへ送信。
    const source = createKeyboardSource((input) => {
      switch (input.kind) {
        case 'move':
          net.sendMove(input.dir)
          break
        case 'jump':
          net.sendJump()
          break
        case 'punch':
          net.sendAttack('punch')
          break
        case 'kick':
          net.sendAttack('kick')
          break
        case 'final-vent':
          net.sendAttack('final')
          break
      }
    })
    source.start()

    return () => {
      source.stop()
      net.close()
      netRef.current = null
      window.clearTimeout(finalTimerRef.current)
    }
  }, [routine])

  // 描画ループ: 受信済みの最新状態をそのまま three.js に流すだけ（更新はサーバー側）。
  useEffect(() => {
    const loop = () => {
      rendererRef.current?.render(battleRef.current, finalActiveRef.current)
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  // three.js レンダラの初期化。SSR を避けるため three は動的 import（クライアント専用）。
  useEffect(() => {
    let disposed = false
    let renderer: ArenaRenderer | null = null
    import('../battle/arena3d').then(({ createArenaRenderer }) => {
      if (disposed || !arenaHostRef.current) return
      renderer = createArenaRenderer(arenaHostRef.current)
      rendererRef.current = renderer
      renderer.render(battleRef.current, finalActiveRef.current)
    })
    return () => {
      disposed = true
      renderer?.dispose()
      rendererRef.current = null
    }
  }, [])

  // 「もう一度」: サーバーへリセットを依頼（全員の画面がリセットされる）。
  function handleReset() {
    netRef.current?.sendReset()
    setFinalActive(false)
  }

  // カードクリックをダミー入力として扱う（マウスでも技を出せる）。
  function handleCard(card: BattleCard) {
    if (card.kind === 'final') netRef.current?.sendAttack('final')
    else if (card.kind === 'attack') netRef.current?.sendAttack('punch')
  }

  const self = battle.players.find((p) => p.id === youIdRef.current) ?? null
  const winner = battle.winnerId ? battle.players.find((p) => p.id === battle.winnerId) ?? null : null

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
      {/* ヘッダー */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <Link to="/" style={{ color: '#9ca3af', textDecoration: 'none', fontSize: '0.9rem' }}>
          ← Back
        </Link>
        <h1 style={{ margin: 0, fontSize: '1.3rem' }}>バトル</h1>
        <span style={{ color: '#a78bfa', fontWeight: 'bold' }}>あなた: {routine.riderName}</span>

        {/* 接続状態 ＋ 参加人数（プレイヤーは WebSocket 経由で動的に増減する） */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.7rem' }}>
          <span style={{ fontSize: '0.85rem', color: '#9ca3af' }}>参加 {battle.players.length}人</span>
          <ConnBadge status={status} />
        </div>
      </div>

      {/* HP バー（スマブラ風・全プレイヤー） */}
      <HpBars players={battle.players} />

      {/* 相手待ち / 切断のヒント */}
      {status === 'open' && battle.players.length < 2 && !winner && <WaitingHint />}
      {status !== 'open' && <DisconnectedHint status={status} />}

      {/* ステージ（three.js の 3D シーン。canvas はこの div に挿入される） */}
      <div
        ref={arenaHostRef}
        style={{
          position: 'relative',
          flex: 1,
          minHeight: '340px',
          borderRadius: '12px',
          overflow: 'hidden',
          background: '#0b1220',
        }}
      />

      {/* 下段: カードトレイ ＋ 操作ヘルプ */}
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <CardTray cards={cards} disabled={!!winner || (self?.hp ?? 0) <= 0} onCard={handleCard} />
        <ControlsHelp />
      </div>

      {/* 右下カメラ（ファイナルベント用。CLAUDE.md: 常時表示） */}
      <FinalVentCam highlight={finalActive} />

      {/* ファイナルベント演出 */}
      {finalActive && <FinalVentBanner />}

      {/* 決着オーバーレイ */}
      {winner && <WinnerOverlay winner={winner} onReset={handleReset} />}
    </div>
  )
}

// ---- 接続状態バッジ / ヒント ---------------------------------------------

function ConnBadge({ status }: { status: NetStatus }) {
  const map = {
    connecting: { label: '接続中…', color: '#fbbf24' },
    open: { label: 'オンライン', color: '#34d399' },
    closed: { label: '切断', color: '#f87171' },
  } as const
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

function WaitingHint() {
  return (
    <div
      style={{
        fontSize: '0.85rem',
        color: '#9ca3af',
        background: '#0f172a',
        border: '1px dashed #334155',
        borderRadius: '8px',
        padding: '0.5rem 0.8rem',
      }}
    >
      相手を待っています… 別の PC・タブから <strong>/battle</strong> を開くと参戦できます。
    </div>
  )
}

function DisconnectedHint({ status }: { status: NetStatus }) {
  return (
    <div
      style={{
        fontSize: '0.85rem',
        color: '#fca5a5',
        background: '#1f0a0a',
        border: '1px solid #7f1d1d',
        borderRadius: '8px',
        padding: '0.5rem 0.8rem',
      }}
    >
      {status === 'connecting'
        ? 'サーバーへ接続中… （起動していない場合は `pnpm server` を実行）'
        : 'サーバーから切断されました。再接続を試みています…'}
    </div>
  )
}

// ---- HP バー -------------------------------------------------------------

function HpBars({ players }: { players: PlayerState[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${players.length}, 1fr)`, gap: '0.9rem' }}>
      {players.map((p, i) => (
        <HpBar key={p.id} player={p} color={PLAYER_COLORS[i % PLAYER_COLORS.length]} index={i} />
      ))}
    </div>
  )
}

// 龍騎(PS) 風の格ゲー HP バー: 斜めのパララインバー＋黄→赤グラデ＋黒帯ネーム。
function HpBar({ player, color, index }: { player: PlayerState; color: string; index: number }) {
  const ratio = Math.max(0, player.hp / player.maxHp)
  const pct = Math.round(ratio * 100)
  const dead = player.hp <= 0
  const low = !dead && ratio <= 0.3
  const slant = '10px' // バーの傾き量
  const bar = `polygon(${slant} 0, 100% 0, calc(100% - ${slant}) 100%, 0 100%)`

  return (
    <div style={{ opacity: dead ? 0.5 : 1, transition: 'opacity 0.3s', minWidth: 0 }}>
      {/* ネーム黒帯 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          width: 'fit-content',
          maxWidth: '100%',
          transform: 'skewX(-16deg)',
          background: 'linear-gradient(180deg, #1a1a1a, #000)',
          border: `1px solid ${player.isSelf ? color : '#4b5563'}`,
          borderBottom: `2px solid ${color}`,
          padding: '2px 12px 2px 8px',
          marginBottom: '3px',
          boxShadow: player.isSelf ? `0 0 8px ${color}88` : 'none',
        }}
      >
        <span
          style={{
            transform: 'skewX(16deg)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              fontSize: '0.62rem',
              fontWeight: 900,
              color: '#000',
              background: color,
              borderRadius: '3px',
              padding: '0 5px',
              lineHeight: 1.5,
            }}
          >
            {player.isSelf ? 'あなた' : `${index + 1}P`}
          </span>
          <span
            style={{
              fontSize: '0.9rem',
              fontWeight: 900,
              letterSpacing: '0.06em',
              textShadow: '0 1px 2px #000',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {player.riderName}
          </span>
        </span>
      </div>

      {/* バー本体（斜めフレーム） */}
      <div
        style={{
          position: 'relative',
          height: '24px',
          clipPath: bar,
          background: 'linear-gradient(180deg, #9ca3af, #1f2937 55%, #000)', // メタルフレーム
          padding: '3px',
        }}
      >
        {/* 内側トラック（減った部分の下地） */}
        <div style={{ position: 'absolute', inset: '3px', background: '#2b0a0a' }} />
        {/* HP 本体（黄→オレンジ→赤グラデ、左詰めで減る） */}
        <div
          style={{
            position: 'absolute',
            top: '3px',
            bottom: '3px',
            left: '3px',
            width: `calc(${pct}% - 6px)`,
            minWidth: dead ? '0' : '2px',
            background: low
              ? 'linear-gradient(180deg, #ff6b3d, #b91c1c)'
              : 'linear-gradient(180deg, #fff27a 0%, #ffd21e 25%, #ff8a00 60%, #ff2d00 100%)',
            boxShadow: low ? 'none' : 'inset 0 -3px 4px rgba(0,0,0,0.4), 0 0 6px rgba(255,160,0,0.5)',
            animation: low ? 'hpLowPulse 0.6s ease-in-out infinite' : undefined,
            transition: 'width 0.25s ease',
          }}
        />
        {/* メーターのセグメント目盛り（上に薄い縦線を重ねる） */}
        <div
          style={{
            position: 'absolute',
            inset: '3px',
            backgroundImage:
              'repeating-linear-gradient(90deg, transparent 0 13px, rgba(0,0,0,0.45) 13px 15px)',
            pointerEvents: 'none',
          }}
        />
        {/* 上端ハイライト */}
        <div
          style={{
            position: 'absolute',
            top: '3px',
            left: '3px',
            right: '3px',
            height: '5px',
            background: 'linear-gradient(180deg, rgba(255,255,255,0.55), transparent)',
            pointerEvents: 'none',
          }}
        />
        {/* KO 表示 */}
        {dead && (
          <span
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.75rem',
              fontWeight: 900,
              color: '#ef4444',
              letterSpacing: '0.15em',
            }}
          >
            K.O.
          </span>
        )}
      </div>
    </div>
  )
}


// ---- カードトレイ --------------------------------------------------------

function CardTray({
  cards,
  disabled,
  onCard,
}: {
  cards: BattleCard[]
  disabled: boolean
  onCard: (card: BattleCard) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
      <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>カード</span>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        {cards.map((c) => {
          const isFinal = c.kind === 'final'
          return (
            <button
              key={c.id}
              type="button"
              disabled={disabled}
              onClick={() => onCard(c)}
              style={{
                width: '78px',
                height: '104px',
                borderRadius: '8px',
                border: `2px solid ${c.color}`,
                background: `linear-gradient(160deg, ${c.color}22, #0f172a)`,
                color: '#fff',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.4 : 1,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                padding: '0.4rem',
                fontSize: '0.7rem',
                textAlign: 'left',
                animation: isFinal && !disabled ? 'none' : undefined,
                boxShadow: isFinal ? `0 0 12px ${c.color}66` : 'none',
              }}
            >
              <span style={{ color: c.color, fontWeight: 'bold', fontSize: '0.6rem' }}>
                {c.kind.toUpperCase()}
              </span>
              <span style={{ fontWeight: 'bold', lineHeight: 1.2 }}>{c.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ---- 操作ヘルプ ----------------------------------------------------------

function ControlsHelp() {
  const rows: [string, string][] = [
    ['← → / A D', '移動'],
    ['W / ↑ / Space', 'ジャンプ'],
    ['J', 'パンチ'],
    ['K', 'キック'],
    ['L / F', 'ファイナルベント'],
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
      <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>操作（キーボード = センサーのダミー入力）</span>
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        {rows.map(([k, v]) => (
          <span key={k} style={{ fontSize: '0.8rem', color: '#cbd5e1' }}>
            <kbd
              style={{
                background: '#374151',
                borderRadius: '4px',
                padding: '1px 6px',
                fontFamily: 'monospace',
                marginRight: '4px',
              }}
            >
              {k}
            </kbd>
            {v}
          </span>
        ))}
      </div>
    </div>
  )
}

// ---- 右下カメラ（ファイナルベント用） ------------------------------------

function FinalVentCam({ highlight }: { highlight: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [state, setState] = useState<'idle' | 'on' | 'error'>('idle')

  async function enable() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setState('on')
    } catch {
      setState('error')
    }
  }

  useEffect(() => {
    enable()
    const video = videoRef.current
    return () => {
      const s = video?.srcObject as MediaStream | null
      s?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  return (
    <div
      style={{
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        width: '180px',
        aspectRatio: '4/3',
        borderRadius: '10px',
        overflow: 'hidden',
        background: '#000',
        border: highlight ? '3px solid #a78bfa' : '2px solid #334155',
        boxShadow: highlight ? '0 0 20px #a78bfa' : '0 4px 12px rgba(0,0,0,0.4)',
        transition: 'border 0.2s, box-shadow 0.2s',
        zIndex: 50,
      }}
    >
      <video
        ref={videoRef}
        playsInline
        muted
        style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }}
      />
      <span
        style={{
          position: 'absolute',
          left: '6px',
          top: '4px',
          fontSize: '0.65rem',
          color: '#fff',
          background: 'rgba(0,0,0,0.5)',
          padding: '1px 6px',
          borderRadius: '4px',
        }}
      >
        FINAL VENT CAM
      </span>
      {state !== 'on' && (
        <button
          type="button"
          onClick={enable}
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            color: '#9ca3af',
            border: 'none',
            cursor: 'pointer',
            fontSize: '0.75rem',
          }}
        >
          {state === 'error' ? 'カメラを許可 →' : 'カメラ起動中…'}
        </button>
      )}
    </div>
  )
}

// ---- 演出オーバーレイ ----------------------------------------------------

function FinalVentBanner() {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        zIndex: 40,
      }}
    >
      <span
        style={{
          fontSize: '3rem',
          fontWeight: 900,
          color: '#fff',
          textShadow: '0 0 20px #a78bfa, 0 0 40px #a78bfa',
          letterSpacing: '0.1em',
        }}
      >
        FINAL VENT !!
      </span>
    </div>
  )
}

function WinnerOverlay({ winner, onReset }: { winner: PlayerState; onReset: () => void }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1.5rem',
        zIndex: 60,
      }}
    >
      <span style={{ fontSize: '2.5rem', fontWeight: 900, color: '#4ade80' }}>
        WINNER: {winner.isSelf ? 'あなた' : winner.riderName}
      </span>
      <button
        type="button"
        onClick={onReset}
        style={{
          padding: '0.7rem 2.5rem',
          fontSize: '1.1rem',
          background: '#a78bfa',
          color: '#000',
          border: 'none',
          borderRadius: '8px',
          cursor: 'pointer',
          fontWeight: 'bold',
        }}
      >
        🔄 もう一度
      </button>
    </div>
  )
}
