import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

const workerUrl = process.env.WORKER_URL?.replace(/\/$/, "");
const secret = process.env.AUDIO_UPLOAD_SECRET_FILE
  ? (await readFile(process.env.AUDIO_UPLOAD_SECRET_FILE, "utf8")).trim()
  : process.env.AUDIO_UPLOAD_SECRET;
if (!workerUrl || !secret) throw new Error("Set WORKER_URL and either AUDIO_UPLOAD_SECRET_FILE or AUDIO_UPLOAD_SECRET. The Telegram bot token remains inside Cloudflare.");

const root = process.cwd();
const manifestPath = path.join(root, "telegram_audio_manifest.json");
const from = parseBound("--from", 1);
const to = parseBound("--to", 260);
const manifest = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, "utf8")) : { workerUrl, lessons: {} };
if (manifest.workerUrl !== workerUrl) throw new Error("The existing manifest belongs to a different Worker URL.");

for (let lesson = from; lesson <= to; lesson += 1) {
  const key = String(lesson);
  const filePath = path.join(root, "persian_audio", "lessons", `${String(lesson).padStart(3, "0")}.mp3`);
  const duration = existsSync(filePath) ? await probeDuration(filePath) : null;
  const status = await getStatus(lesson);
  if (status.ready) {
    if (duration && status.duration !== duration) {
      await updateDuration(lesson, duration);
      console.log(`Lesson ${lesson}: duration updated (${duration}s)`);
    }
    manifest.lessons[key] = { ready: true };
    await saveManifest();
    if (!duration || status.duration === duration) console.log(`Lesson ${lesson}: already ready`);
    continue;
  }
  if (!existsSync(filePath)) {
    console.log(`Lesson ${lesson}: no local audio`);
    continue;
  }
  await uploadWithRetry(filePath, lesson, duration);
  manifest.lessons[key] = { ready: true };
  await saveManifest();
  console.log(`Lesson ${lesson}: uploaded`);
}

console.log(`Resumable manifest: ${manifestPath}`);

async function getStatus(lesson) {
  const response = await fetch(`${workerUrl}/admin/audio/${lesson}`, { headers: authorizationHeaders() });
  if (!response.ok) throw new Error(`Could not check lesson ${lesson}: HTTP ${response.status}`);
  return response.json();
}

async function updateDuration(lesson, duration) {
  const response = await fetch(`${workerUrl}/admin/audio/${lesson}`, {
    method: "PATCH",
    headers: { ...authorizationHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ duration }),
  });
  if (!response.ok) throw new Error(`Could not update duration for lesson ${lesson}: HTTP ${response.status}`);
}

async function uploadWithRetry(filePath, lesson, duration) {
  const bytes = await readFile(filePath);
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const response = await fetch(`${workerUrl}/admin/audio/${lesson}`, {
      method: "POST",
      headers: { ...authorizationHeaders(), "content-type": "audio/mpeg", "content-length": String(bytes.byteLength), ...(duration ? { "x-audio-duration": String(duration) } : {}) },
      body: bytes,
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok && result.ready) return;
    if ((response.status === 409 || response.status === 429 || response.status >= 500) && attempt < 6) {
      const delayMs = attempt * 5000;
      console.warn(`Lesson ${lesson}: retry in ${delayMs / 1000}s (HTTP ${response.status})`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    throw new Error(`Upload failed for lesson ${lesson}: ${result.error ?? `HTTP ${response.status}`}`);
  }
}

async function probeDuration(filePath) {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath]);
  const seconds = Math.round(Number(stdout.trim()));
  if (!Number.isInteger(seconds) || seconds < 1) throw new Error(`Could not read duration from ${filePath}`);
  return seconds;
}

function authorizationHeaders() {
  return { authorization: `Bearer ${secret}` };
}

async function saveManifest() {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function parseBound(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 365) throw new Error(`${name} must be an integer from 1 to 365`);
  return value;
}
