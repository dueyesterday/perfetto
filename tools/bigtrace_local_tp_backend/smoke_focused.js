// Focused Playwright test for two recent fixes:
//   1. Async query: tab.execution must be assigned in runAsync so the status
//      pill in the materialized status bar reflects IN_PROGRESS -> SUCCESS
//      (not stuck on UNKNOWN).
//   2. trace_directory setting: backend should expandvars/expanduser, so
//      typing "~/Downloads" in Settings resolves correctly.
//
// Prereqs (this script does NOT spawn its own backend):
//   - bigtrace_local_tp_backend on http://127.0.0.1:8002 with
//     `--traces-dir /tmp/btraces` (or whatever; we'll override via setting)
//   - perfetto dev server on http://127.0.0.1:10000 (--bigtrace --serve)
//   - At least one .pftrace / .perfetto-trace / .pb / .trace file in
//     ~/Downloads (so the ~ expansion test has something to query).
//
// Run:
//   node smoke_focused.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const PERFETTO_UI = path.resolve(
  __dirname,
  '../../../perfetto/ui/node_modules/@playwright/test',
);
const {chromium} = require(PERFETTO_UI);

const UI = 'http://127.0.0.1:10000/bigtrace.html';
const BACKEND = 'http://127.0.0.1:8002';
const STORAGE_KEY = 'bigtraceSettings';
const SHOTS = path.join(__dirname, 'shots_focused');
fs.mkdirSync(SHOTS, {recursive: true});
for (const f of fs.readdirSync(SHOTS)) fs.unlinkSync(path.join(SHOTS, f));

const dlDir = path.join(os.homedir(), 'Downloads');
const dlTraces = fs.existsSync(dlDir)
  ? fs.readdirSync(dlDir).filter((f) =>
      /\.(pftrace|perfetto-trace|pb|trace)$/.test(f),
    )
  : [];

const issues = [];
function fail(msg) {
  console.log(`  FAIL: ${msg}`);
  issues.push(msg);
}
function ok(msg) {
  console.log(`  OK: ${msg}`);
}

let step = 0;
function header(t) {
  step++;
  console.log(`\n=== STEP ${step}: ${t} ===`);
}

async function snap(page, name) {
  const tag = String(step).padStart(2, '0');
  await page.screenshot({
    path: path.join(SHOTS, `${tag}_${name}.png`),
    fullPage: false,
  });
}

