/**
 * scripts/demo/choreograph.ts — drives the recorded take.
 *
 * The camera is dumb (ffmpeg grabs a rectangle); this file is the direction.
 * It talks CDP to the Chrome that record.sh started, so every take is the
 * same take: same pauses, same keystrokes, same order. Hand-piloting a demo
 * means re-shooting it every time a beat lands wrong.
 *
 * The story, in one line: you write some code, and the review keeps up.
 *
 * What makes it worth filming is that the beats which change anything change
 * it on DISK — a file written into the working tree, a real `git commit` — and
 * never through the UI. The daemon's watcher notices, emits a state-change,
 * and the open view re-pulls itself. So the video is not a tour of buttons; it
 * is the app reacting to work happening somewhere else, which is exactly what
 * it does when the work is being done by you in an editor, or by an agent.
 *
 * Usage: bun scripts/demo/choreograph.ts <cdp-port> <url>
 * Env:   DEMO_REPO (required), DEMO_THEME (default 'dark')
 */

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

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

const DEMO_DISPLAY = process.env.DEMO_DISPLAY ?? ':99';

// ---------------------------------------------------------------- CDP

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

let nextId = 1;
const pending = new Map<number, Pending>();

/**
 * Chrome's app window. record.sh opens it on the target URL and this script
 * navigates it again after seeding prefs, so any page target will do — there
 * is only one window.
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
  } else waiter.resolve(msg.result?.result?.value);
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
 * waiting for the app" says nothing about whether it failed to load, landed
 * on the wrong view, or rendered an error banner — and the stage is torn down
 * before you can look, so the message has to carry it.
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

// --------------------------------------------------------- the pointer
//
// The cursor is REAL: xdotool moves the X pointer on the virtual display and
// ffmpeg composites it in (-draw_mouse 1). CDP's Input.dispatchMouseEvent
// would not do — it delivers events to the page without moving the pointer X
// draws, so the recording would show clicks happening with no cursor anywhere
// near them. Which is what the first cut of this video looked like.

/** Where the pointer is now, in screen coordinates. */
let pointer = { x: 1180, y: 700 };

function xdotool(args: string[]): Promise<unknown> {
  return run('xdotool', args, { env: { ...process.env, DISPLAY: DEMO_DISPLAY } });
}

/**
 * Glide the pointer to a screen position, eased at both ends.
 *
 * One xdotool invocation for the whole path, using its own `sleep` between
 * steps: spawning a process per step costs more than the step itself and the
 * motion comes out lumpy.
 */
async function moveTo(x: number, y: number, ms = 520): Promise<void> {
  const steps = 26;
  const ease = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
  const from = pointer;
  const args: string[] = [];

  for (let i = 1; i <= steps; i++) {
    const k = ease(i / steps);
    args.push(
      'mousemove',
      String(Math.round(from.x + (x - from.x) * k)),
      String(Math.round(from.y + (y - from.y) * k))
    );
    if (i < steps) args.push('sleep', (ms / steps / 1000).toFixed(3));
  }

  await xdotool(args);
  pointer = { x, y };
}

/**
 * The centre of an element, in SCREEN coordinates.
 *
 * screenX/screenY place the window; the outer/inner height difference skips
 * whatever chrome sits above the viewport. In an --app window that difference
 * is zero, but computing it means the take does not silently drift if the
 * window ever grows a toolbar.
 */
async function centreOf(selector: string): Promise<{ x: number; y: number }> {
  const raw = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('no element: ' + ${JSON.stringify(selector)});
    const r = el.getBoundingClientRect();
    return JSON.stringify({
      x: Math.round(window.screenX + r.left + r.width / 2),
      y: Math.round(window.screenY + (window.outerHeight - window.innerHeight) + r.top + r.height / 2),
    });
  })()`);
  return JSON.parse(String(raw)) as { x: number; y: number };
}

/** Move to an element and actually click it — a real button press, in X. */
async function clickOn(selector: string, moveMs?: number): Promise<void> {
  const { x, y } = await centreOf(selector);
  await moveTo(x, y, moveMs);
  await sleep(180); // land, then press — clicking mid-glide reads as a twitch
  await xdotool(['click', '1']);
}

/**
 * Open the commits list. It is a per-view `ref(false)`, so switching into
 * Compare always lands with it closed — which reads as a pile of diffs rather
 * than a branch. Opening it is what makes the view say "this is a branch, and
 * these are its commits", which the last beat then adds to.
 */
async function openCommits(): Promise<void> {
  await evaluate(`(() => {
    const toggle = document.querySelector('[data-testid="commits-toggle"]');
    if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  })()`);
}

/** The compare reloads on every toggle; let it settle before the next beat. */
async function settle(): Promise<void> {
  await sleep(200);
  await waitFor(`!document.querySelector('[data-testid="compare-busy"]')`, 'compare to settle');
}

// ------------------------------------------------- work, done for real

/** Write a file into the demo repo's working tree, mid-take. */
async function writeIntoRepo(relPath: string, content: string): Promise<void> {
  const full = join(DEMO_REPO, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
}

const CONFIG_TS = `export interface Config {
  /** Port the relay listens on. */
  port: number;
  /** Where requests are forwarded. */
  upstream: string;
  /** Give up on the upstream after this long. */
  timeoutMs: number;
  /** Requests a single client may burst before it is limited. */
  burst: number;
  /** Sustained requests per second, once the burst is spent. */
  ratePerSecond: number;
}

