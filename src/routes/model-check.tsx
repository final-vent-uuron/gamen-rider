import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { modelUrl } from "../model-assets";

// GLB モデルの表示検証ページ。GLB が three.js で
// 正しく表示・アニメーション再生できるかを単体で確認する。
// GLB 内のクリップ名を列挙してボタンで切り替えられるので、ここで確認した
// idle / death のクリップ名をそのまま arena3d.ts の RIDER_MODELS.clips に登録できる。

// 検証対象の GLB（配信元は model-assets.ts。既定は R2、無ければ public/model）。
// ?model=xxx.glb で切り替えられる（先頭が既定）。
const MODEL_FILES = [
	"gamen-rider-python-animation.v2.glb",
	"gamen-rider-arduino-add-animation-fix.v2.glb",
	"swift-add-animation.glb",
	"test.v2.glb",
	"flutter.glb",
] as const;

export const Route = createFileRoute("/model-check")({
	validateSearch: (search: Record<string, unknown>): { model?: string } => ({
		model: typeof search.model === "string" ? search.model : undefined,
	}),
	component: ModelCheckPage,
});

// ビューア本体（three.js）への操作ハンドル。React 側からはこれだけ触る。
interface ViewerHandle {
	play(name: string): void;
	dispose(): void;
}

// death 系クリップは一回再生で最終フレーム維持（倒れたまま）にする。
function isOneShotName(name: string): boolean {
	return /death|die|down|dead/i.test(name);
}

