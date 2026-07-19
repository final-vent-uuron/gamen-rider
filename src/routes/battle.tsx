import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

import { RIDER_ROUTINES } from "../pose";
import { LM } from "../pose/landmarks";
import { createSkeletonSmoother } from "../pose/skeleton";
import {
	ARENA,
	applyAbare,
	applyAttack,
	applyJump,
	applyThrow,
	battleCardsFor,
	connectBattle,
	createBgm,
	createCameraGuardSource,
	createKeyboardSource,
	createSfx,
	getPairedLimbs,
	meterStocks,
	stepBattle,
} from "../battle";
import type {
	BattleCard,
	BattleNet,
	BattleState,
	Bgm,
	CameraGuardStatus,
	LimbKey,
	NetStatus,
	PairedLimbs,
	PlayerState,
	Sfx,
} from "../battle";
import type { ArenaRenderer } from "../battle/arena3d";

// 被弾ダメージの浮き数字。命中検出で追加し、一定時間で消す。
interface DamagePopup {
	key: number;
	x: number; // ステージ内の正規化 x（0..1）で位置を決める
	amount: number;
	big: boolean;
	blocked: boolean;
}

// rider をクエリで受け取り、無ければ先頭ルーチンを既定にする（/battle 単体でも動作確認できる）。
// 認証フロー（/auth）からは navigate({ to:'/battle', search:{ rider } }) で遷移してくる想定。
// name はデモ用キャラ選択（/select）が渡す表示名（RIDER_ROUTINES に無い登録ライダー用）。
export const Route = createFileRoute("/battle")({
	validateSearch: (
		search: Record<string, unknown>,
	): { rider?: string; name?: string } => ({
		rider: typeof search.rider === "string" ? search.rider : undefined,
		name: typeof search.name === "string" ? search.name : undefined,
	}),
	component: BattlePage,
});

// プレイヤーの表示色（1P〜5P）。HP バーと placeholder の色に使う。
const PLAYER_COLORS = ["#a78bfa", "#f87171", "#34d399", "#fbbf24", "#38bdf8"];

// サーバーから最初の状態が届くまでの初期値（空のロスター）。
const EMPTY_BATTLE: BattleState = {
	players: [],
	projectiles: [],
	winnerId: null,
};

// 他プレイヤー描画の補間遅延(ms)。本番（インターネット越しの Durable Object）は 60Hz の
// 配信が均等な間隔で届かない（ジッタでまとまって届く）ため、受信値をそのまま描くと
// 他プレイヤーの動きがカクつく。この時間だけ過去を描画時刻とし、その前後の受信
// スナップショット間で位置を補間して滑らかにする。ローカル開発では相手がこの分だけ
// 遅れて見えるだけで、体感はほぼ変わらない。
const INTERP_DELAY_MS = 120;

// 予測の見た目: 自分の技/ガードはサーバーが追いつく前でも即表示。被弾中はサーバー優先。
function predAction(
	serverP: PlayerState,
	predP: PlayerState,
): PlayerState["action"] {
	if (
		serverP.action === "hit" ||
		serverP.action === "thrown" ||
		serverP.action === "down"
	) {
		return serverP.action;
	}
	if (
		predP.action === "punch" ||
		predP.action === "kick" ||
		predP.action === "shot" ||
		predP.action === "throw" ||
		predP.action === "final" ||
		predP.action === "abare" ||
		predP.action === "guard"
	) {
		return predP.action;
	}
	return serverP.action;
}

