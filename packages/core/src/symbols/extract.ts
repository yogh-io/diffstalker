/**
 * The tree-sitter engine. **Runs only inside the daemon's worker thread.**
 *
 * That is not a style preference, it is the containment for two measured
 * failures:
 *
 * - A parse cancelled through a progress callback POISONS the parser. The
 *   next parse on the same instance returns a tree carrying the PREVIOUS
 *   file's content — symbols and line numbers from another file, attributed
 *   to this one — or throws `memory access out of bounds` from inside wasm.
 *   `reset()` does not reliably cure it. So a cancelled or crashed instance
 *   is never reused; the worker is discarded and respawned.
 * - The deadline that bounds `parse()` does NOT bound `Query.captures`,
 *   which was measured at 2.4 s on a 32 KiB pathological file while parse
 *   finished in 22 ms. A query progress callback only helps at coarse
 *   intervals. The real bound is a wall-clock timer the worker cannot
 *   block, enforced by the host.
 *
 * **Engine failures THROW here.** They are not converted to
 * `unavailable` — that decision belongs to the host, which owns the
 * instance and is the only layer that can actually discard it. Returning
 * `unavailable` from inside would leave a corrupt wasm module answering
 * further requests, which is precisely the wrong-symbols failure above.
 *
 * Content arrives already capped by `readFileForDisplay`. The `/file` caps
 * ARE the symbol caps — there is deliberately no second byte budget to
 * drift out of step with the text the outline is supposed to describe.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Language, Parser, Query } from 'web-tree-sitter';
import { grammarForPath } from './languages.js';
import { scanScriptBlocks } from './vueBlocks.js';
import type { FileSymbol, SymbolKind, SymbolOutcome } from './types.js';

/**
 * Defensive ceiling on captures turned into symbols. Not an error state —
 * a file with more declarations than this has an outline nobody can read
 * anyway, and the cap keeps one pathological input from producing a
 * megabyte of JSON.
 */
export const SYMBOL_MAX_COUNT = 10_000;

export interface SymbolEngineOptions {
  /** Directory holding `<grammar>.wasm` and the runtime wasm. */
  grammarDir: string;
  /** Directory holding `<grammar>.scm`. */
  queryDir: string;
}

export interface SymbolEngine {
  /** True when this build can outline `relPath`. A map lookup, no parsing. */
  supported(relPath: string): boolean;
  /** Throws on engine failure — see the module comment. */
  extract(relPath: string, content: string): Promise<SymbolOutcome>;
}

/** `@symbol.<kind>` capture name -> kind. Anything else is ignored. */
const CAPTURE_PREFIX = 'symbol.';

function kindOf(captureName: string): SymbolKind | null {
  if (!captureName.startsWith(CAPTURE_PREFIX)) return null;
  return captureName.slice(CAPTURE_PREFIX.length) as SymbolKind;
}

interface Capture {
  name: string;
  node: {
    startIndex: number;
    endIndex: number;
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
    text: string;
  };
}

/**
 * Turn captures into symbols.
 *
 * Every `@symbol.<kind>` is paired with the `@name` nested inside it. A
 * symbol whose name capture is missing is DROPPED rather than given a
 * placeholder: an outline row reading "(anonymous)" is a row that teaches
 * nothing and costs a line.
 *
 * `parent` is the innermost enclosing symbol, resolved with a stack over
 * captures in document order.
 */
export function symbolsFromCaptures(captures: readonly Capture[]): FileSymbol[] {
  const symbols: FileSymbol[] = [];
  const open: FileSymbol[] = [];

  for (let i = 0; i < captures.length && symbols.length < SYMBOL_MAX_COUNT; i++) {
    const kind = kindOf(captures[i].name);
    if (kind === null) continue;

    const node = captures[i].node;
    const named = captures.find(
      (c, j) =>
        j > i && c.name === 'name' && c.node.startIndex >= node.startIndex && c.node.endIndex <= node.endIndex
    );
    if (named === undefined) continue;

    while (open.length > 0 && open[open.length - 1].endLine < node.startPosition.row + 1) open.pop();

    const symbol: FileSymbol = {
      kind,
      name: named.node.text,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      column: node.startPosition.column,
      parent: open.length > 0 ? open[open.length - 1].name : null,
    };
    symbols.push(symbol);
    open.push(symbol);
  }

  symbols.sort((a, b) => a.startLine - b.startLine || a.column - b.column);
  return symbols;
}

export async function createSymbolEngine(opts: SymbolEngineOptions): Promise<SymbolEngine> {
  await Parser.init({
    wasmBinary: fs.readFileSync(path.join(opts.grammarDir, 'web-tree-sitter.wasm')),
  });

  const languages = new Map<string, { language: Language; query: Query }>();

  async function ensure(grammar: string): Promise<{ language: Language; query: Query }> {
    const cached = languages.get(grammar);
    if (cached !== undefined) return cached;

    const language = await Language.load(
      fs.readFileSync(path.join(opts.grammarDir, `tree-sitter-${grammar}.wasm`))
    );
    const query = new Query(
      language,
      fs.readFileSync(path.join(opts.queryDir, `${grammar}.scm`), 'utf8')
    );
    const entry = { language, query };
    languages.set(grammar, entry);
    return entry;
  }

  return {
    supported(relPath: string): boolean {
      return grammarForPath(relPath) !== null;
    },

    async extract(relPath: string, content: string): Promise<SymbolOutcome> {
      const match = grammarForPath(relPath);
      if (match === null) return { status: 'unsupported', reason: 'language' };

      // Vue: the real code is inside <script>. Ranges rather than a
      // substring, so line numbers stay file-absolute for free.
      let includedRanges;
      if (match.container === 'vue') {
        const blocks = scanScriptBlocks(content);
        if (blocks.length === 0) return { status: 'unsupported', reason: 'no-script-block' };
        includedRanges = blocks;
      }

      const { language, query } = await ensure(match.grammar);
      const parser = new Parser();
      parser.setLanguage(language);

      // A fresh parser per call. The engine is cheap to construct and a
      // long-lived one is exactly what carries a poisoned state forward.
      const tree =
        includedRanges === undefined
          ? parser.parse(content)
          : parser.parse(content, null, { includedRanges });
      if (tree === null) throw new Error('parse returned no tree');

      try {
        const captures = query.captures(tree.rootNode) as unknown as Capture[];
        return { status: 'ok', symbols: symbolsFromCaptures(captures) };
      } finally {
        // Always: a leaked tree is wasm memory that never comes back.
        tree.delete();
        parser.delete();
      }
    },
  };
}
