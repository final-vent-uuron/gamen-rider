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
import { modelUrl } from "../model-assets";
import type { BattleState, PlayerState } from "./state";
import { ARENA } from "./state";

// プレイヤー表示色（battle.tsx の PLAYER_COLORS と対応）。
const PLAYER_COLORS = [0xa78bfa, 0xf87171, 0x34d399, 0xfbbf24, 0x38bdf8];
const WORLD_W = 28; // 正規化 x(0..1) をワールド X(-14..14) に写す（ステージ横幅）
const JUMP_WORLD = 2.4; // 正規化ジャンプ高さ(y) → ワールド高さ

// 格ゲー風フォローカメラの設定。据わった横視点で、ゆっくり pan、ズームは控えめ。
const CAM = {
	fov: 36, // やや望遠（平面的で 2D 格ゲーっぽい見え方）
	y: 2.7, // カメラ高さ（低め＝横視点）
	lookY: 3.0, // 注視点の高さ。キャラの頭上を見る＝画面の中心が上がり、キャラは下寄り・背景が広く映る
	padX: 2.5, // 左右の余白（ワールド）
	halfY: 2.6, // 縦に収める範囲（ジャンプで無理に引かない）
	minDist: 15, // 最接近（近づきすぎると迫力はあるが状況が見えないので遠めに据える）
	maxDist: 30, // 最遠（ステージ幅 28 の端↔端でも全員収まる距離）
	damp: 0.045, // 追従の滑らかさ（小さい＝ゆっくり据わる）
};

// アバターのアクション。GLB のアニメクリップ対応付けのキーにも使う。
export type AvatarAction =
	| "idle"
	| "walk"
	| "punch"
	| "kick"
	| "shot" // 波動弾の発射動作（固有技クリップの差し替え点）
	| "turn" // 振り向き（facing 反転時に差し込む。ゲーム状態からは要求されない見た目専用）
	| "hit"
	| "hit-air" // 空中被弾（Final の打ち上げ等。吹き飛びリアクション）
	| "down"
	| "final"
	| "jump"
	| "guard"
	| "throw" // 掴みかかり（grasp）
	| "throw-hit" // 掴み成立（grasp-attack）
	| "thrown"
	| "abare";

// ライダー別 GLB モデルの登録。ここに 1 行足すだけで box プレースホルダから差し替わる。
//   例) GLB を用意したら（Vite なら import url from '#/assets/models/swift.glb?url'）:
//   export const RIDER_MODELS = {
//     swift: {
//       url: swiftUrl,
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
	// アクション → GLB 内クリップ名。配列で複数登録すると再生のたびにランダムに
	// 選ばれる（左右パンチの打ち分け等。直前と同じ変種は続かないようにする）。
	clips?: Partial<Record<AvatarAction, string | string[]>>;
	// ルートモーション（腰の平行移動ドリフト）を除去してその場アニメ化するクリップ名。
	// In Place でエクスポートされていない走り/歩きに使う（移動はゲーム側が行うため）。
	stripRootMotion?: string[];
	// 腰(Hips)の平行移動アニメを先頭キーの位置で固定するクリップ名。
	// 移動・ジャンプなどの位置はゲーム側が root を動かして表現するため、クリップ側にも
	// 腰の移動が入っていると二重に動いて見える（走りの揺すり・ジャンプの二段上昇など）。
	// 固定しても手足・体幹の回転アニメはそのまま残る。倒れる death のように腰の移動が
	// 本質的なクリップには使わないこと。
	freezeHipsTranslation?: string[];
	// 腰(Hips)の「傾き」を idle クリップの開始姿勢に揃えるクリップ名。
	// 取り込み元が違うアニメは腰の基準回転ごと傾きが焼き込まれていることがある
	// （このモデルの run がそれ。走ると横に傾いて見える）。
	// 縦軸まわりの回転（キャラの向き）とクリップ内の相対的な動きは保たれる。
	// 平均の傾きしか直さないため、周期的な傾き（揺れ）は残る。それも消したい場合は
	// flattenLateralTilt を使う。
	alignHipsToIdle?: string[];
	// 胸（腰＋背骨の合成）の「左右の傾き」を毎キー除去するクリップ名。
	// 前後の傾き（走りの前傾等）・体の向き・ひねりは保たれ、横倒れだけが消える。
	// 横倒れが本質のクリップ（kick・death 等）には使わないこと。
	flattenLateralTilt?: string[];
	// 腰の「向き（ヨー）」の変化を先頭キーで固定するクリップ名。
	// 振り向き（Quick 180 Turn）等、体の回転が焼き込まれたクリップに使う。
	// キャラの向きは renderer の振り向き補間が権威なので、クリップ側の回転は二重になる。
	stripYaw?: string[];
}

// 全ライダー共通の既定モデル（/model-check・/battle-test で検証済み）。
// 実バトル(/battle)・検証(/battle-test)・勝者画面(createAvatar) が共通の fallback として使う。
// ライダー別に見た目を分けたくなったら RIDER_MODELS へ riderId ごとに登録する（そちらが優先）。
// - walk: run クリップを使用。前進のルートモーション焼き込みあり → stripRootMotion で
//   その場走り化。run / punch / guard には左右の傾きが焼き込まれている（実測。焼き込み先は
//   hips だったり背骨だったりクリップ次第）ため flattenLateralTilt で毎キー除去。
// - kick: 前進のルートモーション焼き込みあり（±1.2 ワールド相当）→ strip しないと
//   見た目だけ前へ滑って当たり判定とズレる。
// - hit / thrown: reaction クリップを共用。
// - final / throw / abare は未収録 → idle フォールバック。
export const DEFAULT_RIDER_MODEL: RiderModel = {
	url: modelUrl("gamen-rider-python-animation.v2.glb"),
	height: 0.5, // box アバター(約1.9)より一回り小さめ。画面に対して大きすぎたため
	rotateY: Math.PI / 2, // Mixamo リグは +z 正面 → このゲームの正面 +x へ
	clips: {
		idle: "idle",
		walk: "run",
		down: "death",
		jump: "jump",
		punch: "punch",
		kick: "kick",
		guard: "guard",
		hit: "reaction",
		"hit-air": "reaction", // 空中被弾も同じリアクション（専用クリップ無し）
		thrown: "reaction",
	},
	stripRootMotion: ["kick"],
	// 走り・ジャンプ・ガードは位置をゲーム側が管理する（クリップ側の腰移動は二重になる）。
	// run はこれでルートモーション除去も兼ねる。
	freezeHipsTranslation: ["run", "jump", "guard"],
	// punch は腰の基準回転ごと斜めに焼き込まれている（arduino モデルのパンチと同じ症状）ため、
	// まず平均姿勢を idle に揃え（align）、残る左右の傾きを毎キー除去する（flatten）。
	alignHipsToIdle: ["punch"],
	flattenLateralTilt: ["run", "punch", "guard"],
};

