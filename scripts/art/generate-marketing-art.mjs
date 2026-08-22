#!/usr/bin/env node
/**
 * LP Editorial Commerce — AI banner generation pipeline (dev-time only).
 *
 * Usage:
 *   NANOBANANA_API_KEY=… npm run art:generate        # render missing art + emit variants
 *   NANOBANANA_API_KEY=… npm run art:generate -- --only=hero-editorial-desktop,auth-panel
 *   npm run art:reprocess                            # skip the gateway, rebuild from art-raw/
 *
 * Renders come from a local nanobanana gateway (OpenAI-compatible
 * /v1/images/generations). The API key is read from the environment and never
 * written to the repo. Raw renders land in art-raw/ (gitignored); sharp then
 * encodes committed AVIF/WebP variants under public/brand/landing/v1/.
 * Production serves only the committed files — it never calls the gateway.
 */
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import sharp from "sharp"
import { ART_SPEC, ASPECT_SIZE, ENCODE, FORMATS } from "./prompts.mjs"

const REPO = resolve(import.meta.dirname, "../..")
const RAW_DIR = resolve(REPO, "art-raw")
const OUT_DIR = resolve(REPO, "public/brand/landing/v1")
const MANIFEST_PATH = resolve(REPO, "scripts/art/manifest.json")
const LOGO_WHITE_SVG = resolve(REPO, "public/brand/logo/selinow-logo-white.svg")

const BASE_URL = process.env.NANOBANANA_BASE_URL ?? "http://localhost:20128"
const MODEL = process.env.NANOBANANA_MODEL ?? "nb/nanobanana-pro"
const API_KEY = process.env.NANOBANANA_API_KEY ?? ""

const REQUEST_TIMEOUT_MS = 300_000
const ATTEMPTS = 3
const RETRY_DELAY_MS = 8_000

const args = process.argv.slice(2)
const onlyFlag = args.find((arg) => arg.startsWith("--only="))?.slice("--only=".length)
const only = onlyFlag ? new Set(onlyFlag.split(",").map((id) => id.trim()).filter(Boolean)) : null
const skipFetch = args.includes("--skip-fetch")
const force = args.includes("--force")
const listOnly = args.includes("--list")

const spec = only ? ART_SPEC.filter((item) => only.has(item.id)) : ART_SPEC
if (only) {
  const unknown = [...only].filter((id) => !ART_SPEC.some((item) => item.id === id))
  if (unknown.length > 0) {
    console.error(`Unknown art ids: ${unknown.join(", ")} (see scripts/art/prompts.mjs)`)
    process.exit(1)
  }
}
if (spec.length === 0) {
  console.error("Nothing selected")
  process.exit(1)
}

if (listOnly) {
  for (const item of ART_SPEC) console.log(`${item.id}  ${item.aspect}  seed=n/a`)
  process.exit(0)
}

const needsGateway = !skipFetch && spec.some((item) => force || !existsSync(resolve(RAW_DIR, `${item.id}.png`)))
if (needsGateway && !API_KEY) {
  console.error("NANOBANANA_API_KEY is missing — export it before generating (never commit it).")
  process.exit(1)
}

await mkdir(RAW_DIR, { recursive: true })
await mkdir(OUT_DIR, { recursive: true })

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 16)
}

async function postGeneration(item) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${BASE_URL}/v1/images/generations`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        prompt: item.prompt,
        n: 1,
        size: ASPECT_SIZE[item.aspect],
        quality: "auto",
        background: "auto",
        image_detail: "high",
        output_format: "png",
      }),
    })
    if (!response.ok) {
      throw new Error(`gateway HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
    }
    const payload = await response.json()
    const entry = payload?.data?.[0]
    if (typeof entry?.b64_json === "string") {
      return Buffer.from(entry.b64_json, "base64")
    }
    if (typeof entry?.url === "string") {
      const imageResponse = await fetch(entry.url, { signal: controller.signal })
      if (!imageResponse.ok) throw new Error(`render download HTTP ${imageResponse.status}`)
      return Buffer.from(await imageResponse.arrayBuffer())
    }
    throw new Error("gateway response has neither data[0].url nor data[0].b64_json")
  } finally {
    clearTimeout(timer)
  }
}

async function fetchRender(item) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const bytes = await postGeneration(item)
      if (bytes.byteLength < 20_000) throw new Error(`suspiciously small render (${bytes.byteLength} bytes)`)
      const meta = await sharp(bytes).metadata()
      if ((meta.width ?? 0) < 800 || (meta.height ?? 0) < 600) {
        throw new Error(`render came back ${meta.width}x${meta.height}, expected a >=1K native aspect`)
      }
      return bytes
    } catch (error) {
      const reason = error.name === "AbortError" ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : error.message
      console.error(`  attempt ${attempt}/${ATTEMPTS} failed: ${reason}`)
      if (attempt === ATTEMPTS) {
        throw new Error(`render failed after ${ATTEMPTS} attempts: ${reason}`, { cause: error })
      }
      await sleep(RETRY_DELAY_MS * attempt)
    }
  }
  return null
}

