export function timezoneDetectorPage(): Response {
  return new Response(`<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>تشخیص منطقهٔ زمانی</title>
  <script src="https://telegram.org/js/telegram-web-app.js?59"></script>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, sans-serif; }
    body { margin: 0; padding: max(24px, env(safe-area-inset-top)) 20px max(24px, env(safe-area-inset-bottom)); background: var(--tg-theme-bg-color, #fff); color: var(--tg-theme-text-color, #17203a); }
    main { max-width: 520px; margin: 0 auto; text-align: center; }
    .icon { font-size: 48px; margin: 18px 0 8px; }
    h1 { font-size: 22px; margin: 0 0 12px; }
    p { line-height: 1.8; color: var(--tg-theme-hint-color, #657080); }
    .card { margin: 24px 0; padding: 18px; border-radius: 16px; background: var(--tg-theme-secondary-bg-color, #f2f4f7); }
    #zone { font-weight: 700; font-size: 18px; overflow-wrap: anywhere; }
    #clock { margin-top: 8px; font-size: 16px; }
    button { width: 100%; border: 0; border-radius: 12px; padding: 14px 16px; font: inherit; font-weight: 700; background: var(--tg-theme-button-color, #3b68d8); color: var(--tg-theme-button-text-color, #fff); cursor: pointer; }
    button:disabled { opacity: .55; cursor: default; }
    .privacy { font-size: 13px; }
  </style>
</head>
<body>
<main>
  <div class="icon">🌍</div>
  <h1>منطقهٔ زمانی دستگاه شما</h1>
  <p>فقط نام منطقهٔ زمانی دستگاه خوانده می‌شود؛ موقعیت مکانی یا GPS دریافت نمی‌شود.</p>
  <div class="card"><div id="zone">در حال تشخیص…</div><div id="clock"></div></div>
  <button id="confirm" disabled>تأیید منطقهٔ زمانی</button>
  <p class="privacy">پس از تأیید، درس ساعت ۶ صبح و پیام‌های روزانه بر اساس همین زمان تنظیم می‌شوند.</p>
</main>
<script>
  const webApp = window.Telegram?.WebApp;
  webApp?.ready();
  webApp?.expand();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zoneElement = document.getElementById('zone');
  const clockElement = document.getElementById('clock');
  const confirm = document.getElementById('confirm');
  if (zone && webApp) {
    zoneElement.textContent = zone.replaceAll('_', ' ');
    clockElement.textContent = 'اکنون: ' + new Intl.DateTimeFormat('fa-IR', { timeZone: zone, hour: '2-digit', minute: '2-digit' }).format(new Date());
    confirm.disabled = false;
    confirm.addEventListener('click', () => {
      confirm.disabled = true;
      confirm.textContent = 'در حال ثبت…';
      webApp.sendData(JSON.stringify({ type: 'timezone', timeZone: zone }));
    }, { once: true });
  } else {
    zoneElement.textContent = 'تشخیص خودکار در دسترس نیست';
    clockElement.textContent = 'به تلگرام برگردید و انتخاب دستی را بزنید.';
  }
</script>
</body>
</html>`, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org; base-uri 'none'; form-action 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