function ModelCheckPage() {
	const { model } = Route.useSearch();
	const modelFile = model ?? MODEL_FILES[0];
	const modelSrc = modelUrl(modelFile);

	const hostRef = useRef<HTMLDivElement>(null);
	const viewerRef = useRef<ViewerHandle | null>(null);
	const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
	const [error, setError] = useState("");
	const [clips, setClips] = useState<string[]>([]);
	const [active, setActive] = useState<string | null>(null);
	const [info, setInfo] = useState("");

	useEffect(() => {
		let disposed = false;

		// モデル切り替え時に前の表示状態をリセット
		setStatus("loading");
		setError("");
		setClips([]);
		setActive(null);
		setInfo("");

		// SSR を避けるため three は動的 import（battle.tsx と同じ方針）。
		async function setup() {
			const THREE = await import("three");
			const { GLTFLoader } = await import(
				"three/examples/jsm/loaders/GLTFLoader.js"
			);
			const { OrbitControls } = await import(
				"three/examples/jsm/controls/OrbitControls.js"
			);
			const host = hostRef.current;
			if (disposed || !host) return;

			// --- シーンの基本セット（背景・ライト・床グリッド） ---
			const scene = new THREE.Scene();
			scene.background = new THREE.Color(0x0b1220);

			const camera = new THREE.PerspectiveCamera(
				40,
				(host.clientWidth || 800) / (host.clientHeight || 500),
				0.01,
				1000,
			);

			const renderer = new THREE.WebGLRenderer({ antialias: true });
			renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
			renderer.setSize(host.clientWidth || 800, host.clientHeight || 500);
			renderer.shadowMap.enabled = true;
			host.appendChild(renderer.domElement);

			scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a2033, 1.2));
			const key = new THREE.DirectionalLight(0xffffff, 2.2);
			key.position.set(3, 6, 4);
			key.castShadow = true;
			scene.add(key);

			const grid = new THREE.GridHelper(10, 20, 0x334155, 0x1f2937);
			scene.add(grid);
			const ground = new THREE.Mesh(
				new THREE.CircleGeometry(5, 48).rotateX(-Math.PI / 2),
				new THREE.ShadowMaterial({ opacity: 0.35 }),
			);
			ground.receiveShadow = true;
			scene.add(ground);

			const controls = new OrbitControls(camera, renderer.domElement);
			controls.enableDamping = true;

			// --- GLB ロード ---
			let mixer: InstanceType<typeof THREE.AnimationMixer> | null = null;
			const actions = new Map<
				string,
				InstanceType<typeof THREE.AnimationAction>
			>();
			let current: InstanceType<typeof THREE.AnimationAction> | null = null;

			new GLTFLoader().load(
				modelSrc,
				(gltf) => {
					if (disposed) return;
					const obj = gltf.scene;
					obj.traverse((o) => {
						const m = o as InstanceType<typeof THREE.Mesh>;
						if (m.isMesh) m.castShadow = true;
					});
					scene.add(obj);

					// バウンディングボックスからカメラを自動フレーミング。
					// モデルのスケールが不明でも「必ず画面に収まる」状態で検証を始められる。
					const box = new THREE.Box3().setFromObject(obj);
					const size = box.getSize(new THREE.Vector3());
					const center = box.getCenter(new THREE.Vector3());
					const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
					const dist = radius / Math.tan((camera.fov * Math.PI) / 360) + radius;
					camera.position.set(
						center.x + dist * 0.5,
						center.y + radius * 0.6,
						center.z + dist,
					);
					camera.near = dist / 100;
					camera.far = dist * 100;
					camera.updateProjectionMatrix();
					controls.target.copy(center);
					controls.update();
					grid.position.y = box.min.y; // グリッドを足元に合わせる
					ground.position.y = box.min.y + 0.001;

					setInfo(
						`size: ${size.x.toFixed(2)} × ${size.y.toFixed(
							2,
						)} × ${size.z.toFixed(2)} / ` + `clips: ${gltf.animations.length}`,
					);

					// クリップ一覧を actions 化。death 系のみ一回再生＋最終姿勢維持。
					mixer = new THREE.AnimationMixer(obj);
					for (const clip of gltf.animations) {
						const action = mixer.clipAction(clip);
						if (isOneShotName(clip.name)) {
							action.setLoop(THREE.LoopOnce, 1);
							action.clampWhenFinished = true;
						}
						actions.set(clip.name, action);
					}
					const names = gltf.animations.map((c) => c.name);
					setClips(names);
					setStatus("ok");

					// idle っぽいクリップがあれば自動再生して初期表示にする。
					const idle = names.find((n) => /idle/i.test(n)) ?? names[0];
					if (idle) viewerRef.current?.play(idle);
				},
				undefined,
				(err) => {
					console.warn("[model-check] GLB load failed:", err);
					setError(String(err));
					setStatus("error");
				},
			);

			// --- 描画ループ ---（THREE.Clock は非推奨のため手動で delta を計算）
			let raf = 0;
			let lastT = performance.now();
			const loop = () => {
				raf = requestAnimationFrame(loop);
				const now = performance.now();
				const dt = Math.min((now - lastT) / 1000, 0.05);
				lastT = now;
				mixer?.update(dt);
				controls.update();
				renderer.render(scene, camera);
			};
			loop();

			const onResize = () => {
				const w = host.clientWidth || 800;
				const h = host.clientHeight || 500;
				camera.aspect = w / h;
				camera.updateProjectionMatrix();
				renderer.setSize(w, h);
			};
			window.addEventListener("resize", onResize);

			viewerRef.current = {
				play(name) {
					const next = actions.get(name);
					if (!next) return;
					next.reset().fadeIn(0.2).play();
					if (current && current !== next) current.fadeOut(0.2);
					current = next;
					setActive(name);
				},
				dispose() {
					cancelAnimationFrame(raf);
					window.removeEventListener("resize", onResize);
					mixer?.stopAllAction();
					controls.dispose();
					renderer.dispose();
					renderer.domElement.remove();
				},
			};
		}

		setup();
		return () => {
			disposed = true;
			viewerRef.current?.dispose();
			viewerRef.current = null;
		};
	}, [modelSrc]);

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				minHeight: "100vh",
				padding: "1rem",
				gap: "0.75rem",
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: "1rem",
					flexWrap: "wrap",
				}}
			>
				<Link
					to="/"
					style={{
						color: "#9ca3af",
						textDecoration: "none",
						fontSize: "0.9rem",
					}}
				>
					← Back
				</Link>
				<h1 style={{ margin: 0, fontSize: "1.3rem" }}>モデル表示検証</h1>
				{/* モデル切り替え（?model= で URL にも残るのでリロード・共有できる） */}
				<div style={{ display: "flex", gap: "0.4rem" }}>
					{MODEL_FILES.map((f) => (
						<Link
							key={f}
							to="/model-check"
							search={{ model: f }}
							style={{
								padding: "0.3rem 0.8rem",
								borderRadius: "6px",
								border: "2px solid #a78bfa",
								background: f === modelFile ? "#a78bfa" : "transparent",
								color: f === modelFile ? "#000" : "#a78bfa",
								textDecoration: "none",
								fontSize: "0.85rem",
								fontWeight: "bold",
							}}
						>
							{f}
						</Link>
					))}
				</div>
				<span
					style={{ marginLeft: "auto", fontSize: "0.85rem", color: "#9ca3af" }}
				>
					{info}
				</span>
			</div>

			{/* three.js ビューア（ドラッグで回転 / ホイールでズーム） */}
			<div
				style={{
					position: "relative",
					flex: 1,
					minHeight: "420px",
					borderRadius: "12px",
					overflow: "hidden",
					background: "#0b1220",
				}}
			>
				<div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
				{status === "loading" && (
					<span
						style={{
							position: "absolute",
							inset: 0,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							color: "#9ca3af",
						}}
					>
						{modelFile} を読み込み中…
					</span>
				)}
				{status === "error" && (
					<span
						style={{
							position: "absolute",
							inset: 0,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							color: "#f87171",
							padding: "1rem",
							textAlign: "center",
						}}
					>
						読み込みに失敗しました: {error}
					</span>
				)}
			</div>

			{/* クリップ切り替え。ここで確認した名前を RIDER_MODELS.clips に登録する */}
			<div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
				<span style={{ fontSize: "0.75rem", color: "#9ca3af" }}>
					アニメーションクリップ（death 系は一回再生で倒れたまま停止）
				</span>
				<div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
					{clips.length === 0 && status === "ok" && (
						<span style={{ fontSize: "0.85rem", color: "#fbbf24" }}>
							クリップが含まれていません（静止モデル）
						</span>
					)}
					{clips.map((name) => {
						const isActive = name === active;
						const guess = /idle/i.test(name)
							? "#34d399"
							: isOneShotName(name)
								? "#f87171"
								: "#60a5fa";
						return (
							<button
								key={name}
								type="button"
								onClick={() => viewerRef.current?.play(name)}
								style={{
									padding: "0.45rem 1rem",
									borderRadius: "8px",
									border: `2px solid ${guess}`,
									background: isActive ? guess : "transparent",
									color: isActive ? "#000" : guess,
									fontWeight: "bold",
									fontSize: "0.85rem",
									cursor: "pointer",
								}}
							>
								{name}
							</button>
						);
					})}
				</div>
			</div>
		</div>
	);
}
