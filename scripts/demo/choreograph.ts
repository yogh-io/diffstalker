/**
 * scripts/demo/choreograph.ts — drives the recorded take.
 *
 * The camera is dumb (ffmpeg grabs a rectangle); this file is the direction.
 * It talks CDP to the Chrome that record.sh started, so every take is the
 * same take: same pauses, same scroll distances, same easing. Hand-piloting a
 * demo means re-shooting it every time a beat lands wrong.
 *
 * Everything is driven through Runtime.evaluate rather than synthetic mouse
 * coordinates: the app's own keyboard layer listens on `window`, its rows
 * expose data attributes, and `.click()` on a real checkbox fires a real
 * change event. So the beats survive a re-layout, which pixel coordinates
 * would not.
 *
 * Scrolling is a hand-written rAF tween, not scrollTo({behavior:'smooth'}) —
 * the browser picks its own duration for that, and a beat that runs long
 * desynchronises everything after it.
 *
 * Usage: bun scripts/demo/choreograph.ts <cdp-port>
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const CDP_PORT = process.argv[2];
const TARGET_URL = process.argv[3];
if (CDP_PORT === undefined || TARGET_URL === undefined) {
  console.error('usage: bun scripts/demo/choreograph.ts <cdp-port> <url>');
  process.exit(2);
}
const ORIGIN = new URL(TARGET_URL).origin;

const demoRepo = process.env.DEMO_REPO;
if (demoRepo === undefined) {
  console.error('choreograph: DEMO_REPO is not set');
  process.exit(2);
}
// Rebound as a plain string: the narrowing above does not reach the closures
// further down that actually use it.
const DEMO_REPO: string = demoRepo;

const DIFFS = '[data-testid="compare-diffs"]';
const FILES = '[data-testid="compare-files"]';
const TOGGLES = '[data-testid="uncommitted-toggles"]';

// ---------------------------------------------------------------- CDP

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let nextId = 1;
const pending = new Map<number, Pending>();

/**
 * Chrome's app window. record.sh opens it on about:blank and this script
 * navigates it, so any page target will do — there is only one window, and
 * whatever it is showing now is about to be replaced.
 */
async function findPageTarget(): Promise<string> {
  // Chrome needs a moment to open the debugging port after exec.
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = (await res.json()) as { type: string; webSocketDebuggerUrl?: string }[];
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl !== undefined) return page.webSocketDebuggerUrl;
    } catch {
      // Port not up yet.
    }
    await sleep(250);
  }
  throw new Error(`no CDP page target on :${CDP_PORT}`);
}

const socket = new WebSocket(await findPageTarget());
await new Promise<void>((resolve, reject) => {
  socket.onopen = () => resolve();
  socket.onerror = () => reject(new Error('CDP socket failed'));
});

