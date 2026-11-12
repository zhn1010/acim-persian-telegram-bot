# Persian ACIM Daily Companion Bot on Cloudflare

This repository contains the production implementation of the user experience documented in `PERSIAN_BOT_UX_SPEC.md`. Each user has an independent lesson number, IANA time zone, and daily reminder schedule. The bot sends the lesson at 06:00 and reminders between 08:00 and 20:00 in the user's local time. The 20:15 end-of-course prompt is shown only after lesson 365.

## Files intentionally excluded

Persian and English audio files, installed dependencies, build output, local Wrangler state, environment files, the research notebook, and temporary content-repair datasets are intentionally excluded from the public repository. The final `DB_multilingual.v4.json` dataset and the migrations required to run the bot are included.

## Architecture

- A Cloudflare Worker handles the Telegram webhook and a once-per-minute Cron Trigger.
- Cloudflare D1 stores 365 lessons, user state, daily decisions, and reminder jobs.
- Every user has an independent IANA time zone, selected through automatic detection inside Telegram or a short grouped manual list.
- Audio is delivered as native Telegram audio. Original MP3 files are archived in a private channel, registered with the bot once, and reused through the stored Telegram `file_id`. The temporary registration message is then deleted.
- The webhook is protected with `X-Telegram-Bot-Api-Secret-Token`, and Telegram update IDs are recorded idempotently.
- Reminder jobs use claim/lease processing. Reminders delayed by more than 15 minutes are marked missed instead of being replayed in a burst.

The second migration is generated from `DB_multilingual.v4.json`. The dataset contains all 365 Persian titles, full lesson texts, reminder texts, source links, available audio references, and course-recommended schedules.

## Local setup

The Worker requires Node.js 22 or newer. Audio registration and synchronization also require `ffprobe` from FFmpeg so the real MP3 duration can be stored for Telegram's audio player.

```bash
npm install
npm run cf-typegen
npm run seed:check
npm run db:local
```

Create `.dev.vars` next. This file is ignored by Git:

```dotenv
TELEGRAM_BOT_TOKEN=...
TELEGRAM_WEBHOOK_SECRET=a_secure_random_string
AUDIO_UPLOAD_SECRET=another_secure_random_string
TELEGRAM_MEDIA_CHAT_ID=...
```

Run the Worker and trigger the local Cron handler:

```bash
npm run dev
curl "http://localhost:8787/cdn-cgi/local/scheduled?format=json"
```

## Tests and quality checks

```bash
npm run typecheck
npm test
npm run build
```

The test suite covers fixed-count redistribution over the remaining day, interval schedules that begin after one complete interval, intensive eight-minute schedules, multiple time zones, daylight-saving changes, duplicate-title removal, and safe Telegram message-length limits.

## Deployment

The following commands change resources in your Cloudflare account:

1. Authenticate and create a D1 database:

   ```bash
   npx wrangler login
   npx wrangler d1 create acim-alerts-db
   ```

2. Replace the existing `database_id` in `wrangler.jsonc` with the ID returned for your D1 database. Update `APP_BASE_URL` to your own Worker URL as well.

3. Configure secrets, apply migrations, and deploy:

   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   npx wrangler secret put AUDIO_UPLOAD_SECRET
   npx wrangler secret put TELEGRAM_MEDIA_CHAT_ID
   npm run db:remote
   npm run deploy
   ```

4. Register the Telegram webhook:

   ```bash
   TELEGRAM_BOT_TOKEN=... \
   TELEGRAM_WEBHOOK_SECRET=... \
   WORKER_URL=https://acim-persian-telegram-bot.<subdomain>.workers.dev \
   npm run webhook:set
   ```

## Important product rules

- A fixed-count schedule is redistributed over the time remaining until 20:00. The bot first reserves a safety gap of at least 30 minutes, and the beginning of the available window is not itself counted as a reminder.
- An interval schedule starts after one complete interval from activation time and is rounded to the next five-minute boundary.
- Schedules with intervals of 15 minutes or less, or more than 50 reminders, require an additional confirmation.
- When a lesson provides course-recommended schedules, only those recommendations and the no-reminders option are shown. Lessons without a recommendation offer two, three, four, or five reminders.
- Lessons 1 through 364 advance to the next lesson without a nightly question. After lesson 365, completing the course is the default, while the user may repeat the final lesson or restart from lesson 1.
- The recommended audio preference is on-demand delivery through a button. Users may instead enable automatic audio delivery with the morning lesson.
- The audio button appears only when `telegram_audio_file_id` is available. Telegram reuses the same stored file instead of uploading it separately for every user.
- The media-registration chat ID is stored as a Cloudflare secret and must never be committed to `wrangler.jsonc` or source code.
- A time-zone change for an active user takes effect with the next lesson so the current day's schedule is not duplicated or truncated.
- Manual time-zone selection uses a short grouped list; free-form country or city input is not supported.
- All decisions use inline keyboards, which are removed after selection. Automatic time-zone detection temporarily uses a reply keyboard.
- Lesson text and lesson audio are persistent. The latest control message or reminder replaces the previous temporary message, and incoming user messages are deleted after processing.
- The lesson footer links to the matching lesson on `acim-farsi.org` and to `https://t.me/ACIMDailyCompanionBot`; it does not use a separate URL button.
- Permission to use the translation and audio commercially must be confirmed separately with the source owner before any commercial release.
