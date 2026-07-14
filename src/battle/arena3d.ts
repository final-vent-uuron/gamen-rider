// バトルステージの 3D 描画（three.js）。React にも通信にも依存しない純粋なレンダラ。
// createArenaRenderer(container) で生成し、毎フレーム render(state) に BattleState を渡すだけ。
//
// キャラは「FighterAvatar」インターフェースで抽象化してある:
//   - createBoxAvatar : box プリミティブの人型プレースホルダ（アセット不要・いま動く）
//   - createGltfAvatar: GLB モデルを読み込むアバター（AnimationMixer でクリップ再生）
// RIDER_MODELS にライダー別の GLB url とクリップ名を登録すれば、box から自動で差し替わる。
// renderer 側は FighterAvatar しか見ないので、モデルを足しても描画ロジックは無変更。

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { BattleState, PlayerState } from "./state";

// プレイヤー表示色（battle.tsx の PLAYER_COLORS と対応）。
const PLAYER_COLORS = [0xa78bfa, 0xf87171, 0x34d399, 0xfbbf24, 0x38bdf8];
const WORLD_W = 22; // 正規化 x(0..1) をワールド X(-11..11) に写す（ステージ横幅）
const JUMP_WORLD = 2.4; // 正規化ジャンプ高さ(y) → ワールド高さ

// 格ゲー風フォローカメラの設定。据わった横視点で、ゆっくり pan、ズームは控えめ。
const CAM = {
	fov: 36, // やや望遠（平面的で 2D 格ゲーっぽい見え方）
	y: 2.7, // カメラ高さ（低め＝横視点）
	lookY: 1.3, // 注視点の高さ
	padX: 2.5, // 左右の余白（ワールド）
	halfY: 2.6, // 縦に収める範囲（ジャンプで無理に引かない）
	minDist: 10, // 最接近
	maxDist: 20, // 最遠（ステージ幅 22 の端↔端でも全員収まる距離）
	damp: 0.045, // 追従の滑らかさ（小さい＝ゆっくり据わる）
};

// アバターのアクション。GLB のアニメクリップ対応付けのキーにも使う。
export type AvatarAction =
	| "idle"
	| "walk"
	| "punch"
	| "kick"
	| "hit"
	| "down"
	| "final"
	| "jump"
	| "guard"
	| "throw"
	| "thrown"
	| "abare";

// ライダー別 GLB モデルの登録。ここに 1 行足すだけで box プレースホルダから差し替わる。
//   例) GLB を用意したら（Vite なら import url from '#/assets/models/ryuki.glb?url'）:
//   export const RIDER_MODELS = {
//     ryuki: {
//       url: ryukiUrl,
//       scale: 1,
//       clips: { idle:'Idle', walk:'Walk', punch:'Punch', kick:'Kick', hit:'Hit', down:'Down', final:'Final', jump:'Jump' },
//     },
//   }
export interface RiderModel {
	url: string;
	scale?: number; // モデルの拡大率（省略時は height から自動算出）
	height?: number; // 自動フィットの目標身長（ワールド単位。既定 1.9 ≒ box アバター）
	yOffset?: number; // 接地の微調整（ワールド単位。自動接地に加算）
	rotateY?: number; // 正面補正（renderer は rotation.y=0 で +x を向く前提）
	clips?: Partial<Record<AvatarAction, string>>; // アクション → GLB 内クリップ名
	// ルートモーション（腰の平行移動ドリフト）を除去してその場アニメ化するクリップ名。
	// In Place でエクスポートされていない走り/歩きに使う（移動はゲーム側が行うため）。
	stripRootMotion?: string[];
}

// 全ライダー共通の検証用モデル（/model-check で検証済み）。
// いまは /battle-test だけが createArenaRenderer の fallbackModel として渡して使う。
// 実バトルへ本採用するときは battle.tsx 側で同じように渡すか、RIDER_MODELS に個別登録する。
// - walk: run クリップを使用。前進のルートモーションが焼き込まれているため
//   stripRootMotion でその場走りに変換している。
// - hit / final / guard / throw は未収録 → idle フォールバック（hit は簡易後傾で補助）。
export const DEFAULT_RIDER_MODEL: RiderModel = {
	url: "/model/gamen-rider-arduino-add-animation-fix.glb",
	height: 0.5, // box アバター(約1.9)より一回り小さめ。画面に対して大きすぎたため
	rotateY: Math.PI / 2, // Mixamo リグは +z 正面 → このゲームの正面 +x へ
	clips: {
		idle: "idle",
		walk: "run",
		down: "death",
		jump: "junp",
		punch: "punch",
		kick: "kick",
	},
	stripRootMotion: ["run"],
};

export const RIDER_MODELS: Record<string, RiderModel> = {
	// ライダー別に差し替えたくなったら riderId をキーにここへ登録する。
	// 未登録のライダーは fallbackModel（あれば）→ box プレースホルダの順で描画される。
};

// box でも GLB でも renderer からは同じに見えるアバター。
export interface FighterAvatar {
	root: THREE.Object3D;
	// 毎フレーム、プレイヤー状態に合わせて見た目を更新する。
	update(p: PlayerState, tSec: number, moving: boolean): void;
	dispose(): void;
}

const lerp = THREE.MathUtils.lerp;
const loader = new GLTFLoader();

// GLB は URL ごとに 1 回だけロード/パースして共有する（4人が同じ 20MB 級モデルでも
// パースは 1 回）。各アバターへは SkeletonUtils.clone で骨格ごと複製して渡すので、
// アニメーションは個体ごとに独立して再生できる。
const gltfCache = new Map<string, Promise<GLTF>>();
function loadGltfShared(url: string): Promise<GLTF> {
	let p = gltfCache.get(url);
	if (!p) {
		p = loader.loadAsync(url);
		gltfCache.set(url, p);
	}
	return p;
}

// ルートモーション除去: 各 position トラックから「最初→最後のキーへ直線的に進む
// ドリフト成分」を差し引き、その場アニメに変換する。上下のバウンド等の周期成分は残り、
// 最初と最後のキーが一致するのでループも綺麗に繋がる。
// クリップはキャッシュ経由で全アバター共有のため、二重適用を WeakSet で防ぐ。
const rootMotionStripped = new WeakSet<THREE.AnimationClip>();
function stripRootDrift(clip: THREE.AnimationClip) {
	if (rootMotionStripped.has(clip)) return;
	rootMotionStripped.add(clip);
	for (const track of clip.tracks) {
		if (!track.name.endsWith(".position")) continue;
		const times = track.times;
		const values = track.values;
		const n = times.length;
		if (n < 2) continue;
		const span = times[n - 1] - times[0];
		if (span <= 0) continue;
		const dx = values[(n - 1) * 3] - values[0];
		const dy = values[(n - 1) * 3 + 1] - values[1];
		const dz = values[(n - 1) * 3 + 2] - values[2];
		for (let k = 0; k < n; k++) {
			const f = (times[k] - times[0]) / span;
			values[k * 3] -= dx * f;
			values[k * 3 + 1] -= dy * f;
			values[k * 3 + 2] -= dz * f;
		}
	}
}

// Canvas 2D コンテキスト取得（テクスチャ生成用。取得失敗は環境異常なので即例外）。
function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
	const ctx = c.getContext("2d");
	if (!ctx) throw new Error("2d context unavailable");
	return ctx;
}

function darken(hex: number, f: number): number {
	const r = Math.floor(((hex >> 16) & 0xff) * f);
	const g = Math.floor(((hex >> 8) & 0xff) * f);
	const b = Math.floor((hex & 0xff) * f);
	return (r << 16) | (g << 8) | b;
}

