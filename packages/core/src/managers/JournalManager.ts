/**
 * JournalManager: the append-only, hunk-granular edit journal.
 *
 * Listens to WorkingTreeManager's 'journal-observation' (wired by
 * GitStateManager) and appends immutable entries to a JournalStore. The
 * store is injected: phase 2 lifts it into a daemon-level map keyed by
 * repoId so it outlives the manager lifecycle.
 *
 * Classification is strict boundary-before-kind:
 *   (a) operationInProgress transitions -> op-start/op-end boundaries;
 *       file journaling is SUSPENDED while an operation is in progress
 *       (conflicted rebases produce garbage diffs);
 *   (b) a HEAD move -> one boundary (commit/checkout) + silent rebaseline
 *       of every surviving file — footprints are NEVER compared across a
 *       boundary (a base move changes coordinates without a user edit);
 *   (c) otherwise per-file hunk classification (the pure functions below).
 *
 * Lineage is interval overlap in HEAD pre-image coordinates, computed on
 * each hunk's edit-run footprints (deletion old-line ranges plus
 * half-line-expanded insertion anchors). Content is used only for the
 * silence test: a djb2 bodyHash over +/- lines (the hunkTimes convention)
 * decides "unchanged, no entry" — never for matching.
 *
 * Every guard is defer-don't-decide: a skipped tick is always safe because
 * the next observation re-derives everything; a wrong append is forever.
 *
 * The store is bounded (design decision 8): after every append the
 * oldest OUTDATED bodies are nulled past a byte budget, then the oldest
 * entries are evicted entirely past a count cap — see pruneStore.
 */

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import * as logger from '../utils/logger.js';
import { hashHunkBody } from '../git/hunkTimes.js';
import { splitDiffByFile } from '../view/splitDiffByFile.js';
import { diffByteSize, rawFromLines } from '../git/diffParse.js';
import type { DiffLine, DiffResult } from '../git/diffParse.js';
import type { FileStatus } from '../git/status.js';
import { OVERSIZE_UNTRACKED_MARKER } from '../types/journal.js';
import type {
  JournalBoundaryEntry,
  JournalBoundaryKind,
  JournalEntry,
  JournalHunkEntry,
  JournalHunkKind,
  JournalObservation,
  JournalStore,
  LiveHunk,
  ObservedHunk,
  Run,
} from '../types/journal.js';

/** Entry diff snapshots above this raw size are stored as null. */
export const MAX_SNAPSHOT_BYTES = 256 * 1024;

/**
 * Pruning (design decision 8): the store is a bounded ring, enforced
 * after every append. Total-entry cap per store; past it the oldest
 * evictable entries are evicted entirely (a contiguous prefix, so the
 * daemon's derived prunedBefore — entries[0].seq - 1 — stays the highest
 * evicted seq). A LIVE entry's identity is never evicted.
 */
export const MAX_JOURNAL_ENTRIES = 500;

/**
 * Snapshot-body byte budget per store (sum of retained snapshot sizes).
 * Past it, the OLDEST OUTDATED entries' bodies are nulled first — the
 * cheapest info loss: diff: null is already legal ("pruned body") and the
 * entry's identity, stats, and lineage pointers all survive.
 */
export const MAX_JOURNAL_SNAPSHOT_BYTES = 16 * 1024 * 1024;

/**
 * Upper bound of the pseudo-run for binary/mode-only sections: the
 * pseudo-hunk "touches" the whole old axis, so any later hunk in the
 * same file matches it.
 */
export const PSEUDO_RUN_HI = Number.MAX_SAFE_INTEGER;

// --- Pure classifier -------------------------------------------------------

const JOURNAL_HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/;

/**
 * Parse the old side of an @@ -a,b +c,d @@ header. Counts default to 1
 * when omitted; b may be 0 (-0,0 new file, -N,0 pure insertion).
 */
function parseOldRange(header: string): { oldStart: number; oldCount: number } | null {
  const match = JOURNAL_HUNK_HEADER.exec(header);
  if (!match) return null;
  return {
    oldStart: parseInt(match[1], 10),
    oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
  };
}