function BattlePage() {
	const { rider, name } = Route.useSearch();
	const navigate = useNavigate();

	// 自分のライダーを解決。RIDER_ROUTINES に無い id（登録ライダー・デモ選択）は id を
	// そのまま使い、表示名はクエリの name → 既定ルーチン名 の順で代用する。
	const routine = useMemo(() => {
		const known = RIDER_ROUTINES.find((r) => r.riderId === rider);
		return {
			riderId: rider ?? RIDER_ROUTINES[0].riderId,
			riderName: name ?? known?.riderName ?? RIDER_ROUTINES[0].riderName,
		};
	}, [rider, name]);

	const cards = battleCardsFor(routine.riderId);

	const [battle, setBattle] = useState<BattleState>(EMPTY_BATTLE);
	const [finalActive, setFinalActive] = useState(false);
	const [status, setStatus] = useState<NetStatus>("connecting");
	const [popups, setPopups] = useState<DamagePopup[]>([]); // 被弾ダメージ数字
	const [combo, setCombo] = useState<number | null>(null); // 進行中の最大コンボ数
	const [koFlash, setKoFlash] = useState(false); // KO の一瞬フラッシュ
	const [camGuard, setCamGuard] = useState(false); // カメラがガードポーズを認識中か（表示用）
	const [camPose, setCamPose] = useState<CameraGuardStatus>("loading"); // ポーズ解析の読み込み状態（表示用）
	const [camSide, setCamSide] = useState(false); // カメラに対して横向きか（向き検出）
	// 加速度センサー（右手/左手/右足/左足）のペアリング有無。null = 確認中
	const [pairedLimbs, setPairedLimbs] = useState<PairedLimbs | null>(null);
	const [intruder, setIntruder] = useState<string | null>(null); // 乱入 WARNING（乱入者名。null = 非表示）

	const battleRef = useRef(battle);
	battleRef.current = battle;
	const lastUiSyncRef = useRef(0); // setBattle（React 再レンダー）の間引き用
	const youIdRef = useRef(""); // 自分のプレイヤー id（サーバーが welcome で通知）
	const rafRef = useRef(0);
	const finalTimerRef = useRef(0);
	const arenaHostRef = useRef<HTMLDivElement>(null); // three.js canvas のホスト
	const rendererRef = useRef<ArenaRenderer | null>(null);
	const finalActiveRef = useRef(false); // rAF ループから読む finalActive のミラー
	const netRef = useRef<BattleNet | null>(null);
	const sfxRef = useRef<Sfx | null>(null); // 効果音（WebAudio 合成）
	const bgmRef = useRef<Bgm | null>(null); // BGM（public/bgm/ の mp3）
	const intrusionSeenRef = useRef(0); // 処理済みの intrusionUntil（同じ乱入を1回だけ演出する）
	const intrusionTimerRef = useRef(0);
	const ventVideoRef = useRef<HTMLVideoElement>(null); // 右下カメラの <video>（ポーズ解析と共有）
	const ventCanvasRef = useRef<HTMLCanvasElement>(null); // 右下カメラの骨格オーバーレイ
	const camLmRef = useRef<NormalizedLandmark[] | null>(null); // 最新の検出ランドマーク（画面下ステータス用）
	const comboTimerRef = useRef(0);
	const popupKeyRef = useRef(0);
	const koOrderRef = useRef<string[]>([]); // 撃墜された順（順位付け用。先頭＝最初に落ちた＝下位）

	// --- クライアント予測（自分のキャラだけ即応させてラグ感を消す）---
	// サーバー権威は維持しつつ、自分の移動/技を state.ts の同じ純粋関数でローカルにも回し、
	// 受信のたびに位置を軟着（補正）する。predRef は「自分1人だけ」の BattleState。
	const predRef = useRef<BattleState | null>(null);
	const moveDirRef = useRef<-1 | 0 | 1>(0); // 自分の移動入力
	const guardRef = useRef(false); // 自分のガード入力
	const lastPredTRef = useRef(0);
	// 受信スナップショットの履歴（他プレイヤーの補間用。INTERP_DELAY_MS 参照）
	const snapsRef = useRef<{ t: number; state: BattleState }[]>([]);

	function flashFinal() {
		setFinalActive(true);
		finalActiveRef.current = true;
		window.clearTimeout(finalTimerRef.current);
		finalTimerRef.current = window.setTimeout(() => {
			setFinalActive(false);
			finalActiveRef.current = false;
		}, 1300);
	}

	// 効果音（WebAudio 合成）を用意。実際の発音は最初のユーザー操作(resume)後。
	// 画面を離れるときは AudioContext を必ず閉じる（閉じないと対戦のたびに増えて重くなる）。
	useEffect(() => {
		const sfx = createSfx();
		sfxRef.current = sfx;
		return () => {
			sfx.close();
			sfxRef.current = null;
		};
	}, []);

	// 加速度センサーのペアリング状態。Web Bluetooth の許可済みデバイス名から部位別に判定する
	// （接続はしない）。ペアリングは /pairing 画面で行うので、ここは表示のために定期確認するだけ。
	useEffect(() => {
		let alive = true;
		const check = async () => {
			const limbs = await getPairedLimbs();
			if (alive) setPairedLimbs(limbs);
		};
		check();
		const id = window.setInterval(check, 3000);
		return () => {
			alive = false;
			window.clearInterval(id);
		};
	}, []);

	// BGM: 入場でメインをループ再生（自動再生がブロックされたら最初の操作で開始）。
	// 乱入・ファイナルベントの割り込みは bgm.ts 側が main の停止/復帰まで面倒を見る。
	useEffect(() => {
		const bgm = createBgm();
		bgmRef.current = bgm;
		bgm.playMain();
		return () => {
			bgm.close();
			bgmRef.current = null;
		};
	}, []);

	// WebSocket 接続。シミュレーションは権威サーバー側で回っているので、
	// ここは「自分の入力を送る」「受け取った状態を描く」だけ（→ 4人/2PC で共有）。
	// 受信の差分から命中/ブロック/投げ/KO/コンボ/ゲージ満タンを検出し、演出を焚く。
	useEffect(() => {
		// 前フレーム → 今フレームの差分で「起きたこと」を演出に変換する。
		const processEvents = (
			prev: BattleState,
			next: BattleState,
			youId: string,
		) => {
			const sfx = sfxRef.current;
			const r = rendererRef.current;
			let maxCombo = 0;
			const fresh: DamagePopup[] = [];
			const prevFinal = new Set(
				prev.players.filter((p) => p.action === "final").map((p) => p.id),
			);
			const prevAbare = new Set(
				prev.players.filter((p) => p.action === "abare").map((p) => p.id),
			);
			let newFinal = false;

			for (const np of next.players) {
				if (np.comboCount > maxCombo) maxCombo = np.comboCount;
				if (np.action === "final" && !prevFinal.has(np.id)) newFinal = true;
				// あばれ発動: 誰かが割り込んだ瞬間、紫の衝撃波＋シェイクで「弾けた」ことを見せる。
				if (np.action === "abare" && !prevAbare.has(np.id)) {
					sfx?.burst();
					r?.hitSpark(np.x, np.y, 0xc084fc, true);
					r?.shake(0.45);
					r?.punch(1.0);
				}
				const pp = prev.players.find((p) => p.id === np.id);
				if (!pp) continue;
				const dmg = pp.hp - np.hp;
				const thrown = np.action === "thrown" && pp.action !== "thrown";
				const ko = pp.hp > 0 && np.hp <= 0;
				if (dmg > 0) {
					const blocked = np.action === "guard" && dmg <= 2;
					if (blocked) {
						sfx?.block();
						r?.hitSpark(np.x, np.y, 0x7fdfff, false);
						r?.shake(0.06);
					} else {
						const big = dmg >= 9 || thrown || ko;
						if (!ko) {
							if (thrown) sfx?.grab();
							else sfx?.hit(Math.min(1, dmg / 20));
						}
						r?.hitSpark(np.x, np.y, thrown ? 0xffb020 : 0xffe08a, big);
						r?.shake(Math.min(0.7, 0.08 + dmg * 0.02));
						if (big) r?.punch(0.9);
					}
					fresh.push({
						key: popupKeyRef.current++,
						x: np.x,
						amount: dmg,
						big: dmg >= 9 || thrown,
						blocked,
					});
				}
				if (ko) {
					if (!koOrderRef.current.includes(np.id))
						koOrderRef.current.push(np.id); // 撃墜順を記録
					sfx?.ko();
					r?.shake(0.85);
					r?.punch(1.6);
					setKoFlash(true);
					window.setTimeout(() => setKoFlash(false), 260);
				}
				if (
					np.id === youId &&
					pp.meter < ARENA.meterMax &&
					np.meter >= ARENA.meterMax
				) {
					sfx?.meterFull();
				}
			}

			// 新しく飛んだ波動弾に発射音＋火花。
			const prevProj = new Set(prev.projectiles.map((pr) => pr.id));
			for (const pr of next.projectiles) {
				if (!prevProj.has(pr.id)) {
					sfx?.shoot();
					r?.hitSpark(pr.x, pr.y, 0x9be7ff, false);
				}
			}

			if (newFinal) {
				flashFinal();
				bgmRef.current?.finalVent(); // 掛け声＋ファイナルベント BGM（main は自動で復帰）
			}

			// 乱入（3人目以降の途中参戦）: サーバーが intrusionUntil を立てて全員を停止させる。
			// 新しい intrusionUntil を一度だけ拾い、WARNING 表示＋Intrusion-bgm を演出時間ぶん流す。
			const intrusionUntil = next.intrusionUntil ?? 0;
			if (
				intrusionUntil > Date.now() &&
				intrusionUntil !== intrusionSeenRef.current
			) {
				intrusionSeenRef.current = intrusionUntil;
				const prevIds = new Set(prev.players.map((p) => p.id));
				const newcomer = next.players.find((p) => !prevIds.has(p.id));
				// 乱入者本人の画面は prev が空（全員 newcomer 扱い）なので名前は出さず汎用文言にする
				const name =
					prev.players.length >= 2 ? newcomer?.riderName ?? null : null;
				setIntruder(name ?? "???");
				bgmRef.current?.intrusion(intrusionUntil - Date.now());
				window.clearTimeout(intrusionTimerRef.current);
				intrusionTimerRef.current = window.setTimeout(
					() => setIntruder(null),
					intrusionUntil - Date.now(),
				);
			}
			if (fresh.length) {
				setPopups((ps) => [...ps, ...fresh]);
				for (const pu of fresh) {
					window.setTimeout(
						() => setPopups((ps) => ps.filter((x) => x.key !== pu.key)),
						850,
					);
				}
			}
			if (maxCombo >= 2) {
				setCombo(maxCombo);
				window.clearTimeout(comboTimerRef.current);
				comboTimerRef.current = window.setTimeout(() => setCombo(null), 950);
			}
		};

		// サーバー受信で自分の予測状態を補正する（権威はサーバー、位置は軟着）。
		const reconcilePrediction = (next: BattleState, youId: string) => {
			const serverSelf = next.players.find((p) => p.id === youId);
			if (!serverSelf) {
				predRef.current = null;
				return;
			}
			const now = Date.now();
			const pred = predRef.current?.players[0];
			if (!pred || pred.id !== serverSelf.id) {
				predRef.current = {
					players: [{ ...serverSelf }],
					projectiles: [],
					winnerId: null,
					intrusionUntil: next.intrusionUntil,
				};
				return;
			}
			const merged: PlayerState = { ...serverSelf }; // 権威フィールド(hp/meter/timer等)はサーバー採用
			const constrained =
				serverSelf.action === "hit" ||
				serverSelf.action === "thrown" ||
				serverSelf.action === "down" ||
				now < serverSelf.stunUntil ||
				now < serverSelf.freezeUntil;
			const err =
				Math.abs(serverSelf.x - pred.x) + Math.abs(serverSelf.y - pred.y);
			// しきい値はネット越しの遅延を想定して広め（0.3）。ジャンプ中はサーバー側の y が
			// RTT 分古く誤差が大きく出るため、狭くすると本番で毎受信スナップしてガタつく。
			// 押し出し・投げ等の大ワープ（>0.3）だけサーバー位置へ即スナップさせる。
			if (!constrained && err < 0.3) {
				// 自由移動中は予測位置を維持して軽く寄せる（入力が即反映されて見える）
				merged.x = pred.x + (serverSelf.x - pred.x) * 0.25;
				merged.y = pred.y;
				merged.vx = pred.vx;
				merged.vy = pred.vy;
				merged.facing = pred.facing;
			}
			predRef.current = {
				players: [merged],
				projectiles: predRef.current?.projectiles ?? [],
				winnerId: null,
				intrusionUntil: next.intrusionUntil, // 予測ループ(stepBattle)も乱入停止に従わせる
			};
		};

		const net = connectBattle({
			riderId: routine.riderId,
			riderName: routine.riderName,
			onStatus: setStatus,
			onState: (state, youId) => {
				youIdRef.current = youId;
				const prev = battleRef.current;
				// isSelf は端末ごとに違う（youId と一致する人が自分）。ここで付け直す。
				const players = state.players.map((p) => ({
					...p,
					isSelf: p.id === youId,
				}));
				const next: BattleState = { ...state, players };
				processEvents(prev, next, youId);
				reconcilePrediction(next, youId);
				battleRef.current = next;
				// 補間用の履歴に積む（描画に必要な直近 ~0.5 秒だけ残す）
				const snapNow = performance.now();
				snapsRef.current.push({ t: snapNow, state: next });
				while (
					snapsRef.current.length > 2 &&
					snapsRef.current[0].t < snapNow - 500
				) {
					snapsRef.current.shift();
				}
				// サーバー配信は 60Hz だが、React の再レンダー（HP バー・ゲージ・カード等の UI）まで
				// 60Hz で回すと three.js の描画ループとメインスレッドを取り合ってガタつく。
				// 3D 描画は rAF ループが battleRef を直接読むので毎フレーム反映される。
				// setBattle は約 10Hz に間引く（HP バーは transition 0.25s なので見た目は滑らかなまま）。
				// 参加人数の増減と決着だけは UI 即時反映（決着は /result 遷移のトリガでもある）。
				const nowMs = performance.now();
				const structural =
					prev.players.length !== next.players.length ||
					prev.winnerId !== next.winnerId;
				if (structural || nowMs - lastUiSyncRef.current >= 100) {
					lastUiSyncRef.current = nowMs;
					setBattle(next);
				}
			},
		});
		netRef.current = net;

		// キーボード（＝センサーのダミー入力）→ サーバーへ送信。
		// 攻撃には即時フィードバックの風切り音を鳴らす（往復遅延を体感で吸収）。
		// ローカル予測に自分の操作を即反映するヘルパ（predRef は自分1人だけの状態）。
		const applyPred = (fn: (s: BattleState) => BattleState) => {
			if (predRef.current && youIdRef.current)
				predRef.current = fn(predRef.current);
		};
		// ガードはキーボードとカメラ（ボクシングの構え）の2系統。どちらかが on なら on（OR 合成）。
		// カメラの構えを解いてもキーを押していればガード継続、の直感的な挙動にする。
		const guardParts = { key: false, cam: false };
		const setGuardPart = (part: keyof typeof guardParts, on: boolean) => {
			if (guardParts[part] === on) return;
			guardParts[part] = on;
			const merged = guardParts.key || guardParts.cam;
			if (merged !== guardRef.current) {
				guardRef.current = merged;
				net.sendGuard(merged);
			}
		};
		const source = createKeyboardSource((input) => {
			sfxRef.current?.resume();
			const now = Date.now();
			const selfId = youIdRef.current;
			switch (input.kind) {
				case "move":
					moveDirRef.current = input.dir;
					net.sendMove(input.dir);
					break;
				case "jump":
					net.sendJump();
					applyPred((s) => applyJump(s, selfId, now));
					break;
				case "punch":
					net.sendAttack("punch");
					applyPred((s) => applyAttack(s, selfId, "punch", now));
					sfxRef.current?.whiff();
					break;
				case "kick":
					net.sendAttack("kick");
					applyPred((s) => applyAttack(s, selfId, "kick", now));
					sfxRef.current?.whiff();
					break;
				case "guard":
					setGuardPart("key", input.on);
					break;
				case "throw":
					net.sendThrow();
					applyPred((s) => applyThrow(s, selfId, now));
					sfxRef.current?.whiff();
					break;
				case "shot":
					net.sendAttack("shot");
					applyPred((s) => applyAttack(s, selfId, "shot", now));
					sfxRef.current?.whiff();
					break;
				case "abare":
					net.sendAbare();
					applyPred((s) => applyAbare(s, selfId, now));
					break;
				case "final-vent":
					net.sendAttack("final");
					applyPred((s) => applyAttack(s, selfId, "final", now));
					break;
			}
		});
		source.start();

		// カメラガード: 右下カメラの映像で「ボクシングの構え」を認識している間、強制的にガード。
		// 骨格オーバーレイは smoother 経由（検出 ~15fps → 表示 60fps 補間でぬるぬる動く）。
		// 色: 通常は MediaPipe 風の緑、ガード認識中はシアン（ひと目で状態がわかる）。
		const skeleton = createSkeletonSmoother(() => ventCanvasRef.current);
		const camSource = createCameraGuardSource(
			() => ventVideoRef.current,
			(on) => {
				setGuardPart("cam", on);
				setCamGuard(on);
			},
			(lm, guarding) => {
				camLmRef.current = lm; // 画面下ステータス（部位の生値）用。React は通さない
				skeleton.push(lm, guarding ? "#7fdfff" : "#4ade80");
			},
			// 解析の読み込み状態（カメラ上のバッジ表示。骨格が出ない原因の切り分け用）
			setCamPose,
			// 体の向き（カメラに対して横向きか）
			setCamSide,
		);
		camSource.start();

		return () => {
			source.stop();
			camSource.stop();
			skeleton.stop();
			net.close();
			netRef.current = null;
			window.clearTimeout(finalTimerRef.current);
			window.clearTimeout(comboTimerRef.current);
			window.clearTimeout(intrusionTimerRef.current);
		};
	}, [routine]);

	// 描画ループ: サーバー状態を土台に、自分だけローカル予測で先行させて描く（ラグ感を消す）。
	useEffect(() => {
		const loop = () => {
			const server = battleRef.current;
			const selfId = youIdRef.current;

			// --- 他プレイヤーの補間（INTERP_DELAY_MS 分の過去を、受信履歴の間で lerp）---
			// 自分は下の予測で描くので対象外。履歴が rt を挟めない（受信直後・停滞中）は最新のまま。
			let players = server.players;
			const snaps = snapsRef.current;
			if (snaps.length >= 2) {
				const rt = performance.now() - INTERP_DELAY_MS;
				let hi = snaps.length - 1;
				while (hi > 0 && snaps[hi - 1].t > rt) hi--;
				if (hi > 0 && snaps[hi].t > rt) {
					const s0 = snaps[hi - 1];
					const s1 = snaps[hi];
					const f = Math.max(
						0,
						Math.min(1, (rt - s0.t) / Math.max(1, s1.t - s0.t)),
					);
					players = players.map((p) => {
						if (p.id === selfId) return p;
						const p0 = s0.state.players.find((q) => q.id === p.id);
						const p1 = s1.state.players.find((q) => q.id === p.id);
						if (!p0 || !p1) return p;
						// 連続量(x,y)だけ補間。action/hp/facing 等の離散量は補間時刻側(s1)を使う
						return {
							...p1,
							x: p0.x + (p1.x - p0.x) * f,
							y: p0.y + (p1.y - p0.y) * f,
						};
					});
				}
			}

			let renderState =
				players === server.players ? server : { ...server, players };
			const pred = predRef.current;
			if (
				pred &&
				selfId &&
				!server.winnerId &&
				server.players.some((p) => p.id === selfId)
			) {
				// 自分を同じ純粋関数(stepBattle)で毎フレーム前進させ、位置/技を即反映。
				const now = Date.now();
				const dt = lastPredTRef.current ? now - lastPredTRef.current : 0;
				lastPredTRef.current = now;
				const advanced = stepBattle(
					pred,
					dt,
					now,
					{ [selfId]: moveDirRef.current },
					{ [selfId]: guardRef.current },
				);
				predRef.current = advanced;
				const ps = advanced.players[0];
				if (ps) {
					renderState = {
						...renderState,
						players: renderState.players.map((p) =>
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
					};
				}
			} else {
				lastPredTRef.current = 0;
			}
			rendererRef.current?.render(renderState, finalActiveRef.current);
			rafRef.current = requestAnimationFrame(loop);
		};
		rafRef.current = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(rafRef.current);
	}, []);

	// three.js レンダラの初期化。SSR を避けるため three は動的 import（クライアント専用）。
	// アバターは共通 GLB（DEFAULT_RIDER_MODEL）を fallback に使う（/battle-test で検証済みの構成）。
	// RIDER_MODELS に riderId 別のモデルを登録すればそちらが優先され、GLB ロード中/失敗時は box。
	useEffect(() => {
		let disposed = false;
		let renderer: ArenaRenderer | null = null;
		import("../battle/arena3d").then(
			({ createArenaRenderer, DEFAULT_RIDER_MODEL }) => {
				if (disposed || !arenaHostRef.current) return;
				renderer = createArenaRenderer(arenaHostRef.current, {
					fallbackModel: DEFAULT_RIDER_MODEL,
				});
				rendererRef.current = renderer;
				renderer.render(battleRef.current, finalActiveRef.current);
			},
		);
		return () => {
			disposed = true;
			renderer?.dispose();
			rendererRef.current = null;
		};
	}, []);

	// 決着 → 勝者ページ（/result）へ遷移（スマブラのリザルト画面）。
	// 「GAME SET」の余韻を一瞬見せてから、全順位をクエリに載せて遷移する。
	// 順位: 勝者(生存)＝1位、以降は「撃墜が新しい順」（最後に落ちた＝2位）。
	// winnerId は一度立つと（この端末では）そのままなので、この effect は1回だけ走る。
	// 遷移で battle 画面は unmount し WebSocket も閉じる → 再戦は /result から /battle への再参加で行う。
	useEffect(() => {
		if (!battle.winnerId) return;
		bgmRef.current?.fadeOutMain(); // リザルトの win-bgm へ繋ぐ（main はここで終了）
		const t = window.setTimeout(() => {
			const st = battleRef.current;
			const order: string[] = [];
			if (st.winnerId) order.push(st.winnerId);
			const ko = koOrderRef.current;
			for (let k = ko.length - 1; k >= 0; k--)
				if (!order.includes(ko[k])) order.push(ko[k]);
			for (const p of st.players) if (!order.includes(p.id)) order.push(p.id); // 取りこぼし救済
			const players = order.flatMap((id) => {
				const idx = st.players.findIndex((p) => p.id === id);
				if (idx < 0) return [];
				const p = st.players[idx];
				return [
					{
						name: p.riderName,
						riderId: p.riderId, // 勝者ページの 3D 立ち絵で使う（GLB 差し替え点）
						mine: !!p.isSelf,
						color: PLAYER_COLORS[idx % PLAYER_COLORS.length],
						p: idx + 1, // プレイヤー番号（1P/2P… のペナント表示）
					},
				];
			});
			if (players.length === 0) return;
			navigate({
				to: "/result",
				search: { players, rider: routine.riderId, name: routine.riderName },
			});
		}, 1600);
		return () => window.clearTimeout(t);
	}, [battle.winnerId, navigate, routine.riderId, routine.riderName]);

	// カードクリックをダミー入力として扱う（マウスでも技を出せる）。
	function handleCard(card: BattleCard) {
		sfxRef.current?.resume();
		if (card.kind === "final") netRef.current?.sendAttack("final");
		else if (card.kind === "attack") {
			netRef.current?.sendAttack("punch");
			sfxRef.current?.whiff();
		}
	}

	const self = battle.players.find((p) => p.id === youIdRef.current) ?? null;
	const winner = battle.winnerId
		? battle.players.find((p) => p.id === battle.winnerId) ?? null
		: null;

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				minHeight: "100vh",
				height: "100vh",
				padding: "0.5rem 0.75rem 0.75rem",
				gap: "0.5rem",
			}}
		>
			{/* ステージ（three.js の 3D シーン ＋ 演出オーバーレイ）。
          カード・操作説明はステージ上のオーバーレイに載せ、メイン画面を最大化する。 */}
			<div
				style={{
					position: "relative",
					flex: 1,
					minHeight: "340px",
					borderRadius: "12px",
					overflow: "hidden",
					background: "#0b1220",
				}}
			>
				{/* three canvas はこの div にだけ挿入する（React 子要素と混ぜない） */}
				<div ref={arenaHostRef} style={{ position: "absolute", inset: 0 }} />
				{/* ダメージ数字・コンボ表示（描画に干渉しない透明レイヤ） */}
				<StageOverlay popups={popups} combo={combo} />
				{/* 相手待ち / 切断のヒント（ステージ上部中央のオーバーレイ。下部 HUD の高さを乱さない） */}
				{((status === "open" && battle.players.length < 2 && !winner) ||
					status !== "open") && (
					<div
						style={{
							position: "absolute",
							top: "10px",
							left: "50%",
							transform: "translateX(-50%)",
							maxWidth: "min(92%, 560px)",
						}}
					>
						{status === "open" && battle.players.length < 2 && !winner && (
							<WaitingHint />
						)}
						{status !== "open" && <DisconnectedHint status={status} />}
					</div>
				)}
				{/* KO の一瞬フラッシュ */}
				{koFlash && (
					<div
						style={{
							position: "absolute",
							inset: 0,
							background:
								"radial-gradient(circle, rgba(255,255,255,0.85), rgba(255,255,255,0))",
							pointerEvents: "none",
						}}
					/>
				)}

				{/* カードトレイ（ステージ左下のオーバーレイ） */}
				<div style={{ position: "absolute", left: "10px", bottom: "10px" }}>
					<CardTray
						cards={cards}
						disabled={!!winner || (self?.hp ?? 0) <= 0}
						finalReady={(self?.meter ?? 0) >= ARENA.meterMax}
						onCard={handleCard}
					/>
				</div>

				{/* ステージ右上: Back・全画面（その下に開閉式の操作説明） */}
				<div
					style={{
						position: "absolute",
						top: "10px",
						right: "10px",
						display: "flex",
						alignItems: "center",
						gap: "0.5rem",
						zIndex: 2,
					}}
				>
					<Link
						to="/"
						style={{
							color: "#e5e7eb",
							textDecoration: "none",
							fontSize: "0.78rem",
							background: "rgba(0,0,0,0.45)",
							border: "1px solid #334155",
							borderRadius: "6px",
							padding: "2px 10px",
							whiteSpace: "nowrap",
						}}
					>
						← Back
					</Link>
					<FullscreenButton />
				</div>
				{/* 操作説明（ステージ右上・開閉式。Back/全画面の下） */}
				<ControlsHelp />
			</div>

			{/* ---- 画面下部の HUD（スリムな1本バー） ----
			    左: ナビ/接続情報 ・ 中央: HP ゲージ（伸縮） ・ 右: FINAL VENT CAM。
			    バーの高さは HP ゲージ基準（~95px）。カメラ（280px・4:3）はサイズを保ったまま
			    負マージンでバーの上（ステージ側）へはみ出させる＝バーは低く、カメラは大きく。 */}
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: "0.75rem",
					background: "#0f172a",
					border: "1px solid #1e293b",
					borderRadius: "12px",
					padding: "0.4rem 0.7rem",
				}}
			>
				{/* 左: 接続情報（2行の極小カラム。Back・全画面はステージ右上へ移動） */}
				{/* <div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: "0.2rem",
						minWidth: "140px",
						flexShrink: 0,
					}}
				>
					<span
						style={{
							color: "#a78bfa",
							fontWeight: "bold",
							fontSize: "0.82rem",
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis",
						}}
					>
						あなた: {routine.riderName}
					</span>
					<span
						style={{
							display: "inline-flex",
							alignItems: "center",
							gap: "0.5rem",
							fontSize: "0.75rem",
							color: "#9ca3af",
						}}
					>
						参加 {battle.players.length}人
						<ConnBadge status={status} />
					</span>
				</div> */}

				{/* 左: 部位ステータス（顔=カメラ可視ゲージ、手足=センサーのペアリング＋カメラ可視） */}
				<CamStatusBar
					lmRef={camLmRef}
					side={camSide}
					pose={camPose}
					paired={pairedLimbs}
				/>

				{/* 中央: HP ゲージ（全プレイヤー・スマブラ風。余った幅を全部使う） */}
				<div style={{ flex: 1, minWidth: 0 }}>
					<HpBars players={battle.players} />
				</div>

				{/* 右: FINAL VENT CAM（カメラガード＋ファイナルベント用。常時表示） */}
				<div
					style={{
						alignSelf: "flex-end",
						marginTop: "-118px", // バーより背が高い分をステージ側へ逃がす
						zIndex: 5,
						flexShrink: 0,
					}}
				>
					<FinalVentCam
						highlight={finalActive}
						guarding={camGuard}
						poseStatus={camPose}
						facingSide={camSide}
						videoRef={ventVideoRef}
						canvasRef={ventCanvasRef}
					/>
				</div>
			</div>

			{/* 乱入 WARNING（サーバーが全員を停止させている間、中央に表示） */}
			{intruder != null && <IntrusionWarning name={intruder} />}

			{/* ファイナルベント演出 */}
			{finalActive && <FinalVentBanner />}

			{/* 決着スプラッシュ（この直後に /result へ遷移する） */}
			{winner && <GameSetBanner mine={!!winner.isSelf} />}
		</div>
	);
}