// プレイヤー状態 → アバターのアクション。
function avatarAction(p: PlayerState, moving: boolean): AvatarAction {
	if (p.hp <= 0) return "down";
	if (p.action === "hit") return "hit";
	if (p.action === "thrown") return "thrown";
	if (p.action === "guard") return "guard";
	if (p.action === "throw") return "throw";
	if (p.action === "abare") return "abare";
	if (p.action === "punch") return "punch";
	if (p.action === "kick") return "kick";
	if (p.action === "final") return "final";
	if (p.y > 0.001) return "jump";
	if (moving) return "walk";
	return "idle";
}

// 一回再生クリップの目標再生時間（秒）。見た目重視の手調整値。
// ゲーム側の技時間（パンチ全体 0.26s 等）は格ゲーとして速すぎ、クリップをそこへ
// 圧縮すると一瞬のピクつきにしか見えない。そこでアニメはこの尺で「振り切らせ」、
// ゲーム状態が先に idle へ戻ってもクリップ完走までは維持する（update 側の保留ロジック）。
const ONESHOT_DURATION: Partial<Record<AvatarAction, number>> = {
	// クリップ本来の尺（punch 1.07s / kick 1.63s / junp 1.93s）に近い、やや締めた程度。
	punch: 0.8,
	kick: 1.1,
	throw: 0.9,
	thrown: 0.9,
	final: 1.2,
	hit: 0.5,
	jump: 1.0, // 滞空（約0.8s）＋着地のなじみ分
	// down(death) は指定なし＝クリップ本来の速度で最後まで再生し、倒れたまま止める
};

// レンダラ生成オプション。
export interface ArenaOptions {
	// RIDER_MODELS 未登録ライダーに使う共通 GLB。省略時は box プレースホルダ。
	// 実バトルは box のまま、検証ページ(/battle-test)だけ GLB を試す、という切り替えに使う。
	fallbackModel?: RiderModel;
}

