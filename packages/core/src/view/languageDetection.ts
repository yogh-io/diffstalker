/**
 * Language detection for file content.
 * Pure mapping from file path to highlight.js language name — no highlighting here.
 */

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

/**
 * Get the highlight.js language name from a file path.
 * Returns null if the language cannot be determined.
 * Callers that highlight (e.g. the CLI's syntaxHighlight helpers) tolerate
 * languages their highlighter does not support.
 */
export function getLanguageFromPath(filePath: string): string | null {
  if (!filePath) return null;

  // Check special filenames first
  const filename = filePath.split('/').pop() ?? '';
  if (FILENAME_TO_LANGUAGE[filename]) {
    return FILENAME_TO_LANGUAGE[filename];
  }

  // Get extension
  const ext = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : null;
  if (!ext) return null;

  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}