// ---- 接続状態バッジ / ヒント ---------------------------------------------

// HUD の接続情報カラムが一時的にコメントアウト中でも残す（export で未使用エラー回避）。
export function ConnBadge({ status }: { status: NetStatus }) {
	const map = {
		connecting: { label: "接続中…", color: "#fbbf24" },
		open: { label: "オンライン", color: "#34d399" },
		closed: { label: "切断", color: "#f87171" },
	} as const;
	const { label, color } = map[status];
	return (
		<span
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: "5px",
				fontSize: "0.8rem",
				color,
				border: `1px solid ${color}55`,
				borderRadius: "999px",
				padding: "2px 10px",
			}}
		>
			<span
				style={{
					width: "7px",
					height: "7px",
					borderRadius: "50%",
					background: color,
				}}
			/>
			{label}
		</span>
	);
}

// フルスクリーン切り替え（会場のデモ用。ブラウザの UI を消して対戦画面だけにする）。
function FullscreenButton() {
	const [fs, setFs] = useState(false);
	useEffect(() => {
		const onChange = () => setFs(!!document.fullscreenElement);
		document.addEventListener("fullscreenchange", onChange);
		onChange();
		return () => document.removeEventListener("fullscreenchange", onChange);
	}, []);
	return (
		<button
			type="button"
			onClick={() => {
				if (document.fullscreenElement) document.exitFullscreen();
				else document.documentElement.requestFullscreen();
			}}
			style={{
				// ステージ（3D シーン）の上に置くので視認できる程度の下地を敷く
				background: "rgba(0,0,0,0.45)",
				border: "1px solid #334155",
				borderRadius: "6px",
				color: "#e5e7eb",
				fontSize: "0.78rem",
				padding: "2px 10px",
				cursor: "pointer",
				whiteSpace: "nowrap",
			}}
		>
			{fs ? "✕ 全画面解除" : "⛶ 全画面"}
		</button>
	);
}