export function createArenaRenderer(
	container: HTMLElement,
	opts: ArenaOptions = {},
): ArenaRenderer {
	const width = () => container.clientWidth || 800;
	const height = () => container.clientHeight || 420;

	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0x0b1220);
	scene.fog = new THREE.Fog(0x0b1220, 22, 48); // カメラ最遠(20)でもキャラが霞まない距離

	const camera = new THREE.PerspectiveCamera(
		CAM.fov,
		width() / height(),
		0.1,
		100,
	);
	camera.position.set(0, CAM.y, 12);
	camera.lookAt(0, CAM.lookY, 0);
	const camLook = new THREE.Vector3(0, CAM.lookY, 0); // 現在の注視点（追従で lerp する）
	const camTargetPos = new THREE.Vector3();
	const tmpVec = new THREE.Vector3();

	const renderer = new THREE.WebGLRenderer({ antialias: true });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	renderer.setSize(width(), height());
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	container.appendChild(renderer.domElement);

	// ライティング
	scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x1a2233, 0.9));
	const key = new THREE.DirectionalLight(0xffffff, 1.15);
	key.position.set(5, 11, 7);
	key.castShadow = true;
	key.shadow.mapSize.set(1024, 1024);
	key.shadow.camera.left = -12; // ステージ幅 22 の端でも影が切れないように
	key.shadow.camera.right = 12;
	key.shadow.camera.top = 8;
	key.shadow.camera.bottom = -2;
	key.shadow.camera.near = 1;
	key.shadow.camera.far = 30;
	scene.add(key);
	const rim = new THREE.DirectionalLight(0x5577aa, 0.4);
	rim.position.set(0, 4, -6);
	scene.add(rim);

	// 床（グリッド＋受け影プレーン）
	const grid = new THREE.GridHelper(40, 40, 0x38bdf8, 0x1e3a5f);
	const gridMat = grid.material as THREE.Material;
	gridMat.transparent = true;
	gridMat.opacity = 0.55;
	scene.add(grid);
	const floor = new THREE.Mesh(
		new THREE.PlaneGeometry(60, 60),
		new THREE.MeshStandardMaterial({
			color: 0x0a1120,
			roughness: 1,
			metalness: 0,
		}),
	);
	floor.rotation.x = -Math.PI / 2;
	floor.position.y = -0.02;
	floor.receiveShadow = true;
	scene.add(floor);

	// 作り込んだ背景（グラデ空・月・遠景ビル群・ネオンピラー・星・地面グロー）
	const backdrop = buildBackdrop();
	scene.add(backdrop.group);
	// ファイナルベント演出用の紫ライト（通常は消灯）
	const ventLight = new THREE.PointLight(0xa855f7, 0, 60);
	ventLight.position.set(0, 5, 8);
	scene.add(ventLight);

	const avatars = new Map<string, FighterAvatar>();
	const lastX = new Map<string, number>();
	const yaws = new Map<string, number>(); // 現在の向き（振り向きをなめらかに回す）
	const worldX = (x: number) => (x - 0.5) * WORLD_W;

	// --- FX（ジュース）: 画面シェイク / ヒットスパーク / ズームパンチ ---
	const camBase = new THREE.Vector3(0, CAM.y, 12);
	let shakeMag = 0;
	let zoomKick = 0;
	let lastFxT = 0;
	const sparkTex = makeSparkTexture();
	const sparks: {
		sprite: THREE.Sprite;
		mat: THREE.SpriteMaterial;
		life: number;
		ttl: number;
		base: number;
	}[] = [];

	function shake(mag: number) {
		shakeMag = Math.min(0.9, Math.max(shakeMag, mag));
	}
	function punch(amount: number) {
		zoomKick = Math.min(2.4, zoomKick + amount);
	}
	function hitSpark(
		normX: number,
		normY: number,
		color = 0xffe08a,
		big = false,
	) {
		const mat = new THREE.SpriteMaterial({
			map: sparkTex,
			color,
			blending: THREE.AdditiveBlending,
			depthWrite: false,
			transparent: true,
			fog: false,
		});
		const sprite = new THREE.Sprite(mat);
		sprite.position.set(worldX(normX), normY * JUMP_WORLD + 1.2, 0.6);
		const base = big ? 3.4 : 2.0;
		sprite.scale.setScalar(base * 0.4);
		scene.add(sprite);
		sparks.push({ sprite, mat, life: 0, ttl: big ? 0.26 : 0.18, base });
	}

	// 短命スパークの時間発展（拡大しながらフェードアウト）＋ シェイク/ズームの減衰。
	function stepFx(dt: number) {
		for (let i = sparks.length - 1; i >= 0; i--) {
			const s = sparks[i];
			s.life += dt;
			const k = s.life / s.ttl;
			if (k >= 1) {
				scene.remove(s.sprite);
				s.mat.dispose();
				sparks.splice(i, 1);
				continue;
			}
			s.sprite.scale.setScalar(s.base * (0.4 + k * 1.0));
			s.mat.opacity = 1 - k;
		}
		shakeMag *= 0.86;
		zoomKick *= 0.85;
		if (shakeMag < 0.0005) shakeMag = 0;
		if (zoomKick < 0.002) zoomKick = 0;
	}

	// 波動弾のスプライト（エネルギー弾）。projectile.id ごとに 1 枚を出し入れする。
	const projSprites = new Map<string, THREE.Sprite>();

	// ガード中のシールド（青い六角バリア）。押しっぱなしの間、正面に展開して脈動する。
	const guardTex = makeGuardTexture();
	const guardFx = new Map<
		string,
		{ sprite: THREE.Sprite; mat: THREE.SpriteMaterial }
	>();
	function removeGuardFx(id: string) {
		const g = guardFx.get(id);
		if (!g) return;
		scene.remove(g.sprite);
		g.mat.dispose();
		guardFx.delete(id);
	}

	function ensureAvatar(p: PlayerState, index: number): FighterAvatar {
		let av = avatars.get(p.id);
		if (!av) {
			const color = PLAYER_COLORS[index % PLAYER_COLORS.length];
			const model = RIDER_MODELS[p.riderId] ?? opts.fallbackModel;
			av = model ? createGltfAvatar(model, color) : createBoxAvatar(color);
			scene.add(av.root);
			avatars.set(p.id, av);
		}
		return av;
	}

	function render(state: BattleState, final = false) {
		// いなくなったプレイヤー（離脱・退出）のアバターを破棄
		for (const [id, av] of avatars) {
			if (!state.players.some((p) => p.id === id)) {
				scene.remove(av.root);
				av.dispose();
				avatars.delete(id);
				lastX.delete(id);
				yaws.delete(id);
				removeGuardFx(id);
			}
		}

		const t = performance.now() / 1000;
		backdrop.update(t); // Webワールド背景のアニメ（浮遊ウィンドウ・コードレイン・パケット）
		state.players.forEach((p, index) => {
			const av = ensureAvatar(p, index);
			const wx = worldX(p.x);
			av.root.position.x = wx;
			// 振り向き: facing の反転を即フリップせず、カメラ側（正面）を経由して
			// なめらかに回す。目標を 0 / -π にすることで、中間の -π/2 が「カメラの方を
			// 向く」経路になり、背中を見せずに振り向く。
			const targetYaw = p.facing === 1 ? 0 : -Math.PI;
			const prevYaw = yaws.get(p.id) ?? targetYaw;
			const yaw = lerp(prevYaw, targetYaw, 0.16); // 約 0.2 秒で回りきる
			yaws.set(p.id, yaw);
			av.root.rotation.y = yaw;
			const prev = lastX.get(p.id) ?? wx;
			const moving = Math.abs(wx - prev) > 0.003;
			lastX.set(p.id, wx);
			av.update(p, t, moving);

			// ガードシールド: ガード中はフェードインして正面に維持、解除でフェードアウト。
			// GLB は guard クリップ未収録（idle 代用）なので、構え中であることをこれで可視化する。
			const guarding = p.action === "guard" && p.hp > 0;
			let g = guardFx.get(p.id);
			if (guarding && !g) {
				const mat = new THREE.SpriteMaterial({
					map: guardTex,
					color: 0x38bdf8, // box アバターのガード発光と同じ青
					blending: THREE.AdditiveBlending,
					depthWrite: false,
					transparent: true,
					opacity: 0,
					fog: false,
				});
				g = { sprite: new THREE.Sprite(mat), mat };
				scene.add(g.sprite);
				guardFx.set(p.id, g);
			}
			if (g) {
				g.mat.opacity = lerp(g.mat.opacity, guarding ? 0.85 : 0, 0.25);
				if (!guarding && g.mat.opacity < 0.03) {
					removeGuardFx(p.id);
				} else {
					g.sprite.position.set(wx + p.facing * 0.8, 1.05, 0.5);
					g.sprite.scale.setScalar(2.1 + Math.sin(t * 9) * 0.1);
				}
			}
		});

		// 波動弾（エネルギー弾）の描画: 存在する弾にスプライトを割り当て、消えたら破棄。
		const projectiles = state.projectiles ?? [];
		const seenProj = new Set<string>();
		for (const pr of projectiles) {
			seenProj.add(pr.id);
			let sp = projSprites.get(pr.id);
			if (!sp) {
				const ownerIdx = state.players.findIndex((p) => p.id === pr.owner);
				const color =
					PLAYER_COLORS[(ownerIdx < 0 ? 0 : ownerIdx) % PLAYER_COLORS.length];
				const mat = new THREE.SpriteMaterial({
					map: sparkTex,
					color,
					blending: THREE.AdditiveBlending,
					depthWrite: false,
					transparent: true,
					fog: false,
				});
				sp = new THREE.Sprite(mat);
				scene.add(sp);
				projSprites.set(pr.id, sp);
			}
			sp.position.set(worldX(pr.x), pr.y * JUMP_WORLD + 0.7, 0.4);
			sp.scale.setScalar(1.5 + Math.sin(t * 22) * 0.18); // 脈動
		}
		for (const [id, sp] of projSprites) {
			if (!seenProj.has(id)) {
				scene.remove(sp);
				(sp.material as THREE.SpriteMaterial).dispose();
				projSprites.delete(id);
			}
		}
		// ファイナルベント中は場を紫に寄せ、紫ライトを焚く
		(scene.fog as THREE.Fog).color.lerp(
			new THREE.Color(final ? 0x2a1052 : 0x0b1220),
			0.1,
		);
		(scene.background as THREE.Color).lerp(
			new THREE.Color(final ? 0x1a0f3a : 0x070b16),
			0.1,
		);
		ventLight.intensity = lerp(ventLight.intensity, final ? 3.2 : 0, 0.12);

		// 格ゲー風フォローカメラ: 生存プレイヤーを画面に収めるよう pan＋zoom
		const shown = state.players.filter((p) => p.hp > 0);
		const xs = (shown.length ? shown : state.players).map((p) => worldX(p.x));
		if (xs.length) {
			// pan の中心は平均位置（端の増減で急に振れないので落ち着く）
			const center = xs.reduce((a, b) => a + b, 0) / xs.length;
			const spread = Math.max(...xs) - Math.min(...xs);
			const vHalf = Math.tan((CAM.fov * Math.PI) / 360);
			// 横が収まる距離をクランプ（幅を狭くしてあるのでズームはわずか）。zoomKick で命中時に寄る。
			const needX = (spread / 2 + CAM.padX) / (vHalf * camera.aspect);
			const dist =
				Math.min(CAM.maxDist, Math.max(CAM.minDist, needX)) - zoomKick;
			camTargetPos.set(center, CAM.y, dist);
			camBase.lerp(camTargetPos, CAM.damp);
			camLook.lerp(tmpVec.set(center, CAM.lookY, 0), CAM.damp);
		}

		// FX の時間発展（スパーク・シェイク・ズーム減衰）
		const dtFx = lastFxT ? Math.min(t - lastFxT, 0.05) : 0;
		lastFxT = t;
		stepFx(dtFx);

		// シェイクは camBase にオフセットを足して描画（次フレームの pan で自己補正）
		camera.position.copy(camBase);
		if (shakeMag > 0) {
			camera.position.x += (Math.random() * 2 - 1) * shakeMag;
			camera.position.y += (Math.random() * 2 - 1) * shakeMag * 0.7;
		}
		camera.lookAt(camLook);

		renderer.render(scene, camera);
	}

	const resize = () => {
		camera.aspect = width() / height();
		camera.updateProjectionMatrix();
		renderer.setSize(width(), height());
	};
	const ro = new ResizeObserver(resize);
	ro.observe(container);

	return {
		render,
		shake,
		hitSpark,
		punch,
		dispose() {
			ro.disconnect();
			for (const av of avatars.values()) av.dispose();
			avatars.clear();
			for (const s of sparks) {
				scene.remove(s.sprite);
				s.mat.dispose();
			}
			sparks.length = 0;
			for (const sp of projSprites.values()) {
				scene.remove(sp);
				(sp.material as THREE.SpriteMaterial).dispose();
			}
			projSprites.clear();
			for (const id of [...guardFx.keys()]) removeGuardFx(id);
			guardTex.dispose();
			sparkTex.dispose();
			floor.geometry.dispose();
			(floor.material as THREE.Material).dispose();
			grid.geometry.dispose();
			disposeObject(backdrop.group);
			renderer.dispose();
			if (renderer.domElement.parentNode === container)
				container.removeChild(renderer.domElement);
		},
	};
}

