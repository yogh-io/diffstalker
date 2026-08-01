/**
 * useUrlSync: the URL is the app's address bar in the literal sense — it
 * names ONE PLACE (a repo, a view, and the one anchor you are aimed at
 * inside it) and nothing else. Preferences, modes, expansion sets and
 * scroll offsets are not places and never appear.
 *
 *   /<view>/<repo-segments…>[?at=…][&base=…]
 *   /                                                  (no repo open)
 *   /changes/~/w/diffstalker?at=u:packages/web/src/App.vue
 *   /history/~/w/diffstalker?at=4d1c44a
 *   /compare/~/w/calculator/fix-bbox?base=upstream/main&at=src/a.ts
 *   /explorer/srv/git/thing?at=packages/web/src/App.vue
 *
 * VIEW FIRST. Segment 0 is a view keyword from a closed set, so parsing is
 * positional: nothing scans for where the repo path ends, a repo directory
 * called `history` is just a directory, and no repo path can ever collide
 * with the daemon's own API prefixes (/health, /repos, /events, /follow,
 * /worktrees) — which a repo-first path could, and did.
 *
 * REPO. Segment 1 === `~` (tested RAW, before decoding) means the rest is
 * relative to the daemon's $HOME; otherwise the segments ARE an absolute
 * path. Every segment is encodeURIComponent'd on write and decoded on
 * read, so a directory literally named `~` writes as `%7E` and does not
 * become the sentinel. With no $HOME (GET /health failed) paths stay
 * absolute.
 *
 * ANCHOR. `at` is the one thing the view is aimed at, per view: Changes'
 * stack key (`u:`/`s:` + path — a partially staged file is two rows, so
 * the side is part of the identity), History's selected commit (short
 * hash), Compare's selected file PATH (never its list index — the list
 * re-pulls constantly), Explorer's open file. Journal has none: its entry
 * seqs restart on a daemon restart or a prune, so a remembered one would
 * point at an unrelated entry. Compare also carries `base`, the EXPLICIT
 * pick only — absent means "let the daemon detect", and a detected base is
 * never written back, so a link records what you asked for.
 *
 * Query values are encoded with encodeURIComponent, then `%2F` and `%3A`
 * are put back as `/` and `:` (both legal raw in a query). Reading splits
 * on `&` and the FIRST `=` and decodes — never URLSearchParams, which
 * turns a `+` in a filename into a space. This is what makes a path
 * containing `:`, `#`, `%`, `&`, `+` or a space round-trip.
 *
 * ── History entries ──────────────────────────────────────────────────
 *
 * A new entry is minted for a USER GESTURE and (once) for an ambient
 * hijack. Everything else replaces, so Back always undoes something the
 * user actually did:
 *
 *  - GATE: nothing is written at all while the repo identity is unsettled
 *    (repo.repoId !== daemon.activeRepoId). A switch resets the stores one
 *    flush before the new repo id lands, so every intermediate state —
 *    base going null, the explorer resetting, history clearing — is simply
 *    not writable, and the switch produces exactly one entry when the gate
 *    reopens. This replaces a pile of symptom-matching special cases.
 *  - IDENTITY: a write equal to the current URL writes nothing (it is
 *    still recorded, so the next decision compares against the truth).
 *  - ATTRIBUTION: a gesture calls beginUserNav({repo, view}) declaring
 *    where it is going; the first write that MATCHES that target pushes,
 *    and later writes inside the same gesture replace — so "open this file
 *    in the explorer" (a view change plus a reveal) is one entry, not two.
 *    Matching on the target, rather than arming a one-shot flag, is what
 *    keeps an editor-driven follow event that lands mid-gesture from
 *    consuming the mark and pushing under the wrong name.
 *  - HIJACK: the first ambient write that moves away from the place the
 *    user last reached by gesture pushes ONCE, then clears the mark. Follow
 *    mode yanking you from Changes into another repo's Explorer is
 *    undoable exactly once, and cannot compound into one entry per file.
 *  - Everything else — follow mode, auto mode, scroll-spy, staging moving
 *    a row from unstaged to staged, startup resolution — replaces.
 *  - Ambient writes that only move the ANCHOR are additionally throttled
 *    (trailing edge, 400ms), so the scroll-spy cannot spend the main
 *    thread on replaceState; a real push flushes the pending write first.
 *
 * ── Back / forward ───────────────────────────────────────────────────
 *
 * popstate parses the path and hands it to `onRestore` (App owns applying
 * it — only App can open repos). A restore lands in pieces (the repo after
 * a POST, the anchor after a fetch), so pushes stay disabled for its whole
 * duration and one truthful replace closes it. Each restore carries a
 * generation token: a superseded one (Back-Back-Back) writes nothing and
 * stops applying, instead of racing the newer one to the finish. A cold
 * load's deep link runs through the SAME path, so there is one applier,
 * not two.
 */

