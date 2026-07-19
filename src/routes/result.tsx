import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'

import { playWinBgm } from '../battle/bgm'
import { WEBWORLD_SKY, WebWorldBackdrop } from '../webworld-backdrop'
import type { WinnerPresenter } from '../battle/winner3d'

// 勝者（リザルト）ページ。バトルロワイヤルの決着後シーン。
//   - 勝者は画面中央に大きく（王冠＋後光＋月桂樹の「1」＋巨大な名前）
//   - 敗者は death モーションで倒れたまま周囲に散らばる（暗め・低彩度）
//   - 背景はバトルと同じ「Webワールド（電脳空間）」: 星ノイズ・コード片・遠近グリッドの床
//
// バトル画面（/battle）は決着を検知すると、全順位を players（1位→最下位）に載せて遷移してくる。
// WebSocket 接続はバトル画面の unmount で閉じるので、この画面は受け取った順位を描くだけ。
//   players[i] = { name, mine(この端末のプレイヤーか), color(表示色), p(プレイヤー番号=◯P) }
//   rider      = この端末が使っていたライダー id（「もう一度」で /battle に持ち帰る）
interface RankEntry {
  name: string
  riderId: string // 3D 立ち絵の差し替え（GLB）に使うライダー id
  mine: boolean
  color: string
  p: number
}

export const Route = createFileRoute('/result')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { players: RankEntry[]; rider?: string; name?: string } => {
    const raw = Array.isArray(search.players) ? (search.players as unknown[]) : []
    const players: RankEntry[] = raw.map((e) => {
      const o = (e ?? {}) as Record<string, unknown>
      return {
        name: typeof o.name === 'string' && o.name ? o.name : 'Rider',
        riderId: typeof o.riderId === 'string' ? o.riderId : '',
        mine: o.mine === true || o.mine === 'true' || o.mine === 1 || o.mine === '1',
        color: typeof o.color === 'string' && o.color ? o.color : '#a78bfa',
        p: typeof o.p === 'number' ? o.p : Number(o.p) || 1,
      }
    })
    return {
      players,
      rider: typeof search.rider === 'string' ? search.rider : undefined,
      name: typeof search.name === 'string' ? search.name : undefined, // 再戦時に /battle へ持ち帰る表示名
    }
  },
  component: ResultPage,
})

// '#a78bfa' → 0xa78bfa（three.js 用に色文字列を数値へ）。
function hexToInt(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16)
  return Number.isNaN(n) ? 0xa78bfa : n
}

// 漂うコード片（Webワールドの空気づけ。リザルトの状況を模したスニペット）。
const CODE_FRAGMENTS: { text: string; top: string; left?: string; right?: string }[] = [
  { text: 'if (survivor) crown();', top: '16%', left: '4%' },
  { text: '</battle>', top: '28%', right: '5%' },
  { text: 'rank.sort((a, b) => a - b)', top: '52%', left: '2%' },
  { text: '0111 0111 0110 1001 0110 1110', top: '10%', right: '20%' },
  { text: 'GAME_SET = true;', top: '44%', right: '3%' },
  { text: 'respawn --lobby', top: '62%', right: '12%' },
]

// 順位バッジの色（1=金 / 2=銀 / 3=銅 / 以降=青）。数字テキストのメタリック塗り。
const RANK_METAL: Record<number, [string, string, string]> = {
  1: ['#fff6a8', '#ffd21e', '#b8860b'],
  2: ['#ffffff', '#cbd5e1', '#7c8aa0'],
  3: ['#ffcf9e', '#e08c3e', '#8a4b16'],
}
function metalOf(rank: number): [string, string, string] {
  return RANK_METAL[rank] ?? ['#bfe3ff', '#60a5fa', '#1e40af']
}

