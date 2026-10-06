// Static simulation of an XState machine file in local Stately Sketch.
//
// No real actor runs: Sketch parses the machine code in-browser and its own
// sim engine replays transitions (click a transition label = send its event,
// guards auto-true for the clicked guard, `after` delays scheduled for real).
// Machine must be self-contained — only `xstate` imports resolve (Sketch
// strips them and injects bindings); any other import fails to parse.
//
// Usage (copied into the sandbox by sketch-sim.sh; puppeteer-core resolves
// from sandbox node_modules):
//   node sim.mjs <machine-file> [--url http://127.0.0.1:3000] \
//     [--events NEXT,NEXT,RESET] [--shot out.png] [--keep] [--headless 0|1]
//
// Exit 0: sim ran (or --keep: window left open for interactive clicking).
// Exit 1: machine failed to parse (Sketch error banner text is printed).
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

function parseArgs(argv) {
  const a = { events: [], headless: true, keep: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--events') a.events = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (t === '--shot') a.shot = argv[++i];
    else if (t === '--url') a.url = argv[++i];
    else if (t === '--keep') a.keep = true;
    else if (t === '--headless') a.headless = argv[++i] !== '0';
    else rest.push(t);
  }
  a.machine = rest[0];
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (!args.machine) {
  console.error('usage: node sim.mjs <machine-file> [--events A,B] [--shot out.png] [--url base] [--keep] [--headless 0|1]');
  process.exit(2);
}
if (!args.url) args.url = 'http://127.0.0.1:3000';
const base = args.url.replace(/\/inspect\/?$/, '');
const shotPath = args.shot
  ? resolve(args.shot)
  : resolve(process.env.XSTATE_VIZ_SANDBOX || `${process.env.HOME}/.cache/xstate-viz`, 'sim-shot.png');

// ---------------------------------------------------------------- chrome
const executablePath = CHROME_CANDIDATES.find((p) => p && existsSync(p));
if (!executablePath) {
  console.error('error: no Chrome/Chromium/Edge/Brave found — set CHROME_PATH');
  process.exit(1);
}

const { default: puppeteer } = await import('puppeteer-core');
const code = await readFile(resolve(args.machine), 'utf8');

const browser = await puppeteer.launch({
  executablePath,
  headless: args.keep ? false : args.headless,
  defaultViewport: { width: 1680, height: 1050 },
  args: ['--no-first-run', '--no-default-browser-check'],
});
const page = (await browser.pages())[0] ?? (await browser.newPage());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitSelector(sel, ms = 20000) {
  return page.waitForSelector(sel, { visible: true, timeout: ms });
}

try {
  await page.goto(`${base}/`, { waitUntil: 'networkidle2', timeout: 30000 });

  // ---- inject machine code into the CodeMirror editor ----
  await waitSelector('[data-testid="code-editor"] .cm-content');
  await page.click('[data-testid="code-editor"] .cm-content');
  // puppeteer has no combined-key strings: hold Meta, tap a (select all);
  // no keyboard.insertText in this version — CDP Input.insertText instead
  await page.keyboard.down('Meta');
  await page.keyboard.press('a');
  await page.keyboard.up('Meta');
  const cdp = await page.createCDPSession();
  await cdp.send('Input.insertText', { text: code });
  await page.click('[data-testid="update-button"]');

  // ---- parse result: settle, then read error banner / graph nodes ----
  // (no selector race: the DEFAULT machine's nodes are already on the page,
  // and parseCode runs synchronously inside the store transition — by the
  // first re-render after Update the banner or our graph is settled)
  await sleep(800);
  const errorText = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="error-banner"]');
    return b && b.textContent ? b.textContent.trim() : null;
  });
  if (errorText) {
    console.error(`error: Sketch could not parse ${args.machine}:\n${errorText}`);
    process.exit(1);
  }
  const stateCount = await page.evaluate(
    () => document.querySelectorAll('[data-state-id]').length,
  );
  console.log(`==> machine loaded: ${stateCount} state node(s)`);

  // ---- start simulation ----
  const started = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) =>
        (b.getAttribute('aria-label') || '').startsWith('Start simulation') ||
        b.textContent?.trim() === 'Start simulation',
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!started) {
    console.error('error: "Start simulation" button not found');
    process.exit(1);
  }
  await waitSelector('[data-sim-active]', 10000);
  const readActive = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-sim-active]')]
        .map((el) => {
          const node = el.closest('[data-state-id]') ?? el;
          return node.getAttribute('data-state-id');
        })
        .filter(Boolean),
    );

  // ---- fire events by clicking the active state's matching transition ----
  for (const ev of args.events) {
    const clicked = await page.evaluate((name) => {
      // active (non-dimmed) transitions whose label mentions the event name
      const transitions = [...document.querySelectorAll('[data-testid="transition"]')]
        .filter((el) => !el.classList.contains('opacity-40'))
        .filter((el) => {
          const text = el.textContent ?? '';
          return new RegExp(`(^|[^\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`).test(text);
        });
      const el = transitions[0];
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    }, ev);
    if (!clicked) {
      console.error(`error: no active transition labelled "${ev}" — event not sent`);
      process.exit(1);
    }
    await sleep(80); // let the store settle before the next click
  }

  // ---- report final sim state ----
  const active = await readActive();
  console.log(`==> sim active: ${active.length ? active.join(', ') : '(none)'}`);

  // ---- simulation side panel (event history) + screenshot ----
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('[role="tab"], button')].find(
      (el) => el.textContent?.trim() === 'Simulation',
    );
    tab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await sleep(150);
  await page.screenshot({ path: shotPath });
  console.log(`==> screenshot: ${shotPath}`);

  if (args.keep) {
    console.log('==> browser left open — click transitions interactively; Ctrl-C this process when done');
    await new Promise(() => {}); // hold until killed (browser dies with us)
  }
} finally {
  if (!args.keep) await browser.close();
}