async function composeOg(rawPath, outPath) {
  const overlay = Buffer.from(
    `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">` +
      `<defs><linearGradient id="veil" x1="0" y1="0" x2="1" y2="0">` +
      `<stop offset="0%" stop-color="#0B1020" stop-opacity="0.92"/>` +
      `<stop offset="46%" stop-color="#0B1020" stop-opacity="0.55"/>` +
      `<stop offset="100%" stop-color="#0B1020" stop-opacity="0.05"/>` +
      `</linearGradient></defs>` +
      `<rect width="1200" height="630" fill="url(#veil)"/></svg>`
  )
  const logo = await sharp(await readFile(LOGO_WHITE_SVG)).resize({ width: 360 }).png().toBuffer()
  const logoMeta = await sharp(logo).metadata()
  await sharp(rawPath)
    .resize(1200, 630, { fit: "cover" })
    .flatten({ background: "#ffffff" })
    .composite([
      { input: overlay },
      { input: logo, left: 64, top: 630 - 64 - (logoMeta.height ?? 0) },
    ])
    .jpeg({ quality: 86, progressive: true, chromaSubsampling: "4:4:4" })
    .toFile(outPath)
}

const manifest = []
const failures = []

for (const item of spec) {
  const rawPath = resolve(RAW_DIR, `${item.id}.png`)
  let raw
  if (skipFetch || (!force && existsSync(rawPath))) {
    if (!existsSync(rawPath)) {
      console.error(`x ${item.id}: no raw render at art-raw/${item.id}.png (run without --skip-fetch)`)
      failures.push(item.id)
      continue
    }
    raw = await readFile(rawPath)
    console.log(`- ${item.id}: reusing art-raw/${item.id}.png`)
  } else {
    console.log(`- ${item.id}: rendering via ${MODEL} (${item.aspect}, ${ASPECT_SIZE[item.aspect]}) ...`)
    try {
      raw = await fetchRender(item)
      await writeFile(rawPath, raw)
      console.log(`  saved raw ${raw.byteLength} bytes`)
    } catch (error) {
      console.error(`x ${item.id}: ${error.message}`)
      failures.push(item.id)
      continue
    }
  }

  const entry = {
    id: item.id,
    aspect: item.aspect,
    gatewayModel: MODEL,
    promptSha256: sha256(Buffer.from(item.prompt, "utf8")),
    files: [],
  }

  try {
    if (item.id === "og-editorial") {
      const ogPath = resolve(OUT_DIR, "og-editorial.jpg")
      await composeOg(rawPath, ogPath)
      const bytes = await readFile(ogPath)
      entry.files.push({ file: "og-editorial.jpg", bytes: bytes.byteLength, sha256: sha256(bytes) })
    }
    for (const variantWidth of item.variants) {
      for (const format of FORMATS) {
        const name = `${item.id}-${variantWidth}.${format}`
        const outPath = resolve(OUT_DIR, name)
        const info = await sharp(raw)
          .resize({ width: variantWidth, withoutEnlargement: true })
          .toFormat(format, ENCODE[format])
          .toFile(outPath)
        entry.files.push({ file: name, bytes: info.size, sha256: null })
      }
    }
    for (const file of entry.files) {
      if (file.sha256) continue
      const bytes = await readFile(resolve(OUT_DIR, file.file))
      file.sha256 = sha256(bytes)
    }
    manifest.push(entry)
    const total = entry.files.reduce((sum, file) => sum + file.bytes, 0)
    console.log(`  -> ${entry.files.length} file(s), ${(total / 1024).toFixed(0)} KiB total`)
  } catch (error) {
    console.error(`x ${item.id}: encode failed: ${error.message}`)
    failures.push(item.id)
  }
}

if (manifest.length > 0) {
  const previous = existsSync(MANIFEST_PATH) ? JSON.parse(await readFile(MANIFEST_PATH, "utf8")) : []
  const merged = new Map(previous.map((entry) => [entry.id, entry]))
  for (const entry of manifest) merged.set(entry.id, entry)
  await writeFile(MANIFEST_PATH, `${JSON.stringify([...merged.values()], null, 2)}\n`)
  console.log(`manifest updated: scripts/art/manifest.json (${merged.size} entries)`)
}

if (failures.length > 0) {
  console.error(`\nFailed ids: ${failures.join(", ")} — re-run with --only=${failures.join(",")}`)
  process.exit(1)
}
console.log("\nAll requested art processed.")
