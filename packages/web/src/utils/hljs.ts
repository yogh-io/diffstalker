/**
 * The web UI's shared highlight.js instance. Starts from the lib/common
 * ~36-language build, then registers the extra languages the app's
 * file-type map (core/view/languageDetection) references but common omits
 * — so real-repo files like Jenkinsfiles (Groovy), Dockerfiles,
 * PowerShell, F#, Elixir, Clojure, etc. highlight instead of falling back
 * to plain text — plus a compact HCL / Terraform grammar highlight.js
 * ships none for. Both the Explorer file viewer (utils/highlight) and the
 * diff syntax mode (utils/diffHighlight) import THIS, so they cover the
 * same set. (Full highlight.js is 384 languages — far too heavy; this
 * registers only the ~13 the map actually needs. `zig` is omitted:
 * highlight.js ships no grammar for it.)
 */

import hljs from 'highlight.js/lib/common';
import type { HLJSApi, Language } from 'highlight.js';
import clojure from 'highlight.js/lib/languages/clojure';
import cmake from 'highlight.js/lib/languages/cmake';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import dos from 'highlight.js/lib/languages/dos';
import elixir from 'highlight.js/lib/languages/elixir';
import erlang from 'highlight.js/lib/languages/erlang';
import fsharp from 'highlight.js/lib/languages/fsharp';
import groovy from 'highlight.js/lib/languages/groovy';
import haskell from 'highlight.js/lib/languages/haskell';
import ocaml from 'highlight.js/lib/languages/ocaml';
import powershell from 'highlight.js/lib/languages/powershell';
import scala from 'highlight.js/lib/languages/scala';
import vim from 'highlight.js/lib/languages/vim';

const EXTRA_LANGUAGES = {
  clojure,
  cmake,
  dockerfile,
  dos,
  elixir,
  erlang,
  fsharp,
  groovy,
  haskell,
  ocaml,
  powershell,
  scala,
  vim,
};

for (const [name, def] of Object.entries(EXTRA_LANGUAGES)) {
  hljs.registerLanguage(name, def);
}

/**
 * A compact HCL / Terraform grammar — highlight.js ships none. Not
 * exhaustive, but colors the shape of the file: block keywords, attribute
 * names, quoted strings with ${…} interpolation, numbers, true/false/null,
 * and #, //, and block comments.
 */
function hcl(hl: HLJSApi): Language {
  return {
    name: 'HCL',
    aliases: ['terraform', 'tf'],
    keywords: {
      keyword:
        'resource variable provider data module output locals terraform ' +
        'for for_each count depends_on dynamic lifecycle',
      built_in: 'string number bool list map set object tuple any',
      literal: 'true false null',
    },
    contains: [
      hl.COMMENT('#', '$'),
      hl.COMMENT('//', '$'),
      hl.COMMENT('/\\*', '\\*/'),
      hl.QUOTE_STRING_MODE,
      hl.NUMBER_MODE,
      { className: 'subst', begin: '\\$\\{', end: '\\}' },
      // An identifier that is an assignment target (`name = …`) — the
      // negative lookahead skips `==`. String pattern (hljs's idiom), and
      // linear: [\w-]+ over a simple class backtracks at most once per
      // position on a failed lookahead.
      { className: 'attr', begin: '[A-Za-z_][\\w-]*(?=\\s*=(?!=))' },
    ],
  };
}

hljs.registerLanguage('hcl', hcl);

export default hljs;
