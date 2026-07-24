// 登録ライダーの保存/一覧 API（R2 バケット gamen-rider-models の riders/ プレフィックス）。
// クライアント（/auth/register, /auth など）は dev/本番どちらからも
// デプロイ済みのこの Worker へ直接 fetch する＝登録データが全 PC で共有される。
//
// 保存形式: riders/<id>.json 1オブジェクト＝ライダー1件（画像は data URL のまま同梱）。
// registry.json のような単一ファイルへの read-modify-write をしないので、
// 2PC からの同時登録でも上書き事故が起きない。
//
// id はクライアントがロースターの slug（arduino / python / swift / flutter）を指定してくる想定。
// 同じ id への再登録は同じファイルへの上書き＝ライダーは常に1件ずつに保たれる
//（同一画像が2件並ぶとカード認証のマージン判定が通らなくなるため、重複させない）。

const RIDERS_PREFIX = "riders/";

// steps（ポーズ手順）は src/pose/custom.ts の CustomStep[]。Worker 側では中身に
// 関知せず JSON として素通しする。
// sensorSet: BLE センサー名（<ライダー名>_<部位> 命名の <ライダー名> 部分。例: "Arduino"）。
//   null = 紐付けなし。
// nfcId: ファイナルベント用 NFC タグの固有ID（Swift アプリの enroll で紐付け）。null = 未紐付け。
//   GET /riders のレスポンスには含めない（誰でも取得できる公開 API に乗せると、タグを
//   持たない第三者でも他人のライダーの必殺を撃てる「誰でも打てる」問題がそのまま残るため）。
//   battle-room.ts が readAllRiders() 経由でサーバー内部だけに使う。
export interface StoredRider {
	id: string;
	name: string;
	imageDataUrl: string;
	steps: unknown[];
	// ファイナルベント発動時のポーズ手順（変身ポーズの steps とは別収録）。
	// finalVentSteps 導入前の登録、または未登録は null（バトル側は builtin フォールバックを使う）。
	finalVentSteps: unknown[] | null;
	sensorSet: string | null;
	nfcId: string | null;
	createdAt: string;
}

/** R2 の riders/*.json を全件読む（内部用。nfcId を含む生データ）。壊れた1件はスキップ。 */
export async function readAllRiders(bucket: R2Bucket): Promise<StoredRider[]> {
	const listed = await bucket.list({ prefix: RIDERS_PREFIX });
	const riders = await Promise.all(
		listed.objects
			.filter((o) => o.key.endsWith(".json"))
			.map(async (o) => {
				const obj = await bucket.get(o.key);
				if (!obj) return null;
				try {
					return (await obj.json()) as StoredRider;
				} catch {
					return null; // 壊れた1件はスキップして他を生かす
				}
			}),
	);
	return riders.filter((r): r is StoredRider => r !== null);
}

const CORS_HEADERS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, OPTIONS",
	"access-control-allow-headers": "content-type",
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...CORS_HEADERS,
		},
	});
}

export async function handleRiders(
	request: Request,
	bucket: R2Bucket,
): Promise<Response> {
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: CORS_HEADERS });
	}

	if (request.method === "GET") {
		const all = await readAllRiders(bucket);
		const valid = all
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
			.map(({ id, name, steps, finalVentSteps, imageDataUrl, sensorSet }) => ({
				id,
				name,
				steps,
				finalVentSteps: finalVentSteps ?? null, // finalVentSteps 導入前の登録は null 扱い
				imageDataUrl,
				sensorSet: sensorSet ?? null, // sensorSet 導入前の登録は null 扱い
				// nfcId はここで意図的に除外（公開 API に乗せない。上のコメント参照）
			}));
		return json(valid);
	}

	if (request.method === "POST") {
		let input: Partial<StoredRider>;
		try {
			input = (await request.json()) as Partial<StoredRider>;
		} catch {
			return json({ error: "JSON ボディが必要です" }, 400);
		}
		if (!input.name?.trim()) return json({ error: "ライダー名が空です" }, 400);
		if (!input.imageDataUrl?.startsWith("data:image/"))
			return json({ error: "画像がありません" }, 400);
		if (!Array.isArray(input.steps) || input.steps.length === 0)
			return json({ error: "ポーズが未登録です" }, 400);
		if (input.id !== undefined && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(input.id))
			return json({ error: "id は英小文字・数字・ハイフンのみです" }, 400);

		const id = input.id ?? `rider-${Date.now().toString(36)}`;
		const sensorSet =
			typeof input.sensorSet === "string" && input.sensorSet.trim()
				? input.sensorSet.trim()
				: null;
		// 既存ライダーへの上書き登録で NFC タグの紐付け／ファイナルベントポーズ未送信時に
		// 消さないよう、既存エントリから引き継ぐ（bind は /riders/nfc-bind の専任なのでここでは受け取らない）。
		const existing = await bucket.get(`${RIDERS_PREFIX}${id}.json`);
		const prev = existing ? ((await existing.json()) as StoredRider) : null;
		const nfcId = prev?.nfcId ?? null;
		const finalVentSteps =
			Array.isArray(input.finalVentSteps) && input.finalVentSteps.length > 0
				? input.finalVentSteps
				: (prev?.finalVentSteps ?? null);
		const entry: StoredRider = {
			id,
			name: input.name.trim(),
			imageDataUrl: input.imageDataUrl,
			steps: input.steps,
			finalVentSteps,
			sensorSet,
			nfcId,
			createdAt: new Date().toISOString(),
		};
		await bucket.put(`${RIDERS_PREFIX}${id}.json`, JSON.stringify(entry), {
			httpMetadata: { contentType: "application/json" },
		});
		return json({ id });
	}

	return json({ error: "method not allowed" }, 405);
}

/**
 * NFC タグの紐付け（enroll）。Swift アプリのセットアップ画面から一度だけ呼ぶ想定:
 * 対象ライダーを選び、物理タグを読ませて {riderId, nfcId} を送る。
 * 対象ライダーが未登録なら 404（先に /auth/register で登録しておく必要がある）。
 */
export async function handleNfcBind(
	request: Request,
	bucket: R2Bucket,
): Promise<Response> {
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: CORS_HEADERS });
	}
	if (request.method !== "POST")
		return json({ error: "method not allowed" }, 405);

	let input: { riderId?: unknown; nfcId?: unknown; tagId?: unknown };
	try {
		input = (await request.json()) as {
			riderId?: unknown;
			nfcId?: unknown;
			tagId?: unknown;
		};
	} catch {
		return json({ error: "JSON ボディが必要です" }, 400);
	}
	const riderId = typeof input.riderId === "string" ? input.riderId : "";
	// Swift アプリ側は "tagId" というキー名で送ってくる（web 側が合わせる方針）。
	const rawNfcId = input.nfcId ?? input.tagId;
	const nfcId = typeof rawNfcId === "string" ? rawNfcId.trim() : "";
	if (!riderId) return json({ error: "riderId が空です" }, 400);
	if (!nfcId) return json({ error: "nfcId が空です" }, 400);

	const key = `${RIDERS_PREFIX}${riderId}.json`;
	const obj = await bucket.get(key);
	if (!obj) return json({ error: `未登録のライダーです: ${riderId}` }, 404);
	const entry = (await obj.json()) as StoredRider;
	entry.nfcId = nfcId;
	await bucket.put(key, JSON.stringify(entry), {
		httpMetadata: { contentType: "application/json" },
	});
	return json({ ok: true, riderId, nfcId });
}
