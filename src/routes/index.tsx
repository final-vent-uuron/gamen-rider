import { Link, createFileRoute } from "@tanstack/react-router";

import { WEBWORLD_SKY, WebWorldBackdrop } from "../webworld-backdrop";
import type { CodeFragment } from "../webworld-backdrop";

export const Route = createFileRoute("/")({ component: Home });

// タイトル画面のコード片（これから始まる戦いを匂わせるスニペット）。
const TITLE_FRAGMENTS: CodeFragment[] = [
	{ text: "await henshin(card);", top: "18%", left: "3%" },
	{ text: "on('punch', attack)", top: "34%", right: "4%" },
	{ text: "final_vent --charge 5", top: "56%", left: "2%" },
	{ text: '<rider deck="arduino" />', top: "12%", right: "24%" },
	{ text: "battle.royale(4);", top: "48%", right: "8%" },
];

// 本番フロー（1本道）:
//   [ゲームスタート] → /auth（カード認証 → ポーズ認証）→ /pairing → /battle → /result
// 個別ページ（/pose 等）は各機能の単体検証用。開発時だけ使うので下部に小さくまとめる。
function Home() {
	return (
		<div
			style={{
				position: "relative",
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				minHeight: "100vh",
				overflow: "hidden",
				gap: "2.4rem",
				padding: "1.5rem",
				color: "#fff",
				background: WEBWORLD_SKY,
			}}
		>
			{/* Webワールドの背景（電脳空間。リザルトと共通） */}
			<WebWorldBackdrop fragments={TITLE_FRAGMENTS} />

			{/* タイトルロゴ */}
			<div
				style={{
					position: "relative",
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					gap: "0.6rem",
					animation: "winnerPop 0.7s cubic-bezier(0.2, 0.9, 0.3, 1.2) both",
				}}
			>
				<span
					style={{
						fontFamily: "monospace",
						fontSize: "clamp(0.7rem, 1.6vw, 0.9rem)",
						letterSpacing: "0.5em",
						color: "rgba(56,189,248,0.75)",
						textShadow: "0 0 12px rgba(56,189,248,0.5)",
					}}
				>
					FINAL VENT PROJECT
				</span>
				<h1
					style={{
						margin: 0,
						fontSize: "clamp(3.2rem, 13vw, 7.5rem)",
						fontWeight: 900,
						fontStyle: "italic",
						letterSpacing: "0.02em",
						lineHeight: 1.05,
						transform: "skewX(-6deg)",
						whiteSpace: "nowrap",
						// 電脳メタリック（空色 → シアン → 紫）のグラデ文字＋ネオン発光
						backgroundImage:
							"linear-gradient(180deg, #e0f2fe 0%, #7dd3fc 38%, #38bdf8 58%, #a78bfa 100%)",
						WebkitBackgroundClip: "text",
						backgroundClip: "text",
						color: "transparent",
						filter:
							"drop-shadow(0 0 26px rgba(56,189,248,0.45)) drop-shadow(0 5px 0 rgba(0,0,0,0.45))",
					}}
				>
					画面ライダー
				</h1>
			</div>

			{/* 本番の入口。ここを押すと 認証 → ペアリング → バトル → リザルト まで一本道で進む。 */}
			<Link
				to="/auth"
				style={{
					position: "relative",
					padding: "1.05rem 3.6rem",
					background: "linear-gradient(90deg, #38bdf8, #7c3aed)",
					color: "#fff",
					textDecoration: "none",
					borderRadius: "12px",
					fontSize: "1.35rem",
					fontWeight: 900,
					fontStyle: "italic",
					letterSpacing: "0.08em",
					border: "1px solid rgba(255,255,255,0.35)",
					animation: "titlePulse 1.8s ease-in-out infinite",
				}}
			>
				▶ ゲームスタート
			</Link>

			{/* 開発用（即座にテストするための入口）。本番フローには含まれない。 */}
			<div
				style={{
					position: "relative",
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					gap: "0.6rem",
					marginTop: "0.6rem",
				}}
			>
				<span
					style={{
						color: "#475569",
						fontSize: "0.75rem",
						letterSpacing: "0.1em",
					}}
				>
					開発用
				</span>
				<div
					style={{
						display: "flex",
						gap: "0.5rem",
						flexWrap: "wrap",
						justifyContent: "center",
					}}
				>
					{(
						[
							{ to: "/select", label: "キャラ選択（デモ）" },
							{ to: "/auth/register", label: "ライダー登録" },
							{ to: "/final-vent-pose", label: "FVポーズ登録" },
						] as const
					).map((l) => (
						<Link
							key={l.to}
							to={l.to}
							style={{
								padding: "0.35rem 0.9rem",
								background: "rgba(15,23,42,0.6)",
								color: "#94a3b8",
								textDecoration: "none",
								borderRadius: "6px",
								fontSize: "0.8rem",
								border: "1px solid #1e293b",
							}}
						>
							{l.label}
						</Link>
					))}
				</div>
			</div>
		</div>
	);
}