function ResultPage() {
  const { players, rider, name } = Route.useSearch()
  const winner = players[0] ?? null
  const losers = players.slice(1)

  // 勝利ジングル（win-bgm）。バトル画面が main BGM をフェードアウトさせてから遷移してくる。
  useEffect(() => playWinBgm(), [])

  // 想定外の直リンク等で順位が無いとき用のフォールバック。
  if (!winner) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1.5rem',
        }}
      >
        <span style={{ fontSize: '1.4rem', color: '#9ca3af' }}>リザルトがありません</span>
        <Link
          to="/battle"
          style={{ padding: '0.7rem 2rem', background: '#a78bfa', color: '#000', borderRadius: '8px', textDecoration: 'none', fontWeight: 'bold' }}
        >
          バトルへ →
        </Link>
      </div>
    )
  }

  return (
    <div
      style={{
        position: 'relative',
        minHeight: '100vh',
        overflow: 'hidden',
        color: '#fff',
        // Webワールド（電脳空間）の空。バトル画面（arena3d の backdrop）と同じ世界観。
        background: WEBWORLD_SKY,
      }}
    >
      {/* Webワールドの背景一式（星・コードレイン・地球・ブラウザ窓・グリッド床） */}
      <WebWorldBackdrop fragments={CODE_FRAGMENTS} />

      {/* 敗者たち（バトルロワイヤルの戦場跡: death モーションで倒れたまま周囲に散らばる）。
          勝者より奥（zIndex 0）・暗め・彩度低めで「決着後」の空気を出す。 */}
      {losers.map((pl, i) => {
        const spot = FALLEN_SPOTS[i % FALLEN_SPOTS.length]
        return (
          <div
            key={`${pl.p}-${i}`}
            style={{
              position: 'absolute',
              ...spot.style,
              zIndex: 0,
              animation: `fallenIn 0.7s ease-out ${0.35 + i * 0.15}s both`,
            }}
          >
            <FallenStandee entry={pl} rank={i + 2} facingDeg={spot.facingDeg} />
          </div>
        )
      })}

      {/* 勝者（画面中央・大きく。王冠＋後光つき）。
          センタリングは margin auto（winnerPop が transform を上書きするため translateX は使えない） */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          marginInline: 'auto',
          bottom: 0,
          width: 'clamp(260px, 34vw, 480px)',
          height: 'clamp(360px, 66vh, 640px)',
          zIndex: 1,
          animation: 'winnerPop 0.6s cubic-bezier(0.2, 0.9, 0.3, 1.2) both',
        }}
      >
        <WinnerStandee entry={winner} />
      </div>

      {/* 1位クラスタ（上部中央: 月桂樹の1 ＋ ペナント ＋ 巨大な勝者名）。
          センタリングは margin auto（winnerPop が transform を上書きするため） */}
      <div
        style={{
          position: 'absolute',
          top: 'clamp(1rem, 4vh, 2.5rem)',
          left: 0,
          right: 0,
          marginInline: 'auto',
          width: 'min(92%, 900px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '0.3rem',
          zIndex: 2,
          textAlign: 'center',
          animation: 'winnerPop 0.55s cubic-bezier(0.2, 0.9, 0.3, 1.2) both',
          pointerEvents: 'none',
        }}
      >
        {/* Pペナント ＋ 月桂樹の「1」 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem' }}>
          <Pennant p={winner.p} />
          <LaurelRank rank={1} />
        </div>

        {/* 巨大な勝者名 */}
        <span
          style={{
            fontSize: 'clamp(2.4rem, 9vw, 6.5rem)',
            fontWeight: 900,
            fontStyle: 'italic',
            letterSpacing: '-0.01em',
            lineHeight: 0.95,
            color: '#1a1a1a',
            WebkitTextStroke: '2px #fff',
            textShadow: '5px 6px 0 rgba(0,0,0,0.25)',
            transform: 'skewX(-6deg)',
            textTransform: 'uppercase',
            wordBreak: 'break-word',
          }}
        >
          {winner.name}
        </span>
        <span
          style={{
            fontSize: 'clamp(0.8rem, 1.8vw, 1rem)',
            fontWeight: 800,
            letterSpacing: '0.25em',
            color: 'rgba(255,255,255,0.85)',
            textShadow: '0 1px 4px rgba(0,0,0,0.5)',
          }}
        >
          — BATTLE ROYALE SURVIVOR —
        </span>
        {winner.mine && (
          <span
            style={{
              marginTop: '0.2rem',
              fontSize: 'clamp(1rem, 2.6vw, 1.4rem)',
              fontWeight: 800,
              color: '#166534',
              background: '#bbf7d0',
              padding: '2px 14px',
              borderRadius: '999px',
              transform: 'skewX(-6deg)',
            }}
          >
            🎉 あなたの勝利！
          </span>
        )}
      </div>

      {/* 操作（右下・控えめ） */}
      <div
        style={{
          position: 'absolute',
          right: 'clamp(1rem, 3vw, 2.5rem)',
          bottom: 'clamp(1rem, 4vh, 2.5rem)',
          display: 'flex',
          gap: '0.7rem',
          zIndex: 2,
        }}
      >
        <Link
          to="/battle"
          search={rider ? { rider, name } : {}}
          style={{
            padding: '0.65rem 1.8rem',
            background: '#a78bfa',
            color: '#000',
            textDecoration: 'none',
            borderRadius: '8px',
            fontSize: '1rem',
            fontWeight: 'bold',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          }}
        >
          🔄 もう一度
        </Link>
        <Link
          to="/"
          style={{
            padding: '0.65rem 1.6rem',
            background: 'rgba(0,0,0,0.35)',
            color: '#fff',
            textDecoration: 'none',
            borderRadius: '8px',
            fontSize: '1rem',
            fontWeight: 'bold',
            border: '1px solid rgba(255,255,255,0.35)',
          }}
        >
          ホーム
        </Link>
      </div>
    </div>
  )
}