import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useExplorerStore } from '../stores/explorer';
import { useRepoStore } from '../stores/repo';
import { useUiStore, VIEWS } from '../stores/ui';
import { DiffstalkerClient } from '../api/client';
import type { ViewName } from '../prefs';

/** Segment 1 when the repo path is relative to the daemon's $HOME. */
const HOME_SENTINEL = '~';

/** How long a declared gesture stays open, covering its async work. */
const NAV_INTENT_MS = 3000;

/** Trailing-edge budget for ambient anchor-only writes (scroll-spy). */
const ANCHOR_THROTTLE_MS = 400;

function isViewName(value: string | undefined): value is ViewName {
  return value !== undefined && VIEWS.some((v) => v.name === value);
}

/**
 * decodeURIComponent, but a malformed escape (`%zz` — hand-typed, or a
 * mangled paste) yields the raw text instead of throwing. The address bar
 * is untrusted input; a URIError here would take the whole app down at
 * startup.
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Query value encoding: `/` and `:` stay readable, everything else escapes. */
function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).split('%2F').join('/').split('%3A').join(':');
}

/** Read a query string without URLSearchParams (which eats `+`). */
function readQuery(search: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of search.replace(/^\?/, '').split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const key = eq === -1 ? part : part.slice(0, eq);
    const value = eq === -1 ? '' : part.slice(eq + 1);
    out.set(safeDecode(key), safeDecode(value));
  }
  return out;
}

/** A repo named by a URL: home-relative, or an absolute path. */
export interface UrlRepo {
  homeRelative: boolean;
  /** Path with no leading slash — under $HOME, or from the filesystem root. */
  path: string;
}

export interface UrlState {
  repo: UrlRepo | null;
  view: ViewName | null;
  /** The view's anchor (see the header): stack key, hash, or path. */
  at: string | null;
  /** Compare only: the explicitly picked base branch. */
  base: string | null;
}

const EMPTY_STATE: UrlState = { repo: null, view: null, at: null, base: null };

/**
 * Parse a location into the place it names. Anything that is not
 * view-first — `/`, a stale repo-first link from the old grammar, junk —
 * names no place at all: the app resolves normally and the first write
 * replaces it.
 */
export function parseUrl(pathname: string, search: string = ''): UrlState {
  const raw = pathname.split('/').filter(Boolean);
  if (raw.length === 0 || !isViewName(raw[0])) return EMPTY_STATE;
  const view = raw[0];
  const rest = raw.slice(1);
  const query = readQuery(search);
  const at = query.get('at') ?? null;
  const base = query.get('base') ?? null;
  if (rest.length === 0) return { repo: null, view, at, base };
  // The sentinel test runs on the RAW segment: a directory named `~` is
  // written `%7E` and must not be read as "under $HOME".
  const homeRelative = rest[0] === HOME_SENTINEL;
  const segs = (homeRelative ? rest.slice(1) : rest).map(safeDecode);
  return { repo: { homeRelative, path: segs.join('/') }, view, at, base };
}

/** Where a user gesture is going. Omit a field the gesture leaves alone. */
export interface NavTarget {
  /** Absolute path of the repo being navigated to. */
  repo?: string;
  view?: ViewName;
}

interface NavIntent extends NavTarget {
  expires: number;
  /** The first matching write already pushed; the rest of the gesture replaces. */
  used: boolean;
}

/**
 * Module-level on purpose: the gestures live in components (the rail, the
 * switchers, the finder, every list) that have no handle on App's
 * useUrlSync instance, and there is exactly one instance to inform.
 */
let intent: NavIntent | null = null;

/**
 * Declare that a USER GESTURE is navigating. Call it in the handler, before
 * the state changes: the write it causes — however many flushes later, and
 * whatever async work happens in between — becomes the one history entry
 * for this gesture. A gesture that forgets to call this still works; its
 * move just replaces instead of pushing.
 */
export function beginUserNav(target: NavTarget = {}): void {
  intent = { ...target, expires: Date.now() + NAV_INTENT_MS, used: false };
}

/** Test seam: drop any open gesture. */
export function resetUserNav(): void {
  intent = null;
}

/** What the last write recorded — every decision compares against it. */
interface Place {
  path: string;
  search: string;
  repoPath: string | null;
  view: ViewName;
  at: string | null;
  base: string | null;
}

export interface RestoreContext {
  /** True once a newer restore started — stop applying and write nothing. */
  isStale: () => boolean;
}