export interface ArenaRenderer {
	render(state: BattleState, final?: boolean): void;
	// FX（ジュース）: バトル画面が命中検出時に叩く。
	shake(mag: number): void; // 画面シェイク（強さを足し込む）
	hitSpark(normX: number, normY: number, color?: number, big?: boolean): void; // 命中位置に火花
	punch(amount: number): void; // ズームパンチ（一瞬寄る）
	dispose(): void;
}

// ---- box プレースホルダのアバター ----------------------------------------
// 頭・胴・両腕・両脚を box で組んだ人型。肩/股関節をピボットに関節が動く。
// 正式な 3D モデルが決まったら RIDER_MODELS に登録すれば GLB に差し替わる。

function makeBox(
	w: number,
	h: number,
	d: number,
	mat: THREE.Material,
): THREE.Mesh {
	const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
	m.castShadow = true;
	return m;
}

// 上端(ピボット)からぶら下がる手足。Group を回すと肩/股関節から振れる。
function makeLimb(
	len: number,
	thick: number,
	mat: THREE.Material,
): THREE.Group {
	const g = new THREE.Group();
	const m = makeBox(thick, len, thick, mat);
	m.position.y = -len / 2;
	g.add(m);
	return g;
}

function createBoxAvatar(color: number): FighterAvatar {
	const bodyMat = new THREE.MeshStandardMaterial({
		color,
		roughness: 0.45,
		metalness: 0.35,
	});
	const limbMat = new THREE.MeshStandardMaterial({
		color: darken(color, 0.7),
		roughness: 0.6,
		metalness: 0.25,
	});
	const root = new THREE.Group();

	const legLen = 0.85;
	const torsoH = 0.72;
	const hipY = legLen;
	const shoulderY = legLen + torsoH - 0.1;

	const torso = makeBox(0.52, torsoH, 0.3, bodyMat);
	torso.position.y = legLen + torsoH / 2;

	const head = makeBox(0.36, 0.36, 0.36, bodyMat);
	head.position.y = legLen + torsoH + 0.26;
	// 仮面ライダー風のバイザー（顔の +x 側）
	const visor = new THREE.Mesh(
		new THREE.BoxGeometry(0.06, 0.13, 0.28),
		new THREE.MeshStandardMaterial({
			color: 0x101317,
			emissive: 0xff3b3b,
			emissiveIntensity: 0.7,
		}),
	);
	visor.position.set(0.18, 0, 0);
	head.add(visor);

	const legFront = makeLimb(legLen, 0.17, limbMat);
	legFront.position.set(0, hipY, 0.09);
	const legBack = makeLimb(legLen, 0.17, limbMat);
	legBack.position.set(0, hipY, -0.09);

	const armFront = makeLimb(0.64, 0.14, bodyMat);
	armFront.position.set(0, shoulderY, 0.3);
	const armBack = makeLimb(0.64, 0.14, bodyMat);
	armBack.position.set(0, shoulderY, -0.3);

	root.add(torso, head, legFront, legBack, armFront, armBack);

	const pose = {
		armF: 0.12,
		armB: 0.12,
		legF: 0,
		legB: 0,
		tilt: 0,
		glow: 0,
		lunge: 0,
		extraY: 0,
	};

	return {
		root,
		update(p, tSec, moving) {
			const airborne = p.y > 0.001;
			let armF = 0.12;
			let armB = 0.12;
			let legF = 0;
			let legB = 0;
			let tilt = 0;
			let lunge = 0; // facing 方向への踏み込み量（ワールド x）
			let extraY = 0; // 軽い浮き（キック時など）
			let glow = 0;
			let glowColor = color;
			const bob = Math.abs(Math.sin(tSec * 2.4)) * 0.016;

			if (p.hp <= 0 || p.action === "down") {
				tilt = 1.5; // 倒れる
				legF = 0.25;
				legB = -0.25;
			} else if (p.action === "thrown") {
				tilt = 1.2; // 投げられて崩れ落ちる
				lunge = -0.1;
				glow = 0.8;
				glowColor = 0xff5555;
			} else if (p.action === "hit") {
				tilt = 0.32; // のけぞる
				armF = -0.25;
				armB = -0.25;
				lunge = -0.08; // 押される
				glow = 0.9;
				glowColor = 0xff3333;
			} else if (p.action === "punch") {
				armF = 1.55; // 前腕を鋭く突き出す
				armB = -0.5; // 反対の腕は引く（キレを出す）
				legF = 0.15;
				tilt = -0.18; // 踏み込む
				lunge = 0.2;
				glow = 0.5;
			} else if (p.action === "kick") {
				legF = 1.6; // 前脚を蹴り上げる
				legB = -0.2;
				armF = -0.55; // 腕を振ってバランス
				armB = 0.6;
				tilt = 0.2; // 上体を反らす
				lunge = 0.14;
				extraY = 0.07; // 軸脚で軽く伸び上がる
				glow = 0.5;
			} else if (p.action === "final") {
				armF = 1.7;
				armB = 1.7;
				tilt = -0.14;
				lunge = 0.14;
				glow = 1;
				glowColor = 0xffffff;
			} else if (p.action === "throw") {
				armF = 1.25; // 両腕を前に伸ばして掴む
				armB = 1.15;
				tilt = -0.1;
				lunge = 0.22; // 大きく踏み込む
				glow = 0.5;
				glowColor = 0xfbbf24;
			} else if (p.action === "guard") {
				armF = 0.9; // 腕を前に構える
				armB = 0.72;
				legF = 0.14; // 軽く腰を落とす
				legB = -0.14;
				tilt = -0.1;
				glow = 0.55;
				glowColor = 0x38bdf8; // 青いガード光
			} else if (p.action === "abare") {
				armF = -1.0; // 両腕を大きく振り開いて弾き飛ばす
				armB = -1.0;
				legF = 0.3;
				legB = -0.3;
				tilt = -0.05;
				extraY = 0.05;
				glow = 1;
				glowColor = 0xc084fc; // 紫のバースト光
			} else if (airborne) {
				// ジャンプ: 膝を抱えて腕を上げる
				legF = 0.6;
				legB = 0.85;
				armF = -0.7;
				armB = -0.7;
				tilt = 0.06;
			} else if (moving) {
				const s = Math.sin(tSec * 8);
				legF = s * 0.42;
				legB = -s * 0.42;
				armF = -s * 0.32 + 0.12;
				armB = s * 0.32 + 0.12;
				tilt = 0.04;
			}

			// 攻撃・被弾はキビキビ、待機/歩行は滑らかに。
			const combat =
				p.action === "punch" ||
				p.action === "kick" ||
				p.action === "throw" ||
				p.action === "final" ||
				p.action === "abare" ||
				p.action === "hit" ||
				p.action === "thrown";
			const k = combat ? 0.5 : 0.28;
			pose.armF = lerp(pose.armF, armF, k);
			pose.armB = lerp(pose.armB, armB, k);
			pose.legF = lerp(pose.legF, legF, k);
			pose.legB = lerp(pose.legB, legB, k);
			pose.tilt = lerp(pose.tilt, tilt, k);
			pose.lunge = lerp(pose.lunge, lunge, k);
			pose.extraY = lerp(pose.extraY, extraY, k);
			pose.glow = lerp(pose.glow, glow, 0.35);

			armFront.rotation.z = pose.armF;
			armBack.rotation.z = pose.armB;
			legFront.rotation.z = pose.legF;
			legBack.rotation.z = pose.legB;
			root.rotation.z = pose.tilt;
			// render 側が毎フレーム root.position.x = worldX(p.x) を設定した直後に呼ばれるので、
			// ここで踏み込み(lunge)を facing 方向へ足す（次フレームで上書きされるため蓄積しない）。
			root.position.x += pose.lunge * p.facing;
			root.position.y = p.y * JUMP_WORLD + (airborne ? 0 : bob) + pose.extraY;
			bodyMat.emissive.setHex(glowColor);
			bodyMat.emissiveIntensity = pose.glow;
		},
		dispose() {
			disposeObject(root);
		},
	};
}

