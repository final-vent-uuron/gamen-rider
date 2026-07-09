import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'

import { RIDER_ROUTINES } from '../pose'
import {
  ARENA,
  applyAttack,
  applyJump,
  applyThrow,
  battleCardsFor,
  connectBattle,
  createKeyboardSource,
  createSfx,
  stepBattle,
} from '../battle'
import type { BattleCard, BattleNet, BattleState, NetStatus, PlayerState, Sfx } from '../battle'
import type { ArenaRenderer } from '../battle/arena3d'

// 被弾ダメージの浮き数字。命中検出で追加し、一定時間で消す。
interface DamagePopup {
  key: number
  x: number // ステージ内の正規化 x（0..1）で位置を決める
  amount: number
  big: boolean
  blocked: boolean
}

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

// 予測の見た目: 自分の技/ガードはサーバーが追いつく前でも即表示。被弾中はサーバー優先。
function predAction(serverP: PlayerState, predP: PlayerState): PlayerState['action'] {
  if (serverP.action === 'hit' || serverP.action === 'thrown' || serverP.action === 'down') {
    return serverP.action
  }
  if (
    predP.action === 'punch' ||
    predP.action === 'kick' ||
    predP.action === 'throw' ||
    predP.action === 'final' ||
    predP.action === 'guard'
  ) {
    return predP.action
  }
  return serverP.action
}

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
  const [popups, setPopups] = useState<DamagePopup[]>([]) // 被弾ダメージ数字
  const [combo, setCombo] = useState<number | null>(null) // 進行中の最大コンボ数
  const [koFlash, setKoFlash] = useState(false) // KO の一瞬フラッシュ

  const battleRef = useRef(battle)
  battleRef.current = battle
  const youIdRef = useRef('') // 自分のプレイヤー id（サーバーが welcome で通知）
  const rafRef = useRef(0)
  const finalTimerRef = useRef(0)
  const arenaHostRef = useRef<HTMLDivElement>(null) // three.js canvas のホスト
  const rendererRef = useRef<ArenaRenderer | null>(null)
  const finalActiveRef = useRef(false) // rAF ループから読む finalActive のミラー
  const netRef = useRef<BattleNet | null>(null)
  const sfxRef = useRef<Sfx | null>(null) // 効果音（WebAudio 合成）
  const comboTimerRef = useRef(0)
  const popupKeyRef = useRef(0)

  // --- クライアント予測（自分のキャラだけ即応させてラグ感を消す）---
  // サーバー権威は維持しつつ、自分の移動/技を state.ts の同じ純粋関数でローカルにも回し、
  // 受信のたびに位置を軟着（補正）する。predRef は「自分1人だけ」の BattleState。
  const predRef = useRef<BattleState | null>(null)
  const moveDirRef = useRef<-1 | 0 | 1>(0) // 自分の移動入力
  const guardRef = useRef(false) // 自分のガード入力
  const lastPredTRef = useRef(0)

  function flashFinal() {
    setFinalActive(true)
    finalActiveRef.current = true
    window.clearTimeout(finalTimerRef.current)
    finalTimerRef.current = window.setTimeout(() => {
      setFinalActive(false)
      finalActiveRef.current = false
    }, 1300)
  }

  // 効果音（WebAudio 合成）を用意。実際の発音は最初のユーザー操作(resume)後。
  useEffect(() => {
    sfxRef.current = createSfx()
  }, [])

  // WebSocket 接続。シミュレーションは権威サーバー側で回っているので、
  // ここは「自分の入力を送る」「受け取った状態を描く」だけ（→ 4人/2PC で共有）。
  // 受信の差分から命中/ブロック/投げ/KO/コンボ/ゲージ満タンを検出し、演出を焚く。
  useEffect(() => {
    // 前フレーム → 今フレームの差分で「起きたこと」を演出に変換する。
    const processEvents = (prev: BattleState, next: BattleState, youId: string) => {
      const sfx = sfxRef.current
      const r = rendererRef.current
      let maxCombo = 0
      const fresh: DamagePopup[] = []
      const prevFinal = new Set(prev.players.filter((p) => p.action === 'final').map((p) => p.id))
      let newFinal = false

      for (const np of next.players) {
        if (np.comboCount > maxCombo) maxCombo = np.comboCount
        if (np.action === 'final' && !prevFinal.has(np.id)) newFinal = true
        const pp = prev.players.find((p) => p.id === np.id)
        if (!pp) continue
        const dmg = pp.hp - np.hp
        const thrown = np.action === 'thrown' && pp.action !== 'thrown'
        const ko = pp.hp > 0 && np.hp <= 0
        if (dmg > 0) {
          const blocked = np.action === 'guard' && dmg <= 2
          if (blocked) {
            sfx?.block()
            r?.hitSpark(np.x, np.y, 0x7fdfff, false)
            r?.shake(0.06)
          } else {
            const big = dmg >= 9 || thrown || ko
            if (!ko) {
              if (thrown) sfx?.grab()
              else sfx?.hit(Math.min(1, dmg / 20))
            }
            r?.hitSpark(np.x, np.y, thrown ? 0xffb020 : 0xffe08a, big)
            r?.shake(Math.min(0.7, 0.08 + dmg * 0.02))
            if (big) r?.punch(0.9)
          }
          fresh.push({
            key: popupKeyRef.current++,
            x: np.x,
            amount: dmg,
            big: dmg >= 9 || thrown,
            blocked,
          })
        }
        if (ko) {
          sfx?.ko()
          r?.shake(0.85)
          r?.punch(1.6)
          setKoFlash(true)
          window.setTimeout(() => setKoFlash(false), 260)
        }
        if (np.id === youId && pp.meter < ARENA.meterMax && np.meter >= ARENA.meterMax) {
          sfx?.meterFull()
        }
      }

      if (newFinal) flashFinal()
      if (fresh.length) {
        setPopups((ps) => [...ps, ...fresh])
        for (const pu of fresh) {
          window.setTimeout(() => setPopups((ps) => ps.filter((x) => x.key !== pu.key)), 850)
        }
      }
      if (maxCombo >= 2) {
        setCombo(maxCombo)
        window.clearTimeout(comboTimerRef.current)
        comboTimerRef.current = window.setTimeout(() => setCombo(null), 950)
      }
    }

    // サーバー受信で自分の予測状態を補正する（権威はサーバー、位置は軟着）。
    const reconcilePrediction = (next: BattleState, youId: string) => {
      const serverSelf = next.players.find((p) => p.id === youId)
      if (!serverSelf) {
        predRef.current = null
        return
      }
      const now = Date.now()
      const pred = predRef.current?.players[0]
      if (!pred || pred.id !== serverSelf.id) {
        predRef.current = { players: [{ ...serverSelf }], winnerId: null }
        return
      }
      const merged: PlayerState = { ...serverSelf } // 権威フィールド(hp/meter/timer等)はサーバー採用
      const constrained =
        serverSelf.action === 'hit' ||
        serverSelf.action === 'thrown' ||
        serverSelf.action === 'down' ||
        now < serverSelf.stunUntil ||
        now < serverSelf.freezeUntil
      const err = Math.abs(serverSelf.x - pred.x) + Math.abs(serverSelf.y - pred.y)
      if (!constrained && err < 0.08) {
        // 自由移動中は予測位置を維持して軽く寄せる（入力が即反映されて見える）
        merged.x = pred.x + (serverSelf.x - pred.x) * 0.25
        merged.y = pred.y
        merged.vx = pred.vx
        merged.vy = pred.vy
        merged.facing = pred.facing
      }
      predRef.current = { players: [merged], winnerId: null }
    }

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
        processEvents(prev, next, youId)
        reconcilePrediction(next, youId)
        battleRef.current = next
        setBattle(next)
      },
    })
    netRef.current = net

    // キーボード（＝センサーのダミー入力）→ サーバーへ送信。
    // 攻撃には即時フィードバックの風切り音を鳴らす（往復遅延を体感で吸収）。
    // ローカル予測に自分の操作を即反映するヘルパ（predRef は自分1人だけの状態）。
    const applyPred = (fn: (s: BattleState) => BattleState) => {
      if (predRef.current && youIdRef.current) predRef.current = fn(predRef.current)
    }
    const source = createKeyboardSource((input) => {
      sfxRef.current?.resume()
      const now = Date.now()
      const selfId = youIdRef.current
      switch (input.kind) {
        case 'move':
          moveDirRef.current = input.dir
          net.sendMove(input.dir)
          break
        case 'jump':
          net.sendJump()
          applyPred((s) => applyJump(s, selfId, now))
          break
        case 'punch':
          net.sendAttack('punch')
          applyPred((s) => applyAttack(s, selfId, 'punch', now))
          sfxRef.current?.whiff()
          break
        case 'kick':
          net.sendAttack('kick')
          applyPred((s) => applyAttack(s, selfId, 'kick', now))
          sfxRef.current?.whiff()
          break
        case 'guard':
          guardRef.current = input.on
          net.sendGuard(input.on)
          break
        case 'throw':
          net.sendThrow()
          applyPred((s) => applyThrow(s, selfId, now))
          sfxRef.current?.whiff()
          break
        case 'final-vent':
          net.sendAttack('final')
          applyPred((s) => applyAttack(s, selfId, 'final', now))
          break
      }
    })
    source.start()

    return () => {
      source.stop()
      net.close()
      netRef.current = null
      window.clearTimeout(finalTimerRef.current)
      window.clearTimeout(comboTimerRef.current)
    }
  }, [routine])

  // 描画ループ: サーバー状態を土台に、自分だけローカル予測で先行させて描く（ラグ感を消す）。
  useEffect(() => {
    const loop = () => {
      const server = battleRef.current
      let renderState = server
      const selfId = youIdRef.current
      const pred = predRef.current
      if (pred && selfId && !server.winnerId && server.players.some((p) => p.id === selfId)) {
        // 自分を同じ純粋関数(stepBattle)で毎フレーム前進させ、位置/技を即反映。
        const now = Date.now()
        const dt = lastPredTRef.current ? now - lastPredTRef.current : 0
        lastPredTRef.current = now
        const advanced = stepBattle(
          pred,
          dt,
          now,
          { [selfId]: moveDirRef.current },
          { [selfId]: guardRef.current },
        )
        predRef.current = advanced
        const ps = advanced.players[0]
        if (ps) {
          renderState = {
            ...server,
            players: server.players.map((p) =>
              p.id === selfId
                ? {
                    ...p,
                    x: ps.x,
                    y: ps.y,
                    vx: ps.vx,
                    vy: ps.vy,
                    facing: ps.facing,
                    action: predAction(p, ps),
                  }
                : p,
            ),
          }
        }
      } else {
        lastPredTRef.current = 0
      }
      rendererRef.current?.render(renderState, finalActiveRef.current)
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
    setPopups([])
    setCombo(null)
    setKoFlash(false)
  }

  // カードクリックをダミー入力として扱う（マウスでも技を出せる）。
  function handleCard(card: BattleCard) {
    sfxRef.current?.resume()
    if (card.kind === 'final') netRef.current?.sendAttack('final')
    else if (card.kind === 'attack') {
      netRef.current?.sendAttack('punch')
      sfxRef.current?.whiff()
    }
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

      {/* ステージ（three.js の 3D シーン ＋ 演出オーバーレイ） */}
      <div
        style={{
          position: 'relative',
          flex: 1,
          minHeight: '340px',
          borderRadius: '12px',
          overflow: 'hidden',
          background: '#0b1220',
        }}
      >
        {/* three canvas はこの div にだけ挿入する（React 子要素と混ぜない） */}
        <div ref={arenaHostRef} style={{ position: 'absolute', inset: 0 }} />
        {/* ダメージ数字・コンボ表示（描画に干渉しない透明レイヤ） */}
        <StageOverlay popups={popups} combo={combo} />
        {/* KO の一瞬フラッシュ */}
        {koFlash && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'radial-gradient(circle, rgba(255,255,255,0.85), rgba(255,255,255,0))',
              pointerEvents: 'none',
            }}
          />
        )}
      </div>

      {/* 下段: カードトレイ ＋ 操作ヘルプ */}
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <CardTray
          cards={cards}
          disabled={!!winner || (self?.hp ?? 0) <= 0}
          finalReady={(self?.meter ?? 0) >= ARENA.meterMax}
          onCard={handleCard}
        />
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

      {/* 逆転ゲージ（満タンで Final Vent 解禁） */}
      <MeterBar meter={player.meter} color={color} />
    </div>
  )
}