/**
 * Extract a hunk's edit-run footprints in half-line HEAD coordinates.
 *
 * A maximal consecutive del/add group is one run:
 * - deletions of HEAD lines d1..d2 -> [2*d1, 2*d2]
 * - a pure insertion after HEAD line A -> [2A, 2A+2] (the half-line
 *   expansion: it "touches" both neighboring HEAD lines; A = 0 at top)
 *
 * This OWNS its old-line accounting — it re-derives counts from the
 * header (including -0,0 and -N,0 forms), skips "\ No newline" lines
 * (which parseDiffWithLineNumbers numbers as context and would therefore
 * drift every later anchor), and classifies every body line by its RAW
 * FIRST CHARACTER, never by DiffLine.type: the parser's header-prefix
 * checks also match body lines whose CONTENT starts with "--" (a deleted
 * `--foo` comment reads as a `---` header), "++", or "\". Real ---/+++/@@
 * headers never appear inside a hunk body, so the first char is
 * unambiguous here.
 *
 * bodyLines are the hunk's lines AFTER the @@ header.
 */
export function extractRuns(bodyLines: DiffLine[], header: string): Run[] {
  const range = parseOldRange(header);
  if (!range) return [];

  // Number of the next HEAD line to consume. A zero old count positions
  // the hunk AFTER line oldStart.
  let nextOld = range.oldCount === 0 ? range.oldStart + 1 : range.oldStart;

  const runs: Run[] = [];
  let group: RunGroup | null = null;

  for (const line of bodyLines) {
    const first = line.content[0];
    if (first === '\\') continue; // "\ No newline …" — never a HEAD line
    if (first === '-') {
      group = noteDeletion(group, nextOld);
      nextOld++;
    } else if (first === '+') {
      group = group ?? { hasDel: false, delStart: 0, delEnd: 0, anchor: nextOld - 1 };
    } else {
      // context line
      flushGroup(runs, group);
      group = null;
      nextOld++;
    }
  }
  flushGroup(runs, group);
  return runs;
}

interface RunGroup {
  hasDel: boolean;
  delStart: number;
  delEnd: number;
  anchor: number;
}

function noteDeletion(group: RunGroup | null, oldLine: number): RunGroup {
  if (!group) return { hasDel: true, delStart: oldLine, delEnd: oldLine, anchor: oldLine - 1 };
  if (!group.hasDel) {
    group.hasDel = true;
    group.delStart = oldLine;
  }
  group.delEnd = oldLine;
  return group;
}

function flushGroup(runs: Run[], group: RunGroup | null): void {
  if (!group) return;
  runs.push(
    group.hasDel ? [2 * group.delStart, 2 * group.delEnd] : [2 * group.anchor, 2 * group.anchor + 2]
  );
}

/** HEAD old-line hull of a footprint set — drives the "lines 10-14" label. */
export function spanOfRuns(runs: Run[]): { start: number; count: number } {
  if (runs.length === 0) return { start: 0, count: 0 };
  let lo = Infinity;
  let hi = -Infinity;
  for (const [a, b] of runs) {
    if (a < lo) lo = a;
    if (b > hi) hi = b;
  }
  if (hi >= PSEUDO_RUN_HI) return { start: 0, count: 0 }; // binary/mode-only pseudo-hunk
  const start = Math.ceil(lo / 2);
  const end = Math.floor(hi / 2);
  return { start, count: end - start + 1 };
}

export interface FileHunks {
  hunks: ObservedHunk[];
  /** Old path when git reported this section as a rename. */
  renamedFrom: string | null;
  /** True when the section carried no @@ hunks (binary, mode-only, pure rename). */
  hunkless: boolean;
}

/**
 * Parse one file's diff section into ObservedHunks: footprints, bodyHash
 * (djb2 over +/- lines only), sizes, span, and the single-hunk snapshot
 * diff (file headers + the one @@ section). A section with no hunks
 * (binary, mode-only) yields one pseudo-hunk covering the whole old axis,
 * hashed over the raw slice.
 */
