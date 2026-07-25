// BGM（public/bgm/ の mp3 再生）。効果音（sfx.ts = WebAudio 合成）とは別レイヤで、
// こちらは HTMLAudioElement によるストリーミング再生を管理する。
//
// 使い分け:
//   - main-bgm       : バトル中ずっとループ
//   - Intrusion-bgm  : 乱入（3人目以降の途中参戦）。WARNING 演出の間だけ main をダッキングして再生
//   - final-vent-bgm : ファイナルベント発動の高揚。voice（1〜4 のランダム）を重ねる
//   - win-bgm        : リザルト画面（playWinBgm を /result から呼ぶ）
//
// ブラウザの自動再生ポリシー対策: play() が拒否されたら最初のユーザー操作
// （pointerdown / keydown）で自動リトライする。SSR 安全（Audio が無ければ何もしない）。
//
// 音量: マスター 0〜1（localStorage に保存）。各トラックの相対音量に掛ける。

const BGM_DIR = "/bgm";
const VOLUME_KEY = "gamen-rider:bgm-volume";
const DEFAULT_MASTER = 0.7;

// トラックごとの相対音量（マスター 1.0 のときの目標値）
const MAIN_BASE = 0.35;
const INTRUSION_BASE = 0.75;
const FINAL_BASE = 0.6;
const VOICE_BASE = 0.9;
const WIN_BASE = 0.7;
const HOME_BASE = 0.5;
const HENSHIN_BASE = 0.5;

// ファイナルベントの掛け声（存在するファイル名そのまま。3 だけ綴りが違う）。
const FINAL_VENT_VOICES = [
	"final-vent-voice-1.mp3",
	"final-vent-voice-2.mp3",
	"fina-vent-voice-3.mp3",
	"final-vent-voice-4.mp3",
];

// ライダー別の掛け声（ロースター順に 1〜4 を割り当て）。
// 未知の riderId（既定の gamen やテスト用）は従来どおりランダム。
const VOICE_BY_RIDER: Record<string, string> = {
	arduino: FINAL_VENT_VOICES[0],
	python: FINAL_VENT_VOICES[1],
	swift: FINAL_VENT_VOICES[2],
	flutter: FINAL_VENT_VOICES[3],
};

export interface Bgm {
	playMain(): void; // メイン BGM をループ再生（既に鳴っていれば何もしない）
	intrusion(durationMs: number): void; // 乱入: main を止めて Intrusion-bgm を durationMs だけ流す
	finalVent(riderId?: string): void; // ファイナルベント: 発動ライダーの掛け声＋final-vent-bgm を数秒流して main へ戻す
	fadeOutMain(ms?: number): void; // 決着時など、main をフェードアウトして止める
	setVolume(master: number): void; // マスター音量 0〜1（即時反映＋localStorage）
	getVolume(): number;
	close(): void; // 全停止＋解放（画面を離れるとき必ず呼ぶ）
}

const NOOP: Bgm = {
	playMain() {},
	intrusion() {},
	finalVent() {},
	fadeOutMain() {},
	setVolume() {},
	getVolume: () => DEFAULT_MASTER,
	close() {},
};

function clamp01(v: number): number {
	if (Number.isNaN(v)) return DEFAULT_MASTER;
	return Math.min(1, Math.max(0, v));
}

/** localStorage からマスター音量を読む（SSR では既定値）。 */
export function getStoredBgmVolume(): number {
	if (typeof window === "undefined") return DEFAULT_MASTER;
	try {
		const raw = window.localStorage.getItem(VOLUME_KEY);
		if (raw == null) return DEFAULT_MASTER;
		return clamp01(Number.parseFloat(raw));
	} catch {
		return DEFAULT_MASTER;
	}
}

// 音量変更の通知イベント。再生中のループ BGM（home / henshin）が拾ってその場で追従する。
const VOLUME_EVENT = "gamen-rider:bgm-volume";