// 逆転ゲージのバー。満タンで発光・脈動する。
function MeterBar({ meter, color }: { meter: number; color: string }) {
  const ratio = Math.max(0, Math.min(1, meter / ARENA.meterMax))
  const full = ratio >= 1
  return (
    <div
      style={{
        marginTop: '3px',
        height: '6px',
        background: '#111827',
        borderRadius: '3px',
        overflow: 'hidden',
        border: '1px solid #1f2937',
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${ratio * 100}%`,
          background: full
            ? 'linear-gradient(90deg, #a855f7, #38bdf8)'
            : `linear-gradient(90deg, ${color}, #a855f7)`,
          boxShadow: full ? '0 0 8px #a855f7' : 'none',
          animation: full ? 'meterReady 0.7s ease-in-out infinite' : undefined,
          transition: 'width 0.2s ease',
        }}
      />
    </div>
  )
}

// ---- ステージ演出オーバーレイ（コンボ / ダメージ数字） -------------------

function StageOverlay({ popups, combo }: { popups: DamagePopup[]; combo: number | null }) {
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      {/* コンボカウンタ（中央上） */}
      {combo != null && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '13%',
            transform: 'translateX(-50%)',
            animation: 'comboPop 0.25s ease-out',
            textShadow: '0 2px 8px #000',
            whiteSpace: 'nowrap',
          }}
        >
          <span
            style={{ fontSize: '2.6rem', fontWeight: 900, color: '#ffd21e', fontStyle: 'italic' }}
          >
            {combo}
          </span>
          <span style={{ fontSize: '1rem', fontWeight: 900, color: '#fff', marginLeft: '5px' }}>
            HITS
          </span>
        </div>
      )}
      {/* 被弾ダメージ数字（被弾者の位置に浮かせる） */}
      {popups.map((p) => (
        <span
          key={p.key}
          style={{
            position: 'absolute',
            left: `${p.x * 100}%`,
            top: '38%',
            animation: 'dmgRise 0.85s ease-out forwards',
            fontWeight: 900,
            fontStyle: 'italic',
            fontSize: p.big ? '2rem' : '1.4rem',
            color: p.blocked ? '#7fdfff' : p.big ? '#ff5a3c' : '#ffe08a',
            textShadow: '0 2px 6px #000',
            whiteSpace: 'nowrap',
          }}
        >
          {p.blocked ? 'GUARD' : p.amount}
        </span>
      ))}
    </div>
  )
}