// ---- GLB モデルのアバター ------------------------------------------------
// ロード完了までは box プレースホルダを表示。完了後にモデル＋AnimationMixer へ差し替え、
// アクションに対応するクリップへクロスフェードする。

// 一回再生（完走後に最終フレームで停止）するアクション。down(death) は倒れたまま維持。
const ONE_SHOT = new Set<AvatarAction>([
	"punch",
	"kick",
	"hit",
	"final",
	"down",
	"throw",
	"thrown",
	"jump",
]);

function createGltfAvatar(model: RiderModel, color: number): FighterAvatar {
	const root = new THREE.Group();
	const placeholder = createBoxAvatar(color); // ロード中の仮表示
	root.add(placeholder.root);

	let mixer: THREE.AnimationMixer | null = null;
	const clipActions = new Map<AvatarAction, THREE.AnimationAction>();
	let current: THREE.AnimationAction | null = null;
	let currentAct: AvatarAction | null = null; // current が表すアクション（idle 代用時は 'idle'）
	let lastAct: AvatarAction | null = null; // ゲーム状態が要求している最新アクション
	let lastT = 0;
	let loaded = false;
	let disposed = false;
	let lean = 0; // クリップ未収録の被弾系を可視化する簡易後傾

	const isLow = (a: AvatarAction) => a === "idle" || a === "walk";

	// act のクリップへクロスフェード。同じワンショットへの再要求（連打）は頭から打ち直す。
	function switchTo(act: AvatarAction) {
		const exact = clipActions.get(act) ?? null; // このアクション専用のクリップ
		const next = exact ?? clipActions.get("idle") ?? null;
		if (!next) return;
		const dur = exact ? ONESHOT_DURATION[act] : undefined;
		if (next === current) {
			if (exact && ONE_SHOT.has(act)) {
				next.reset();
				if (dur) next.setDuration(dur);
				next.play();
				currentAct = act;
			}
			return;
		}
		next.reset();
		if (dur) next.setDuration(dur);
		// 技はキレ優先で素早く入り（0.07s）、通常の切り替えは少しなじませる（0.15s）
		next.fadeIn(exact && ONE_SHOT.has(act) ? 0.07 : 0.15).play();
		current?.fadeOut(0.12);
		current = next;
		currentAct = exact ? act : "idle";
	}

	loadGltfShared(model.url).then(
		(gltf) => {
			if (disposed) return;
			// 骨格ごと複製する。SkinnedMesh は普通の clone() だとボーン参照が元と共有されて
			// アニメが混線するため、必ず SkeletonUtils.clone を使う。
			const obj = cloneSkinned(gltf.scene);
			obj.traverse((o) => {
				const m = o as THREE.Mesh;
				if (m.isMesh) m.castShadow = true;
			});

			// 自動フィット: 実寸から身長を目標値へ合わせ、中心を原点・足元を y=0 へ寄せる。
			// スキンメッシュは Box3.setFromObject だと骨格側のスケール（Mixamo の cm 単位＝
			// Armature 0.01 倍等）を拾えず実寸とズレるため、ボーンのワールド座標から測る。
			obj.updateMatrixWorld(true);
			const box = new THREE.Box3();
			const tmp = new THREE.Vector3();
			let boneCount = 0;
			obj.traverse((o) => {
				if ((o as THREE.Bone).isBone) {
					boneCount++;
					box.expandByPoint(o.getWorldPosition(tmp));
				}
			});
			if (boneCount === 0) box.setFromObject(obj); // 非スキンモデルは従来どおり
			const size = box.getSize(new THREE.Vector3());
			const s =
				model.scale ?? (size.y > 0 ? (model.height ?? 1.9) / size.y : 1);
			obj.position.x -= (box.min.x + box.max.x) / 2;
			obj.position.z -= (box.min.z + box.max.z) / 2;
			obj.position.y -= box.min.y;
			const inner = new THREE.Group(); // 補正は inner に載せ、root は renderer 専用に保つ
			inner.add(obj);
			inner.scale.setScalar(s);
			if (model.rotateY) inner.rotation.y = model.rotateY;
			inner.position.y = model.yOffset ?? 0;

			root.remove(placeholder.root);
			placeholder.dispose();
			root.add(inner);

			mixer = new THREE.AnimationMixer(obj);
			const byName = new Map(gltf.animations.map((c) => [c.name, c]));
			if (model.clips) {
				for (const [act, name] of Object.entries(model.clips) as [
					AvatarAction,
					string,
				][]) {
					const clip = byName.get(name);
					if (!clip) continue;
					if (model.stripRootMotion?.includes(name)) stripRootDrift(clip);
					const action = mixer.clipAction(clip);
					if (ONE_SHOT.has(act)) {
						action.setLoop(THREE.LoopOnce, 1);
						action.clampWhenFinished = true;
					}
					clipActions.set(act, action);
				}
			}
			// ワンショット完走時: 保留していた idle/walk へ遅れて戻る。
			// down(death) は clamp（倒れたまま）を維持するので何もしない。
			mixer.addEventListener("finished", (e) => {
				if (e.action !== current || currentAct === "down") return;
				if (lastAct && lastAct !== currentAct) switchTo(lastAct);
			});
			loaded = true;
		},
		(err) => {
			// 失敗時は box プレースホルダのまま続行（デモを止めない）
			console.warn("[arena3d] GLB load failed:", model.url, err);
		},
	);

	return {
		root,
		update(p, tSec, moving) {
			if (!loaded || !mixer) {
				placeholder.update(p, tSec, moving);
				return;
			}
			root.position.y = p.y * JUMP_WORLD;
			const act = avatarAction(p, moving);
			if (act !== lastAct) {
				lastAct = act;
				// ワンショット再生中に idle/walk へ戻る要求が来ても保留し、クリップを振り切らせる
				// （ゲームの技時間はアニメより短いので、即時に戻すと振りの途中で切れて見える）。
				// 攻撃・被弾・down など優先度の高い要求は即座に割り込む。
				const holding =
					!!current &&
					!!currentAct &&
					ONE_SHOT.has(currentAct) &&
					current.isRunning();
				if (!(isLow(act) && holding)) switchTo(act);
			}
			// クリップ未収録の被弾系（hit / thrown）は軽い後傾でリアクションを可視化する
			const needLean =
				(p.action === "hit" && !clipActions.has("hit")) ||
				(p.action === "thrown" && !clipActions.has("thrown"));
			lean = lerp(lean, needLean ? 0.3 : 0, 0.25);
			root.rotation.z = lean;
			const dt = lastT ? Math.min(tSec - lastT, 0.05) : 0;
			lastT = tSec;
			mixer.update(dt);
		},
		dispose() {
			disposed = true;
			placeholder.dispose();
			mixer?.stopAllAction();
			// モデルの geometry/material は gltfCache の原本と共有しているので dispose しない
			// （他のアバター・以降のロードが壊れる）。シーンからの切り離しだけ行う。
			root.clear();
		},
	};
}

// アバターを1体作る（ライダー別 GLB があれば GLB、無ければ box プレースホルダ）。
// バトルのアリーナ（createArenaRenderer）と勝者画面（winner3d）で同じ見た目・同じ
// 差し替え点を共有するためのヘルパ。RIDER_MODELS に登録すれば両方が自動で 3D 化する。
export function createAvatar(riderId: string, color: number): FighterAvatar {
	const model = RIDER_MODELS[riderId];
	return model ? createGltfAvatar(model, color) : createBoxAvatar(color);
}

// ---- 背景の作り込み ------------------------------------------------------

function rand(a: number, b: number): number {
	return a + Math.random() * (b - a);
}

