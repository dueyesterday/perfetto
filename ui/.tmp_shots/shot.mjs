// Screenshot harness for the perfetto UI dev server.
// Usage: node shot.mjs <outdir> <pagesJson> [themeClassOverride]
// pagesJson: [{name, url, waitMs?, selector?}]
import puppeteer from 'puppeteer';
import * as fs from 'node:fs';
import * as path from 'node:path';

const [outdir, pagesJsonPath, theme] = process.argv.slice(2);
if (!outdir || !pagesJsonPath) {
  console.error('usage: node shot.mjs <outdir> <pages.json> [light|dark]');
  process.exit(1);
}
const pages = JSON.parse(fs.readFileSync(pagesJsonPath, 'utf8'));
fs.mkdirSync(outdir, {recursive: true});

const execPath =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome';

const browser = await puppeteer.launch({
  executablePath: execPath,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({width: 1600, height: 1000});

  for (const p of pages) {
    const url = p.url;
    process.stderr.write(`[shot] ${p.name} -> ${url}\n`);
    await page.goto(url, {waitUntil: 'networkidle2', timeout: 60000});

    // Dismiss cookie consent if present.
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const ok = btns.find((b) => b.textContent.trim() === 'OK');
      if (ok) ok.click();
    });

    // Force theme if requested. THEME_HOOK is finalized once we know the
    // exact mechanism (settings key); placeholder: toggle the provider class.
    if (theme === 'light' || theme === 'dark') {
      await page.evaluate((t) => {
        const el = document.querySelector('.pf-theme-provider');
        if (el) {
          el.classList.remove('pf-theme-provider--light', 'pf-theme-provider--dark');
          el.classList.add(`pf-theme-provider--${t}`);
        }
      }, theme);
    }

    // Optional click-through actions: [{clickText: '...'}]
    for (const act of p.actions ?? []) {
      if (act.clickText) {
        await page.evaluate((txt) => {
          // Icon ligatures pollute textContent, so match on inclusion and
          // pick the tightest (shortest-text) clickable candidate.
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
        await new Promise((r) => setTimeout(r, act.waitMs ?? 1000));
      }
    }

    if (p.selector) {
      await page.waitForSelector(p.selector, {timeout: p.selectorTimeoutMs ?? 30000});
    }
    await new Promise((r) => setTimeout(r, p.waitMs ?? 1500));

    const file = path.join(outdir, `${p.name}${theme ? '.' + theme : ''}.png`);
    await page.screenshot({path: file});
    console.log(file);
  }
} finally {
  await browser.close();
}
