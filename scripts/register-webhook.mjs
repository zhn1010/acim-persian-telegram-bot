const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const baseUrl = process.env.WORKER_URL;

if (!token || !secret || !baseUrl) {
  throw new Error("Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, and WORKER_URL.");
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  throw new Error("Telegram webhook secret may contain only A-Z, a-z, 0-9, _ and -.");
}

const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: `${baseUrl.replace(/\/$/, "")}/telegram/webhook`,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  }),
});
const body = await response.json();
if (!response.ok || !body.ok) throw new Error(`Telegram rejected webhook: ${JSON.stringify(body)}`);
console.log("Telegram webhook registered.");

const commandsResponse = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    commands: [
      { command: "start", description: "نمایش منوی اصلی" },
      { command: "lesson", description: "تغییر شمارهٔ درس" },
      { command: "settings", description: "تنظیمات بات" },
      { command: "help", description: "راهنما" },
    ],
  }),
});
const commandsBody = await commandsResponse.json();
if (!commandsResponse.ok || !commandsBody.ok) throw new Error(`Telegram rejected commands: ${JSON.stringify(commandsBody)}`);
console.log("Telegram command menu registered.");
