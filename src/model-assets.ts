// GLB モデルアセットの配信元管理。
// モデル本体はリポジトリに置かず、Cloudflare R2 の公開バケット（gamen-rider-models）で
// 管理する（20MB 超のバイナリが多く、git 管理に向かないため）。
// ローカル開発も本番も R2 から取得する。
//   初回セットアップ / アップロード: scripts/r2-models.sh（README「3Dモデル(GLB)の管理」参照）
//   公開 URL の確認: `pnpm models:url`
//
// VITE_MODEL_BASE_URL（.env 等）を設定するとその値を優先する。
// オフライン検証などで R2 を使えないときに `/model`（public/model のローカルファイル）へ
// 切り替える用途。通常は未設定のままでよい。
const R2_PUBLIC_BASE_URL =
	"https://pub-7c2fbe2e557543dfba35d2c94333885e.r2.dev";

export const MODEL_BASE_URL: string =
	(import.meta.env?.VITE_MODEL_BASE_URL as string | undefined) ||
	R2_PUBLIC_BASE_URL;

// GLB ファイル名 → 実際に fetch する URL。モデルを参照する箇所は必ずこれを通すこと。
export function modelUrl(file: string): string {
	return `${MODEL_BASE_URL}/${file}`;
}
