// Screenshot harness v2 for the perfetto UI dev server.
// Usage: node shot2.mjs <outdir> <pagesJson> <light|dark|both>
// pages.json entries:
//   {name, route, extraQuery?, loadTrace?, actions?: [{clickText}], waitMs?, selector?}
// Uses ?testing=1, window.waitForPerfettoIdle(), and the settings API for
// theme forcing (full remount incl. canvas via uiMainKey).
import puppeteer from 'puppeteer';
import * as fs from 'node:fs';
import * as path from 'node:path';

const [outdir, pagesJsonPath, themeArg] = process.argv.slice(2);
const pages = JSON.parse(fs.readFileSync(pagesJsonPath, 'utf8'));
fs.mkdirSync(outdir, {recursive: true});

const TRACE_FILE =
  '/home/ga/Projects/perfetto_4/test/data/api34_startup_cold.perfetto-trace';
const themes =
  themeArg === 'both' ? ['light', 'dark'] : [themeArg ?? 'light'];

// Determinism flags lifted from ui/playwright.config.ts.
const browser = await puppeteer.launch({
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome',
  headless: 'shell',
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-font-subpixel-positioning',
    '--ignore-gpu-blocklist',
    '--use-angle=gl',
    '--disable-lcd-text',
    '--disable-spell-checking',
    '--font-render-hinting=none',
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    '--js-flags=--random-seed=1',
  ],
});

const idle = async (page, ms) => {
  // The idle detector can spuriously take 60s+ in headless (all conditions
  // report true yet it never settles). Race it against a hard cap and treat
  // the result as advisory; selector waits below provide the real readiness.
  await Promise.race([
    page
      .evaluate((timeout) => window.waitForPerfettoIdle(timeout), ms ?? 15000)
      .catch(() => {}),
    new Promise((r) => setTimeout(r, Math.min(ms ?? 15000, 8000))),
  ]);
  await page.waitForSelector('.pf-sidebar', {timeout: 30000});
};

try {
  for (const theme of themes) {
    const page = await browser.newPage();
    await page.setViewport({width: 1920, height: 1080});
    let traceLoaded = false;

    for (const p of pages) {
      const url = `http://localhost:10000/?testing=1&enablePlugins=dev.perfetto.WidgetsPage${p.extraQuery ?? ''}#!${p.route}`;
      process.stderr.write(`[shot] ${theme}/${p.name} -> ${url}\n`);

      if (traceLoaded) {
        // In-app hash navigation keeps the loaded trace alive; a full goto
        // would reload the app and drop it.
        await page.evaluate((route) => (location.hash = `#!${route}`), p.route);
      } else {
        await page.goto(url, {waitUntil: 'networkidle2', timeout: 60000});
      }
      await idle(page, 20000);

      // Force theme via the settings API (persists in localStorage and
      // remounts the whole tree, re-snapshotting canvas constants).
      const got = await page.evaluate((t) => {
        const setting = globalThis.app?.settings?.get?.('theme');
        if (!setting) return 'no-settings-api';
        if (setting.get() === t) return 'ok';
        setting.set(t); // Persists to localStorage; may not redraw from here.
        return 'changed';
      }, theme);
      if (got === 'no-settings-api') {
        throw new Error('theme forcing failed: no settings api');
      }
      if (got === 'changed') {
        // Boot fresh with the new theme — set() from outside Mithril's event
        // loop persists but doesn't reliably redraw.
        await page.reload({waitUntil: 'networkidle2', timeout: 60000});
        await idle(page, 20000);
      }
      // The provider must carry the requested theme class before we shoot.
      await page.waitForSelector(`.pf-theme-provider--${theme}`, {
        timeout: 30000,
      });

      if (p.loadTrace && !traceLoaded) {
        const input = await page.$('input.trace_file');
        if (!input) throw new Error('input.trace_file not found');
        await input.uploadFile(TRACE_FILE);
        await idle(page, 120000);
        traceLoaded = true;
      }

      for (const act of p.actions ?? []) {
        if (act.clickText) {
          await page.evaluate((txt) => {
            const pick = (sel) => {
              const els = [...document.querySelectorAll(sel)].filter((e) =>
                e.textContent.includes(txt),
              );
              els.sort((a, b) => a.textContent.length - b.textContent.length);
              return els[0];
            };
            const el = pick('a, button') ?? pick('li, div');
            if (!el) throw new Error(`clickText not found: ${txt}`);
            el.click();
          }, act.clickText);
          await idle(page, 15000);
        }
      }

      if (p.selector) {
        await page.waitForSelector(p.selector, {
          timeout: p.selectorTimeoutMs ?? 30000,
        });
      }
      // Deterministic captures: drop focus (kills caret blink diffs).
      await page.evaluate(() => document.activeElement?.blur?.());
      await new Promise((r) => setTimeout(r, p.waitMs ?? 400));

      const file = path.join(outdir, `${p.name}.${theme}.png`);
      await page.screenshot({path: file});
      console.log(file);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
