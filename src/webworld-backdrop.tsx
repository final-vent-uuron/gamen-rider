import { useMemo } from 'react'

// ---- Webワールドの背景（共有コンポーネント） -------------------------------
// バトル（arena3d の buildBackdrop）と同じ世界観「インターネット空間の中のアリーナ」を
// CSS だけで再現する: 星ノイズ・コードレイン・漂うコード片・ワイヤーフレーム地球(The Web)・
// 浮遊ブラウザウィンドウ・地平線へ向かう遠近グリッドの床。すべて pointerEvents: none の装飾。
// タイトル（/）とリザルト（/result）が共用。fragments で画面ごとのコード片を差し替える。

export interface CodeFragment {
  text: string
  top: string
  left?: string
  right?: string
}

const DEFAULT_FRAGMENTS: CodeFragment[] = [
  { text: 'const world = new Web();', top: '16%', left: '4%' },
  { text: '<arena />', top: '28%', right: '5%' },
  { text: 'riders.forEach(fight)', top: '52%', left: '2%' },
  { text: '0110 0111 0110 1101', top: '10%', right: '20%' },
  { text: 'await henshin();', top: '44%', right: '3%' },
]

export function WebWorldBackdrop({
  fragments = DEFAULT_FRAGMENTS,
}: {
  fragments?: CodeFragment[]
}) {
  // 星（電脳ノイズ粒）とコードレインの配置はマウント時に一度だけ確定させる。
  const stars = useMemo(
    () =>
      Array.from({ length: 34 }).map((_, i) => ({
        key: i,
        left: Math.random() * 100,
        top: Math.random() * 58, // 地平線より上だけ
        size: 1 + Math.round(Math.random() * 2),
        delay: Math.random() * 3,
        cyan: i % 3 === 0,
      })),
    [],
  )
  const rains = useMemo(() => {
    const glyphs = '01</>{};=+#$&λΔ'
    return Array.from({ length: 7 }).map((_, i) => ({
      key: i,
      left: 3 + Math.random() * 94,
      duration: 9 + Math.random() * 9,
      delay: -Math.random() * 12, // 負の delay で最初から降ってる途中にする
      text: Array.from(
        { length: 16 },
        () => glyphs[Math.floor(Math.random() * glyphs.length)],
      ).join('\n'),
    }))
  }, [])

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      {/* 星（電脳空間のノイズ粒。まばたきする） */}
      {stars.map((s) => (
        <span
          key={s.key}
          style={{
            position: 'absolute',
            left: `${s.left}%`,
            top: `${s.top}%`,
            width: `${s.size}px`,
            height: `${s.size}px`,
            borderRadius: '50%',
            background: s.cyan ? '#7fd4ff' : '#dbeafe',
            boxShadow: s.cyan ? '0 0 6px #38bdf8' : '0 0 4px #fff',
            animation: `starTwinkle ${2 + s.delay}s ease-in-out ${s.delay}s infinite`,
          }}
        />
      ))}

      {/* コードレイン（マトリックス風に文字列が降り続ける） */}
      {rains.map((r) => (
        <span
          key={r.key}
          style={{
            position: 'absolute',
            top: 0,
            left: `${r.left}%`,
            fontFamily: 'monospace',
            fontSize: '13px',
            lineHeight: 1.25,
            whiteSpace: 'pre',
            textAlign: 'center',
            color: 'rgba(56,189,248,0.35)',
            textShadow: '0 0 8px rgba(56,189,248,0.3)',
            animation: `codeRain ${r.duration}s linear ${r.delay}s infinite`,
          }}
        >
          {r.text}
        </span>
      ))}

      {/* ワイヤーフレーム地球「The Web」（バトル背景と同じランドマーク） */}
      <div
        style={{
          position: 'absolute',
          top: '8%',
          right: '10%',
          width: 'clamp(110px, 15vw, 200px)',
          aspectRatio: '1',
          animation: 'winnerFloat 9s ease-in-out infinite',
          opacity: 0.55,
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            border: '1px solid rgba(56,189,248,0.6)',
            boxShadow: '0 0 26px rgba(56,189,248,0.25), inset 0 0 26px rgba(56,189,248,0.18)',
            backgroundImage:
              'repeating-linear-gradient(0deg, rgba(56,189,248,0.3) 0 1px, transparent 1px 19%), repeating-linear-gradient(90deg, rgba(56,189,248,0.3) 0 1px, transparent 1px 19%)',
            overflow: 'hidden',
          }}
        />
        <span
          style={{
            position: 'absolute',
            left: '50%',
            bottom: '-1.4rem',
            transform: 'translateX(-50%)',
            fontFamily: 'monospace',
            fontSize: '0.7rem',
            letterSpacing: '0.3em',
            color: 'rgba(56,189,248,0.6)',
          }}
        >
          THE WEB
        </span>
      </div>

      {/* 浮遊するブラウザウィンドウ（電脳世界の建造物） */}
      {[
        { left: '6%', top: '20%', w: 170, delay: 0 },
        { right: '24%', top: '38%', w: 130, delay: 2.4 },
      ].map((win, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: win.left,
            right: win.right,
            top: win.top,
            width: `${win.w}px`,
            background: 'rgba(15,23,42,0.55)',
            border: '1px solid rgba(56,189,248,0.35)',
            borderRadius: '8px',
            boxShadow: '0 0 18px rgba(56,189,248,0.15)',
            animation: `codeDrift ${8 + i * 2}s ease-in-out ${win.delay}s infinite`,
            overflow: 'hidden',
            opacity: 0.8,
          }}
        >
          {/* タイトルバー（信号機ドット） */}
          <div
            style={{
              display: 'flex',
              gap: '4px',
              padding: '5px 7px',
              borderBottom: '1px solid rgba(56,189,248,0.25)',
            }}
          >
            {['#f87171', '#fbbf24', '#34d399'].map((c) => (
              <span
                key={c}
                style={{ width: '6px', height: '6px', borderRadius: '50%', background: c }}
              />
            ))}
          </div>
          {/* 中身のダミー行 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', padding: '8px' }}>
            {[85, 60, 72].map((w, k) => (
              <span
                key={k}
                style={{
                  width: `${w}%`,
                  height: '5px',
                  borderRadius: '3px',
                  background: 'rgba(148,163,184,0.3)',
                }}
              />
            ))}
          </div>
        </div>
      ))}

      {/* 漂うコード片（この世界がプログラムでできていることを匂わせる） */}
      {fragments.map((f, i) => (
        <span
          key={i}
          style={{
            position: 'absolute',
            top: f.top,
            left: f.left,
            right: f.right,
            fontFamily: 'monospace',
            fontSize: 'clamp(0.7rem, 1.4vw, 0.95rem)',
            color: 'rgba(56,189,248,0.45)',
            textShadow: '0 0 10px rgba(56,189,248,0.35)',
            animation: `codeDrift ${6 + (i % 3)}s ease-in-out ${i * 0.9}s infinite`,
            whiteSpace: 'nowrap',
          }}
        >
          {f.text}
        </span>
      ))}

      {/* 電脳グリッドの床（地平線へ向かう遠近グリッド。バトルステージの床と同じ意匠） */}
      <div
        style={{
          position: 'absolute',
          left: '-15%',
          right: '-15%',
          bottom: 0,
          height: '42%',
          backgroundImage:
            'repeating-linear-gradient(90deg, rgba(56,189,248,0.25) 0 2px, transparent 2px 90px), repeating-linear-gradient(0deg, rgba(56,189,248,0.25) 0 2px, transparent 2px 60px)',
          transform: 'perspective(320px) rotateX(58deg)',
          transformOrigin: '50% 100%',
          maskImage: 'linear-gradient(180deg, transparent 0%, #000 55%)',
          WebkitMaskImage: 'linear-gradient(180deg, transparent 0%, #000 55%)',
        }}
      />
      {/* 地平線のネオンライン */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: '42%',
          height: '2px',
          background:
            'linear-gradient(90deg, transparent, rgba(56,189,248,0.55) 30%, rgba(167,139,250,0.55) 70%, transparent)',
          boxShadow: '0 0 18px rgba(56,189,248,0.35)',
        }}
      />

      {/* 下部の暗い床の陰（キャラを立たせる土台） */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: '34%',
          background:
            'linear-gradient(180deg, rgba(7,11,22,0) 0%, rgba(7,11,22,0.55) 60%, rgba(4,7,14,0.9) 100%)',
        }}
      />
    </div>
  )
}

// Webワールドの空の色（各画面のルート背景に使う共通グラデーション）。
export const WEBWORLD_SKY =
  'radial-gradient(ellipse at 50% 18%, #1b2a52 0%, #101a33 45%, #0b1220 72%, #070b16 100%)'
