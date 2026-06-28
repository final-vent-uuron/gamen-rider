import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        gap: '1.5rem',
      }}
    >
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
      </div>
    </div>
  )
}