function WaitingHint() {
	return (
		<div
			style={{
				fontSize: "0.85rem",
				color: "#9ca3af",
				background: "#0f172a",
				border: "1px dashed #334155",
				borderRadius: "8px",
				padding: "0.5rem 0.8rem",
			}}
		>
			相手を待っています…
		</div>
	);
}

function DisconnectedHint({ status }: { status: NetStatus }) {
	return (
		<div
			style={{
				fontSize: "0.85rem",
				color: "#fca5a5",
				background: "#1f0a0a",
				border: "1px solid #7f1d1d",
				borderRadius: "8px",
				padding: "0.5rem 0.8rem",
			}}
		>
			{status === "connecting"
				? "サーバーへ接続中… （起動していない場合は `pnpm server` を実行）"
				: "サーバーから切断されました。再接続を試みています…"}
		</div>
	);
}

// ---- HP バー -------------------------------------------------------------

function HpBars({ players }: { players: PlayerState[] }) {
	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: `repeat(${players.length}, 1fr)`,
				gap: "0.9rem",
			}}
		>
			{players.map((p, i) => (
				<HpBar
					key={p.id}
					player={p}
					color={PLAYER_COLORS[i % PLAYER_COLORS.length]}
					index={i}
				/>
			))}
		</div>
	);
}