export const RIDER_MODELS: Record<string, RiderModel> = {
	// ライダー別に差し替えたくなったら riderId をキーにここへ登録する。
	// 未登録のライダーは fallbackModel（あれば）→ box プレースホルダの順で描画される。
	// キーは /select の言語ライダー id（arduino / swift / python / flutter / cpp）。
	// swift / cpp は GLB 未用意のため未登録 → 共通モデル(python)にフォールバック。
	python: DEFAULT_RIDER_MODEL,
	arduino: {
		// モーション大量収録版（2026-07-19 R2 アップロード）。
		// 収録: death / error-mode / grasp / grasp-attack / grasp-reaction / idle / jump /
		//       jump.001 / large-reaction / left-kick / left-punch / right-kick /
		//       right-punch / run / skill / small-reaction / special / turn
		// turn は facing 反転時に差し込む。焼き込みの 180°回転がそのまま「回るモーション」になる。
		url: modelUrl("arduino-add-animation.glb"),
		height: 0.5,
		rotateY: Math.PI / 2,
		clips: {
			idle: "idle",
			walk: "run",
			down: "death",
			jump: ["jump", "jump.001"], // 2 種をランダム（連続ジャンプの単調さ回避）
			punch: ["left-punch", "right-punch"], // 左右を打ち分け（ランダム交互）
			kick: ["left-kick", "right-kick"],
			guard: "guard", // ガード構え（構えている間ループ）
			shot: "skill", // 波動弾＝固有技（skill）
			turn: "turn", // 振り向き（Quick 180。焼き込み回転で回る。再生中 renderer は root yaw を停止）
			hit: "small-reaction",
			"hit-air": "large-reaction", // Final の打ち上げ等＝吹き飛びリアクション
			thrown: "grasp-reaction", // 投げられ（掴まれてやられる）
			throw: "grasp", // 掴みかかり（まだ当たっていない。空振りはこのまま）
			"throw-hit": "grasp-attack", // 掴み成立 → 攻撃（state.ts の throw-hit）
			final: "special", // ファイナルベント＝必殺
			abare: "error-mode", // 暴れ＝Arduino がエラーで暴走するイメージ
		},
		// python モデルと同じ Mixamo 系パイプラインのためルートモーション補正も同構成。
		// キック・掴み攻撃・固有技は前進の焼き込みが入りやすい → その場化（位置はゲーム側が管理）。
		stripRootMotion: ["left-kick", "right-kick", "grasp-attack", "skill"],
		// large-reaction（Flying Back）は後方への移動が本体に焼き込まれている。吹き飛び距離は
		// ゲーム側（knockback/launch）が権威なので腰の平行移動は殺し、のけぞりだけ使う。
		// turn は位置だけゲーム側が権威（平行移動は殺す）。回転は焼き込みをそのまま使い、
		// 再生中は renderer が root の yaw 補間を止める（二重回転の回避）。
		freezeHipsTranslation: [
			"run",
			"jump",
			"jump.001",
			"large-reaction",
			"turn",
			"guard", // 構えの立ち位置はゲーム側が権威（クリップ側の腰移動は二重になる）
		],
		// パンチは腰の基準回転ごと斜めに焼き込まれている（取り込み元差）ため、
		// まず平均姿勢を idle に揃え（align）、残る左右の傾きを毎キー除去する（flatten）。
		alignHipsToIdle: ["left-punch", "right-punch"],
		flattenLateralTilt: ["run", "left-punch", "right-punch"],
	},
	flutter: {
		// モーション大量収録版（2026-07-20 R2 アップロード）。収録クリップ・補正は
		// arduino（arduino-add-animation.glb）と同じモーションパック構成。
		url: modelUrl("flutter-add-animation.glb"),
		height: 0.5,
		rotateY: Math.PI / 2,
		clips: {
			idle: "idle",
			walk: "run",
			down: "death",
			jump: ["jump", "jump.001"],
			punch: ["left-punch", "right-punch"],
			kick: ["left-kick", "right-kick"],
			guard: "guard",
			shot: "skill",
			turn: "turn",
			hit: "small-reaction",
			"hit-air": "large-reaction",
			thrown: "grasp-reaction",
			throw: "grasp",
			"throw-hit": "grasp-attack",
			final: "special",
			abare: "error-mode",
		},
		stripRootMotion: ["left-kick", "right-kick", "grasp-attack", "skill"],
		freezeHipsTranslation: [
			"run",
			"jump",
			"jump.001",
			"large-reaction",
			"turn",
			"guard",
		],
		alignHipsToIdle: ["left-punch", "right-punch"],
		flattenLateralTilt: ["run", "left-punch", "right-punch"],
	},
};

// box でも GLB でも renderer からは同じに見えるアバター。
export interface FighterAvatar {
	root: THREE.Object3D;
	// 毎フレーム、プレイヤー状態に合わせて見た目を更新する。
	update(p: PlayerState, tSec: number, moving: boolean): void;
	dispose(): void;
	// --- 振り向き（turn クリップ）連携。実装はクリップを持つ GLB アバターのみ ---
	// facing 反転時に renderer から呼ぶ。turn クリップの再生を開始したら true。
	// 再生中は renderer が root の yaw を止め、クリップの焼き込み回転に回転を任せる。
	playTurn?(p: PlayerState, moving: boolean): boolean;
	// turn クリップ再生中か（true の間、renderer は root の yaw を固定する）。
	isTurning?(): boolean;
	// turn がこのフレームで終わったか（一度だけ true。renderer は root yaw をスナップする）。
	consumeTurnEnd?(): boolean;
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

// バトル前の画面（認証中など）から呼び、使用する全 GLB を裏でロードしておく。
// gltfCache に載るので、/battle 到達時にはダウンロードもパースも済んだ状態になる
// （SPA 遷移でモジュールが生き続ける前提。リロードしてもブラウザの HTTP キャッシュは残る）。
// 失敗したものはキャッシュから外し、バトル側の本ロードで再試行させる。
export function preloadRiderModels(): void {
	const urls = new Set<string>([
		DEFAULT_RIDER_MODEL.url,
		...Object.values(RIDER_MODELS).map((m) => m.url),
	]);
	for (const url of urls) {
		loadGltfShared(url).catch(() => gltfCache.delete(url));
	}
}

// ルートモーション除去: 各 position トラックから「最初→最後のキーへ直線的に進む
// ドリフト成分」を水平方向だけ差し引き、その場アニメに変換する。上下のバウンド等の
// 周期成分は残る。
// 縦（hips トラックの乗る Armature ローカルでは -Z が上。HIPS_UP 参照）は差し引かない:
// しゃがみ姿勢で終わるクリップ（grasp-attack 等）の腰の沈み込みまで消すと、
// 脚だけ畳まれて宙に浮いて見える。対象は一回再生の技クリップなのでループ継ぎ目は無い。
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
		for (let k = 0; k < n; k++) {
			const f = (times[k] - times[0]) / span;
			values[k * 3] -= dx * f;
			values[k * 3 + 1] -= dy * f;
		}
	}
}

