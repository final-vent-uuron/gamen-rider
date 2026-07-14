import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Home })

// 本番フロー（1本道）:
//   [ゲームスタート] → /auth（カード認証 → ポーズ認証）→ /battle（対戦）→ /result（リザルト）
// 個別ページ（/pose 等）は各機能の単体検証用。開発時だけ使うので下部に小さくまとめる。
function Home() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        gap: '2.5rem',
        padding: '1.5rem',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.4rem' }}>
        <h1 style={{ fontSize: '3rem', margin: 0, letterSpacing: '0.04em' }}>Final Vent</h1>
        <p style={{ margin: 0, color: '#9ca3af', fontSize: '0.95rem' }}>
          カードで変身 → ライダーになって対戦する IoT バトル
        </p>
      </div>

      {/* 本番の入口。ここを押すと 認証 → バトル → リザルト まで一本道で進む。 */}
      <Link
        to="/auth"
        style={{
          padding: '1.1rem 3.5rem',
          background: 'linear-gradient(135deg, #a78bfa, #6366f1)',
          color: '#fff',
          textDecoration: 'none',
          borderRadius: '12px',
          fontSize: '1.4rem',
          fontWeight: 'bold',
          letterSpacing: '0.05em',
          boxShadow: '0 8px 24px rgba(99,102,241,0.5)',
        }}
      >
        ▶ ゲームスタート
      </Link>

      {/* 本番フローの流れを一目で示す（今どこを通るのか分かるように）。 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          color: '#6b7280',
          fontSize: '0.85rem',
          flexWrap: 'wrap',
          justifyContent: 'center',
        }}
      >
        {['カード認証', 'ポーズ認証', 'バトル', 'リザルト'].map((label, i, arr) => (
          <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
            <span
              style={{
                background: '#1f2937',
                borderRadius: '999px',
                padding: '0.2rem 0.8rem',
                color: '#cbd5e1',
              }}
            >
              {label}
            </span>
            {i < arr.length - 1 && <span>→</span>}
          </span>
        ))}
      </div>

      {/* 開発用（個別テスト）。本番フローには含まれない単体検証ページ。 */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.6rem', marginTop: '1rem' }}>
        <span style={{ color: '#4b5563', fontSize: '0.75rem', letterSpacing: '0.1em' }}>
          開発用（個別テスト）
        </span>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          {(
            [
              { to: '/pose', label: 'Pose 検知' },
              { to: '/detect', label: '画像検知' },
              { to: '/henshin', label: '変身フロー(旧)' },
              { to: '/battle', label: 'バトル単体' },
              { to: '/auth/register', label: 'ライダー登録' },
            ] as const
          ).map((l) => (
            <Link
              key={l.to}
              to={l.to}
              style={{
                padding: '0.35rem 0.9rem',
                background: '#111827',
                color: '#9ca3af',
                textDecoration: 'none',
                borderRadius: '6px',
                fontSize: '0.8rem',
                border: '1px solid #1f2937',
              }}
            >
              {l.label}
            </Link>
          ))}
        </div>
      <h1 style={{ fontSize: '2.5rem', margin: 0 }}>Final Vent</h1>
      <div style={{ display: 'flex', gap: '1rem' }}>
        <Link
          to="/pose"
          style={{
            padding: '0.75rem 2rem',
            background: '#4ade80',
            color: '#000',
            textDecoration: 'none',
            borderRadius: '8px',
            fontSize: '1.1rem',
            fontWeight: 'bold',
          }}
        >
          Pose Detection →
        </Link>
        <Link
          to="/detect"
          style={{
            padding: '0.75rem 2rem',
            background: '#60a5fa',
            color: '#000',
            textDecoration: 'none',
            borderRadius: '8px',
            fontSize: '1.1rem',
            fontWeight: 'bold',
          }}
        >
          画像検知 →
        </Link>
        <Link
          to="/henshin"
          style={{
            padding: '0.75rem 2rem',
            background: '#a78bfa',
            color: '#000',
            textDecoration: 'none',
            borderRadius: '8px',
            fontSize: '1.1rem',
            fontWeight: 'bold',
          }}
        >
          変身フロー →
        </Link>
        <Link
          to="/battle"
          style={{
            padding: '0.75rem 2rem',
            background: '#f87171',
            color: '#000',
            textDecoration: 'none',
            borderRadius: '8px',
            fontSize: '1.1rem',
            fontWeight: 'bold',
          }}
        >
          バトル →
        </Link>
        <Link
          to="/battle-test"
          style={{
            padding: '0.75rem 2rem',
            background: '#fb923c',
            color: '#000',
            textDecoration: 'none',
            borderRadius: '8px',
            fontSize: '1.1rem',
            fontWeight: 'bold',
          }}
        >
          バトル検証 →
        </Link>
        <Link
          to="/model-check"
          style={{
            padding: '0.75rem 2rem',
            background: '#fbbf24',
            color: '#000',
            textDecoration: 'none',
            borderRadius: '8px',
            fontSize: '1.1rem',
            fontWeight: 'bold',
          }}
        >
          モデル検証 →
        </Link>
      </div>
    </div>
  )
}