export const config: Config = {
  port: 8080,
  upstream: 'http://127.0.0.1:9000',
  timeoutMs: 5_000,
  burst: 20,
  ratePerSecond: 5,
};
`;

const RATE_LIMIT_TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateLimiter } from './rateLimit.js';

test('spends the bucket, then refuses', () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1 });

  assert.equal(limiter.take('a', 0), true);
  assert.equal(limiter.take('a', 0), true);
  assert.equal(limiter.take('a', 0), false);
});

test('refills over time, and never past capacity', () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1 });

  limiter.take('a', 0);
  limiter.take('a', 0);
  assert.equal(limiter.take('a', 1_000), true);
  assert.equal(limiter.take('a', 60_000), true);
});

test('retryAfter rounds up to the next whole token', () => {
  const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 2 });

  limiter.take('a', 0);
  assert.equal(limiter.retryAfter('a', 0), 1);
});
`;

const RATE_LIMIT_DOC = `# Rate limiting

Every client gets a token bucket: \`burst\` tokens, refilled at
\`ratePerSecond\`. One request spends one token.

An empty bucket answers \`429\` with a \`Retry-After\` header, in whole
seconds, rounded up — a caller told to retry too early just earns a
second \`429\`.

Clients are keyed by socket address today. Behind a proxy that is the
proxy, not the caller — \`X-Forwarded-For\` is the next step.
`;

/**
 * Commit them, with git — not with the UI, which cannot commit anyway (the
 * web client is a viewer with one write, file-level staging). That is the
 * point of the beat: the commit happens in a terminal, or in an agent's tool
 * call, and the open review absorbs it. The rows that were tagged [unstaged]
 * and [untracked] a second ago are simply part of the branch now.
 */
async function commitEverything(): Promise<void> {
  await run('git', ['-C', DEMO_REPO, 'add', '-A']);
  await run('git', ['-C', DEMO_REPO, 'commit', '-q', '-m', 'Configure the limits, and test them'], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
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

// Park the real pointer where `pointer` claims it is. X starts it in the
// middle of the screen; without this the first glide would begin from the
// wrong place and read as a jump.
await xdotool(['mousemove', String(pointer.x), String(pointer.y)]);

// ------------------------------------------------------------- script

interface Beat {
  label: string;
  run: () => Promise<unknown>;
}

/** The Compare tab in the rail — the whole button, not just its count badge. */
const COMPARE_TAB = 'button:has([data-testid="compare-count"])';

const beats: Beat[] = [
  // Roughly fifteen seconds. The holds are the tunable part: they exist so a
  // reader can take in what just changed, and nothing more.

  // 1. Changes, with nothing in it. A clean working tree — so everything that
  //    appears from here on appeared while the camera was running.
  { label: 'hold on the empty Changes tab', run: () => sleep(1200) },

  // 2. Three files land on disk, ONE AT A TIME. Writing them together is
  //    faster but unreadable: the list jumps from empty to full in a single
  //    frame and there is nothing to notice. A beat apart, you watch each one
  //    arrive — and nothing is clicked to make any of it happen.
  { label: 'write src/config.ts', run: () => writeIntoRepo('src/config.ts', CONFIG_TS) },
  { label: 'hold', run: () => sleep(1400) },
  {
    label: 'write src/rateLimit.test.ts',
    run: () => writeIntoRepo('src/rateLimit.test.ts', RATE_LIMIT_TEST),
  },
  { label: 'hold', run: () => sleep(1400) },
  { label: 'write docs/rate-limit.md', run: () => writeIntoRepo('docs/rate-limit.md', RATE_LIMIT_DOC) },
  { label: 'hold', run: () => sleep(1600) },

  // 3. Over to Compare: the branch so far, one commit against origin/main.
  {
    label: 'click the Compare tab',
    run: async () => {
      await clickOn(COMPARE_TAB, 620);
      await sleep(350);
      await openCommits();
    },
  },
  { label: 'hold on the branch review', run: () => sleep(1600) },

  // 4. Fold in the work that is not committed yet. No forge can show this.
  {
    label: 'click unstaged',
    run: () => clickOn('[data-testid="uncommitted-toggle-unstaged"]', 560),
  },
  { label: 'settle', run: settle },
  { label: 'hold', run: () => sleep(900) },
  {
    label: 'click untracked',
    run: () => clickOn('[data-testid="uncommitted-toggle-untracked"]', 320),
  },
  { label: 'settle', run: settle },
  { label: 'hold', run: () => sleep(1700) },

  // 5. Commit, in git. The commits list gains an entry, and the rows that were
  //    tagged a moment ago are just part of the branch now.
  { label: 'commit', run: commitEverything },
  { label: 'hold on the new commit', run: () => sleep(2600) },
];

// Do not start the clock until the repo is open and Changes has rendered, or
// the opening beat records an empty shell instead of an empty working tree.
await waitFor(`document.querySelector('[data-testid="branch-info"]')`, 'the repo to open');
await sleep(600);
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