// 腰(Hips)の平行移動アニメを先頭キーで固定する（freezeHipsTranslation 用）。
// 体全体の位置はゲーム側（root）が動かすので、クリップ側の腰移動は二重の動きになる。
// クリップはキャッシュ経由で全アバター共有のため、二重適用を WeakSet で防ぐ。
const hipsFrozen = new WeakSet<THREE.AnimationClip>();
export function freezeHipsPosition(clip: THREE.AnimationClip) {
	if (hipsFrozen.has(clip)) return;
	hipsFrozen.add(clip);
	for (const track of clip.tracks) {
		if (!track.name.endsWith(".position") || !/hips/i.test(track.name))
			continue;
		const v = track.values;
		for (let i = 3; i < v.length; i += 3) {
			v[i] = v[0];
			v[i + 1] = v[1];
			v[i + 2] = v[2];
		}
	}
}

// 腰(Hips)回転の基準ズレ補正: クリップ中の腰の「平均的な傾き」が参照クリップ（idle）の
// 平均と揃うよう、回転トラック全キーへ同じ補正クォータニオンを前掛けする。
// - 補正は「上方向の平均 → idle の上方向の平均」への最短弧回転だけ。姿勢を丸ごと揃えると
//   縦軸まわりの回転（＝キャラの向き）まで回ってしまい、走る向きが狂う。
// - 先頭キーではなく全キーの平均で合わせる。走りは周期的に体が揺れるので、先頭 1 キーを
//   水平にしてもサイクル平均では斜めに傾いたままになる。
// - 一括回転なので、クリップ内の相対的な動き（バウンド・ひねり・体の揺れ）はそのまま残る。
// クリップはキャッシュ経由で全アバター共有のため、二重適用を WeakSet で防ぐ。
const hipsAligned = new WeakSet<THREE.AnimationClip>();
// 縦軸（ワールド上方向）。Mixamo は Armature が +90°X 回転しているため、
// hips トラックが乗る Armature ローカル空間では -Z が上にあたる。
const HIPS_UP = new THREE.Vector3(0, 0, -1);
function findHipsQuaternionTrack(c: THREE.AnimationClip) {
	return c.tracks.find(
		(t) => t.name.endsWith(".quaternion") && /hips/i.test(t.name),
	);
}
export function alignHipsRotation(
	clip: THREE.AnimationClip,
	ref: THREE.AnimationClip,
) {
	if (hipsAligned.has(clip)) return;
	hipsAligned.add(clip);
	const src = findHipsQuaternionTrack(clip);
	const refTrack = findHipsQuaternionTrack(ref);
	if (!src || !refTrack) return;
	// idle 先頭が直立している前提で、hips ボーン空間の「上」を逆算する。
	const qRef0 = new THREE.Quaternion().fromArray(refTrack.values, 0);
	const upBone = HIPS_UP.clone().applyQuaternion(qRef0.clone().invert());
	// トラック全キーでの「上方向」の平均（＝そのクリップの平均的な立ち姿勢）。
	const meanUp = (values: ArrayLike<number>) => {
		const m = new THREE.Vector3();
		const q = new THREE.Quaternion();
		for (let i = 0; i < values.length; i += 4) {
			m.add(upBone.clone().applyQuaternion(q.fromArray(values, i)));
		}
		return m.normalize();
	};
	// クリップの平均上方向 → idle の平均上方向 への最短弧回転。
	// 回転軸は両者に直交する（≒水平）ので、キャラの向き（heading）はほぼ保たれる。
	const fix = new THREE.Quaternion().setFromUnitVectors(
		meanUp(src.values),
		meanUp(refTrack.values),
	);
	const q = new THREE.Quaternion();
	for (let i = 0; i < src.values.length; i += 4) {
		q.fromArray(src.values, i).premultiply(fix);
		q.toArray(src.values, i);
	}
}

// 胸の左右傾き除去: 腰〜背骨の合成でできる「胸の姿勢」から左右の傾き（正面軸まわりの
// ロール）だけを毎キー測り、打ち消す回転を hips トラックへ前掛けする。
// 傾きの焼き込み先はクリップごとに違う:
//   - run: hips が左右に振れるが背骨が打ち消すので胸は揺れのみ（hips 単体を直すと
//     打ち消し役の背骨だけが残り、逆に胸が傾く）
//   - guard: hips は idle と同じなのに背骨側に約9°の横傾き（python モデル・実測）
//   - arduino の punch: 胸で約9〜16°の横傾き（実測）
// そのため hips 単体ではなく胸の合成姿勢で誤差を測るのが要点。
// - 除去するのは左右の傾きだけ。前後の傾き（走りの前傾・パンチの踏み込み）、体の向き、
//   ひねりはそのまま残る。
// - 横倒れが本質のクリップ（kick・death 等）には使わないこと。
// クリップはキャッシュ経由で全アバター共有のため、二重適用を WeakSet で防ぐ。
const lateralFlattened = new WeakSet<THREE.AnimationClip>();
// Armature ローカルでの正面（HIPS_UP と同じ座標前提。ワールドの +Z にあたる）。
const HIPS_FORWARD = new THREE.Vector3(0, 1, 0);
export function flattenLateralRotation(
	clip: THREE.AnimationClip,
	ref: THREE.AnimationClip,
) {
	if (lateralFlattened.has(clip)) return;
	lateralFlattened.add(clip);
	const hips = findHipsQuaternionTrack(clip);
	const refHips = findHipsQuaternionTrack(ref);
	if (!hips || !refHips) return;
	// 背骨チェーンの回転トラック（Spine → Spine1 → Spine2。名前順が親子順に一致）。
	// 任意時刻を補間器で評価して合成する。トラックが無いクリップでは hips のみで測る。
	const composeSpine = (c: THREE.AnimationClip) => {
		const interps = c.tracks
			.filter((t) => /spine\d*\.quaternion$/i.test(t.name))
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((t) => t.InterpolantFactoryMethodLinear());
		const q = new THREE.Quaternion();
		return (t: number, out: THREE.Quaternion) => {
			out.identity();
			for (const ip of interps) {
				const v = ip.evaluate(t) as Float32Array;
				out.multiply(q.set(v[0], v[1], v[2], v[3]));
			}
			return out;
		};
	};
	const spineOfClip = composeSpine(clip);
	const spineOfRef = composeSpine(ref);
	// idle 先頭の胸の合成姿勢（＝直立の基準）から、胸ボーン空間での「上」を逆算する。
	const chest = new THREE.Quaternion();
	const spin = new THREE.Quaternion();
	chest
		.fromArray(refHips.values, 0)
		.multiply(spineOfRef(refHips.times[0], spin));
	const upBone = HIPS_UP.clone().applyQuaternion(chest.clone().invert());

	const qh = new THREE.Quaternion();
	const up = new THREE.Vector3();
	const fix = new THREE.Quaternion();
	for (let k = 0; k < hips.times.length; k++) {
		qh.fromArray(hips.values, k * 4);
		chest.copy(qh).multiply(spineOfClip(hips.times[k], spin));
		up.copy(upBone).applyQuaternion(chest); // このキーでの胸の上方向
		// 正面軸まわりの左右傾き角。直立（up = HIPS_UP）なら 0。
		const theta = Math.atan2(-up.x, -up.z);
		fix.setFromAxisAngle(HIPS_FORWARD, -theta);
		qh.premultiply(fix);
		qh.toArray(hips.values, k * 4);
	}
}

