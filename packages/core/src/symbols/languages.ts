/**
 * Which grammar answers for a path, and whether it needs unwrapping first.
 *
 * Deliberately NOT `view/languageDetection.ts`. That map answers to
 * highlight.js and calls `.vue` "xml" — correct for colouring, useless for
 * structure. Two questions, two maps; merging them would make one of the
 * answers wrong.
 *
 * The set is closed at the repo boundary. A language is added by vendoring
 * a grammar and a query and editing this table in a reviewed commit —
 * never at runtime, never from a path a repo controls. Follow mode opens
 * repos without anyone clicking, so a runtime grammar path would be
 * arbitrary WebAssembly executing on the daemon's origin.
 *
 * An extension that is not here gets `unsupported: 'language'` and the UI
 * says so by name. There is no regex second pass: a wrong symbol is worse
 * than an absent one.
 */

/** A container format whose real code sits inside another syntax. */
export type SymbolContainer = 'vue';

export interface GrammarMatch {
  /** Grammar id — the `<id>.wasm` / `<id>.scm` basename. */
  grammar: string;
  /** Non-null when the file must be unwrapped before parsing. */
  container: SymbolContainer | null;
}

/**
 * Extension (lowercase, with dot) -> grammar.
 *
 * `.vue` maps to the TypeScript grammar on purpose: there is no Vue
 * grammar to ship. The `<script>` block bounds are handed to the TS parser
 * as included ranges, which keeps line numbers file-absolute for free.
 */
const EXTENSION_TO_GRAMMAR: ReadonlyMap<string, GrammarMatch> = new Map([
  ['.ts', { grammar: 'typescript', container: null }],
  ['.mts', { grammar: 'typescript', container: null }],
  ['.cts', { grammar: 'typescript', container: null }],
  ['.vue', { grammar: 'typescript', container: 'vue' as const }],
]);

/** Extensions this build can outline, for the capability report. */
export function supportedExtensions(): string[] {
  return [...EXTENSION_TO_GRAMMAR.keys()];
}

/** Lowercased extension of `relPath`, including the dot; '' when none. */
function extensionOf(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  // A leading dot is a dotfile, not an extension (`.gitignore`).
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

/** The grammar for `relPath`, or null when this build cannot outline it. */
export function grammarForPath(relPath: string): GrammarMatch | null {
  return EXTENSION_TO_GRAMMAR.get(extensionOf(relPath)) ?? null;
}