// 「Webワールド」= インターネット空間の中のアリーナ、という世界観の背景。
// 電脳グラデーションの空、ワイヤーフレーム地球(The Web)、浮遊するブラウザウィンドウ、
// コードレイン、ステージ裏を流れるデータパケット、漂う HTML タグ断片で構成する。
// group と update(t) を返し、renderer が毎フレーム update を呼んでゆっくり動かす。
interface BackdropHandle {
	group: THREE.Group;
	update(t: number): void;
}

function buildBackdrop(): BackdropHandle {
	const group = new THREE.Group();
	const updaters: ((t: number) => void)[] = [];

	// 電脳空間のグラデーション空（大きな板）
	const sky = new THREE.Mesh(
		new THREE.PlaneGeometry(240, 90),
		new THREE.MeshBasicMaterial({
			map: makeGradientTexture(),
			fog: false,
			depthWrite: false,
		}),
	);
	sky.position.set(0, 22, -45);
	group.add(sky);

	// ワイヤーフレームの地球 = 「The Web」。月の代わりのランドマーク。ゆっくり自転。
	const globe = new THREE.Mesh(
		new THREE.IcosahedronGeometry(4.6, 1),
		new THREE.MeshBasicMaterial({
			color: 0x38bdf8,
			wireframe: true,
			transparent: true,
			opacity: 0.65,
			fog: false,
		}),
	);
	globe.position.set(-17, 24, -43);
	globe.rotation.x = 0.35;
	const globeGlow = new THREE.Mesh(
		new THREE.CircleGeometry(6.8, 48),
		new THREE.MeshBasicMaterial({
			color: 0x1d4ed8,
			transparent: true,
			opacity: 0.2,
			blending: THREE.AdditiveBlending,
			depthWrite: false,
			fog: false,
		}),
	);
	globeGlow.position.set(-17, 24, -43.6);
	group.add(globeGlow, globe);
	updaters.push((t) => {
		globe.rotation.y = t * 0.18;
	});

	// 星（データの瞬き）
	group.add(makeStars());

	// 浮遊するブラウザ / ターミナルのウィンドウ群（遠景の UI パネル）。ゆっくり上下に漂う。
	const winDefs = [
		{ x: -27, y: 13, z: -34, w: 8, h: 5.6, accent: "#38bdf8", kind: "browser" },
		{
			x: -13,
			y: 7.5,
			z: -27,
			w: 5.6,
			h: 4,
			accent: "#a78bfa",
			kind: "terminal",
		},
		{ x: 1, y: 16, z: -38, w: 7, h: 4.8, accent: "#34d399", kind: "terminal" },
		{ x: 14, y: 9, z: -29, w: 6.4, h: 4.4, accent: "#f472b6", kind: "browser" },
		{ x: 27, y: 15, z: -35, w: 8, h: 5.4, accent: "#fbbf24", kind: "browser" },
		{ x: -36, y: 8, z: -30, w: 6, h: 4.2, accent: "#34d399", kind: "terminal" },
		{
			x: 36,
			y: 10,
			z: -32,
			w: 6.6,
			h: 4.6,
			accent: "#38bdf8",
			kind: "terminal",
		},
	] as const;
	for (const [i, def] of winDefs.entries()) {
		const win = new THREE.Group();
		const panel = new THREE.Mesh(
			new THREE.PlaneGeometry(def.w, def.h),
			new THREE.MeshBasicMaterial({
				map:
					def.kind === "terminal"
						? makeTerminalTexture(def.accent)
						: makeBrowserTexture(def.accent),
				transparent: true,
				opacity: 0.92,
			}),
		);
		const glow = new THREE.Mesh(
			new THREE.PlaneGeometry(def.w * 1.06, def.h * 1.09),
			new THREE.MeshBasicMaterial({
				color: new THREE.Color(def.accent),
				transparent: true,
				opacity: 0.16,
				blending: THREE.AdditiveBlending,
				depthWrite: false,
			}),
		);
		glow.position.z = -0.05;
		win.add(glow, panel);
		win.position.set(def.x, def.y, def.z);
		win.rotation.y = def.x * -0.008; // うっすら中央（アリーナ）の方を向かせる
		group.add(win);
		const phase = i * 1.7;
		updaters.push((t) => {
			win.position.y = def.y + Math.sin(t * 0.5 + phase) * 0.45;
			win.rotation.z = Math.sin(t * 0.32 + phase) * 0.02;
		});
	}

	// コードレイン（流れ落ちるグリフの柱）。テクスチャの offset を回してループさせる。
	// 幅・速度・濃さをバラして「空間の奥までコードが降っている」密度を出す。
	const rainTex = makeCodeRainTexture();
	for (const def of [
		{ x: -38, z: -28, s: 0.05, w: 1.4, o: 0.3 },
		{ x: -32, z: -26, s: 0.065, w: 1.7, o: 0.42 },
		{ x: -25, z: -20, s: 0.09, w: 1.2, o: 0.35 },
		{ x: -20, z: -18, s: 0.075, w: 1.9, o: 0.45 },
		{ x: -11, z: -24, s: 0.055, w: 1.4, o: 0.3 },
		{ x: -6, z: -30, s: 0.06, w: 2.1, o: 0.4 },
		{ x: 4, z: -26, s: 0.1, w: 1.2, o: 0.32 },
		{ x: 9, z: -19, s: 0.08, w: 1.7, o: 0.45 },
		{ x: 17, z: -28, s: 0.06, w: 1.4, o: 0.3 },
		{ x: 22, z: -24, s: 0.055, w: 2.0, o: 0.42 },
		{ x: 30, z: -21, s: 0.085, w: 1.3, o: 0.35 },
		{ x: 36, z: -30, s: 0.07, w: 1.8, o: 0.4 },
	]) {
		const tex = rainTex.clone(); // 画像は共有、offset だけ個別
		tex.needsUpdate = true;
		const col = new THREE.Mesh(
			new THREE.PlaneGeometry(def.w, 15),
			new THREE.MeshBasicMaterial({
				map: tex,
				transparent: true,
				opacity: def.o,
				blending: THREE.AdditiveBlending,
				depthWrite: false,
			}),
		);
		col.position.set(def.x, 8.5, def.z);
		group.add(col);
		updaters.push((t) => {
			tex.offset.y = t * def.s;
		});
	}

	// ステージ裏を流れるデータパケット（回線のラインと、その上を走る光）
	const lanes = [
		{ y: 3.2, z: -15, color: 0x38bdf8, speed: 0.14 },
		{ y: 5.6, z: -21, color: 0x34d399, speed: 0.09 },
		{ y: 8.4, z: -27, color: 0xf472b6, speed: 0.11 },
		{ y: 11.4, z: -32, color: 0xa78bfa, speed: 0.07 },
	];
	for (const [i, lane] of lanes.entries()) {
		const line = new THREE.Mesh(
			new THREE.PlaneGeometry(96, 0.03),
			new THREE.MeshBasicMaterial({
				color: lane.color,
				transparent: true,
				opacity: 0.14,
				blending: THREE.AdditiveBlending,
				depthWrite: false,
			}),
		);
		line.position.set(0, lane.y, lane.z);
		group.add(line);
		for (let k = 0; k < 2; k++) {
			const packet = new THREE.Mesh(
				new THREE.PlaneGeometry(0.9, 0.1),
				new THREE.MeshBasicMaterial({
					color: lane.color,
					transparent: true,
					opacity: 0.9,
					blending: THREE.AdditiveBlending,
					depthWrite: false,
				}),
			);
			packet.position.set(0, lane.y, lane.z);
			group.add(packet);
			const phase = i * 0.31 + k * 0.5;
			const dir = i % 2 === 0 ? 1 : -1; // レーンごとに流れる向きを変える
			updaters.push((t) => {
				const f = (t * lane.speed + phase) % 1;
				packet.position.x = dir * (-48 + f * 96);
			});
		}
	}

	// 漂うコード断片（HTML タグ・API・ログ・エラー）。世界のノイズとして多めに散らす。
	const tags = [
		{ text: "<html>", color: "#38bdf8", x: -30, y: 5, z: -17 },
		{ text: 'fetch("/battle")', color: "#a78bfa", x: -18, y: 12, z: -22 },
		{ text: "{ }", color: "#fbbf24", x: -8, y: 4.4, z: -14 },
		{ text: "ws://arena", color: "#34d399", x: 3, y: 10, z: -18 },
		{ text: "200 OK", color: "#34d399", x: 12, y: 5.2, z: -15 },
		{ text: "<final-vent/>", color: "#f472b6", x: 21, y: 12.5, z: -23 },
		{ text: "</div>", color: "#38bdf8", x: 31, y: 6.5, z: -18 },
		{
			text: 'console.log("HENSHIN")',
			color: "#7dd3fc",
			x: -34,
			y: 15.5,
			z: -26,
		},
		{ text: "npm run battle", color: "#fda4af", x: -24, y: 3.2, z: -13 },
		{ text: "if (hp <= 0) down()", color: "#fbbf24", x: -2, y: 13.8, z: -25 },
		{ text: "POST /henshin 201", color: "#a78bfa", x: 8, y: 15.5, z: -28 },
		{ text: "404 Not Found", color: "#f87171", x: 17, y: 3.4, z: -13 },
		{ text: "0xDEADBEEF", color: "#f472b6", x: 27, y: 9.8, z: -20 },
		{ text: "await punch()", color: "#7dd3fc", x: 36, y: 13.5, z: -24 },
		{ text: "git push --force", color: "#f87171", x: -12, y: 17, z: -30 },
	];
	for (const [i, def] of tags.entries()) {
		const sprite = makeTextSprite(def.text, def.color);
		sprite.position.set(def.x, def.y, def.z);
		group.add(sprite);
		const phase = i * 1.3;
		updaters.push((t) => {
			sprite.position.y = def.y + Math.sin(t * 0.6 + phase) * 0.35;
			(sprite.material as THREE.SpriteMaterial).opacity =
				0.62 + Math.sin(t * 1.7 + phase) * 0.18;
		});
	}

	// バイナリのティッカー（ステージ裏を横に流れる 0/1 とステータスコードの帯）
	const tickerTex = makeTickerTexture();
	for (const def of [
		{ y: 1.6, z: -13, s: 0.02, dir: 1, o: 0.3 },
		{ y: 14.5, z: -34, s: 0.012, dir: -1, o: 0.22 },
	]) {
		const tex = tickerTex.clone();
		tex.needsUpdate = true;
		tex.repeat.x = 3;
		const strip = new THREE.Mesh(
			new THREE.PlaneGeometry(110, 1.0),
			new THREE.MeshBasicMaterial({
				map: tex,
				transparent: true,
				opacity: def.o,
				blending: THREE.AdditiveBlending,
				depthWrite: false,
			}),
		);
		strip.position.set(0, def.y, def.z);
		group.add(strip);
		updaters.push((t) => {
			tex.offset.x = t * def.s * def.dir;
		});
	}

	// 回転するワイヤーフレームのデータキューブ（浮遊するデータブロック）
	for (const [i, def] of [
		{ x: -22, y: 16.5, z: -30, size: 1.6, color: 0x38bdf8 },
		{ x: -9, y: 9.2, z: -21, size: 1.0, color: 0xa78bfa },
		{ x: 15, y: 17.5, z: -33, size: 2.0, color: 0x34d399 },
		{ x: 25, y: 4.6, z: -16, size: 0.9, color: 0xf472b6 },
	].entries()) {
		const cube = new THREE.Mesh(
			new THREE.BoxGeometry(def.size, def.size, def.size),
			new THREE.MeshBasicMaterial({
				color: def.color,
				wireframe: true,
				transparent: true,
				opacity: 0.45,
			}),
		);
		cube.position.set(def.x, def.y, def.z);
		group.add(cube);
		const phase = i * 0.9;
		updaters.push((t) => {
			cube.rotation.x = t * 0.4 + phase;
			cube.rotation.y = t * 0.31 + phase;
			cube.position.y = def.y + Math.sin(t * 0.45 + phase) * 0.5;
		});
	}

	// 空に薄く浮かぶ巨大コード透かし（世界そのものがコードでできている感）
	const watermark = makeTextSprite("</>", "#38bdf8");
	watermark.scale.set(46, 8.6, 1);
	watermark.position.set(14, 24, -44);
	(watermark.material as THREE.SpriteMaterial).opacity = 0.07;
	group.add(watermark);

	// 地面のスポットグロー
	group.add(makeGroundGlow());

	return {
		group,
		update(t) {
			for (const u of updaters) u(t);
		},
	};
}