// ---- カードトレイ --------------------------------------------------------

function CardTray({
  cards,
  disabled,
  finalReady,
  onCard,
}: {
  cards: BattleCard[]
  disabled: boolean
  finalReady: boolean // Final はゲージ満タンでのみ押せる
  onCard: (card: BattleCard) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
      <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>カード</span>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        {cards.map((c) => {
          const isFinal = c.kind === 'final'
          const cardDisabled = disabled || (isFinal && !finalReady)
          const ready = isFinal && finalReady && !disabled
          return (
            <button
              key={c.id}
              type="button"
              disabled={cardDisabled}
              onClick={() => onCard(c)}
              style={{
                width: '78px',
                height: '104px',
                borderRadius: '8px',
                border: `2px solid ${c.color}`,
                background: `linear-gradient(160deg, ${c.color}22, #0f172a)`,
                color: '#fff',
                cursor: cardDisabled ? 'not-allowed' : 'pointer',
                opacity: cardDisabled ? 0.4 : 1,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                padding: '0.4rem',
                fontSize: '0.7rem',
                textAlign: 'left',
                animation: ready ? 'meterReady 0.7s ease-in-out infinite' : undefined,
                boxShadow: ready ? `0 0 16px ${c.color}` : isFinal ? `0 0 12px ${c.color}66` : 'none',
              }}
            >
              <span style={{ color: c.color, fontWeight: 'bold', fontSize: '0.6rem' }}>
                {c.kind.toUpperCase()}
              </span>
              <span style={{ fontWeight: 'bold', lineHeight: 1.2 }}>{c.label}</span>
              {isFinal && !finalReady && (
                <span style={{ color: '#9ca3af', fontSize: '0.55rem' }}>ゲージ必要</span>
              )}
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
    ['J', 'パンチ(軽・発生早)'],
    ['K', 'キック(重・主力)'],
    ['Shift / S / ↓', 'ガード(押しっぱ)'],
    ['U', '投げ(ガード崩し)'],
    ['L / F', 'ファイナル(ゲージ満タン)'],
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
      <span style={{ fontSize: '0.75rem', color: '#fbbf24' }}>
        コンボ: 当てた技を<strong>ヒット中にキャンセル</strong>して次へ → 例) パンチ→キック→ファイナル
      </span>
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