// 赤いPペナント（1P / 2P …）。右がとがった旗の形。
function Pennant({ p }: { p: number }) {
  return (
    <span
      style={{
        display: 'inline-block',
        background: 'linear-gradient(180deg, #f2453b, #c81e14)',
        color: '#fff',
        fontWeight: 900,
        fontStyle: 'italic',
        fontSize: 'clamp(0.9rem, 2vw, 1.3rem)',
        padding: '3px 22px 3px 12px',
        clipPath: 'polygon(0 0, 84% 0, 100% 50%, 84% 100%, 0 100%)',
        boxShadow: '0 2px 4px rgba(0,0,0,0.4)',
        letterSpacing: '0.02em',
      }}
    >
      {p}P
    </span>
  )
}

// 月桂樹に囲まれた順位番号（1位のヘッダ用）。メタリックな数字＋左右の月桂樹。
function LaurelRank({ rank }: { rank: number }) {
  const [c0, c1, c2] = metalOf(rank)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.1rem', lineHeight: 1 }}>
      <span style={{ fontSize: 'clamp(1.8rem, 4.5vw, 3rem)', transform: 'scaleX(-1) rotate(8deg)', filter: 'saturate(0.6) brightness(0.9)' }}>
        🌿
      </span>
      <span
        style={{
          fontSize: 'clamp(2.6rem, 7vw, 5rem)',
          fontWeight: 900,
          fontStyle: 'italic',
          backgroundImage: `linear-gradient(180deg, ${c0} 0%, ${c1} 52%, ${c2} 100%)`,
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
          WebkitTextStroke: '1.5px rgba(60,40,0,0.55)',
          filter: 'drop-shadow(0 3px 3px rgba(0,0,0,0.4))',
          padding: '0 0.1em',
        }}
      >
        {rank}
      </span>
      <span style={{ fontSize: 'clamp(1.8rem, 4.5vw, 3rem)', transform: 'rotate(8deg)', filter: 'saturate(0.6) brightness(0.9)' }}>
        🌿
      </span>
    </span>
  )
}

// 敗者の配置スポット（散らばり方。順位 2位から順に使う）。
// 中央の勝者を避けて左右へ、手前/奥で大きさに変化をつける。facingDeg で倒れる向きも散らす。
const FALLEN_SPOTS: {
  style: React.CSSProperties
  facingDeg: number
}[] = [
  {
    style: { left: '4%', bottom: '1%', width: 'clamp(170px, 20vw, 280px)', height: 'clamp(140px, 26vh, 240px)' },
    facingDeg: -35,
  },
  {
    style: { right: '4%', bottom: '2%', width: 'clamp(160px, 19vw, 260px)', height: 'clamp(130px, 24vh, 220px)' },
    facingDeg: 40,
  },
  {
    style: { left: '20%', bottom: '14%', width: 'clamp(120px, 14vw, 200px)', height: 'clamp(100px, 18vh, 170px)' },
    facingDeg: 75,
  },
  {
    style: { right: '20%', bottom: '15%', width: 'clamp(115px, 13vw, 190px)', height: 'clamp(95px, 17vh, 160px)' },
    facingDeg: -70,
  },
]