// 龍騎(PS) 風の格ゲー HP バー: 斜めのパララインバー＋黄→赤グラデ＋黒帯ネーム。
function HpBar({
	player,
	color,
	index,
}: { player: PlayerState; color: string; index: number }) {
	const ratio = Math.max(0, player.hp / player.maxHp);
	const pct = Math.round(ratio * 100);
	const dead = player.hp <= 0;
	const low = !dead && ratio <= 0.3;
	const slant = "10px"; // バーの傾き量
	const bar = `polygon(${slant} 0, 100% 0, calc(100% - ${slant}) 100%, 0 100%)`;

	return (
		<div
			style={{
				opacity: dead ? 0.5 : 1,
				transition: "opacity 0.3s",
				minWidth: 0,
			}}
		>
			{/* ネーム黒帯 */}
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: "6px",
					width: "fit-content",
					maxWidth: "100%",
					transform: "skewX(-16deg)",
					background: "linear-gradient(180deg, #1a1a1a, #000)",
					border: `1px solid ${player.isSelf ? color : "#4b5563"}`,
					borderBottom: `2px solid ${color}`,
					padding: "2px 12px 2px 8px",
					marginBottom: "3px",
					boxShadow: player.isSelf ? `0 0 8px ${color}88` : "none",
				}}
			>
				<span
					style={{
						transform: "skewX(16deg)",
						display: "inline-flex",
						alignItems: "center",
						gap: "6px",
						whiteSpace: "nowrap",
						overflow: "hidden",
					}}
				>
					<span
						style={{
							fontSize: "0.62rem",
							fontWeight: 900,
							color: "#000",
							background: color,
							borderRadius: "3px",
							padding: "0 5px",
							lineHeight: 1.5,
						}}
					>
						{player.isSelf ? "あなた" : `${index + 1}P`}
					</span>
					<span
						style={{
							fontSize: "0.9rem",
							fontWeight: 900,
							letterSpacing: "0.06em",
							textShadow: "0 1px 2px #000",
							overflow: "hidden",
							textOverflow: "ellipsis",
						}}
					>
						{player.riderName}
					</span>
				</span>
			</div>

			{/* バー本体（斜めフレーム） */}
			<div
				style={{
					position: "relative",
					height: "24px",
					clipPath: bar,
					background: "linear-gradient(180deg, #9ca3af, #1f2937 55%, #000)", // メタルフレーム
					padding: "3px",
				}}
			>
				{/* 内側トラック（減った部分の下地） */}
				<div
					style={{ position: "absolute", inset: "3px", background: "#2b0a0a" }}
				/>
				{/* HP 本体（黄→オレンジ→赤グラデ、左詰めで減る） */}
				<div
					style={{
						position: "absolute",
						top: "3px",
						bottom: "3px",
						left: "3px",
						width: `calc(${pct}% - 6px)`,
						minWidth: dead ? "0" : "2px",
						background: low
							? "linear-gradient(180deg, #ff6b3d, #b91c1c)"
							: "linear-gradient(180deg, #fff27a 0%, #ffd21e 25%, #ff8a00 60%, #ff2d00 100%)",
						boxShadow: low
							? "none"
							: "inset 0 -3px 4px rgba(0,0,0,0.4), 0 0 6px rgba(255,160,0,0.5)",
						animation: low ? "hpLowPulse 0.6s ease-in-out infinite" : undefined,
						transition: "width 0.25s ease",
					}}
				/>
				{/* メーターのセグメント目盛り（上に薄い縦線を重ねる） */}
				<div
					style={{
						position: "absolute",
						inset: "3px",
						backgroundImage:
							"repeating-linear-gradient(90deg, transparent 0 13px, rgba(0,0,0,0.45) 13px 15px)",
						pointerEvents: "none",
					}}
				/>
				{/* 上端ハイライト */}
				<div
					style={{
						position: "absolute",
						top: "3px",
						left: "3px",
						right: "3px",
						height: "5px",
						background:
							"linear-gradient(180deg, rgba(255,255,255,0.55), transparent)",
						pointerEvents: "none",
					}}
				/>
				{/* KO 表示 */}
				{dead && (
					<span
						style={{
							position: "absolute",
							inset: 0,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							fontSize: "0.75rem",
							fontWeight: 900,
							color: "#ef4444",
							letterSpacing: "0.15em",
						}}
					>
						K.O.
					</span>
				)}
			</div>

			{/* 逆転ゲージ（満タンで Final Vent 解禁） */}
			<MeterBar meter={player.meter} color={color} />
		</div>
	);
}