export function extractFileHunks(fileDiff: DiffResult): FileHunks {
  const headerLines: DiffLine[] = [];
  let renamedFrom: string | null = null;
  const rawHunks: { header: DiffLine; body: DiffLine[] }[] = [];
  let current: { header: DiffLine; body: DiffLine[] } | null = null;

  for (const line of fileDiff.lines) {
    if (line.type === 'hunk') {
      current = { header: line, body: [] };
      rawHunks.push(current);
    } else if (current) {
      current.body.push(line);
    } else {
      headerLines.push(line);
      if (line.content.startsWith('rename from ')) {
        renamedFrom = line.content.slice('rename from '.length);
      }
    }
  }

  if (rawHunks.length === 0) {
    // An OVERSIZE_UNTRACKED_MARKER section is a header-only stand-in for
    // a file too large to snapshot: classify it (created/edited via the
    // marker's size/mtime suffix in the raw hash) but never store its
    // header lines as if they were the snapshot.
    const oversize = headerLines.some((l) => l.content.startsWith(OVERSIZE_UNTRACKED_MARKER));
    return {
      hunks: [
        {
          runs: [[0, PSEUDO_RUN_HI]],
          bodyHash: hashHunkBody([rawFromLines(fileDiff.lines)]),
          ins: 0,
          del: 0,
          span: { start: 0, count: 0 },
          diff: fileDiff,
          oversize,
        },
      ],
      renamedFrom,
      hunkless: true,
    };
  }

  const hunks = rawHunks.map(({ header, body }): ObservedHunk => {
    const runs = extractRuns(body, header.content);
    const changed: string[] = [];
    let ins = 0;
    let del = 0;
    for (const line of body) {
      // Raw first char, never DiffLine.type — see extractRuns.
      const first = line.content[0];
      if (first === '\\') continue;
      if (first === '+') {
        ins++;
        changed.push(line.content);
      } else if (first === '-') {
        del++;
        changed.push(line.content);
      }
    }
    const lines = [...headerLines, header, ...body];
    return {
      runs,
      bodyHash: hashHunkBody(changed),
      ins,
      del,
      span: spanOfRuns(runs),
      diff: { lines },
    };
  });
  return { hunks, renamedFrom, hunkless: false };
}

/** A classified hunk: a journal entry minus the per-observation stamps. */
export interface ClassifiedHunk {
  seq: number;
  kind: JournalHunkKind;
  span: { start: number; count: number };
  stats: { insertions: number; deletions: number };
  diff: DiffResult | null;
  supersedes: number[];
  siblings: number;
}

/**
 * The body to store for an observed hunk: null for an oversize-untracked
 * stand-in section (its headers are not a snapshot) and for snapshots
 * past the raw-size cap.
 */
function snapshotFor(h: ObservedHunk): DiffResult | null {
  if (h.oversize === true) return null;
  return diffByteSize(h.diff.lines) > MAX_SNAPSHOT_BYTES ? null : h.diff;
}

function deriveKind(ins: number, del: number, predSize: number): JournalHunkKind {
  // A pure deletion is never growth: removing HEAD lines only ever
  // shrinks the change, whatever its gross churn (deleting 3 lines has
  // more +/- lines than inserting 1, but must not badge 'expanded').
  if (ins === 0 && del > 0) return 'shrunk';
  const size = ins + del;
  if (size > predSize) return 'expanded';
  if (size < predSize) return 'shrunk';
  return 'edited';
}

interface FlatRun {
  lo: number;
  hi: number;
  node: number;
}

function flattenRuns(hunks: { runs: Run[] }[], nodeOffset: number): FlatRun[] {
  const flat: FlatRun[] = [];
  hunks.forEach((h, i) => {
    for (const [lo, hi] of h.runs) flat.push({ lo, hi, node: nodeOffset + i });
  });
  flat.sort((a, b) => a.lo - b.lo);
  return flat;
}

