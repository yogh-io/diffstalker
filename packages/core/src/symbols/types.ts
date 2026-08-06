/**
 * The symbol model: what an outline says, and what it says when it cannot.
 *
 * Browser-safe by construction — types only, no engine import. The parser
 * lives in `extract.ts` and runs only inside the daemon's worker.
 *
 * This is SYNTAX, never semantics. Nothing resolves. Methods attached by
 * `Object.assign(Foo.prototype, {…})` are invisible; `export { x } from
 * './y'` is not a declaration; decorator-synthesized and build-time
 * members are permanently absent. Overloads and get/set pairs come out as
 * same-named entries on different lines, undisambiguated. Cross-file is
 * out, and nothing here is a substrate for it.
 */

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'const'
  | 'namespace'
  | 'field'
  | 'constructor';

export interface FileSymbol {
  kind: SymbolKind;
  name: string;
  /** 1-based, in the same coordinate space as `FileForDisplay.content`. */
  startLine: number;
  endLine: number;
  /** 0-based column of the declaration, for stable ordering within a line. */
  column: number;
  /** Innermost enclosing symbol's name, or null at top level. */
  parent: string | null;
}

/**
 * Exactly three variants, and the omissions are deliberate.
 *
 * Binary, too-large and truncated are NOT re-encoded here: `FileForDisplay`
 * already carries those flags, and a second encoding is how two states
 * collapse into one string. The UI derives that copy from the flags and
 * this outcome together (see `view/outlineModel`).
 *
 * `unavailable` never means "no symbols" — an empty `ok` is a real answer
 * about a real file, and conflating them would tell someone their file has
 * no functions when the parser actually died.
 */
export type SymbolOutcome =
  | { status: 'ok'; symbols: FileSymbol[] }
  | { status: 'unsupported'; reason: 'language' | 'no-script-block' }
  | { status: 'unavailable'; reason: 'deadline' | 'error' };

/**
 * A parse range, in web-tree-sitter's shape.
 *
 * Redeclared here so browser-safe modules (the Vue block scanner) can
 * produce ranges without importing the engine. Indices are UTF-16 code
 * units, matching JavaScript string offsets.
 */
export interface IncludedRange {
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
}
