/**
 * Language detection and syntax highlighting utilities for file content.
 * Uses the emphasize package for ANSI terminal colors.
 */

import { createEmphasize } from 'emphasize';
import { common } from 'lowlight';

// Create emphasize instance with common languages
const emphasize = createEmphasize(common);

// Map file extensions to highlight.js language names
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  // TypeScript/JavaScript
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',

  // Web
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',

  // Data formats
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',

  // Shell/Config
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  ps1: 'powershell',
  bat: 'dos',
  cmd: 'dos',

  // Systems languages
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  rs: 'rust',
  go: 'go',
  zig: 'zig',

  // JVM
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  groovy: 'groovy',
  gradle: 'groovy',

  // Scripting
  py: 'python',
  rb: 'ruby',
  pl: 'perl',
  lua: 'lua',
  php: 'php',
  r: 'r',

  // Functional
  hs: 'haskell',
  ml: 'ocaml',
  fs: 'fsharp',
  fsx: 'fsharp',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  clj: 'clojure',
  cljs: 'clojure',

  // .NET
  cs: 'csharp',
  vb: 'vbnet',

  // Documentation
  md: 'markdown',
  markdown: 'markdown',
  rst: 'plaintext',
  txt: 'plaintext',

  // Config/Build
  Makefile: 'makefile',
  Dockerfile: 'dockerfile',
  cmake: 'cmake',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',

  // SQL
  sql: 'sql',

  // Other
  vim: 'vim',
  diff: 'diff',
  patch: 'diff',
};

// Special filenames that map to languages
const FILENAME_TO_LANGUAGE: Record<string, string> = {
  Makefile: 'makefile',
  makefile: 'makefile',
  GNUmakefile: 'makefile',
  Dockerfile: 'dockerfile',
  dockerfile: 'dockerfile',
  Jenkinsfile: 'groovy',
  Vagrantfile: 'ruby',
  Gemfile: 'ruby',
  Rakefile: 'ruby',
  '.gitignore': 'plaintext',
  '.gitattributes': 'plaintext',
  '.editorconfig': 'ini',
  '.prettierrc': 'json',
  '.eslintrc': 'json',
  'tsconfig.json': 'json',
  'package.json': 'json',
  'package-lock.json': 'json',
  'bun.lockb': 'plaintext',
  'yarn.lock': 'yaml',
  'pnpm-lock.yaml': 'yaml',
  'Cargo.toml': 'ini',
  'Cargo.lock': 'ini',
  'go.mod': 'go',
  'go.sum': 'plaintext',
};

// Cache of available languages
let availableLanguages: Set<string> | null = null;

function getAvailableLanguages(): Set<string> {
  if (!availableLanguages) {
    availableLanguages = new Set(emphasize.listLanguages());
  }
  return availableLanguages;
}

/**
 * Get the highlight.js language name from a file path.
 * Returns null if the language cannot be determined or is not supported.
 */
export function getLanguageFromPath(filePath: string): string | null {
  if (!filePath) return null;

  // Check special filenames first
  const filename = filePath.split('/').pop() ?? '';
  if (FILENAME_TO_LANGUAGE[filename]) {
    const lang = FILENAME_TO_LANGUAGE[filename];
    return getAvailableLanguages().has(lang) ? lang : null;
  }

  // Get extension
  const ext = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : null;
  if (!ext) return null;

  const lang = EXTENSION_TO_LANGUAGE[ext];
  if (!lang) return null;

  // Verify language is available
  return getAvailableLanguages().has(lang) ? lang : null;
}

/**
 * Apply syntax highlighting to a line of code.
 * Returns the highlighted string with ANSI escape codes.
 * If highlighting fails, returns the original content.
 */
export function highlightLine(content: string, language: string): string {
  if (!content || !language) return content;

  try {
    const result = emphasize.highlight(language, content);
    return result.value;
  } catch {
    // If highlighting fails, return original content
    return content;
  }
}

/**
 * Apply syntax highlighting to multiple lines.
 * More efficient than calling highlightLine for each line
 * as it reuses the language detection.
 */
export function highlightLines(lines: string[], language: string): string[] {
  if (!language || lines.length === 0) return lines;

  return lines.map((line) => highlightLine(line, language));
}