/** Union-find over prev (0..P-1) and next (P..P+N-1) hunk nodes. */
function connectByOverlap(prev: LiveHunk[], next: ObservedHunk[]): number[] {
  const parent = Array.from({ length: prev.length + next.length }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // Both lists are sorted by lo with monotone hi (runs within one diff are
  // ordered and non-nested), so a forward scan with a moving lower bound
  // enumerates every intersecting pair. Closed-interval overlap:
  // lo1 <= hi2 && lo2 <= hi1.
  const prevRuns = flattenRuns(prev, 0);
  const nextRuns = flattenRuns(next, prev.length);
  let jStart = 0;
  for (const a of prevRuns) {
    while (jStart < nextRuns.length && nextRuns[jStart].hi < a.lo) jStart++;
    for (let j = jStart; j < nextRuns.length && nextRuns[j].lo <= a.hi; j++) {
      union(a.node, nextRuns[j].node);
    }
  }
  return parent.map((_, i) => find(i));
}

interface Component {
  prevIdx: number[];
  nextIdx: number[];
  minLo: number;
}

function buildComponents(prev: LiveHunk[], next: ObservedHunk[]): Component[] {
  const roots = connectByOverlap(prev, next);
  const comps = new Map<number, Component>();
  const compFor = (root: number): Component => {
    let comp = comps.get(root);
    if (!comp) {
      comp = { prevIdx: [], nextIdx: [], minLo: Infinity };
      comps.set(root, comp);
    }
    return comp;
  };
  prev.forEach((h, i) => {
    const comp = compFor(roots[i]);
    comp.prevIdx.push(i);
    for (const [lo] of h.runs) if (lo < comp.minLo) comp.minLo = lo;
  });
  next.forEach((h, i) => {
    const comp = compFor(roots[prev.length + i]);
    comp.nextIdx.push(i);
    for (const [lo] of h.runs) if (lo < comp.minLo) comp.minLo = lo;
  });
  return [...comps.values()].sort((a, b) => a.minLo - b.minLo);
}

/**
 * Classify one file's hunks between two observations (HEAD frozen).
 * Matches prev to next by any run-interval intersection, builds connected
 * components, and applies the component table:
 *
 *   0 prev, 1 next            -> created, supersedes []
 *   1 prev, 0 next            -> reverted tombstone, diff null
 *   1<->1, same bodyHash      -> SILENT (carry seq, recomputed runs)
 *   1<->1, hash differs       -> one entry, kind by size
 *   1 -> N (split)            -> N entries, EACH supersedes the parent, siblings N
 *   N -> 1 (merge)            -> one entry superseding all N
 *   N <-> M                   -> every next supersedes all prev in the
 *                                component, siblings M (honest over-
 *                                supersession, never clever)
 *
 * Entry seqs are assigned from startSeq in output order; the caller
 * advances its counter by entries.length. nextLive preserves next order.
 */
export function classifyFileHunks(
  prev: LiveHunk[],
  next: ObservedHunk[],
  startSeq: number
): { entries: ClassifiedHunk[]; nextLive: LiveHunk[] } {
  const entries: ClassifiedHunk[] = [];
  const nextLive: (LiveHunk | null)[] = next.map(() => null);
  let seq = startSeq;

  for (const comp of buildComponents(prev, next)) {
    const P = comp.prevIdx.map((i) => prev[i]);
    const N = comp.nextIdx.map((i) => next[i]);

    if (P.length === 1 && N.length === 1 && P[0].bodyHash === N[0].bodyHash) {
      // Silent: content unchanged (line shifts only). Carry the seq
      // forward with the recomputed runs.
      const h = N[0];
      nextLive[comp.nextIdx[0]] = {
        seq: P[0].seq,
        runs: h.runs,
        bodyHash: h.bodyHash,
        ins: h.ins,
        del: h.del,
      };
      continue;
    }

    if (N.length === 0) {
      // Distinct prev hunks are disjoint on the old axis, so a prev-only
      // component holds exactly one hunk; loop for robustness anyway.
      for (const p of P) {
        entries.push({
          seq: seq++,
          kind: 'reverted',
          span: spanOfRuns(p.runs),
          stats: { insertions: 0, deletions: 0 },
          diff: null,
          supersedes: [p.seq],
          siblings: 1,
        });
      }
      continue;
    }

    const supersedes = P.map((p) => p.seq);
    const predSize = P.reduce((sum, p) => sum + p.ins + p.del, 0);
    for (const i of comp.nextIdx) {
      const h = next[i];
      const entry: ClassifiedHunk = {
        seq: seq++,
        kind: P.length === 0 ? 'created' : deriveKind(h.ins, h.del, predSize),
        span: h.span,
        stats: { insertions: h.ins, deletions: h.del },
        diff: snapshotFor(h),
        supersedes: [...supersedes],
        siblings: N.length,
      };
      entries.push(entry);
      nextLive[i] = { seq: entry.seq, runs: h.runs, bodyHash: h.bodyHash, ins: h.ins, del: h.del };
    }
  }

  return { entries, nextLive: nextLive.filter((l): l is LiveHunk => l !== null) };
}

/**
 * Re-key a file's live hunks against a new HEAD. Footprints are NEVER
 * compared across a boundary — seqs carry by bodyHash (an untouched
 * hunk's +/- content is identical against the new base), then
 * positionally for content the boundary itself changed (partial hunk
 * commits); leftover old seqs retire into the boundary's resolves.
 */
export function rebaselineFile(
  old: LiveHunk[],
  next: ObservedHunk[]
): { carried: LiveHunk[]; retired: number[] } {
  const usedOld = new Array<boolean>(old.length).fill(false);
  const assigned = new Array<number | null>(next.length).fill(null);

  for (let i = 0; i < next.length; i++) {
    const k = old.findIndex((o, idx) => !usedOld[idx] && o.bodyHash === next[i].bodyHash);
    if (k !== -1) {
      usedOld[k] = true;
      assigned[i] = old[k].seq;
    }
  }
  for (let i = 0; i < next.length; i++) {
    if (assigned[i] !== null) continue;
    const k = usedOld.findIndex((used) => !used);
    if (k !== -1) {
      usedOld[k] = true;
      assigned[i] = old[k].seq;
    }
  }

  // A next hunk beyond the old count borrows the file's last seq: honest
  // over-supersession later, never clever.
  const fallback = old[old.length - 1].seq;
  const carried = next.map((h, i): LiveHunk => {
    return {
      seq: assigned[i] ?? fallback,
      runs: h.runs,
      bodyHash: h.bodyHash,
      ins: h.ins,
      del: h.del,
    };
  });
  const retired = old.filter((_, k) => !usedOld[k]).map((o) => o.seq);
  return { carried, retired };
}

// --- The stateful manager --------------------------------------------------

export function createJournalStore(): JournalStore {
  return {
    entries: [],
    epoch: `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
    nextSeq: 1,
    live: new Map(),
    lastHeadOid: null,
    lastBranch: null,
    lastStashCount: 0,
    lastOperation: null,
  };
}

type JournalEventMap = {
  append: [JournalEntry[]];
};

interface ParsedObservation {
  files: Map<string, FileHunks>;
  /**
   * Untracked defer guard: getDiffForUntracked catches-to-empty, so an
   * untracked path status still lists but whose section is absent from
   * the observation's diff must NOT read as a whole-file revert. These
   * paths keep their live hunks and emit nothing this tick.
   */
  deferred: Set<string>;
}

export class JournalManager extends EventEmitter<JournalEventMap> {
  constructor(private store: JournalStore) {
    super();
  }

  get journalStore(): JournalStore {
    return this.store;
  }

  /**
   * Fold one settled observation into the journal. Never throws and never
   * emits 'error': an internal failure skips the tick (defer-don't-decide
   * — the next observation re-derives everything from scratch).
   */
  observe(observation: JournalObservation): void {
    try {
      this.doObserve(observation);
    } catch (err) {
      logger.warn(
        `Journal observation skipped: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private doObserve(obs: JournalObservation): void {
    const batch: JournalEntry[] = [];

    if (this.store.lastHeadOid === null) {
      // Unseeded store. Wait for a clean tick if an operation is mid-flight.
      if (obs.operationInProgress === null) this.seed(obs, batch);
    } else if (this.handleOperations(obs, batch)) {
      // (a) suspended while an operation is in progress
    } else if (obs.headOid !== this.store.lastHeadOid) {
      // (b) HEAD moved: one boundary, silent rebaseline
      this.rebaseline(obs, batch);
    } else {
      // (c) HEAD stable: per-file hunk classification
      this.classify(obs, batch);
    }

    if (batch.length > 0) {
      this.store.entries.push(...batch);
      // Emit BEFORE pruning: the SSE fan-out serializes the batch on
      // emit, so subscribers get full bodies even when the prune pass
      // immediately nulls the oldest outdated ones.
      this.emit('append', batch);
      this.pruneStore();
    }
  }

  /**
   * Enforce the store bounds (design decision 8) after an append: null
   * the oldest OUTDATED bodies past the byte budget, then evict the
   * oldest entries entirely past the count cap. Identity eviction is a
   * contiguous prefix and never removes a LIVE entry, so seqs stay
   * contiguous and the daemon's derived prunedBefore (entries[0].seq - 1)
   * remains the highest evicted seq. Lineage pointers of retained
   * entries may name evicted seqs — that is exactly the pruned-baseline
   * gap prunedBefore exposes honestly to clients.
   */
  private pruneStore(): void {
    const liveSeqs = new Set<number>();
    for (const hunks of this.store.live.values()) {
      for (const h of hunks) liveSeqs.add(h.seq);
    }
    this.pruneBodies(liveSeqs);
    this.pruneEntries(liveSeqs);
  }

  /** Null the oldest outdated (non-live) bodies until under the byte budget. */
  private pruneBodies(liveSeqs: Set<number>): void {
    let bytes = 0;
    for (const e of this.store.entries) {
      if (e.type === 'hunk' && e.diff !== null) bytes += diffByteSize(e.diff.lines);
    }
    for (const e of this.store.entries) {
      if (bytes <= MAX_JOURNAL_SNAPSHOT_BYTES) return;
      if (e.type !== 'hunk' || e.diff === null || liveSeqs.has(e.seq)) continue;
      bytes -= diffByteSize(e.diff.lines);
      e.diff = null;
    }
  }

  /**
   * Evict a contiguous oldest prefix past the count cap. Eviction stops
   * at the first live entry: a live identity is never evicted, even if
   * that leaves the store above the cap (bounded in practice — live
   * entries are at most the working tree's current hunks).
   */
  private pruneEntries(liveSeqs: Set<number>): void {
    const entries = this.store.entries;
    let drop = 0;
    while (
      entries.length - drop > MAX_JOURNAL_ENTRIES &&
      (entries[drop].type === 'boundary' || !liveSeqs.has(entries[drop].seq))
    ) {
      drop++;
    }
    if (drop > 0) entries.splice(0, drop);
  }

  /**
   * (a) Operation transitions. Returns true when this tick is suspended
   * (an operation is in progress). An op-end falls through so (b)/(c)
   * classify the post-operation reality in the same tick.
   */
  private handleOperations(obs: JournalObservation, batch: JournalEntry[]): boolean {
    const prevOp = this.store.lastOperation;
    if (obs.operationInProgress !== null) {
      if (prevOp === null) {
        batch.push(this.boundary('op-start', obs.operationInProgress, [], obs.at));
        this.store.lastOperation = obs.operationInProgress;
      }
      return true;
    }
    if (prevOp !== null) {
      batch.push(this.boundary('op-end', prevOp, [], obs.at));
      this.store.lastOperation = null;
    }
    return false;
  }

  /** First observation: journal-start boundary + seeded entries in mtime order. */
  private seed(obs: JournalObservation, batch: JournalEntry[]): void {
    batch.push(this.boundary('journal-start', obs.status.branch.current, [], obs.at));

    const { files } = this.parseObservation(obs);
    const paths = [...files.keys()].sort((a, b) => this.tsFor(obs, a) - this.tsFor(obs, b));
    for (const path of paths) {
      this.classifyPath(path, [], files.get(path)!.hunks, obs, true, batch);
    }

    this.store.lastHeadOid = obs.headOid;
    this.store.lastBranch = obs.status.branch.current;
    this.store.lastStashCount = obs.stashCount;
    this.store.lastOperation = null;
  }

  /**
   * (b) HEAD moved: one boundary (commit if the branch held, checkout
   * otherwise) resolving the seqs of files that left the diff; every
   * surviving file rebaselines SILENTLY (same seqs, fresh runs/hashes).
   * Files newly in the diff at the boundary tick (e.g. reset --soft)
   * classify as ordinary creations after the divider.
   */
  private rebaseline(obs: JournalObservation, batch: JournalEntry[]): void {
    const { files, deferred } = this.parseObservation(obs);
    const isCommit = obs.status.branch.current === this.store.lastBranch;
    const kind: JournalBoundaryKind = isCommit ? 'commit' : 'checkout';
    const label = isCommit ? obs.headOid.slice(0, 7) : obs.status.branch.current;

    const { resolves, newLive } = this.carrySurvivors(files, deferred);
    batch.push(this.boundary(kind, label, resolves, obs.at));
    this.store.live = newLive;

    for (const [path, { hunks }] of files) {
      if (newLive.has(path)) continue;
      this.classifyPath(path, [], hunks, obs, false, batch);
    }

    this.store.lastHeadOid = obs.headOid;
    this.store.lastBranch = obs.status.branch.current;
    this.store.lastStashCount = obs.stashCount;
  }

  /** Rebaseline every surviving file's live hunks; retire the rest into resolves. */
  private carrySurvivors(
    files: Map<string, FileHunks>,
    deferred: Set<string>
  ): { resolves: number[]; newLive: Map<string, LiveHunk[]> } {
    const resolves: number[] = [];
    const newLive = new Map<string, LiveHunk[]>();
    for (const [path, liveHunks] of this.store.live) {
      if (deferred.has(path)) {
        newLive.set(path, liveHunks);
        continue;
      }
      const observed = files.get(path);
      if (!observed) {
        // The file left the diff across the boundary (committed away).
        resolves.push(...liveHunks.map((h) => h.seq));
        continue;
      }
      const { carried, retired } = rebaselineFile(liveHunks, observed.hunks);
      resolves.push(...retired);
      newLive.set(path, carried);
    }
    return { resolves, newLive };
  }

  /** (c) HEAD stable: renames, whole-file disappearances, then per-file hunks. */
  private classify(obs: JournalObservation, batch: JournalEntry[]): void {
    const { files, deferred } = this.parseObservation(obs);

    this.handleRenames(obs, files, batch);
    this.handleDisappearances(obs, files, deferred, batch);

    for (const [path, { hunks, renamedFrom, hunkless }] of files) {
      const prev = this.store.live.get(path) ?? [];
      // A hunkless section carrying a rename is content-silent: when the
      // re-keyed live hunks exist (content reverted in the same tick as a
      // 100%-similarity rename), its pseudo-hunk would misfire as an edit
      // against them. Defer — keep the live hunks untouched this tick.
      if (hunkless && renamedFrom !== null && prev.length > 0) continue;
      this.classifyPath(path, prev, hunks, obs, false, batch);
    }

    // A branch rename/creation with HEAD stable (git branch -m,
    // checkout -b) lands here: track it, or the next HEAD move is
    // mislabeled 'checkout' instead of 'commit'.
    this.store.lastBranch = obs.status.branch.current;
    this.store.lastStashCount = obs.stashCount;
  }

  /**
   * Rename with a git-reported old path: re-key the live map (the HEAD
   * pre-image blob is content-identical, so anchors stay valid), then
   * classification proceeds normally; one file-scoped renamed marker is
   * appended. A similarity-detection flip-flop degrades to revert+create.
   */
  private handleRenames(
    obs: JournalObservation,
    files: Map<string, FileHunks>,
    batch: JournalEntry[]
  ): void {
    for (const [path, fileHunks] of files) {
      const from = fileHunks.renamedFrom;
      if (from === null || from === path) continue;
      if (!this.store.live.has(from) || files.has(from)) continue;
      // Re-keying must not silently clobber live hunks already recorded
      // AT the target path (delete B + rename A->B in one observation):
      // the marker supersedes the displaced seqs so they retire honestly.
      const displaced = (this.store.live.get(path) ?? []).map((h) => h.seq);
      this.store.live.set(path, this.store.live.get(from)!);
      this.store.live.delete(from);
      batch.push({
        type: 'hunk',
        seq: this.store.nextSeq++,
        ts: this.tsFor(obs, path),
        path,
        status: 'renamed',
        kind: 'renamed',
        span: { start: 0, count: 0 },
        stats: { insertions: 0, deletions: 0 },
        diff: null,
        supersedes: displaced,
        siblings: 1,
        seeded: false,
      });
    }
  }

  /**
   * Whole-file disappearances. When the stash count rose this observation
   * the vanished files fold into one stash boundary (heuristic: the label
   * can be wrong, the content record stays truthful); otherwise each file
   * gets ONE reverted entry superseding all its live seqs.
   */
  private handleDisappearances(
    obs: JournalObservation,
    files: Map<string, FileHunks>,
    deferred: Set<string>,
    batch: JournalEntry[]
  ): void {
    const left = [...this.store.live.keys()].filter((p) => !files.has(p) && !deferred.has(p));
    if (left.length === 0) return;

    if (obs.stashCount > this.store.lastStashCount) {
      const resolves = left.flatMap((p) => this.store.live.get(p)!.map((h) => h.seq));
      batch.push(this.boundary('stash', 'stash', resolves, obs.at));
      for (const p of left) this.store.live.delete(p);
      return;
    }

    for (const path of left) {
      const liveHunks = this.store.live.get(path)!;
      batch.push({
        type: 'hunk',
        seq: this.store.nextSeq++,
        ts: this.tsFor(obs, path),
        path,
        status: this.statusOf(obs, path),
        kind: 'reverted',
        span: spanOfRuns(liveHunks.flatMap((h) => h.runs)),
        stats: { insertions: 0, deletions: 0 },
        diff: null,
        supersedes: liveHunks.map((h) => h.seq),
        siblings: 1,
        seeded: false,
      });
      this.store.live.delete(path);
    }
  }

  /** Run the pure classifier for one path and stamp+append its entries. */
  private classifyPath(
    path: string,
    prev: LiveHunk[],
    hunks: ObservedHunk[],
    obs: JournalObservation,
    seeded: boolean,
    batch: JournalEntry[]
  ): void {
    const { entries, nextLive } = classifyFileHunks(prev, hunks, this.store.nextSeq);
    this.store.nextSeq += entries.length;
    const ts = this.tsFor(obs, path);
    const status = this.statusOf(obs, path);
    for (const e of entries) {
      const entry: JournalHunkEntry = {
        type: 'hunk',
        seq: e.seq,
        ts,
        path,
        status,
        // "in diff, no live entry -> created; status renamed -> renamed"
        kind: e.kind === 'created' && status === 'renamed' ? 'renamed' : e.kind,
        span: e.span,
        stats: e.stats,
        diff: e.diff,
        supersedes: e.supersedes,
        siblings: e.siblings,
        seeded,
      };
      batch.push(entry);
    }
    if (nextLive.length > 0) this.store.live.set(path, nextLive);
    else this.store.live.delete(path);
  }

  private parseObservation(obs: JournalObservation): ParsedObservation {
    const files = new Map<string, FileHunks>();
    for (const [path, fileDiff] of splitDiffByFile(obs.headDiff)) {
      files.set(path, extractFileHunks(fileDiff));
    }
    const deferred = new Set<string>();
    for (const file of obs.status.files) {
      if (file.status === 'untracked' && !files.has(file.path)) deferred.add(file.path);
    }
    return { files, deferred };
  }

  private boundary(
    kind: JournalBoundaryKind,
    label: string,
    resolves: number[],
    at: number
  ): JournalBoundaryEntry {
    return { type: 'boundary', seq: this.store.nextSeq++, ts: at, kind, label, resolves };
  }

  /** ts = min(file mtime, observation time): mtime-honest, never future. */
  private tsFor(obs: JournalObservation, path: string): number {
    const mtime = obs.mtimes?.get(path);
    return mtime === undefined ? obs.at : Math.min(mtime, obs.at);
  }

  private statusOf(obs: JournalObservation, path: string): FileStatus {
    return obs.status.files.find((f) => f.path === path)?.status ?? 'modified';
  }
}