// 腰(Hips)の「向き（ヨー＝縦軸まわりの回転）」の変化を先頭キーで固定する（stripYaw 用）。
// Quick 180 Turn のような振り向きクリップは体の回転そのものが焼き込まれているが、
// キャラの向きはゲーム側（renderer の root 振り向き補間）が権威なので二重回転になる。
// ヨーだけを毎キー打ち消し、足の踏み替え・体の傾き・ひねりは残す。
// クリップはキャッシュ経由で全アバター共有のため、二重適用を WeakSet で防ぐ。
const yawStripped = new WeakSet<THREE.AnimationClip>();
export function stripHipsYaw(
	clip: THREE.AnimationClip,
	ref: THREE.AnimationClip,
) {
	if (yawStripped.has(clip)) return;
	yawStripped.add(clip);
	const hips = findHipsQuaternionTrack(clip);
	const refHips = findHipsQuaternionTrack(ref);
	if (!hips || !refHips) return;
	// idle 先頭（直立・正面向き）から「hips ボーン空間の正面」を逆算し、
	// 各キーの正面ベクトルを水平面（HIPS_FORWARD / e2 平面）に落としてヨー角を測る。
	const qRef0 = new THREE.Quaternion().fromArray(refHips.values, 0);
	const fBone = HIPS_FORWARD.clone().applyQuaternion(qRef0.clone().invert());
	const e2 = HIPS_UP.clone().cross(HIPS_FORWARD); // 水平面のもう1軸
	const f = new THREE.Vector3();
	const q = new THREE.Quaternion();
	const fix = new THREE.Quaternion();
	const yawOf = (quat: THREE.Quaternion) => {
		f.copy(fBone).applyQuaternion(quat);
		return Math.atan2(f.dot(e2), f.dot(HIPS_FORWARD));
	};
	const yaw0 = yawOf(q.fromArray(hips.values, 0));
	for (let i = 0; i < hips.values.length; i += 4) {
		q.fromArray(hips.values, i);
		fix.setFromAxisAngle(HIPS_UP, yaw0 - yawOf(q));
		q.premultiply(fix);
		q.toArray(hips.values, i);
	}
}

// Canvas 2D コンテキスト取得（テクスチャ生成用。取得失敗は環境異常なので即例外）。
function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
	const ctx = c.getContext("2d");
	if (!ctx) throw new Error("2d context unavailable");
	return ctx;
}

// 頭上のプレイヤー番号タグのテクスチャ（「1P」等。自分は下に「YOU」を併記）。
// 格ゲー風の太字イタリック＋黒フチ。色はプレイヤーカラー。
function makeTagTexture(
	label: string,
	color: number,
	isSelf: boolean,
): THREE.CanvasTexture {
	const c = document.createElement("canvas");
	c.width = 256;
	c.height = 128;
	const ctx = ctx2d(c);
	const colorCss = `#${color.toString(16).padStart(6, "0")}`;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.lineJoin = "round";
	// 番号（1P など）
	ctx.font = "italic 900 64px system-ui, sans-serif";
	ctx.lineWidth = 14;
	ctx.strokeStyle = "rgba(0,0,0,0.85)";
	ctx.strokeText(label, 128, isSelf ? 44 : 64);
	ctx.fillStyle = colorCss;
	ctx.fillText(label, 128, isSelf ? 44 : 64);
	// 自分にだけ YOU（どれが自分か一目で分かるように）
	if (isSelf) {
		ctx.font = "900 30px system-ui, sans-serif";
		ctx.lineWidth = 8;
		ctx.strokeText("あなた", 128, 96);
		ctx.fillStyle = "#ffffff";
		ctx.fillText("あなた", 128, 96);
	}
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
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
	// 空中で被弾（Final の打ち上げ・空中ヒット）は吹き飛びリアクション。クリップ未登録の
	// モデルでは hit ではなく idle に落ちるため、クリップ側で hit-air を hit と同じにしておく。
	if (p.action === "hit" || p.action === "shield-break")
		return p.y > 0.001 ? "hit-air" : "hit";
	if (p.action === "thrown") return "thrown";
	if (p.action === "guard") return "guard";
	if (p.action === "throw") return "throw";
	if (p.action === "throw-hit") return "throw-hit";
	if (p.action === "abare") return "abare";
	if (p.action === "punch") return "punch";
	if (p.action === "kick") return "kick";
	if (p.action === "shot") return "shot";
	if (p.action === "final") return "final";
	if (p.y > 0.001) {
		// 被弾由来の滞空（打ち上げられた・空中で殴られた直後）は、硬直が明けても
		// ジャンプモーションに切り替えず吹き飛びのまま落とす。コンボ被弾中
		// （comboCount > 0。着弾から ~0.8s でリセット）を「被弾由来」の目印にする。
		if (p.comboCount > 0) return "hit-air";
		return "jump";
	}
	if (moving) return "walk";
	return "idle";
}

// 一回再生クリップの目標再生時間（秒）。見た目重視の手調整値。
// 技（punch/kick/throw/final）は state.ts の MOVES 合計時間をこの尺に合わせてあり、
// 「アニメを振っている間＝行動ロック」が一致する。尺を変えるときは MOVES 側も揃えること。
// ヒットでキャンセルされた場合はゲーム状態が先に切り替わるが、クリップは次の技へ
// クロスフェードするので破綻しない（update 側の保留ロジックは短い hit/jump 用に残す）。
const ONESHOT_DURATION: Partial<Record<AvatarAction, number>> = {
	// クリップ本来の尺（punch 2.03s / kick 1.53s / jump 0.27s / reaction 1.47s）との差は
	// setDuration の再生速度調整で吸収する（短ければ振り切り、長ければ早回し）。
	punch: 0.8,
	kick: 1.4, // = MOVES.kick 合計 1400ms（left/right-kick 素の尺 ~1.7s → 1.2倍速）
	shot: 1.0, // = MOVES.shot 合計 1000ms（skill 素の尺 2.6s → 2.6倍速。0.53s だと 5倍速で不自然）
	throw: 1.2, // = MOVES.throw 合計 1200ms（掴みかかり grasp。空振り時はこのまま振り切る）
	"throw-hit": 1.8, // = MOVES.throw recoveryOnHit 1800ms（grasp-attack 素の尺 2.07s → 1.15倍速）
	thrown: 0.9, // grasp-reaction の再生尺。hitstun(1200ms) の残りは倒れ姿勢で保持（clamp）
	final: 3.1, // = MOVES.final 合計 3100ms（暴れ範囲技。special クリップをゆっくり再生して尺を合わせる）
	hit: 0.5,
	"hit-air": 0.9, // Final の打ち上げ hitstun(520ms)＋滞空のなじみ分
	turn: 0.45, // renderer の振り向き補間(~0.25s)＋踏み替えの余韻（素の尺 0.93s → 2倍速）
	jump: 2.4, // 0.5倍速（従来 1.2s 目標の半分の速さ）。滞空(~1.2s)より長いが着地で即切り替える
	abare: 1.8, // = ARENA.abareRecovery 1800ms（ゆっくり再生。終わりぎわ 1400ms に突き放しが入る）
	// down(death) は指定なし＝クリップ本来の速度で最後まで再生し、倒れたまま止める
};