// 勝者の 3D 立ち絵（中央・王冠＋後光つき）。名前は上部中央のクラスタが出すのでここは絵だけ。
function WinnerStandee({ entry }: { entry: RankEntry }) {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let disposed = false
    let presenter: WinnerPresenter | null = null
    import('../battle/winner3d').then(({ createWinnerPresenter }) => {
      if (disposed || !hostRef.current) return
      presenter = createWinnerPresenter(hostRef.current, {
        riderId: entry.riderId,
        color: hexToInt(entry.color),
        // 勝利ポーズ: 必殺技クリップ（arduino は special）を一度再生して最終フレームで静止。
        // クリップ未収録のモデルは idle にフォールバックする（従来と同じ見た目）。
        action: 'final',
      })
    })
    return () => {
      disposed = true
      presenter?.dispose()
    }
  }, [entry.riderId, entry.color])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* 足元のスポットライト（電脳空間に立つ勝者を静かに照らす） */}
      <div
        style={{
          position: 'absolute',
          bottom: '-2%',
          left: '10%',
          right: '10%',
          height: '18%',
          background:
            'radial-gradient(ellipse at 50% 100%, rgba(56,189,248,0.35) 0%, rgba(167,139,250,0.18) 45%, transparent 75%)',
          pointerEvents: 'none',
        }}
      />
      {/* 3D キャンバスのホスト（背景透過なので CSS の電脳空間の上にキャラだけ乗る） */}
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      {/* 王冠（3D キャラの頭上あたり） */}
      <span
        style={{
          position: 'absolute',
          top: '3%',
          left: '50%',
          transform: 'translateX(-50%)',
          fontSize: '3.4rem',
          filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.5))',
          animation: 'winnerFloat 3.4s ease-in-out infinite',
          pointerEvents: 'none',
          zIndex: 1,
        }}
      >
        👑
      </span>
    </div>
  )
}

// 敗者の 3D 立ち絵（death モーションで倒れたまま）。暗め・低彩度で「戦いのあと」を出しつつ、
// 足元に順位チップ（メタリック数字＋名前＋P）を添える。
function FallenStandee({
  entry,
  rank,
  facingDeg,
}: {
  entry: RankEntry
  rank: number
  facingDeg: number
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let disposed = false
    let presenter: WinnerPresenter | null = null
    import('../battle/winner3d').then(({ createWinnerPresenter }) => {
      if (disposed || !hostRef.current) return
      presenter = createWinnerPresenter(hostRef.current, {
        riderId: entry.riderId,
        color: hexToInt(entry.color),
        action: 'down', // death クリップを一度再生して倒れたまま静止
        facingDeg,
      })
    })
    return () => {
      disposed = true
      presenter?.dispose()
    }
  }, [entry.riderId, entry.color, facingDeg])

  const [c0, c1, c2] = metalOf(rank)
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div
        ref={hostRef}
        style={{
          position: 'absolute',
          inset: 0,
          filter: 'brightness(0.72) saturate(0.7)', // 敗者は暗め・低彩度（勝者を引き立てる）
        }}
      />
      {/* 順位チップ */}
      <span
        style={{
          position: 'absolute',
          bottom: '-2px',
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.35rem',
          background: 'rgba(0,0,0,0.55)',
          border: '1px solid rgba(255,255,255,0.18)',
          borderRadius: '999px',
          padding: '2px 12px',
          whiteSpace: 'nowrap',
          maxWidth: '130%',
        }}
      >
        <span
          style={{
            fontSize: '1.05rem',
            fontWeight: 900,
            fontStyle: 'italic',
            backgroundImage: `linear-gradient(180deg, ${c0} 0%, ${c1} 52%, ${c2} 100%)`,
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
            WebkitTextStroke: '1px rgba(0,0,0,0.5)',
            lineHeight: 1,
          }}
        >
          {rank}
        </span>
        <span
          style={{
            fontSize: '0.72rem',
            fontWeight: 800,
            color: '#e5e7eb',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {entry.name}
        </span>
        <span
          style={{
            fontSize: '0.65rem',
            fontWeight: 900,
            fontStyle: 'italic',
            color: '#9ca3af',
          }}
        >
          {entry.p}P
        </span>
      </span>
    </div>
  )
}