// 逆転ゲージ（5 ゲージ制）。2 本で「波動弾」、3 本で「エラーモード(割り込み)」、満タンで「ファイナル」。
// たまった本数は発光したセルで示し、満タンで全体が脈動する。
function MeterBar({ meter, color }: { meter: number; color: string }) {
	const STOCKS = ARENA.meterMax / ARENA.meterPerStock;
	const stocks = meterStocks(meter);
	const full = meter >= ARENA.meterMax;
	return (
		<div style={{ marginTop: "3px", display: "flex", gap: "3px" }}>
			{Array.from({ length: STOCKS }).map((_, i) => {
				const lo = i * ARENA.meterPerStock;
				const filled = i < stocks;
				const partial = filled
					? 1
					: Math.max(0, Math.min(1, (meter - lo) / ARENA.meterPerStock));
				return (
					<div
						key={i}
						style={{
							position: "relative",
							flex: 1,
							height: "7px",
							background: "#111827",
							borderRadius: "2px",
							overflow: "hidden",
							border: `1px solid ${filled ? `${color}88` : "#1f2937"}`,
						}}
					>
						<div
							style={{
								position: "absolute",
								inset: 0,
								width: `${partial * 100}%`,
								background: full
									? "linear-gradient(90deg, #a855f7, #38bdf8)"
									: filled
										? `linear-gradient(90deg, ${color}, #a855f7)`
										: color,
								boxShadow: filled ? `0 0 5px ${color}` : "none",
								animation: full
									? "meterReady 0.7s ease-in-out infinite"
									: undefined,
								transition: "width 0.2s ease",
							}}
						/>
					</div>
				);
			})}
		</div>
	);
}

// ---- ステージ演出オーバーレイ（コンボ / ダメージ数字） -------------------

function StageOverlay({
	popups,
	combo,
}: { popups: DamagePopup[]; combo: number | null }) {
	return (
		<div
			style={{
				position: "absolute",
				inset: 0,
				pointerEvents: "none",
				overflow: "hidden",
			}}
		>
			{/* コンボカウンタ（中央上） */}
			{combo != null && (
				<div
					style={{
						position: "absolute",
						left: "50%",
						top: "13%",
						transform: "translateX(-50%)",
						animation: "comboPop 0.25s ease-out",
						textShadow: "0 2px 8px #000",
						whiteSpace: "nowrap",
					}}
				>
					<span
						style={{
							fontSize: "2.6rem",
							fontWeight: 900,
							color: "#ffd21e",
							fontStyle: "italic",
						}}
					>
						{combo}
					</span>
					<span
						style={{
							fontSize: "1rem",
							fontWeight: 900,
							color: "#fff",
							marginLeft: "5px",
						}}
					>
						HITS
					</span>
				</div>
			)}
			{/* 被弾ダメージ数字（被弾者の位置に浮かせる） */}
			{popups.map((p) => (
				<span
					key={p.key}
					style={{
						position: "absolute",
						left: `${p.x * 100}%`,
						top: "38%",
						animation: "dmgRise 0.85s ease-out forwards",
						fontWeight: 900,
						fontStyle: "italic",
						fontSize: p.big ? "2rem" : "1.4rem",
						color: p.blocked ? "#7fdfff" : p.big ? "#ff5a3c" : "#ffe08a",
						textShadow: "0 2px 6px #000",
						whiteSpace: "nowrap",
					}}
				>
					{p.blocked ? "GUARD" : p.amount}
				</span>
			))}
		</div>
	);
}

// ---- カードトレイ --------------------------------------------------------

function CardTray({
	cards,
	disabled,
	finalReady,
	onCard,
}: {
	cards: BattleCard[];
	disabled: boolean;
	finalReady: boolean; // Final はゲージ満タンでのみ押せる
	onCard: (card: BattleCard) => void;
}) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
			<div style={{ display: "flex", gap: "0.5rem" }}>
				{cards.map((c) => {
					const isFinal = c.kind === "final";
					const cardDisabled = disabled || (isFinal && !finalReady);
					const ready = isFinal && finalReady && !disabled;
					return (
						<button
							key={c.id}
							type="button"
							disabled={cardDisabled}
							onClick={() => onCard(c)}
							style={{
								width: "68px",
								height: "92px",
								borderRadius: "8px",
								border: `2px solid ${c.color}`,
								background: `linear-gradient(160deg, ${c.color}33, rgba(15,23,42,0.88))`,
								color: "#fff",
								cursor: cardDisabled ? "not-allowed" : "pointer",
								opacity: cardDisabled ? 0.4 : 1,
								display: "flex",
								flexDirection: "column",
								justifyContent: "space-between",
								padding: "0.4rem",
								fontSize: "0.7rem",
								textAlign: "left",
								animation: ready
									? "meterReady 0.7s ease-in-out infinite"
									: undefined,
								boxShadow: ready
									? `0 0 16px ${c.color}`
									: isFinal
										? `0 0 12px ${c.color}66`
										: "none",
							}}
						>
							<span
								style={{
									color: c.color,
									fontWeight: "bold",
									fontSize: "0.6rem",
								}}
							>
								{c.kind.toUpperCase()}
							</span>
							<span style={{ fontWeight: "bold", lineHeight: 1.2 }}>
								{c.label}
							</span>
							{isFinal && !finalReady && (
								<span style={{ color: "#9ca3af", fontSize: "0.55rem" }}>
									5ゲージ必要
								</span>
							)}
						</button>
					);
				})}
			</div>
		</div>
	);
}

// ---- 操作ヘルプ（開閉式・ステージ右上のオーバーレイ） ---------------------
// メイン画面を広く使うため、普段は小さなボタンだけを置き、押したときだけパネルを開く。