async function waitFor(cond, {timeout = 15000, label = ''} = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (await cond()) return true;
    } catch (_) {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

// (Endpoint is seeded via ctx.addInitScript before any page load — see
// main below — so BigTraceLayout.oninit reads it on first render.)

(async () => {
  console.log(`Found ${dlTraces.length} trace(s) in ${dlDir}`);
  const browser = await chromium.launch({headless: true});
  const ctx = await browser.newContext({permissions: ['clipboard-read']});
  // Seed the endpoint BEFORE any page script runs.
  await ctx.addInitScript(
    ({key, endpoint}) => {
      localStorage.setItem(key, JSON.stringify({bigtraceEndpoint: endpoint}));
    },
    {key: STORAGE_KEY, endpoint: BACKEND},
  );
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  CONSOLE.ERR: ${msg.text()}`);
  });

  try {
    await page.goto(UI, {waitUntil: 'load', timeout: 30000});
    await page.waitForTimeout(800);
    // Navigate to the query page (default URL is the home page).
    await page.evaluate(() => (location.hash = '#!/query'));
    await page.waitForTimeout(1000);

    // ---------- TEST A: async status pill not stuck on UNKNOWN ----------
    header('Async query: status pill flips IN_PROGRESS -> SUCCESS (not UNKNOWN)');
    // Wait for the editor to be ready.
    await waitFor(() => page.locator('.cm-content').first().count(), {
      label: 'editor mount',
    });
    // Make sure Materialize is on. The toggle has a 'pf-toggle__switch' class
    // upstream; we click via label text to avoid the internal markup.
    const matToggle = page.locator(
      'label:has-text("Materialize") .pf-toggle__switch, label:has-text("Materialize")',
    );
    // The toggle is bound to an underlying checkbox; just check the state.
    const matChecked = await page.evaluate(() => {
      const cb = Array.from(document.querySelectorAll('input[type="checkbox"]'))
        .find((c) => {
          const lbl = c.closest('label');
          return lbl && lbl.textContent && lbl.textContent.includes('Materialize');
        });
      return cb ? cb.checked : null;
    });
    if (matChecked === false) {
      // Click the label to flip it on.
      await page.locator('label:has-text("Materialize")').first().click();
      await page.waitForTimeout(200);
    }

    // Type a real query that should succeed against /tmp/btraces.
    const editor = page.locator('.cm-content:visible').first();
    await editor.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await page.keyboard.type('SELECT name, dur FROM slice LIMIT 5');
    await page.waitForTimeout(150);
    await page.keyboard.press('Control+Enter');

    // Wait for the materialized status bar to appear.
    await waitFor(
      () =>
        page.locator('.pf-query-page__status-bar-pill').count().then((n) => n > 0),
      {label: 'status bar pill'},
    );

    // The pill text should reach SUCCESS within a few seconds (against a
    // 58 MB sample.pftrace this is sub-second). Read it.
    let finalStatus = 'UNKNOWN';
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const txt = (await page
        .locator('.pf-query-page__status-bar-pill')
        .first()
        .textContent()) ?? '';
      finalStatus = txt.trim();
      if (finalStatus === 'SUCCESS' || finalStatus === 'FAILED') break;
      await page.waitForTimeout(200);
    }
    console.log(`  status pill: ${finalStatus}`);
    if (finalStatus === 'SUCCESS') {
      ok('status pill reached SUCCESS');
    } else {
      fail(`status pill never reached SUCCESS (final: ${finalStatus})`);
    }

    // Traces counter should NOT be 0/0 after success. Labels use mixed-case
    // text in the DOM (CSS uppercases them); compare case-insensitively.
    const tracesText = await page.evaluate(() => {
      const stats = Array.from(
        document.querySelectorAll('.pf-query-page__status-bar-stat'),
      );
      const m = stats.find((s) => /traces/i.test(s.textContent || ''));
      const v = m
        ? m.querySelector('.pf-query-page__status-bar-stat-value')
        : null;
      return v ? (v.textContent || '').trim() : null;
    });
    console.log(`  traces counter: ${tracesText}`);
    if (tracesText && tracesText !== '0/0') {
      ok(`traces counter is ${tracesText} (not 0/0)`);
    } else {
      fail(`traces counter stuck at ${tracesText}`);
    }

    await snap(page, 'after_async_success');

    // ---------- TEST B: ~ expansion in trace_directory ----------
    header('Trace Directory: ~/Downloads expands and runs');
    if (dlTraces.length === 0) {
      console.log(
        '  SKIP: no trace files in ~/Downloads — drop a .pftrace there to enable',
      );
    } else {
      // Navigate to settings.
      await page.evaluate(() => (location.hash = '#!/settings'));
      await page.waitForTimeout(800);

      // Find the Trace Directory card by anchoring to its label.
      const tdLabel = page.locator('text=Trace Directory').first();
      const tdCard = tdLabel.locator(
        'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " pf-settings-card ")][1]',
      );
      const tdToggle = tdCard.locator('input[type="checkbox"]').first();
      const toggleChecked = await tdToggle.isChecked().catch(() => false);
      if (!toggleChecked) {
        // Click the label (which wraps the input) so the visual switch flips.
        await tdCard.locator('label.pf-checkbox').first().click();
        await page.waitForTimeout(200);
      }

      const tdInput = tdCard.locator('.pf-text-input__input').first();
      await tdInput.click();
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Delete');
      await page.keyboard.type('~/Downloads');
      // Blur via Tab so onChange fires.
      await page.keyboard.press('Tab');
      await page.waitForTimeout(400);

      // If a "Reload required" button shows up, click it (TRACE_ADDRESS
      // changes typically prompt for a reload to refresh metadata).
      const reloadBtn = page
        .locator('button', {hasText: /reload required/i})
        .first();
      if (await reloadBtn.count()) {
        await reloadBtn.click();
        await page.waitForTimeout(1500);
      }

      // Back to the query page (hash navigation).
      await page.evaluate(() => (location.hash = '#!/query'));
      await page.waitForTimeout(1500);
      await waitFor(
        () => page.locator('.cm-content:visible').first().count(),
        {label: 'editor remount after settings'},
      );

      // Issue a fresh query and intercept whichever execute endpoint fires
      // (sync or async, depending on the Materialize state set earlier).
      const editor2 = page.locator('.cm-content:visible').first();
      await editor2.click();
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Delete');
      await page.keyboard.type('SELECT 1 AS x');
      await page.waitForTimeout(150);

      const responsePromise = page.waitForResponse(
        (r) =>
          /\/execute_bigtrace_query(_async)?$/.test(r.url()) &&
          (r.status() === 200 || r.status() === 400 || r.status() === 500),
        {timeout: 20000},
      );
      // Re-focus the editor — settings navigation may have stolen focus.
      await editor2.click();
      await page.waitForTimeout(100);
      await page.keyboard.press('Control+Enter');
      const resp = await responsePromise;
      console.log(`  ${resp.request().method()} ${resp.url()} -> ${resp.status()}`);
      if (resp.status() === 200) {
        ok('~/Downloads expanded server-side, query succeeded');
      } else {
        const body = await resp.text().catch(() => '<no body>');
        fail(
          `~/Downloads request returned ${resp.status()}: ${body.slice(0, 200)}`,
        );
      }
      await snap(page, 'after_tilde_query');
    }

    // ---------- TEST C: bad path still returns 400 with a clear message
    header('Bad trace_directory still returns HTTP 400');
    const r = await page.evaluate(async (backend) => {
      const res = await fetch(`${backend}/execute_bigtrace_query`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          limit: 1,
          perfetto_sql: 'SELECT 1',
          settings: [
            {
              settingId: 'trace_directory',
              values: ['/no/such/dir/exists'],
              category: 'TRACE_ADDRESS',
            },
          ],
        }),
      });
      const text = await res.text();
      return {status: res.status, text};
    }, BACKEND);
    console.log(`  ${r.status}: ${r.text}`);
    if (r.status === 400 && r.text.includes('does not exist')) {
      ok('bad dir 400s with clear error');
    } else {
      fail(`unexpected response: ${r.status} ${r.text}`);
    }
  } finally {
    await browser.close();
  }

  console.log('\n--- ISSUES ---');
  if (issues.length === 0) {
    console.log('  (none)');
    console.log('\nDONE');
    process.exit(0);
  } else {
    issues.forEach((i, n) => console.log(`  ${n + 1}. ${i}`));
    console.log('\nDONE (with failures)');
    process.exit(1);
  }
})();
