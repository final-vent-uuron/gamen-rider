// GLB モデルアセットの配信元管理。
// モデル本体はリポジトリに置かず、Cloudflare R2 の公開バケット（gamen-rider-models）で
// 管理する（20MB 超のバイナリが多く、git 管理に向かないため）。
//   初回セットアップ / アップロード: scripts/r2-models.sh（README「3Dモデル(GLB)の管理」参照）
//
// 配信元の優先順:
//   1. VITE_MODEL_BASE_URL（.env 等での上書き。例: /model にするとローカル public/model 配信に戻る）
//   2. R2_PUBLIC_BASE_URL（R2 バケットの公開 URL。バケット作成後にここへ貼って全員の既定にする）
//   3. '/model'（public/model のローカルファイル。R2 未設定時のフォールバック）
//
// R2 の公開 URL は `pnpm models:url` で確認できる（例: https://pub-xxxxxxxx.r2.dev）。
const R2_PUBLIC_BASE_URL =
	"https://pub-7c2fbe2e557543dfba35d2c94333885e.r2.dev";

export const MODEL_BASE_URL: string =
	(import.meta.env?.VITE_MODEL_BASE_URL as string | undefined) ||
	R2_PUBLIC_BASE_URL ||
	"/model";

// GLB ファイル名 → 実際に fetch する URL。モデルを参照する箇所は必ずこれを通すこと。
export function modelUrl(file: string): string {
	return `${MODEL_BASE_URL}/${file}`;
}