function ControlsHelp() {
	const [open, setOpen] = useState(false);
	const rows: [string, string][] = [
		["← → / A D", "移動"],
		["W / ↑ / Space", "ジャンプ"],
		["J", "パンチ(軽・発生早)"],
		["K", "キック(重・主力)"],
		["Shift / S / ↓", "ガード(押しっぱ・前後OK)"],
		["📷 構え", "カメラにボクシングの構え(両拳を顔の前)でガード"],
		["U", "投げ(ガード崩し)"],
		["I", "波動弾(2ゲージ・飛び道具・1発ずつ)"],
		["E", "エラーモード(3ゲージ・割り込み脱出)"],
		["L / F", "ファイナル(5ゲージ)"],
	];
	return (
		<div
			style={{
				position: "absolute",
				top: "44px", // Back・全画面ボタンの行の下
				right: "10px",
				display: "flex",
				flexDirection: "column",
				alignItems: "flex-end",
				gap: "0.4rem",
				maxWidth: "min(380px, 70%)",
			}}
		>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				style={{
					background: "rgba(15,23,42,0.8)",
					color: "#cbd5e1",
					border: "1px solid #334155",
					borderRadius: "999px",
					padding: "3px 12px",
					fontSize: "0.75rem",
					cursor: "pointer",
				}}
			>
				🎮 操作説明 {open ? "▲" : "▼"}
			</button>
			{open && (
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: "0.45rem",
						background: "rgba(10,15,28,0.92)",
						border: "1px solid #334155",
						borderRadius: "10px",
						padding: "0.7rem 0.8rem",
						boxShadow: "0 8px 20px rgba(0,0,0,0.45)",
					}}
				>
					<span style={{ fontSize: "0.72rem", color: "#9ca3af" }}>
						操作（キーボード = センサーのダミー入力）
					</span>
					<div
						style={{ display: "flex", gap: "0.35rem 0.7rem", flexWrap: "wrap" }}
					>
						{rows.map(([k, v]) => (
							<span key={k} style={{ fontSize: "0.78rem", color: "#cbd5e1" }}>
								<kbd
									style={{
										background: "#374151",
										borderRadius: "4px",
										padding: "1px 6px",
										fontFamily: "monospace",
										marginRight: "4px",
									}}
								>
									{k}
								</kbd>
								{v}
							</span>
						))}
					</div>
					<span style={{ fontSize: "0.72rem", color: "#fbbf24" }}>
						技は<strong>出し切り</strong>制: モーション中は次の技を出せない（連打非対応）
					</span>
					<span style={{ fontSize: "0.72rem", color: "#7fdfff" }}>
						ピンチ: <strong>E でエラーモード</strong>（ゲージ3本）→
						無敵で割り込み、両隣を突き放してハメを脱出
					</span>
				</div>
			)}
		</div>
	);
}

// ---- 乱入 WARNING ---------------------------------------------------------
// 3人目以降が途中参戦した瞬間の演出。サーバーが intrusionUntil で全員を停止させている間、
// 中央に WARNING を出す（BGM は Intrusion-bgm に切り替わる）。

function IntrusionWarning({ name }: { name: string }) {
	const stripes =
		"repeating-linear-gradient(45deg, rgba(239,68,68,0.28) 0 20px, rgba(0,0,0,0.55) 20px 40px)";
	return (
		<div
			style={{
				position: "fixed",
				inset: 0,
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				gap: "0.8rem",
				background: "rgba(0,0,0,0.5)",
				pointerEvents: "none",
				zIndex: 55,
			}}
		>
			{/* 上下の危険ストライプ帯 */}
			{(["top", "bottom"] as const).map((side) => (
				<div
					key={side}
					style={{
						position: "absolute",
						left: 0,
						right: 0,
						[side]: "18%",
						height: "26px",
						background: stripes,
						backgroundSize: "80px 80px",
						animation: "warningStripes 0.9s linear infinite",
						borderTop: "2px solid #ef4444",
						borderBottom: "2px solid #ef4444",
					}}
				/>
			))}
			<div
				style={{
					animation: "warningIn 0.3s ease-out both",
					textAlign: "center",
				}}
			>
				<div
					style={{
						fontSize: "clamp(3rem, 12vw, 6rem)",
						fontWeight: 900,
						fontStyle: "italic",
						letterSpacing: "0.18em",
						color: "#ef4444",
						animation: "warningPulse 0.8s ease-in-out infinite",
						whiteSpace: "nowrap",
					}}
				>
					⚠ WARNING ⚠
				</div>
				<div
					style={{
						marginTop: "0.4rem",
						fontSize: "clamp(1rem, 3vw, 1.6rem)",
						fontWeight: 800,
						color: "#fff",
						textShadow: "0 2px 8px #000",
					}}
				>
					乱入者が現れた — <span style={{ color: "#fbbf24" }}>{name}</span>{" "}
					参戦！
				</div>
			</div>
		</div>
	);
}

// ---- 画面下ステータス（カメラの部位検出の生値） ---------------------------
// 顔・両手・両足の可視性(%)と体の向きを HUD バー左端に出す。デバッグ兼「なぜ判定されないか」の
// 可視化。親は検出ループ(~15fps)のたびに ref へ書くだけで、この component が 200ms 周期で
// ref を読んで自分だけ再レンダーする（BattlePage 全体を 15fps で再レンダーさせない）。

// [表示名, カメラのランドマーク index, 対応するセンサー部位（null = センサー無し・カメラのみ）]
const STATUS_PARTS: [string, number, LimbKey | null][] = [
	["顔", LM.NOSE, null],
	["右手", LM.R_WRIST, "rightHand"],
	["左手", LM.L_WRIST, "leftHand"],
	["右足", LM.R_ANKLE, "rightFoot"],
	["左足", LM.L_ANKLE, "leftFoot"],
];

function CamStatusBar({
	lmRef,
	side,
	pose,
	paired,
}: {
	lmRef: React.RefObject<NormalizedLandmark[] | null>;
	side: boolean;
	pose: CameraGuardStatus;
	paired: PairedLimbs | null; // 加速度センサーのペアリング有無（null = 確認中）
}) {
	const [, setTick] = useState(0);
	useEffect(() => {
		const id = window.setInterval(() => setTick((v) => v + 1), 200);
		return () => window.clearInterval(id);
	}, []);

	const lm = lmRef.current;
	// 部位ごとの可視性ゲージ（0..1）。緑 ≥0.6 / 黄 ≥0.3 / 赤 それ未満。
	const gauge = (label: string, v: number, active: boolean) => {
		const color = !active
			? "#4b5563"
			: v >= 0.6
				? "#4ade80"
				: v >= 0.3
					? "#fbbf24"
					: "#f87171";
		return (
			<span
				key={label}
				style={{
					display: "inline-flex",
					alignItems: "center",
					gap: "4px",
					fontSize: "0.66rem",
					fontFamily: "monospace",
					color: "#cbd5e1",
					whiteSpace: "nowrap",
				}}
			>
				<span style={{ width: "2.4em", textAlign: "right" }}>{label}</span>
				<span
					style={{
						position: "relative",
						width: "54px",
						height: "7px",
						background: "#1f2937",
						borderRadius: "4px",
						overflow: "hidden",
					}}
				>
					<span
						style={{
							position: "absolute",
							inset: 0,
							width: `${Math.round((active ? v : 0) * 100)}%`,
							background: color,
							borderRadius: "4px",
							transition: "width 0.15s linear",
						}}
					/>
				</span>
			</span>
		);
	};

	// 未ペアリングの部位はゲージの代わりに表示（入力は加速度センサー由来のため、
	// ペアリングされていなければカメラに映っていても操作できない）。
	const unpaired = (label: string) => (
		<span
			key={label}
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: "4px",
				fontSize: "0.66rem",
				fontFamily: "monospace",
				whiteSpace: "nowrap",
				color: "#cbd5e1",
			}}
		>
			<span style={{ width: "2.4em", textAlign: "right" }}>{label}</span>
			<span
				style={{
					fontWeight: 700,
					color: "#f87171",
					background: "rgba(127,29,29,0.35)",
					border: "1px solid #7f1d1d",
					borderRadius: "3px",
					padding: "0 5px",
					fontSize: "0.6rem",
				}}
			>
				未ペアリング
			</span>
		</span>
	);

	if (pose !== "ready") {
		// カメラ（ポーズ解析）が起動していなくても、センサーのペアリング有無は独立して見せる
		return (
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(2, auto)",
					gap: "0.15rem 0.7rem",
					flexShrink: 0,
					padding: "0 0.2rem",
				}}
			>
				<span style={{ fontSize: "0.66rem", color: "#9ca3af", whiteSpace: "nowrap" }}>
					ポーズ解析 {pose === "error" ? "エラー" : "準備中…"}
				</span>
				{STATUS_PARTS.filter(([, , limb]) => limb && !(paired?.[limb] ?? false)).map(
					([label]) => unpaired(label),
				)}
			</div>
		);
	}
	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "repeat(2, auto)",
				gap: "0.15rem 0.7rem",
				flexShrink: 0,
				padding: "0 0.2rem",
			}}
		>
			{STATUS_PARTS.map(([label, idx, limb]) =>
				limb && !(paired?.[limb] ?? false)
					? unpaired(label)
					: gauge(label, lm?.[idx]?.visibility ?? 0, !!lm),
			)}
			{/* 向き: 正面か横向きか（肩幅/胴長比のデバウンス済み判定） */}
			<span
				style={{
					display: "inline-flex",
					alignItems: "center",
					gap: "4px",
					fontSize: "0.66rem",
					fontFamily: "monospace",
					color: "#cbd5e1",
					whiteSpace: "nowrap",
				}}
			>
				<span style={{ width: "2.4em", textAlign: "right" }}>向き</span>
				<span
					style={{
						fontWeight: 700,
						color: !lm ? "#4b5563" : side ? "#fbbf24" : "#4ade80",
					}}
				>
					{!lm ? "--" : side ? "横向き" : "正面"}
				</span>
			</span>
		</div>
	);
}