/** マスター音量を localStorage に保存する（UI からも直接呼べる）。 */
export function setStoredBgmVolume(master: number): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(VOLUME_KEY, String(clamp01(master)));
	} catch {
		/* quota / private mode */
	}
	window.dispatchEvent(new Event(VOLUME_EVENT));
}

// play() が自動再生ポリシーで拒否されたら、最初のユーザー操作で一度だけリトライする。
function playWithUnlock(audio: HTMLAudioElement, isAlive: () => boolean) {
	audio.play().catch(() => {
		const retry = () => {
			cleanup();
			if (isAlive()) audio.play().catch(() => {});
		};
		const cleanup = () => {
			window.removeEventListener("pointerdown", retry);
			window.removeEventListener("keydown", retry);
		};
		window.addEventListener("pointerdown", retry, { once: true });
		window.addEventListener("keydown", retry, { once: true });
	});
}

export function createBgm(): Bgm {
	if (typeof window === "undefined" || typeof Audio === "undefined")
		return NOOP;

	let closed = false;
	let master = getStoredBgmVolume();
	const alive = () => !closed;
	const timers: number[] = [];
	const later = (fn: () => void, ms: number) =>
		timers.push(window.setTimeout(fn, ms));
	const scaled = (base: number) => clamp01(base * master);

	const make = (file: string, volume: number, loop = false) => {
		const a = new Audio(`${BGM_DIR}/${file}`);
		a.volume = volume;
		a.loop = loop;
		a.preload = "auto";
		return a;
	};

	const main = make("main-bgm.mp3", scaled(MAIN_BASE), true);
	const intrusionBgm = make("Intrusion-bgm.mp3", scaled(INTRUSION_BASE));
	const finalBgm = make("final-vent-bgm.mp3", scaled(FINAL_BASE));

	// 音量フェード（50ms 刻みの線形）。onDone は最後に一度だけ。
	const fades = new Map<HTMLAudioElement, number>();
	const fadeTo = (
		a: HTMLAudioElement,
		target: number,
		ms: number,
		onDone?: () => void,
	) => {
		window.clearInterval(fades.get(a));
		const from = a.volume;
		const start = performance.now();
		const id = window.setInterval(() => {
			const k = Math.min(1, (performance.now() - start) / ms);
			a.volume = from + (target - from) * k;
			if (k >= 1) {
				window.clearInterval(id);
				fades.delete(a);
				onDone?.();
			}
		}, 50);
		fades.set(a, id);
	};

	// main を一時停止 → 割り込み音源を流す → 終わったら main をフェードインで復帰、の共通形。
	let interruptDepth = 0; // 乱入とファイナルが重なっても main の復帰は最後の1回だけ
	const interrupt = (
		a: HTMLAudioElement,
		durationMs: number,
		fadeOutMs: number,
	) => {
		interruptDepth++;
		main.pause();
		a.currentTime = 0;
		a.volume = scaled(a === intrusionBgm ? INTRUSION_BASE : FINAL_BASE);
		playWithUnlock(a, alive);
		later(
			() => fadeTo(a, 0, fadeOutMs, () => a.pause()),
			Math.max(0, durationMs - fadeOutMs),
		);
		later(() => {
			interruptDepth--;
			if (interruptDepth > 0 || closed || mainStopped) return;
			main.volume = 0;
			playWithUnlock(main, alive);
			fadeTo(main, scaled(MAIN_BASE), 600);
		}, durationMs);
	};

	let mainStopped = false;

	return {
		playMain() {
			if (closed || mainStopped) return;
			if (!main.paused) return;
			main.volume = scaled(MAIN_BASE);
			playWithUnlock(main, alive);
		},
		intrusion(durationMs) {
			if (closed) return;
			interrupt(intrusionBgm, durationMs, 700);
		},
		finalVent(riderId) {
			if (closed) return;
			// 掛け声（発動ライダー固有。未知ならランダム）＋ BGM を約 8 秒。技そのものは ~1.2s だが余韻を残す。
			const file =
				(riderId && VOICE_BY_RIDER[riderId]) ??
				FINAL_VENT_VOICES[Math.floor(Math.random() * FINAL_VENT_VOICES.length)];
			const voice = make(file, scaled(VOICE_BASE));
			playWithUnlock(voice, alive);
			interrupt(finalBgm, 8000, 1200);
		},
		fadeOutMain(ms = 800) {
			if (closed) return;
			mainStopped = true; // 以後 interrupt 明けでも main は復帰させない
			fadeTo(main, 0, ms, () => main.pause());
		},
		setVolume(next) {
			if (closed) return;
			master = clamp01(next);
			setStoredBgmVolume(master);
			// 再生中トラックへ即反映（フェード中は目標へスナップ）
			if (!main.paused && !mainStopped && interruptDepth === 0) {
				window.clearInterval(fades.get(main));
				fades.delete(main);
				main.volume = scaled(MAIN_BASE);
			}
			if (!intrusionBgm.paused) {
				window.clearInterval(fades.get(intrusionBgm));
				fades.delete(intrusionBgm);
				intrusionBgm.volume = scaled(INTRUSION_BASE);
			}
			if (!finalBgm.paused) {
				window.clearInterval(fades.get(finalBgm));
				fades.delete(finalBgm);
				finalBgm.volume = scaled(FINAL_BASE);
			}
		},
		getVolume() {
			return master;
		},
		close() {
			closed = true;
			for (const t of timers) window.clearTimeout(t);
			for (const id of fades.values()) window.clearInterval(id);
			for (const a of [main, intrusionBgm, finalBgm]) {
				a.pause();
				a.src = ""; // ネットワーク/デコードのリソースを解放
			}
		},
	};
}