function makeGradientTexture(): THREE.CanvasTexture {
	const c = document.createElement("canvas");
	c.width = 8;
	c.height = 256;
	const ctx = ctx2d(c);
	const g = ctx.createLinearGradient(0, 0, 0, 256);
	g.addColorStop(0.0, "#010409"); // 深宇宙（データの海の最深部）
	g.addColorStop(0.42, "#061530");
	g.addColorStop(0.7, "#0c2b57"); // シアン寄りの中景
	g.addColorStop(0.86, "#2a1b63"); // 地平線近くの電脳パープル
	g.addColorStop(1.0, "#0b1020");
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, 8, 256);
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

// ブラウザウィンドウ風テクスチャ（タイトルバー＋信号ボタン＋アドレスバー＋本文の行）。
function makeBrowserTexture(accent: string): THREE.CanvasTexture {
	const c = document.createElement("canvas");
	c.width = 160;
	c.height = 112;
	const ctx = ctx2d(c);
	ctx.fillStyle = "#0b1424";
	ctx.fillRect(0, 0, 160, 112);
	// タイトルバー＋信号ボタン（macOS 風の3点）
	ctx.fillStyle = "#111c33";
	ctx.fillRect(0, 0, 160, 14);
	for (const [i, col] of ["#ff5f57", "#febc2e", "#28c840"].entries()) {
		ctx.fillStyle = col;
		ctx.beginPath();
		ctx.arc(9 + i * 9, 7, 2.6, 0, Math.PI * 2);
		ctx.fill();
	}
	// アドレスバー
	ctx.fillStyle = "#081020";
	ctx.fillRect(5, 18, 150, 10);
	ctx.fillStyle = accent;
	ctx.font = "8px ui-monospace, monospace";
	ctx.fillText("https://web-world.arena", 10, 26);
	// 本文（テキスト行。たまにリンク色）
	let y = 38;
	while (y < 104) {
		ctx.fillStyle = Math.random() < 0.25 ? accent : "#33415e";
		ctx.fillRect(8, y, rand(60, 140), 4);
		y += 9;
	}
	// 枠線
	ctx.globalAlpha = 0.8;
	ctx.strokeStyle = accent;
	ctx.strokeRect(0.5, 0.5, 159, 111);
	ctx.globalAlpha = 1;
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

// コードレイン用テクスチャ（縦に並ぶグリフ列。wrapT + offset.y でループスクロール）。
function makeCodeRainTexture(): THREE.CanvasTexture {
	const c = document.createElement("canvas");
	c.width = 48;
	c.height = 512;
	const ctx = ctx2d(c);
	const glyphs = "01<>/{}();=#$&%?";
	ctx.font = "bold 11px ui-monospace, monospace";
	for (let col = 0; col < 4; col++) {
		for (let y = 8; y < 512; y += 13) {
			if (Math.random() < 0.3) continue;
			const bright = Math.random() < 0.12; // たまに先頭グリフっぽく明るく
			ctx.fillStyle = bright
				? "rgba(190,255,230,0.95)"
				: `rgba(56,239,154,${rand(0.15, 0.6).toFixed(2)})`;
			ctx.fillText(
				glyphs[Math.floor(Math.random() * glyphs.length)],
				3 + col * 12,
				y,
			);
		}
	}
	const tex = new THREE.CanvasTexture(c);
	tex.wrapS = THREE.RepeatWrapping;
	tex.wrapT = THREE.RepeatWrapping;
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

// 漂うタグ用のテキストスプライト（ネオン発光風）。
function makeTextSprite(text: string, color: string): THREE.Sprite {
	const c = document.createElement("canvas");
	c.width = 512;
	c.height = 96;
	const ctx = ctx2d(c);
	ctx.font = "bold 44px ui-monospace, monospace";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.shadowColor = color;
	ctx.shadowBlur = 18;
	ctx.fillStyle = color;
	ctx.fillText(text, 256, 48, 496);
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	const sprite = new THREE.Sprite(
		new THREE.SpriteMaterial({
			map: tex,
			transparent: true,
			depthWrite: false,
		}),
	);
	sprite.scale.set(6.4, 1.2, 1); // canvas の縦横比(512:96)に合わせる
	return sprite;
}

// ターミナル風テクスチャ（変身〜ファイナルベントまでのログが流れている体）。
function makeTerminalTexture(accent: string): THREE.CanvasTexture {
	const c = document.createElement("canvas");
	c.width = 160;
	c.height = 112;
	const ctx = ctx2d(c);
	ctx.fillStyle = "#04080f";
	ctx.fillRect(0, 0, 160, 112);
	ctx.fillStyle = "#0d1526";
	ctx.fillRect(0, 0, 160, 12);
	ctx.fillStyle = accent;
	ctx.font = "7px ui-monospace, monospace";
	ctx.fillText("web-world — zsh", 6, 9);
	const lines = [
		"$ pnpm dev",
		"VITE ready in 312 ms",
		"-> ws://arena connected",
		"$ henshin --rider ryuki",
		"[ok] card matched (ORB)",
		"[ok] pose verified",
		"$ final-vent --charge 100",
		"BOOM. 34 dmg",
	];
	let ly = 24;
	for (const line of lines) {
		ctx.fillStyle = line.startsWith("$") ? "#e5e7eb" : "#22c55e";
		ctx.fillText(line, 6, ly);
		ly += 11;
	}
	// ブロックカーソル
	ctx.fillStyle = accent;
	ctx.fillRect(6, ly - 7, 5, 8);
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

// ティッカー用テクスチャ（横一列の 0/1 とステータスの帯。wrapS + offset.x でループ）。
function makeTickerTexture(): THREE.CanvasTexture {
	const c = document.createElement("canvas");
	c.width = 1024;
	c.height = 24;
	const ctx = ctx2d(c);
	ctx.font = "bold 14px ui-monospace, monospace";
	ctx.textBaseline = "middle";
	const words = [
		"01101001",
		"GET /battle 200",
		"10010110",
		"ws PING 12ms",
		"11011000",
		"POST /final-vent 201",
		"00101101",
	];
	let x = 0;
	let w = 0;
	while (x < 1024) {
		const word = words[w % words.length];
		w++;
		ctx.fillStyle = /^[01]+$/.test(word)
			? "rgba(56,189,248,0.55)"
			: "rgba(52,211,153,0.8)";
		ctx.fillText(word, x, 12);
		x += ctx.measureText(word).width + 26;
	}
	const tex = new THREE.CanvasTexture(c);
	tex.wrapS = THREE.RepeatWrapping;
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

function makeStars(): THREE.Points {
	const n = 320;
	const pos = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) {
		pos[i * 3] = rand(-70, 70);
		pos[i * 3 + 1] = rand(8, 45);
		pos[i * 3 + 2] = rand(-46, -18);
	}
	const geo = new THREE.BufferGeometry();
	geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
	const mat = new THREE.PointsMaterial({
		color: 0x9fc6ff,
		size: 0.18,
		sizeAttenuation: true,
		transparent: true,
		opacity: 0.85,
		fog: false,
	});
	return new THREE.Points(geo, mat);
}

function makeGroundGlow(): THREE.Mesh {
	const c = document.createElement("canvas");
	c.width = 128;
	c.height = 128;
	const ctx = ctx2d(c);
	const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
	g.addColorStop(0, "rgba(120,180,255,0.55)");
	g.addColorStop(1, "rgba(120,180,255,0)");
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, 128, 128);
	const m = new THREE.Mesh(
		new THREE.PlaneGeometry(22, 12),
		new THREE.MeshBasicMaterial({
			map: new THREE.CanvasTexture(c),
			transparent: true,
			opacity: 0.6,
			blending: THREE.AdditiveBlending,
			depthWrite: false,
			fog: false,
		}),
	);
	m.rotation.x = -Math.PI / 2;
	m.position.y = 0.02;
	return m;
}

// ヒットスパーク用テクスチャ（白＋十字フレア。色は SpriteMaterial.color で着色）。
function makeSparkTexture(): THREE.CanvasTexture {
	const c = document.createElement("canvas");
	c.width = 64;
	c.height = 64;
	const ctx = ctx2d(c);
	const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
	g.addColorStop(0, "rgba(255,255,255,1)");
	g.addColorStop(0.3, "rgba(255,255,255,0.7)");
	g.addColorStop(0.7, "rgba(255,255,255,0.18)");
	g.addColorStop(1, "rgba(255,255,255,0)");
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, 64, 64);
	// 十字のフレア（ヒットっぽさ）
	ctx.strokeStyle = "rgba(255,255,255,0.85)";
	ctx.lineWidth = 2.5;
	ctx.beginPath();
	ctx.moveTo(32, 3);
	ctx.lineTo(32, 61);
	ctx.moveTo(3, 32);
	ctx.lineTo(61, 32);
	ctx.stroke();
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

// ガードシールド用テクスチャ。淡い面＋外周リング＋六角形でエネルギー障壁を表す。
// 色は SpriteMaterial 側で乗せるので白で描く。
function makeGuardTexture(): THREE.CanvasTexture {
	const c = document.createElement("canvas");
	c.width = 128;
	c.height = 128;
	const ctx = ctx2d(c);
	const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
	g.addColorStop(0, "rgba(255,255,255,0.30)");
	g.addColorStop(0.75, "rgba(255,255,255,0.12)");
	g.addColorStop(0.92, "rgba(255,255,255,0.38)");
	g.addColorStop(1, "rgba(255,255,255,0)");
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, 128, 128);
	ctx.strokeStyle = "rgba(255,255,255,0.9)";
	ctx.lineWidth = 3;
	ctx.beginPath();
	ctx.arc(64, 64, 58, 0, Math.PI * 2);
	ctx.stroke();
	ctx.strokeStyle = "rgba(255,255,255,0.55)";
	ctx.lineWidth = 2;
	ctx.beginPath();
	for (let i = 0; i < 6; i++) {
		const a = (Math.PI / 3) * i - Math.PI / 2;
		const x = 64 + Math.cos(a) * 40;
		const y = 64 + Math.sin(a) * 40;
		if (i === 0) ctx.moveTo(x, y);
		else ctx.lineTo(x, y);
	}
	ctx.closePath();
	ctx.stroke();
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

function disposeObject(obj: THREE.Object3D) {
	obj.traverse((o) => {
		const m = o as THREE.Mesh;
		if (m.geometry) m.geometry.dispose();
		const mat = m.material as THREE.Material | THREE.Material[] | undefined;
		if (Array.isArray(mat)) {
			for (const x of mat) x.dispose();
		} else if (mat) {
			mat.dispose();
		}
	});
}