socket.onmessage = (event) => {
  const msg = JSON.parse(String(event.data)) as {
    id?: number;
    result?: {
      result?: { value?: unknown };
      // `text` is always the useless "Uncaught"; the real message and stack
      // live on the thrown object's description.
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    error?: { message: string };
  };
  if (msg.id === undefined) return;
  const waiter = pending.get(msg.id);
  if (waiter === undefined) return;
  pending.delete(msg.id);

  if (msg.error) waiter.reject(new Error(msg.error.message));
  else if (msg.result?.exceptionDetails) {
    const details = msg.result.exceptionDetails;
    waiter.reject(new Error(details.exception?.description ?? details.text));
  }
  else waiter.resolve(msg.result?.result?.value);
};

function send(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

/** Run an expression in the page. `await` inside it is honoured. */
function evaluate(expression: string): Promise<unknown> {
  return send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
}

/**
 * What the page looked like when something timed out. A bare "timed out
 * waiting for compare view" says nothing about whether the app failed to
 * load, landed on the wrong view, or rendered an error banner — and the
 * stage is torn down before you can look, so the message has to carry it.
 */
async function snapshot(): Promise<string> {
  try {
    const seen = await evaluate(`JSON.stringify({
      url: location.href,
      ready: document.readyState,
      testids: [...document.querySelectorAll('[data-testid]')]
        .map((el) => el.dataset.testid)
        .filter((id, i, all) => all.indexOf(id) === i),
      text: document.body?.innerText?.slice(0, 400) ?? '',
    })`);
    return `\n  page: ${String(seen)}`;
  } catch (error) {
    return `\n  page: unreachable (${String(error)})`;
  }
}

/** Poll an expression until it is true, or give up and say what was there. */
async function waitFor(expression: string, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await evaluate(`Boolean(${expression})`)) === true) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}${await snapshot()}`);
}

// ------------------------------------------------------------- motion

/**
 * Tween a scroller to a fraction of its range over `ms`, eased at both ends.
 * Resolves when the tween is done, so a beat's duration is its real duration.
 */
function scrollTo(selector: string, fraction: number, ms: number): Promise<unknown> {
  return evaluate(`(async () => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('no scroller: ' + ${JSON.stringify(selector)});
    const from = el.scrollTop;
    const to = (el.scrollHeight - el.clientHeight) * ${fraction};
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const start = performance.now();
    await new Promise((done) => {
      const step = (now) => {
        const t = Math.min(1, (now - start) / ${ms});
        el.scrollTop = from + (to - from) * ease(t);
        if (t < 1) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
  })()`);
}

/** Press a bare key the way the app's global layer hears it. */
function press(key: string): Promise<unknown> {
  return evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`
  );
}

/**
 * Write a file into the demo repo, mid-take.
 *
 * This is the live-refresh beat, and it is deliberately a real write to a
 * real working tree: the daemon's watcher sees it, emits a state-change, and
 * the open Compare re-pulls itself (stores/repo.ts refreshes compare on every
 * state-change, with the uncommitted flags the view already had). Nothing
 * here pokes the UI — the view updates because the file changed.
 */