// レンダラ生成オプション。
export interface ArenaOptions {
	// RIDER_MODELS 未登録ライダーに使う共通 GLB。省略時は box プレースホルダ。
	// 実バトル(/battle)・検証(/battle-test)とも DEFAULT_RIDER_MODEL を渡している。
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
	scene.fog = new THREE.Fog(0x0b1220, 32, 62); // カメラ最遠(30)でもキャラが霞まない距離

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
	scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a3547, 1.25));
	const key = new THREE.DirectionalLight(0xffffff, 1.5);
	key.position.set(5, 11, 7);
	key.castShadow = true;
	key.shadow.mapSize.set(1024, 1024);
	key.shadow.camera.left = -16; // ステージ幅 28 の端でも影が切れないように
	key.shadow.camera.right = 16;
	key.shadow.camera.top = 8;
	key.shadow.camera.bottom = -2;
	key.shadow.camera.near = 1;
	key.shadow.camera.far = 30;
	scene.add(key);
	const rim = new THREE.DirectionalLight(0x5577aa, 0.55);
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
	const facings = new Map<string, 1 | -1>(); // 前フレームの facing（turn クリップ差し込みの検出用）
	const worldX = (x: number) => (x - 0.5) * WORLD_W;

	// プレイヤー番号タグ（キャラ頭上の「1P」「2P」…）。
	// 頭の高さ(topY)はアバターの実寸から測る。GLB は非同期ロードで後から身長が変わる
	// （ロード完了で root に子が増える）ので、子の数の変化を検知して測り直す。
	const playerTags = new Map<
		string,
		{
			sprite: THREE.Sprite;
			mat: THREE.SpriteMaterial;
			tex: THREE.CanvasTexture;
			childCount: number;
			topY: number;
		}
	>();
	const tagBox = new THREE.Box3();
	const tagVec = new THREE.Vector3();
	function removeTag(id: string) {
		const tag = playerTags.get(id);
		if (!tag) return;
		scene.remove(tag.sprite);
		tag.mat.dispose();
		tag.tex.dispose();
		playerTags.delete(id);
	}

	// --- FX（ジュース）: 画面シェイク / ヒットスパーク / ズームパンチ ---
	const camBase = new THREE.Vector3(0, CAM.y, 12);
	let shakeMag = 0;
	let zoomKick = 0;
	let lastFxT = 0;
	// スローモーション用のアニメ専用クロック。実時間 t とは別に timeScale 倍で進み、
	// slowmo() が呼ばれた間だけ減速する（止め演出で死亡/必殺モーションをゆっくり見せる）。
	// 背景・FX・カメラ追従は実時間 t のままなので、キャラの動きだけがスローになる。
	let animClock = 0;
	let lastAnimT = 0;
	let timeScale = 1; // 現在のアニメ再生倍率（1 = 等速。なめらかに減速/復帰する）
	let slowUntilMs = 0; // この実時刻まで減速（Date.now 基準）
	let slowTargetScale = 1; // 減速中に狙う倍率
	let cutinFrozenT: number | null = null; // カットイン中に固定するアニメ時刻（全員静止用）
	const cutinBox = new THREE.Box3(); // カットイン中の身長実測用（ボーンのワールド座標から）
	const cutinTmp = new THREE.Vector3();
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
	// スローモーションを焚く（止め演出用）。durationMs の間、アバターのアニメを scale 倍速へ
	// なめらかに落とし、明けたら等速へ戻す。ゲーム状態・カメラ・FX には触れない見た目専用。
	function slowmo(durationMs = 1400, scale = 0.26) {
		slowUntilMs = Date.now() + durationMs;
		slowTargetScale = scale;
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

	// アバターの実身長（ワールド）をボーンのワールド座標から測る。カメラ寄せ（カットイン・
	// 乱入）で足元ではなく顔〜上半身を映すため。スキンメッシュは Box3.setFromObject では
	// 骨格スケールを拾えないのでボーンで測る。wy = そのキャラの接地ワールド Y。
	function avatarHeight(id: string, wy: number): number {
		let h = playerTags.get(id)?.topY ?? 1.6; // 実測できないときの後備え
		const av = avatars.get(id);
		if (av) {
			cutinBox.makeEmpty();
			let bones = 0;
			av.root.traverse((o) => {
				if ((o as THREE.Bone).isBone) {
					bones++;
					cutinBox.expandByPoint(o.getWorldPosition(cutinTmp));
				}
			});
			if (bones > 0 && Number.isFinite(cutinBox.max.y)) {
				h = Math.max(0.4, cutinBox.max.y - wy);
			}
		}
		return h;
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
				facings.delete(id);
				removeGuardFx(id);
				removeTag(id);
			}
		}

		const t = performance.now() / 1000;
		backdrop.update(t); // Webワールド背景のアニメ（浮遊ウィンドウ・コードレイン・パケット）

		// アニメ専用クロックを進める。通常は等速、slowmo() 中だけ timeScale が落ちて
		// アバターのモーションがスローになる（背景・カメラ・FX は実時間 t のまま）。
		const dtReal = lastAnimT ? Math.min(t - lastAnimT, 0.05) : 0;
		lastAnimT = t;
		const targetScale = Date.now() < slowUntilMs ? slowTargetScale : 1;
		timeScale += (targetScale - timeScale) * 0.18; // なめらかに入って戻る
		animClock += dtReal * timeScale;

		// カード技のカットイン／ファイナルベント溜め／乱入の演出中は、全アバターのアニメを
		// 静止させる（ゲーム状態もサーバー側で完全停止）。下のカメラ処理で発動者／乱入者へ寄る。
		const cutin =
			state.cutin && Date.now() < state.cutin.until ? state.cutin : null;
		const vent =
			state.finalVent && Date.now() < state.finalVent.until
				? state.finalVent
				: null;
		const focusPlayerId = cutin?.playerId ?? vent?.playerId ?? null;
		const intruding = (state.intrusionUntil ?? 0) > Date.now();
		if (cutin || vent || intruding) {
			if (cutinFrozenT === null) cutinFrozenT = animClock;
		} else {
			cutinFrozenT = null;
		}
		const tAnim = cutinFrozenT ?? animClock;

		state.players.forEach((p, index) => {
			const av = ensureAvatar(p, index);
			const wx = worldX(p.x);
			av.root.position.x = wx;
			const prev = lastX.get(p.id) ?? wx;
			const moving = Math.abs(wx - prev) > 0.003;
			lastX.set(p.id, wx);

			// 振り向き。turn クリップを持つアバターは「クリップの焼き込み回転」に回転を任せ、
			// その間 root の yaw は止める（両方回すと二重回転になる）。クリップが無い/使えない
			// 状況では従来どおり root をカメラ側（正面）経由でなめらかに補間して回す。
			const targetYaw = p.facing === 1 ? 0 : -Math.PI;
			const prevYaw = yaws.get(p.id) ?? targetYaw;
			const prevFacing = facings.get(p.id) ?? p.facing;
			facings.set(p.id, p.facing);
			let turning = av.isTurning?.() ?? false;
			if (!turning && p.facing !== prevFacing) {
				// 反転の瞬間に turn クリップの再生を試みる（接地・通常時のみ成功する）
				turning = av.playTurn?.(p, moving) ?? false;
			}
			const yaw = turning ? prevYaw : lerp(prevYaw, targetYaw, 0.16); // 補間は約 0.2 秒で回りきる
			yaws.set(p.id, yaw);
			av.root.rotation.y = yaw;
			av.update(p, tAnim, moving);
			// turn クリップがこのフレームで終わった場合、クリップの回転が消えるのと
			// 同フレームで root を目標向きへスナップして繋ぐ（1フレームの向き抜けを防ぐ）。
			if (av.consumeTurnEnd?.()) {
				yaws.set(p.id, targetYaw);
				av.root.rotation.y = targetYaw;
			}

			// 頭上のプレイヤー番号タグ（1P/2P…）。自分は色付きで「YOU」を併記。
			let tag = playerTags.get(p.id);
			if (!tag) {
				const color = PLAYER_COLORS[index % PLAYER_COLORS.length];
				const tex = makeTagTexture(`${index + 1}P`, color, p.isSelf);
				const mat = new THREE.SpriteMaterial({
					map: tex,
					transparent: true,
					depthWrite: false,
					fog: false,
				});
				const sprite = new THREE.Sprite(mat);
				scene.add(sprite);
				tag = { sprite, mat, tex, childCount: -1, topY: 1.0 };
				playerTags.set(p.id, tag);
			}
			if (av.root.children.length !== tag.childCount) {
				// アバターの実寸から頭の高さを測る（スキンメッシュは Box3 だと骨格スケールを
				// 拾えないため、ロード時計測と同じくボーンのワールド座標から測る）。
				tag.childCount = av.root.children.length;
				av.root.updateMatrixWorld(true);
				tagBox.makeEmpty();
				let bones = 0;
				av.root.traverse((o) => {
					if ((o as THREE.Bone).isBone) {
						bones++;
						tagBox.expandByPoint(o.getWorldPosition(tagVec));
					}
				});
				if (bones === 0) tagBox.setFromObject(av.root);
				const top = tagBox.max.y;
				if (Number.isFinite(top))
					tag.topY = Math.max(0.4, top - av.root.position.y);
				// タグの大きさは身長に比例させる（モデルごとの全高差があっても見た目が揃う）
				const s = Math.min(1.4, Math.max(0.45, tag.topY * 0.9));
				tag.sprite.scale.set(s, s / 2, 1);
			}
			tag.sprite.position.set(
				av.root.position.x,
				av.root.position.y + tag.topY * 1.15 + 0.18,
				0,
			);
			tag.mat.opacity = p.hp <= 0 ? 0.3 : 0.95; // KO したら薄く

			// ガードシールド: ガード中はフェードインして正面に維持、解除でフェードアウト。
			// 耐久に応じて大きさ・色が変わる（満タン＝大きく青、削れると小さく赤く＝割れ間近）。
			const guarding = p.action === "guard" && p.hp > 0;
			const shieldRatio = Math.max(
				0,
				Math.min(1, p.shield / ARENA.shieldMax),
			);
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
				g.mat.opacity = lerp(g.mat.opacity, guarding ? 0.55 + shieldRatio * 0.35 : 0, 0.25);
				if (!guarding && g.mat.opacity < 0.03) {
					removeGuardFx(p.id);
				} else {
					// キャラの実寸（tag.topY = 頭の高さ）に比例させて配置する。
					// 固定値だと box アバター(~1.9)基準になり、GLB(全高 0.5)ではシールドが
					// キャラよりだいぶ前・上に浮いて見える。前方オフセットは付けず、
					// キャラと同じ x（体の中心）・胸の高さに重ねる。
					const h = tag.topY;
					const size = h * (0.85 + shieldRatio * 0.45);
					g.sprite.position.set(wx, p.y * JUMP_WORLD + h * 0.52, 0.5);
					g.sprite.scale.setScalar(size + Math.sin(t * 9) * 0.04);
					// 耐久低下: シアン → 黄 → 赤
					const c =
						shieldRatio > 0.45
							? 0x38bdf8
							: shieldRatio > 0.2
								? 0xfbbf24
								: 0xf87171;
					g.mat.color.setHex(c);
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
		// 場の色: ファイナルベント中は紫、乱入中は危険な赤に寄せる（両方無ければ通常）。
		const fogTarget = final ? 0x2a1052 : intruding ? 0x2a0810 : 0x0b1220;
		const bgTarget = final ? 0x1a0f3a : intruding ? 0x1a0608 : 0x070b16;
		(scene.fog as THREE.Fog).color.lerp(new THREE.Color(fogTarget), 0.1);
		(scene.background as THREE.Color).lerp(new THREE.Color(bgTarget), 0.1);
		// 演出ライト: final は紫、乱入は赤。乱入者へ寄るので位置も乱入者側へ。
		ventLight.color.set(intruding && !final ? 0xff3b3b : 0xa855f7);
		ventLight.intensity = lerp(
			ventLight.intensity,
			final ? 3.2 : intruding ? 2.4 : 0,
			0.12,
		);

		// カットイン中は発動者へ斜め前から寄る近接カット（明けたら通常カメラの damp で自然に引く）
		const cutinPlayer = focusPlayerId
			? state.players.find((p) => p.id === focusPlayerId)
			: null;
		// 乱入中は乱入者（新規参戦者）。カットインが同時に走ることは無いので排他に扱う。
		const intruder =
			intruding && state.intruderId && !cutinPlayer
				? state.players.find((p) => p.id === state.intruderId) ?? null
				: null;
		if (cutinPlayer) {
			const wx = worldX(cutinPlayer.x);
			const wy = cutinPlayer.y * JUMP_WORLD;
			const h = avatarHeight(cutinPlayer.id, wy);
			// 向いている方向へ回り込み、顔〜上半身を見る。lerp 強め＝素早くドリーイン
			camTargetPos.set(
				wx + cutinPlayer.facing * h * 0.5,
				wy + h * 0.85,
				Math.max(1.5, h * 1.1),
			);
			camBase.lerp(camTargetPos, 0.22);
			camLook.lerp(tmpVec.set(wx, wy + h * 0.72, 0), 0.22);
		} else if (intruder) {
			// 乱入者の正面・低めから煽り気味に寄る（見上げる構図＝「強敵が現れた」）。
			// 通常フォロー位置から始まるので、ゆっくりめの lerp で「じわっと寄る」ドリーインになる。
			// ventLight も乱入者側へ寄せて赤く照らす。
			const wx = worldX(intruder.x);
			const wy = intruder.y * JUMP_WORLD;
			const h = avatarHeight(intruder.id, wy);
			ventLight.position.set(wx + intruder.facing * h * 0.6, wy + h * 0.6, 6);
			camTargetPos.set(
				wx + intruder.facing * (h * 0.55 + 0.8), // 正面へ回り込む
				wy + h * 0.5, // 低め＝見上げる
				Math.max(1.4, h * 1.15),
			);
			camBase.lerp(camTargetPos, 0.11); // ゆっくり寄る（push-in を見せる）
			camLook.lerp(tmpVec.set(wx, wy + h * 0.95, 0), 0.11); // 頭上気味を見る＝煽り
		} else {
			ventLight.position.set(0, 5, 8); // 通常位置へ戻す
		}

		// 格ゲー風フォローカメラ: 生存プレイヤーを画面に収めるよう pan＋zoom
		const shown = state.players.filter((p) => p.hp > 0);
		const xs = (shown.length ? shown : state.players).map((p) => worldX(p.x));
		if (!cutinPlayer && !intruder && xs.length) {
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
		slowmo,
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
			for (const id of [...playerTags.keys()]) removeTag(id);
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
	slowmo(durationMs?: number, scale?: number): void; // 止め演出のスローモーション
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
			} else if (p.action === "shield-break") {
				armF = -0.85;
				armB = -0.85;
				legF = 0.2;
				legB = -0.15;
				tilt = Math.sin(tSec * 18) * 0.25; // 割れ硬直のふらつき
				glow = 0.7;
				glowColor = 0xfbbf24;
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
// ロード完了までは何も表示しない（旧 box プレースホルダは見た目が混ざるため廃止）。
// 完了後にモデル＋AnimationMixer を追加し、アクションに対応するクリップへクロスフェードする。
// 動き（走り・技・傾き等）はすべて GLB のクリップに任せ、手続き的なモーションは足さない。

// 一回再生（完走後に最終フレームで停止）するアクション。down(death) は倒れたまま維持。
const ONE_SHOT = new Set<AvatarAction>([
	"punch",
	"kick",
	"shot",
	"turn",
	"hit",
	"hit-air",
	"final",
	"down",
	"throw",
	"throw-hit",
	"thrown",
	"jump",
	"abare",
]);

function createGltfAvatar(model: RiderModel, _color: number): FighterAvatar {
	const root = new THREE.Group();

	let mixer: THREE.AnimationMixer | null = null;
	// アクション → 再生候補のクリップ群（複数登録時はランダムに選ぶ。左右パンチ等）
	const clipActions = new Map<AvatarAction, THREE.AnimationAction[]>();
	let current: THREE.AnimationAction | null = null;
	let currentAct: AvatarAction | null = null; // current が表すアクション（idle 代用時は 'idle'）
	let lastAct: AvatarAction | null = null; // ゲーム状態が要求している最新アクション
	// 直近の技インスタンス（move:開始時刻）。同じアクション名が連続する連打
	// （左パンチ→右パンチ等。間に idle を挟まない）でも新しい技として打ち直すための鍵。
	let lastMoveKey: string | null = null;
	let turning = false; // turn クリップ再生中（renderer が root yaw を止める）
	let turnEnded = false; // turn がこのフレームで終わった（renderer が yaw をスナップして消費）
	let turnStartedAt = 0; // 開始時刻(s)。finished を取りこぼしても固まらないための保険
	let lastT = 0;
	let loaded = false;
	let disposed = false;

	const isLow = (a: AvatarAction) => a === "idle" || a === "walk";

	// act のクリップへクロスフェード。同じワンショットへの再要求（連打）は頭から打ち直す。
	// 複数クリップが登録されたアクション（左右パンチ等）は、side（moveSide: 入力の左右）が
	// あれば対応するクリップ（left-* / right-*）を確定選択、無ければランダムに選び、
	// 直前と同じ変種が続かないようにする（連打で左右が交互に出る見た目になる）。
	function switchTo(act: AvatarAction, side?: "left" | "right") {
		const exactList = clipActions.get(act) ?? null; // このアクション専用のクリップ群
		const list = exactList ?? clipActions.get("idle") ?? null;
		if (!list || list.length === 0) return;
		const exact = !!exactList;
		const dur = exact ? ONESHOT_DURATION[act] : undefined;
		let next: THREE.AnimationAction | undefined;
		if (side && list.length > 1) {
			next = list.find((a) => a.getClip().name.includes(side));
		}
		if (!next) {
			next = list[Math.floor(Math.random() * list.length)];
			if (list.length > 1 && next === current) {
				next = list[(list.indexOf(next) + 1) % list.length];
			}
		}
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

			root.add(inner);

			mixer = new THREE.AnimationMixer(obj);
			const byName = new Map(gltf.animations.map((c) => [c.name, c]));
			// idle は変種を持たない前提（複数指定されていても先頭を基準にする）
			const idleName = Array.isArray(model.clips?.idle)
				? model.clips.idle[0]
				: model.clips?.idle;
			const idleClip = idleName ? byName.get(idleName) : undefined;
			// バインドポーズ対策: このモデル群のバインドポーズはうつ伏せ（地面向き）。
			// mixer はクロスフェード中にアクションのウェイト合計が 1 を割ると、不足分を
			// 「最初にバインドした時点のポーズ」で埋めるため、そのままだと出現直後や
			// idle↔走り の切り替わり（fadeIn 0.15s / fadeOut 0.12s の非対称区間）で
			// 一瞬うつ伏せ方向へ倒れて見える。先にボーンへ idle の先頭キーを書き込み、
			// 不足分の補完先を直立姿勢にしておく。
			// ※ 上の自動フィット計測より後に行うこと（スケール調整はバインドポーズ計測
			//    に対して合わせ込み済みのため、順序を変えると見た目の大きさが変わる）。
			if (idleClip) {
				for (const track of idleClip.tracks) {
					// トラック名は "ノード名.quaternion" 等（GLTFLoader がノード名を揃えている）
					const dot = track.name.lastIndexOf(".");
					const target = obj.getObjectByName(track.name.slice(0, dot));
					if (!target) continue;
					const prop = track.name.slice(dot + 1);
					if (prop === "quaternion")
						target.quaternion.fromArray(track.values, 0);
					else if (prop === "position")
						target.position.fromArray(track.values, 0);
					else if (prop === "scale") target.scale.fromArray(track.values, 0);
				}

				// 再センタリング: 上の原点合わせは「うつ伏せのバインドポーズ」の箱で行っている
				// ため、idle で立ち上がると体が原点から前後にずれる（root 基準のシールド・
				// タグ・当たり判定の見た目がずれて見える原因）。idle の立ち姿で測り直し、
				// 位置だけ root 直下(inner)で補正する。スケールは合わせ込み済みなので触らない。
				// x/z の基準は腰（Hips）ボーン＝体の芯。ボーン全体の箱の中心だと、idle で
				// 前に出ている腕まで含まれて体が後ろへ寄りすぎる（補正しすぎになる）。
				// ※ 計測は必ず「root ローカル」で行うこと。この時点で root には renderer が
				//    プレイヤーのステージ座標（worldX 等）を入れていることがあり、ワールド値の
				//    まま引くとその座標ぶんキャラが飛ぶ。root.matrixWorld の逆行列で戻す。
				root.updateMatrixWorld(true);
				const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
				let hipsBone: THREE.Object3D | null = null;
				const standBox = new THREE.Box3();
				let standBones = 0;
				obj.traverse((o) => {
					if ((o as THREE.Bone).isBone) {
						standBones++;
						standBox.expandByPoint(
							o.getWorldPosition(tmp).applyMatrix4(rootInv),
						);
						if (!hipsBone && /hips/i.test(o.name)) hipsBone = o;
					}
				});
				if (standBones > 0 && Number.isFinite(standBox.min.y)) {
					// 計測値は root ローカル（= inner の親空間）なので、そのまま引けば補正になる。
					if (hipsBone) {
						const hp = (hipsBone as THREE.Object3D)
							.getWorldPosition(tmp)
							.applyMatrix4(rootInv);
						inner.position.x -= hp.x;
						inner.position.z -= hp.z;
					} else {
						inner.position.x -= (standBox.min.x + standBox.max.x) / 2;
						inner.position.z -= (standBox.min.z + standBox.max.z) / 2;
					}
					// 足元（立ち姿の箱の底＝足ボーン）を yOffset へ接地し直す
					inner.position.y += (model.yOffset ?? 0) - standBox.min.y;
				}
			}
			if (model.clips) {
				for (const [act, names] of Object.entries(model.clips) as [
					AvatarAction,
					string | string[],
				][]) {
					const actions: THREE.AnimationAction[] = [];
					for (const name of Array.isArray(names) ? names : [names]) {
						const clip = byName.get(name);
						if (!clip) continue;
						if (model.stripRootMotion?.includes(name)) stripRootDrift(clip);
						if (model.freezeHipsTranslation?.includes(name))
							freezeHipsPosition(clip);
						if (
							idleClip &&
							clip !== idleClip &&
							model.alignHipsToIdle?.includes(name)
						)
							alignHipsRotation(clip, idleClip);
						if (
							idleClip &&
							clip !== idleClip &&
							model.flattenLateralTilt?.includes(name)
						)
							flattenLateralRotation(clip, idleClip);
						if (idleClip && clip !== idleClip && model.stripYaw?.includes(name))
							stripHipsYaw(clip, idleClip);
						const action = mixer.clipAction(clip);
						if (ONE_SHOT.has(act)) {
							action.setLoop(THREE.LoopOnce, 1);
							action.clampWhenFinished = true;
						}
						actions.push(action);
					}
					if (actions.length > 0) clipActions.set(act, actions);
				}
			}
			// ワンショット完走時: 保留していた idle/walk へ遅れて戻る。
			// down(death) は clamp（倒れたまま）を維持するので何もしない。
			mixer.addEventListener("finished", (e) => {
				if (e.action !== current || currentAct === "down") return;
				if (currentAct === "turn") {
					// turn は焼き込み回転（180°回った姿勢）で終わるため、フェードで戻すと
					// 巻き戻る回転が見えてしまう。ハードカットで即 idle/walk に切り替え、
					// renderer が同フレームで root yaw を目標向きへスナップして辻褄を合わせる。
					turning = false;
					turnEnded = true;
					current.stop();
					current = null;
					currentAct = null;
					switchTo(lastAct ?? "idle");
					return;
				}
				if (lastAct && lastAct !== currentAct) switchTo(lastAct);
			});
			loaded = true;
		},
		(err) => {
			// 失敗時は非表示のまま続行（HP バー等は出るのでデモは止まらない）
			console.warn("[arena3d] GLB load failed:", model.url, err);
		},
	);

	return {
		root,
		update(p, tSec, moving) {
			if (!loaded || !mixer) return; // ロード完了まで非表示（プレースホルダなし）
			root.position.y = p.y * JUMP_WORLD;
			const act = avatarAction(p, moving);
			// turn 中に技・被弾など優先度の高いアクションが来たら turn を打ち切る
			// （下の switchTo が割り込むので、renderer 側の yaw 固定だけ解除して繋ぐ）。
			// finished の取りこぼし対策のタイムアウトも兼ねる。
			if (turning) {
				const timedOut = tSec - turnStartedAt > 1.0;
				if ((act !== lastAct && !isLow(act)) || timedOut) {
					turning = false;
					turnEnded = true;
				}
			}
			// 技インスタンスの変化（moveActiveFrom が変わる）も切り替えトリガに含める。
			// 左パンチ→右パンチのように間に idle を挟まず同じアクション名が続くケースでも、
			// 新しい技として正しい側のクリップへ打ち直すため。
			const moveKey = p.move ? `${p.move}:${p.moveActiveFrom}` : null;
			const newMove = moveKey !== null && moveKey !== lastMoveKey;
			lastMoveKey = moveKey;
			if (act !== lastAct || (newMove && !isLow(act))) {
				lastAct = act;
				// ワンショット再生中に idle/walk へ戻る要求が来ても保留し、クリップを振り切らせる
				// （ゲームの技時間はアニメより短いので、即時に戻すと振りの途中で切れて見える）。
				// 攻撃・被弾・down など優先度の高い要求は即座に割り込む。
				const holding =
					!!current &&
					!!currentAct &&
					ONE_SHOT.has(currentAct) &&
					// jump は 0.5倍速で滞空より尺が長いため、着地（idle/walk 要求）で
					// 振り切りを待たずに即切り替える（待つと着地後もジャンプポーズが残る）
					currentAct !== "jump" &&
					current.isRunning();
				// パンチ/キックは入力の左右（moveSide）でクリップを確定させる
				const side =
					(act === "punch" || act === "kick") && p.moveSide
						? p.moveSide
						: undefined;
				if (!(isLow(act) && holding)) switchTo(act, side);
			}
			const dt = lastT ? Math.min(tSec - lastT, 0.05) : 0;
			lastT = tSec;
			mixer.update(dt);
		},
		playTurn(p, moving) {
			// 接地して通常状態（idle/走り）のときだけ。技・被弾の一回再生中は割り込まない。
			if (!loaded || !mixer || !clipActions.has("turn")) return false;
			if (p.y > 0.001) return false;
			if (!isLow(avatarAction(p, moving))) return false;
			const busyOneShot =
				!!current &&
				!!currentAct &&
				currentAct !== "turn" &&
				ONE_SHOT.has(currentAct) &&
				current.isRunning();
			if (busyOneShot) return false;
			switchTo("turn");
			turning = true;
			turnEnded = false;
			turnStartedAt = lastT;
			return true;
		},
		isTurning() {
			return turning;
		},
		consumeTurnEnd() {
			const ended = turnEnded;
			turnEnded = false;
			return ended;
		},
		dispose() {
			disposed = true;
			mixer?.stopAllAction();
			// モデルの geometry/material は gltfCache の原本と共有しているので dispose しない
			// （他のアバター・以降のロードが壊れる）。シーンからの切り離しだけ行う。
			root.clear();
		},
	};
}

// アバターを1体作る（ライダー別 GLB → 共通 GLB(DEFAULT_RIDER_MODEL) の順で解決）。
// バトルのアリーナ（createArenaRenderer）と勝者画面（winner3d）で同じ見た目・同じ
// 差し替え点を共有するためのヘルパ。RIDER_MODELS に登録すれば両方が自動で差し替わる。
export function createAvatar(riderId: string, color: number): FighterAvatar {
	const model = RIDER_MODELS[riderId] ?? DEFAULT_RIDER_MODEL;
	return createGltfAvatar(model, color);
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
		"$ henshin --rider arduino",
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
