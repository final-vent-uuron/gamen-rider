// 登録ライダーの永続化（node:fs 直書き。ローカル実行＝pnpm dev 前提）。
// 画像と registry.json を src/assets/riders/ に保存する。
// このファイルはサーバー関数の handler 内から dynamic import でのみ読み込むこと
// （クライアントバンドルに node:fs が混入しないようにするため）。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RegisteredRider, SaveRiderInput } from './types'

const RIDERS_DIR = path.join(process.cwd(), 'src', 'assets', 'riders')
const REGISTRY_PATH = path.join(RIDERS_DIR, 'registry.json')

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
}

export async function readRegistry(): Promise<RegisteredRider[]> {
  try {
    const raw = await readFile(REGISTRY_PATH, 'utf8')
    return JSON.parse(raw) as RegisteredRider[]
  } catch {
    return [] // 未登録（ファイル無し）は空でよい
  }
}

export async function readRiderImageDataUrl(rider: RegisteredRider): Promise<string | null> {
  try {
    const buf = await readFile(path.join(RIDERS_DIR, rider.image))
    const ext = path.extname(rider.image).slice(1).toLowerCase()
    const mime = EXT_TO_MIME[ext] ?? 'image/png'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null // 画像だけ消えている場合はその1件をスキップさせる
  }
}

export async function saveRiderFiles(input: SaveRiderInput): Promise<RegisteredRider> {
  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/.exec(input.imageDataUrl)
  if (!m) throw new Error('画像は base64 data URL 形式で渡してください')
  const ext = MIME_TO_EXT[m[1]]
  if (!ext) throw new Error(`未対応の画像形式です: ${m[1]}`)

  const id = `rider-${Date.now().toString(36)}`
  const image = `${id}.${ext}`
  await mkdir(RIDERS_DIR, { recursive: true })
  await writeFile(path.join(RIDERS_DIR, image), Buffer.from(m[2], 'base64'))

  const entry: RegisteredRider = {
    id,
    name: input.name,
    image,
    steps: input.steps,
    createdAt: new Date().toISOString(),
  }
  const registry = await readRegistry()
  registry.push(entry)
  await writeFile(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  return entry
}