// ---- 右下カメラ（ファイナルベント＋カメラガード用） ----------------------
// videoRef は親から受け取り、カメラガード（MediaPipe ポーズ解析）と映像を共有する。

function FinalVentCam({
	highlight,
	guarding,
	poseStatus,
	facingSide,
	videoRef,
	canvasRef,
}: {
	highlight: boolean;
	guarding: boolean;
	poseStatus: CameraGuardStatus; // ポーズ解析（骨格・ガード判定）の読み込み状態
	facingSide: boolean; // カメラに対して横向き（向き検出）
	videoRef: React.RefObject<HTMLVideoElement | null>;
	canvasRef: React.RefObject<HTMLCanvasElement | null>;
}) {
	const [state, setState] = useState<"idle" | "on" | "error">("idle");

	async function enable() {
		try {
			// 解像度・fps は低めに要求する。この映像は 180px のプレビューと構え判定（320px に
			// 縮小して解析）にしか使わないので、高解像度・高 fps はデコード/合成の無駄な負荷になる。
			const stream = await navigator.mediaDevices.getUserMedia({
				video: {
					width: { ideal: 640 },
					height: { ideal: 480 },
					frameRate: { ideal: 15, max: 24 },
				},
				audio: false,
			});
			if (videoRef.current) {
				videoRef.current.srcObject = stream;
				await videoRef.current.play();
			}
			setState("on");
		} catch {
			setState("error");
		}
	}

	useEffect(() => {
		enable();
		const video = videoRef.current;
		return () => {
			const s = video?.srcObject as MediaStream | null;
			s?.getTracks().forEach((t) => t.stop());
		};
	}, []);

	return (
		<div
			style={{
				// 下部 HUD の一員として in-flow で置く（fixed で他 UI に重ねない）。
				// 内側のラベル・GUARD バッジは absolute なので基準を持たせる。
				position: "relative",
				flexShrink: 0,
				width: "280px",
				aspectRatio: "4/3",
				borderRadius: "10px",
				overflow: "hidden",
				background: "#000",
				border: highlight
					? "3px solid #a78bfa"
					: guarding
						? "3px solid #7fdfff"
						: "2px solid #334155",
				boxShadow: highlight
					? "0 0 20px #a78bfa"
					: guarding
						? "0 0 20px #7fdfff"
						: "0 4px 12px rgba(0,0,0,0.4)",
				transition: "border 0.2s, box-shadow 0.2s",
			}}
		>
			<video
				ref={videoRef}
				playsInline
				muted
				style={{
					width: "100%",
					height: "100%",
					objectFit: "cover",
					transform: "scaleX(-1)",
				}}
			/>
			{/* 骨格オーバーレイ（MediaPipe の棒人間）。映像と同じミラー変換で座標が揃う。
          内部解像度は 4:3 固定（要求解像度 640x480 と同比。280px プレビューに合わせて 320） */}
			<canvas
				ref={canvasRef}
				width={320}
				height={240}
				style={{
					position: "absolute",
					inset: 0,
					width: "100%",
					height: "100%",
					transform: "scaleX(-1)",
					pointerEvents: "none",
				}}
			/>
			<span
				style={{
					position: "absolute",
					left: "6px",
					top: "4px",
					fontSize: "0.65rem",
					color: "#fff",
					background: "rgba(0,0,0,0.5)",
					padding: "1px 6px",
					borderRadius: "4px",
				}}
			>
				FINAL VENT CAM
			</span>
			{/* 横向き検出中の表示 */}
			{facingSide && (
				<span
					style={{
						position: "absolute",
						right: "6px",
						top: "4px",
						fontSize: "0.7rem",
						fontWeight: 900,
						color: "#1c1917",
						background: "#fbbf24",
						padding: "1px 8px",
						borderRadius: "4px",
						letterSpacing: "0.08em",
					}}
				>
					横向き
				</span>
			)}
			{/* ポーズ解析（骨格・ガード判定）の状態。ready になるまで出す＝骨格が出ない原因の切り分け */}
			{poseStatus !== "ready" && (
				<span
					style={{
						position: "absolute",
						left: "6px",
						bottom: "4px",
						fontSize: "0.65rem",
						fontWeight: 700,
						color: poseStatus === "error" ? "#fecaca" : "#e5e7eb",
						background:
							poseStatus === "error"
								? "rgba(127,29,29,0.85)"
								: "rgba(0,0,0,0.55)",
						padding: "1px 6px",
						borderRadius: "4px",
					}}
				>
					{poseStatus === "error"
						? "ポーズ解析エラー（リロードで再試行）"
						: "ポーズ解析 準備中…"}
				</span>
			)}
			{/* カメラガード認識中の表示（構えている間ガード状態） */}
			{guarding && (
				<span
					style={{
						position: "absolute",
						right: "6px",
						bottom: "4px",
						fontSize: "0.7rem",
						fontWeight: 900,
						color: "#001b22",
						background: "#7fdfff",
						padding: "1px 8px",
						borderRadius: "4px",
						letterSpacing: "0.08em",
					}}
				>
					GUARD
				</span>
			)}
			{state !== "on" && (
				<button
					type="button"
					onClick={enable}
					style={{
						position: "absolute",
						inset: 0,
						background: "rgba(0,0,0,0.55)",
						color: "#9ca3af",
						border: "none",
						cursor: "pointer",
						fontSize: "0.75rem",
					}}
				>
					{state === "error" ? "カメラを許可 →" : "カメラ起動中…"}
				</button>
			)}
		</div>
	);
}

// ---- 演出オーバーレイ ----------------------------------------------------

function FinalVentBanner() {
	return (
		<div
			style={{
				position: "fixed",
				inset: 0,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				pointerEvents: "none",
				zIndex: 40,
			}}
		>
			<span
				style={{
					fontSize: "3rem",
					fontWeight: 900,
					color: "#fff",
					textShadow: "0 0 20px #a78bfa, 0 0 40px #a78bfa",
					letterSpacing: "0.1em",
				}}
			>
				FINAL VENT !!
			</span>
		</div>
	);
}

// 決着の一瞬に出す「GAME SET」スプラッシュ。この直後に /result（勝者ページ）へ遷移する。
function GameSetBanner({ mine }: { mine: boolean }) {
	return (
		<div
			style={{
				position: "fixed",
				inset: 0,
				background: "rgba(0,0,0,0.72)",
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				gap: "0.6rem",
				zIndex: 60,
				pointerEvents: "none",
			}}
		>
			<span
				style={{
					fontSize: "clamp(2.5rem, 10vw, 5rem)",
					fontWeight: 900,
					fontStyle: "italic",
					letterSpacing: "0.1em",
					color: "#fff",
					textShadow: "0 0 24px rgba(167,139,250,0.9), 0 2px 6px #000",
					animation: "gameSet 1.6s ease-out both",
				}}
			>
				GAME SET
			</span>
			<span
				style={{
					fontSize: "1.1rem",
					fontWeight: 700,
					color: mine ? "#4ade80" : "#cbd5e1",
				}}
			>
				{mine ? "あなたの勝利！" : "勝者が決定"}
			</span>
		</div>
	);
}