// リザルト画面用の勝利ジングル（約6秒・単発）。戻り値のクリーンアップを unmount で呼ぶ。
// volume 未指定時は保存済みマスター × WIN_BASE。
export function playWinBgm(volume?: number): () => void {
	if (typeof window === "undefined" || typeof Audio === "undefined")
		return () => {};
	let stopped = false;
	const a = new Audio(`${BGM_DIR}/win-bgm.mp3`);
	a.volume = clamp01(volume ?? WIN_BASE * getStoredBgmVolume());
	playWithUnlock(a, () => !stopped);
	return () => {
		stopped = true;
		a.pause();
		a.src = "";
	};
}

// ループ再生する単発トラック用の共通ヘルパ（home-bgm / henshin-bgm で使う）。
// 戻り値のクリーンアップを unmount で呼ぶ。volume 未指定時は保存済みマスター × base。
function loopingTrack(file: string, base: number, volume?: number): () => void {
	if (typeof window === "undefined" || typeof Audio === "undefined")
		return () => {};
	let stopped = false;
	const a = new Audio(`${BGM_DIR}/${file}`);
	a.loop = true;
	a.volume = clamp01(volume ?? base * getStoredBgmVolume());
	// volume 未指定（＝マスター追従）のときは、再生中の音量変更（タイトルのスライダー等）にも追従する。
	const onVolume =
		volume === undefined
			? () => {
					a.volume = clamp01(base * getStoredBgmVolume());
				}
			: null;
	if (onVolume) window.addEventListener(VOLUME_EVENT, onVolume);
	playWithUnlock(a, () => !stopped);
	return () => {
		stopped = true;
		if (onVolume) window.removeEventListener(VOLUME_EVENT, onVolume);
		a.pause();
		a.src = "";
	};
}

// タイトル画面（/）用のループ BGM。
export function playHomeBgm(volume?: number): () => void {
	return loopingTrack("home.mp3", HOME_BASE, volume);
}

// 変身フロー（/auth・/henshin。カード認証〜ポーズ認証）用のループ BGM。
export function playHenshinBgm(volume?: number): () => void {
	return loopingTrack("henshin.mp3", HENSHIN_BASE, volume);
}
