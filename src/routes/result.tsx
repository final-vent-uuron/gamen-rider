import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useRef } from 'react'

import type { WinnerPresenter } from '../battle/winner3d'

// 勝者（リザルト）ページ。スマブラのリザルト画面イメージ。
//   - 1位を巨大に見せる（月桂樹の「1」＋ Pペナント ＋ 巨大な名前 ＋ 立ち絵プレースホルダ）
//   - 2位以降は左下に斜めの小カード（順位バッジ＋ポートレート＋Pタグ）
//   - 背景はステージ風の夕景
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
  ): { players: RankEntry[]; rider?: string } => {
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
    return { players, rider: typeof search.rider === 'string' ? search.rider : undefined }
  },
  component: ResultPage,
})

// '#a78bfa' → 0xa78bfa（three.js 用に色文字列を数値へ）。
function hexToInt(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16)
  return Number.isNaN(n) ? 0xa78bfa : n
}

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
  const { players, rider } = Route.useSearch()
  const winner = players[0] ?? null
  const losers = players.slice(1)

  // 勝者の 3D 立ち絵。three は動的 import（クライアント専用・SSR 回避）でマウントする。
  // arena3d と同じアバター抽象なので、RIDER_MODELS に GLB を足せばここも自動で 3D モデルに。
  const stageHostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!winner) return
    let disposed = false
    let presenter: WinnerPresenter | null = null
    import('../battle/winner3d').then(({ createWinnerPresenter }) => {
      if (disposed || !stageHostRef.current) return
      presenter = createWinnerPresenter(stageHostRef.current, {
        riderId: winner.riderId,
        color: hexToInt(winner.color),
        action: 'idle',
      })
    })
    return () => {
      disposed = true
      presenter?.dispose()
    }
  }, [winner?.riderId, winner?.color])

  // 紙吹雪の見た目はマウント時に一度だけ確定させる（毎レンダーで飛ばないように）。
  const confetti = useMemo(
    () =>
      Array.from({ length: 20 }).map((_, i) => ({
        key: i,
        left: Math.round(Math.random() * 100),
        color: ['#ffd21e', '#f87171', '#34d399', '#38bdf8', '#f472b6'][i % 5],
        delay: Math.random() * 2.5,
        duration: 2.6 + Math.random() * 2.4,
        size: 7 + Math.round(Math.random() * 7),
      })),
    [],
  )

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
        // ステージ風の夕景（上＝空 → 下＝夕焼け）。
        background:
          'linear-gradient(180deg, #7fb0ef 0%, #b8cdec 26%, #f3d7a6 58%, #ff9f5c 88%, #f4854a 100%)',
      }}
    >
      {/* 雲（ふわっとした白い塊を数個） */}
      {[
        { top: '12%', left: '8%', w: 220 },
        { top: '20%', left: '55%', w: 300 },
        { top: '6%', left: '78%', w: 180 },
      ].map((c, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            top: c.top,
            left: c.left,
            width: c.w,
            height: c.w * 0.36,
            background: 'radial-gradient(closest-side, rgba(255,255,255,0.85), rgba(255,255,255,0))',
            filter: 'blur(4px)',
            pointerEvents: 'none',
          }}
        />
      ))}

      {/* 下部の暗いステージ床（カードを乗せる土台の陰） */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: '34%',
          background: 'linear-gradient(180deg, rgba(10,8,20,0) 0%, rgba(10,8,20,0.55) 60%, rgba(6,5,12,0.85) 100%)',
          pointerEvents: 'none',
        }}
      />

      {/* 紙吹雪 */}
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        {confetti.map((c) => (
          <span
            key={c.key}
            style={{
              position: 'absolute',
              top: 0,
              left: `${c.left}%`,
              width: `${c.size}px`,
              height: `${c.size * 1.6}px`,
              background: c.color,
              borderRadius: '2px',
              opacity: 0.9,
              animation: `confettiFall ${c.duration}s linear ${c.delay}s infinite`,
            }}
          />
        ))}
      </div>

      {/* 勝者の立ち絵（右側・3D）。中身は winner3d が three.js で描く（GLB 登録で自動差し替え）。 */}
      <div
        style={{
          position: 'absolute',
          right: '2%',
          bottom: 0,
          width: 'clamp(240px, 32vw, 460px)',
          height: 'clamp(340px, 74vh, 660px)',
          animation: 'winnerPop 0.6s cubic-bezier(0.2, 0.9, 0.3, 1.2) both',
        }}
      >
        {/* 背後の後光 */}
        <div
          style={{
            position: 'absolute',
            bottom: '14%',
            left: '50%',
            width: '460px',
            height: '460px',
            transform: 'translate(-50%, 0)',
            background:
              'repeating-conic-gradient(from 0deg, rgba(255,255,255,0.22) 0deg 11deg, transparent 11deg 22deg)',
            borderRadius: '50%',
            animation: 'winnerRays 16s linear infinite',
            pointerEvents: 'none',
          }}
        />
        {/* 3D キャンバスのホスト（背景透過なので CSS の夕景の上にキャラだけ乗る） */}
        <div ref={stageHostRef} style={{ position: 'absolute', inset: 0 }} />
        {/* 王冠（3D キャラの頭上あたり） */}
        <span
          style={{
            position: 'absolute',
            top: '4%',
            left: '50%',
            transform: 'translateX(-50%)',
            fontSize: '3.4rem',
            filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.5))',
            animation: 'winnerFloat 3.4s ease-in-out infinite',
            pointerEvents: 'none',
          }}
        >
          👑
        </span>
      </div>

      {/* 1位クラスタ（左・手前） */}
      <div
        style={{
          position: 'absolute',
          top: 'clamp(1.5rem, 6vh, 4rem)',
          left: 'clamp(1rem, 4vw, 3.5rem)',
          maxWidth: '66%',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.4rem',
          animation: 'winnerPop 0.55s cubic-bezier(0.2, 0.9, 0.3, 1.2) both',
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
            fontSize: 'clamp(2.6rem, 11vw, 8rem)',
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
        {winner.mine && (
          <span
            style={{
              marginTop: '0.2rem',
              fontSize: 'clamp(1rem, 2.6vw, 1.5rem)',
              fontWeight: 800,
              color: '#166534',
              background: '#bbf7d0',
              alignSelf: 'flex-start',
              padding: '2px 14px',
              borderRadius: '999px',
              transform: 'skewX(-6deg)',
            }}
          >
            🎉 あなたの勝利！
          </span>
        )}
      </div>

      {/* 2位以降（左下・斜めカード） */}
      {losers.length > 0 && (
        <div
          style={{
            position: 'absolute',
            left: 'clamp(1rem, 4vw, 3.5rem)',
            bottom: 'clamp(1rem, 4vh, 2.5rem)',
            display: 'flex',
            gap: '0.9rem',
            flexWrap: 'wrap',
          }}
        >
          {losers.map((pl, i) => (
            <LoserCard key={`${pl.p}-${i}`} entry={pl} rank={i + 2} />
          ))}
        </div>
      )}

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
          search={rider ? { rider } : {}}
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

// 2位以降の斜めカード（順位バッジ＋ポートレート＋Pタグ）。
function LoserCard({ entry, rank }: { entry: RankEntry; rank: number }) {
  const [c0, c1, c2] = metalOf(rank)
  return (
    <div
      style={{
        position: 'relative',
        width: 'clamp(140px, 16vw, 184px)',
        height: 'clamp(84px, 11vh, 104px)',
        transform: 'skewX(-9deg)',
        background: 'linear-gradient(180deg, #1a2233, #0b1120)',
        border: `3px solid ${entry.color}`,
        borderRadius: '8px',
        boxShadow: '0 8px 18px rgba(0,0,0,0.5)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          transform: 'skewX(9deg)',
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          height: '100%',
          padding: '0 0.7rem',
        }}
      >
        {/* 順位番号（メタリック） */}
        <span
          style={{
            fontSize: 'clamp(1.9rem, 4.5vw, 2.8rem)',
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
        {/* ポートレート（プレースホルダ・色玉） */}
        <div
          style={{
            width: '46px',
            height: '46px',
            borderRadius: '50%',
            flexShrink: 0,
            background: `radial-gradient(circle at 35% 30%, ${entry.color}, ${entry.color}55 65%, #0b1120)`,
            border: `2px solid ${entry.color}`,
          }}
        />
        {/* 名前（小さく） */}
        <span
          style={{
            fontSize: '0.72rem',
            fontWeight: 800,
            color: '#e5e7eb',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {entry.name}
        </span>
      </div>
      {/* Pタグ（カード右下） */}
      <span
        style={{
          position: 'absolute',
          right: '4px',
          bottom: '2px',
          transform: 'skewX(9deg)',
          fontSize: '0.7rem',
          fontWeight: 900,
          fontStyle: 'italic',
          color: '#fff',
          textShadow: '0 1px 2px #000',
        }}
      >
        {entry.p}P
      </span>
    </div>
  )
}
