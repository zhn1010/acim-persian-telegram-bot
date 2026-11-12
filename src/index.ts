import { claimUpdate } from "./db";
import { handleUpdate } from "./bot";
import { runScheduler } from "./scheduler";
import { timezoneDetectorPage } from "./timezone-page";
import { TelegramClient } from "./telegram";
import type { AppEnv, TelegramUpdate } from "./types";

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "acim-persian-telegram-bot" });
    }
    if (request.method === "GET" && url.pathname === "/timezone") return timezoneDetectorPage();
    const audioAdminMatch = /^\/admin\/audio\/(\d{1,3})$/.exec(url.pathname);
    if (audioAdminMatch && (request.method === "GET" || request.method === "POST" || request.method === "PATCH")) {
      return handleAudioAdmin(request, env, Number(audioAdminMatch[1]));
    }
    if (request.method !== "POST" || url.pathname !== "/telegram/webhook") return new Response("Not found", { status: 404 });
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return new Response("Server is not configured", { status: 503 });
    const providedSecret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!(await constantTimeEqual(providedSecret, env.TELEGRAM_WEBHOOK_SECRET))) return new Response("Unauthorized", { status: 401 });
    if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return new Response("Unsupported media type", { status: 415 });

    let update: TelegramUpdate;
    try {
      update = await request.json<TelegramUpdate>();
      if (!Number.isSafeInteger(update.update_id)) throw new Error("Invalid update_id");
    } catch {
      return new Response("Invalid update", { status: 400 });
    }

    const nowMs = Date.now();
    if (!(await claimUpdate(env.DB, update.update_id, nowMs))) return new Response("OK");
    try {
      await handleUpdate(update, env, nowMs);
    } catch (error) {
      console.error("telegram_update_failed", { updateId: update.update_id, error: error instanceof Error ? error.message : String(error) });
      await env.DB.prepare("DELETE FROM telegram_updates WHERE update_id = ?").bind(update.update_id).run();
      return new Response("Retry", { status: 500 });
    }
    return new Response("OK");
  },

  async scheduled(controller: ScheduledController, env: AppEnv): Promise<void> {
    await runScheduler(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<AppEnv>;

async function handleAudioAdmin(request: Request, env: AppEnv, lessonNumber: number): Promise<Response> {
  if (!env.AUDIO_UPLOAD_SECRET || !env.TELEGRAM_MEDIA_CHAT_ID) return Response.json({ ok: false, error: "Audio upload is not configured" }, { status: 503 });
  const authorization = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.AUDIO_UPLOAD_SECRET}`;
  if (!(await constantTimeEqual(authorization, expected))) return new Response("Unauthorized", { status: 401 });
  if (!Number.isInteger(lessonNumber) || lessonNumber < 1 || lessonNumber > 365) return Response.json({ ok: false, error: "Invalid lesson" }, { status: 400 });
  const lesson = await env.DB.prepare("SELECT telegram_audio_file_id, telegram_audio_duration, telegram_audio_uploading_at_ms FROM lessons WHERE lesson_number = ?").bind(lessonNumber).first<{ telegram_audio_file_id: string | null; telegram_audio_duration: number | null; telegram_audio_uploading_at_ms: number | null }>();
  if (!lesson) return Response.json({ ok: false, error: "Lesson not found" }, { status: 404 });
  if (request.method === "GET") return Response.json({ ok: true, ready: Boolean(lesson.telegram_audio_file_id), duration: lesson.telegram_audio_duration });
  if (request.method === "PATCH") {
    if (!lesson.telegram_audio_file_id) return Response.json({ ok: false, error: "Audio is not ready" }, { status: 409 });
    if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return Response.json({ ok: false, error: "Expected JSON" }, { status: 415 });
    let duration: number;
    try {
      const body = await request.json<{ duration?: unknown }>();
      duration = Number(body.duration);
    } catch {
      return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
    }
    if (!Number.isInteger(duration) || duration < 1 || duration > 24 * 60 * 60) return Response.json({ ok: false, error: "Invalid duration" }, { status: 400 });
    await env.DB.prepare("UPDATE lessons SET telegram_audio_duration = ? WHERE lesson_number = ? AND telegram_audio_file_id IS NOT NULL").bind(duration, lessonNumber).run();
    return Response.json({ ok: true, ready: true, lesson: lessonNumber, duration });
  }
  if (lesson.telegram_audio_file_id) return Response.json({ ok: true, ready: true, alreadyUploaded: true });

  const declaredSize = Number(request.headers.get("content-length") ?? 0);
  if (declaredSize <= 0 || declaredSize > 50 * 1024 * 1024) return Response.json({ ok: false, error: "Audio must be between 1 byte and 50 MB" }, { status: 413 });
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "audio/mpeg" && contentType !== "audio/mp3") return Response.json({ ok: false, error: "Expected MP3 audio" }, { status: 415 });
  const declaredDuration = Number(request.headers.get("x-audio-duration") ?? 0);
  if (declaredDuration !== 0 && (!Number.isInteger(declaredDuration) || declaredDuration < 1 || declaredDuration > 24 * 60 * 60)) return Response.json({ ok: false, error: "Invalid audio duration" }, { status: 400 });

  const nowMs = Date.now();
  const claim = await env.DB.prepare(`
    UPDATE lessons SET telegram_audio_uploading_at_ms = ?
    WHERE lesson_number = ? AND telegram_audio_file_id IS NULL
      AND (telegram_audio_uploading_at_ms IS NULL OR telegram_audio_uploading_at_ms < ?)
  `).bind(nowMs, lessonNumber, nowMs - 10 * 60_000).run();
  if ((claim.meta.changes ?? 0) !== 1) return Response.json({ ok: false, error: "Upload already in progress" }, { status: 409 });

  try {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength !== declaredSize || bytes.byteLength > 50 * 1024 * 1024) throw new Error("Audio size did not match Content-Length");
    const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
    const sent = await telegram.uploadAudio(env.TELEGRAM_MEDIA_CHAT_ID, bytes, `${String(lessonNumber).padStart(3, "0")}.mp3`, lessonNumber, declaredDuration || undefined);
    if (!sent.audio) throw new Error("Telegram response did not include audio metadata");
    await env.DB.prepare(`
      UPDATE lessons SET telegram_audio_file_id = ?, telegram_audio_file_unique_id = ?, telegram_audio_duration = ?, telegram_audio_uploading_at_ms = NULL
      WHERE lesson_number = ? AND telegram_audio_uploading_at_ms = ?
    `).bind(sent.audio.file_id, sent.audio.file_unique_id, sent.audio.duration || declaredDuration || null, lessonNumber, nowMs).run();
    try {
      await telegram.deleteMessage(env.TELEGRAM_MEDIA_CHAT_ID, sent.message_id);
    } catch (deleteError) {
      console.warn("audio_registration_message_delete_failed", {
        lesson: lessonNumber,
        messageId: sent.message_id,
        error: deleteError instanceof Error ? deleteError.message : String(deleteError),
      });
    }
    return Response.json({ ok: true, ready: true, lesson: lessonNumber });
  } catch (error) {
    await env.DB.prepare("UPDATE lessons SET telegram_audio_uploading_at_ms = NULL WHERE lesson_number = ? AND telegram_audio_uploading_at_ms = ?").bind(lessonNumber, nowMs).run();
    console.error("audio_upload_failed", { lesson: lessonNumber, error: error instanceof Error ? error.message : String(error) });
    return Response.json({ ok: false, error: "Upload failed" }, { status: 502 });
  }
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = left.length === right.length ? 0 : 1;
  for (let index = 0; index < a.length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}