async function writeIntoRepo(relPath: string, content: string): Promise<void> {
  const full = join(DEMO_REPO, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
}

/**
 * Click a file row by its path, not its index. The band re-sorts and re-indexes
 * every time a category is folded in or a file appears, so an index that was
 * right when the beat was written points somewhere else by the time it runs.
 */
function clickFileByPath(name: string): Promise<unknown> {
  return evaluate(`(() => {
    const rows = [...document.querySelectorAll('${FILES} .file-row')];
    const row = rows.find((r) => (r.textContent ?? '').includes(${JSON.stringify(name)}));
    if (!row) throw new Error('no file row for ' + ${JSON.stringify(name)});
    row.click();
  })()`);
}

/** Click the Nth file row in the compare file band. */
function clickFileRow(index: number): Promise<unknown> {
  return evaluate(`(() => {
    const row = document.querySelector('${FILES} .file-row[data-file-index="${index}"]');
    if (!row) throw new Error('no file row ' + ${index});
    row.click();
  })()`);
}

/** Tick one of the three uncommitted checkboxes by its label text. */
function toggleUncommitted(label: string): Promise<unknown> {
  return evaluate(`(() => {
    const scope = document.querySelector('${TOGGLES}');
    if (!scope) throw new Error('no uncommitted toggles');
    const box = [...scope.querySelectorAll('input[type=checkbox]')].find((input) => {
      const text = (input.closest('label') ?? input.parentElement)?.textContent ?? '';
      return text.trim().toLowerCase().includes(${JSON.stringify(label)});
    });
    if (!box) throw new Error('no toggle: ' + ${JSON.stringify(label)});
    box.click();
  })()`);
}

/** The compare reloads on every toggle; let it settle before the next beat. */
async function settle(): Promise<void> {
  await sleep(200);
  await waitFor(`!document.querySelector('[data-testid="compare-busy"]')`, 'compare to settle');
}

// ------------------------------------------------------------ prepare

/**
 * Pin the look of the take, then go.
 *
 * Theme, syntax highlighting and diff layout are user prefs in localStorage,
 * so the same script on a profile that had been used before would record a
 * different-looking video. They have to be in place BEFORE the app's first
 * render — seeding them afterwards and reloading does not work, because by
 * the time the shell has booted, useUrlSync has already rewritten the address
 * to `/` (no repo open yet) and the reload lands on the empty state with the
 * deep link gone.
 *
 * So: seed on every new document, and navigate ourselves. Chrome was started
 * on about:blank precisely so there is no first load to race.
 */
await send('Page.enable', {});
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem('diffstalker:prefs', JSON.stringify({
    theme: ${JSON.stringify(process.env.DEMO_THEME ?? 'dark')},
    diffSyntax: true,
    diffMode: 'unified',
  })); } catch {}`,
});
await send('Page.navigate', { url: TARGET_URL });
await waitFor(
  `location.origin === ${JSON.stringify(ORIGIN)} && document.readyState === 'complete'`,
  'the app document'
);

// ------------------------------------------------------------- script

interface Beat {
  label: string;
  run: () => Promise<unknown>;
}

/** The file the live-refresh beat writes: short enough to read at a glance. */
const NEW_FILE = 'src/burst.ts';
const NEW_FILE_BODY = `/** Extra allowance for a client that has been quiet. */
export function burstFor(idleSeconds: number, max: number): number {
  return Math.min(max, Math.floor(idleSeconds / 2));
}
`;

const beats: Beat[] = [
  // Ten seconds, because this loops in a README. Everything that is merely
  // nice to show has been cut; what is left is the three things only this
  // tool does: review an unpushed branch, fold in uncommitted work, and keep
  // up with the working tree by itself.

  // 1. Establish: a branch, its commits, its files — a review, not a diff.
  { label: 'hold on the opening frame', run: () => sleep(1500) },

  // 2. Fold in work that is not committed. The header goes 4 files -> 6.
  //    No forge can show this: none of it has left the machine.
  { label: 'tick unstaged', run: () => toggleUncommitted('unstaged') },
  { label: 'settle', run: settle },
  { label: 'hold', run: () => sleep(700) },
  { label: 'tick untracked', run: () => toggleUncommitted('untracked') },
  { label: 'settle', run: settle },
  { label: 'hold', run: () => sleep(1000) },

  // 3. The live beat: a file appears on disk and the review updates itself.
  //    Nothing clicks anything here — that is the entire point.
  { label: 'write a new file on disk', run: () => writeIntoRepo(NEW_FILE, NEW_FILE_BODY) },
  { label: 'hold while the view catches up', run: () => sleep(2000) },

  // 4. Land on the file that did not exist when the take started.
  { label: 'open the new file', run: () => clickFileByPath('burst.ts') },
  { label: 'hold on the new diff', run: () => sleep(1600) },
  { label: 'scroll onto the rest', run: () => scrollTo(DIFFS, 0.18, 1200) },
  { label: 'hold on the last frame', run: () => sleep(1500) },
];

/**
 * Open the commits list before the camera rolls. Collapsed, Compare reads as
 * a pile of diffs; expanded, the first frame says "this is a branch, these
 * are its commits, here is every file it touched" — which is the whole claim
 * the video is making.
 */
async function openCommits(): Promise<void> {
  await evaluate(`(() => {
    const toggle = document.querySelector('[data-testid="commits-toggle"]');
    if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  })()`);
}

// Do not start the clock until the compare has actually rendered, or the
// opening beat records a spinner.
await waitFor(`document.querySelector('${DIFFS}')`, 'compare view');
await waitFor(`!document.querySelector('[data-testid="compare-loading"]')`, 'compare to load');
await settle();
await openCommits();
await sleep(400);
console.log('ready');

// record.sh starts ffmpeg on that line, then releases us.
await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));

const started = Date.now();
for (const beat of beats) {
  const at = ((Date.now() - started) / 1000).toFixed(1);
  console.error(`  ${at}s  ${beat.label}`);
  await beat.run();
}
console.error(`  ${((Date.now() - started) / 1000).toFixed(1)}s  done`);
socket.close();

// Exit explicitly. The stdin listener that waited for the cue keeps the event
// loop alive on its own, so without this the process lingers after the last
// beat and record.sh's `wait` never returns — the take looks like it hangs
// right after finishing.
process.exit(0);

export {};