export interface UrlSyncOptions {
  /**
   * Apply a place the browser (or a deep link) asked for. App owns this:
   * reaching a URL can mean opening a repo, which only App's repo-open
   * flow does. Check ctx.isStale() between awaits.
   */
  onRestore?: (state: UrlState, ctx: RestoreContext) => Promise<void> | void;
}

export function useUrlSync(options: UrlSyncOptions = {}): {
  initial: UrlState;
  whenHomeReady: Promise<void>;
  toAbsolute: (repo: UrlRepo) => string;
  isActiveRepo: (repo: UrlRepo) => boolean;
  restore: (state: UrlState) => Promise<void>;
} {
  const daemon = useDaemonStore();
  const explorer = useExplorerStore();
  const repo = useRepoStore();
  const ui = useUiStore();
  const client = new DiffstalkerClient();

  const home = ref<string | null>(null);
  const whenHomeReady = client
    .health()
    .then((h) => {
      home.value = h.home ?? null;
    })
    .catch(() => {
      // No home from the daemon -> absolute paths.
    });

  const initial =
    typeof window === 'undefined'
      ? EMPTY_STATE
      : parseUrl(window.location.pathname, window.location.search);

  if (typeof window !== 'undefined' && 'scrollRestoration' in window.history) {
    // Every position in this app is re-derived from an anchor; a
    // browser-restored pixel offset would fight the stack's own scroll.
    window.history.scrollRestoration = 'manual';
  }

  function toAbsolute(target: UrlRepo): string {
    if (target.homeRelative) return home.value === null ? `/${target.path}` : `${home.value}/${target.path}`;
    return `/${target.path}`;
  }

  /** The repo the URL should name: only ever one that is actually open. */
  const urlRepoPath = computed(() => (repo.repoId === null ? null : repo.repoPath));

  function isActiveRepo(target: UrlRepo): boolean {
    return urlRepoPath.value !== null && toAbsolute(target) === urlRepoPath.value;
  }

  /** Absolute repo path -> URL segments, `~`-prefixed when under $HOME. */
  function repoSegments(abs: string): string[] {
    const h = home.value;
    const underHome = h !== null && (abs === h || abs.startsWith(h + '/'));
    const rel = underHome ? abs.slice(h.length) : abs;
    const segs = rel.split('/').filter(Boolean).map(encodeURIComponent);
    return underHome ? [HOME_SENTINEL, ...segs] : segs;
  }

  /** The one thing the active view is aimed at, or null. */
  function currentAnchor(): string | null {
    switch (ui.activeView) {
      case 'changes':
        return ui.activeStackKey;
      case 'history':
        return repo.history.selectedCommit?.shortHash ?? null;
      case 'compare': {
        const { selection, compareDiff } = repo.compare;
        if (selection.type !== 'file' || !compareDiff) return null;
        return compareDiff.files[selection.index]?.path ?? null;
      }
      case 'explorer':
        return explorer.selectedPath;
      default:
        return null; // journal: its seqs are not stable identities
    }
  }

  /** Derive the place the app is currently showing. */
  function derive(): Place {
    const abs = urlRepoPath.value;
    const view = ui.activeView;
    const at = abs === null ? null : currentAnchor();
    const base = abs !== null && view === 'compare' ? repo.selectedCompareBase : null;
    if (abs === null) return { path: '/', search: '', repoPath: null, view, at: null, base: null };
    const query: string[] = [];
    if (base !== null) query.push(`base=${encodeQueryValue(base)}`);
    if (at !== null) query.push(`at=${encodeQueryValue(at)}`);
    return {
      path: '/' + [view, ...repoSegments(abs)].join('/'),
      search: query.length === 0 ? '' : '?' + query.join('&'),
      repoPath: abs,
      view,
      at,
      base,
    };
  }

  /** `<anchor> — <view> — <repo>`, so a deep Back menu is readable. */
  function titleFor(place: Place): string {
    const parts: string[] = [];
    if (place.at !== null) parts.push(place.at);
    parts.push(place.view);
    if (place.repoPath !== null) parts.push(place.repoPath.split('/').filter(Boolean).pop() ?? '');
    return parts.filter(Boolean).join(' — ') || 'diffstalker';
  }

  let written: Place | null = null;
  /** True for the whole of a restore, including the writes it triggers. */
  let restoring = false;
  /** The place the user last reached by gesture; the hijack rule reads it. */
  let userPlace: { repoPath: string | null; view: ViewName } | null = null;
  /** Entry counter, stored in history.state so entries are distinguishable. */
  let serial = 0;
  let anchorTimer: ReturnType<typeof setTimeout> | null = null;

  function openIntent(): NavIntent | null {
    if (intent === null) return null;
    if (intent.expires <= Date.now()) {
      intent = null;
      return null;
    }
    return intent;
  }

  function matchesIntent(candidate: NavIntent, next: Place): boolean {
    if (candidate.view !== undefined && candidate.view !== next.view) return false;
    if (candidate.repo !== undefined && candidate.repo !== next.repoPath) return false;
    return true;
  }

  /** Only the anchor moved — the ambient case worth throttling. */
  function anchorOnly(next: Place): boolean {
    return (
      written !== null &&
      written.repoPath === next.repoPath &&
      written.view === next.view &&
      written.base === next.base
    );
  }

  type Verdict = 'push' | 'replace' | 'defer';

  function decide(next: Place): Verdict {
    // The entry the user ARRIVED on becoming complete, and every write a
    // restore makes on its way to the place it was asked for.
    if (written === null || restoring) return 'replace';

    const candidate = openIntent();
    if (candidate !== null && matchesIntent(candidate, next)) {
      if (candidate.used) return 'replace'; // same gesture, later write
      candidate.used = true;
      userPlace = { repoPath: next.repoPath, view: next.view };
      return 'push';
    }

    // Ambient from here: follow mode, auto mode, the scroll-spy, a
    // staging move, an SSE-driven reload.
    if (
      userPlace !== null &&
      (userPlace.repoPath !== next.repoPath || userPlace.view !== next.view)
    ) {
      userPlace = null; // one entry per gesture, never a chain of them
      return 'push';
    }
    return anchorOnly(next) ? 'defer' : 'replace';
  }

  function cancelDeferred(): void {
    if (anchorTimer !== null) {
      clearTimeout(anchorTimer);
      anchorTimer = null;
    }
  }

  function writeUrl(): void {
    if (typeof window === 'undefined') return;
    // GATE: the repo identity is unsettled (a switch is in flight, or a
    // failed open left the two disagreeing). Nothing about the current
    // state is worth recording, and every flicker lives in this window.
    if (repo.repoId !== daemon.activeRepoId) return;

    const next = derive();
    const url = next.path + next.search;
    if (url === window.location.pathname + window.location.search) {
      written = next; // nothing to write, but this IS where we are
      return;
    }

    const verdict = decide(next);
    if (verdict === 'defer') {
      if (anchorTimer === null) {
        anchorTimer = setTimeout(() => {
          anchorTimer = null;
          flushWrite(derive(), 'replace');
        }, ANCHOR_THROTTLE_MS);
      }
      return;
    }
    // A real move supersedes any queued anchor write: letting it land
    // afterwards would replace the fresh entry with a stale anchor.
    cancelDeferred();
    flushWrite(next, verdict);
  }

  function flushWrite(next: Place, verdict: 'push' | 'replace'): void {
    const url = next.path + next.search;
    if (url !== window.location.pathname + window.location.search) {
      if (verdict === 'push') {
        serial += 1;
        window.history.pushState({ serial, place: next }, '', url);
      } else {
        window.history.replaceState({ serial, place: next }, '', url);
      }
      document.title = titleFor(next);
    }
    written = next;
  }

  // First write once $HOME is known, so the path is home-relative from the
  // start (not a transient /home/<user>), then on every state change.
  async function writeAfterHome(): Promise<void> {
    await whenHomeReady;
    writeUrl();
  }
  void writeAfterHome();

  watch(
    [
      // The gate's two halves: a write is only allowed when they agree,
      // and the moment they do is when a repo switch gets its one entry.
      () => repo.repoId,
      () => daemon.activeRepoId,
      () => repo.repoPath,
      () => ui.activeView,
      () => ui.activeStackKey,
      () => repo.selectedCompareBase,
      () => repo.compare.selection,
      () => repo.history.selectedCommit,
      () => explorer.selectedPath,
    ],
    writeUrl,
    { flush: 'post' }
  );

  // --- Back / forward, and the cold-load deep link (one applier) ---

  let restoreGen = 0;

  async function restore(state: UrlState): Promise<void> {
    const token = ++restoreGen;
    restoring = true;
    cancelDeferred();
    try {
      await options.onRestore?.(state, { isStale: () => token !== restoreGen });
    } finally {
      // A superseded restore leaves everything to the newer one — it must
      // not clear the suppression out from under it, and must not write.
      if (token === restoreGen) {
        await nextTick();
        writeUrl();
        restoring = false;
      }
    }
  }

  function onPopState(): void {
    void restore(parseUrl(window.location.pathname, window.location.search));
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', onPopState);
    onScopeDispose(() => {
      window.removeEventListener('popstate', onPopState);
      cancelDeferred();
    });
  }

  return { initial, whenHomeReady, toAbsolute, isActiveRepo, restore };
}
