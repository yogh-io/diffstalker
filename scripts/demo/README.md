# Demo recording

A repeatable flow that records the **Compare view** demo: a feature branch
reviewed like a pull request, with uncommitted work folded in.

```bash
scripts/demo/record.sh     # build fixture + record  -> out/raw.mkv
scripts/demo/encode.sh     # encode                  -> out/compare.{mp4,gif}, poster
```

Everything runs on a virtual X display, so nothing appears on your screen and
nothing can wander in front of the camera. It is safe to run while you work.

## What it shows, and why

The story is the one users actually live: *you write some code, and the review
keeps up.* Sixteen seconds, because it loops in a README:

| at | beat |
| --- | --- |
| 0s | **Changes**, empty. The working tree is clean, so everything after this appears on camera |
| 1.2s | `src/config.ts` is written to disk — the list fills itself in |
| 2.6s | `src/rateLimit.test.ts` |
| 4.0s | `docs/rate-limit.md` |
| 5.6s | Click over to **Compare**: the branch so far, one commit against `origin/main` |
| 8.4s | Tick `unstaged`, then `untracked` — the uncommitted work joins the review, tagged |
| 12.9s | **`git commit` runs in a terminal.** The commits list goes 1 → 2, the tags fall away, Changes drops to 0 |

The files land **one at a time, a beat apart**. Writing them together is faster
but unreadable: the list jumps from empty to full in a single frame and there
is nothing to notice.

The two beats that change anything change it **on disk** — a real write into
the working tree, a real `git commit` — and never through the UI. The web
client could not make that commit anyway; it is a viewer with one write
(file-level staging). That is the point, and the visible cursor now makes it
legible: you can see which things were clicked (a tab, two checkboxes) and,
by contrast, that nothing was clicked to make the changes or the commit appear.

So three claims, and only three, because sixteen seconds does not fit more:

1. It **keeps up by itself** as you work.
2. You can review an **unpushed** branch like a pull request.
3. Work you have not committed folds into that same review — and stops being
   folded in the moment it is committed.

If the daemon ever stops watching, these beats record nothing happening — which
is the correct outcome for a demo of a feature that broke.

## The pieces

| file | what it does |
| --- | --- |
| `fixture.sh` | Builds the demo repo (`/tmp/diffstalker-demo/relay`) from scratch |
| `record.sh` | Xvfb → daemon → Chrome → ffmpeg, and cues the choreography |
| `choreograph.ts` | Drives the take over CDP: the pauses, scrolls and keystrokes |
| `encode.sh` | `raw.mkv` → MP4, GIF and a poster frame |

`out/` is gitignored. The scripts are the source of truth; re-run them.

## Why it is scripted

A hand-piloted demo has to be re-shot every time a beat lands wrong, and it
never lands the same way twice. Here every take is the same take. Concretely:

- **The repo is a fixture, not a real project.** A real repo leaks paths and
  private code, its diffs change under you, and its history is not shaped like
  the story. The fixture's commits are dated relative to now, so the UI shows
  plausible "2 hours ago" rather than a frozen date, and it is left with a
  **clean working tree** — the changes in the video are written by the take.
- **The fixture has an `origin`.** Compare discovers its base by scanning
  history for remote-tracking refs, so a repo with only local branches has no
  base and the view opens with nothing to compare. The remote URL is
  unreachable on purpose; only the ref matters.
- **The cursor is a real X pointer.** `xdotool` moves it on the virtual
  display and ffmpeg composites it in (`-draw_mouse 1`). CDP's
  `Input.dispatchMouseEvent` will not do: it delivers events to the page
  without moving the pointer X draws, so the recording shows things being
  clicked with no cursor anywhere near them.
- **Click targets are resolved from the DOM, never hardcoded.** `centreOf()`
  asks the page for an element's rect and converts it to screen coordinates,
  so a re-layout moves the pointer with it. Hardcoded pixels would silently
  start clicking the wrong thing.
- **Scrolling is a hand-written rAF tween.** `scrollTo({behavior:'smooth'})`
  picks its own duration, so a beat that runs long desynchronises every beat
  after it.
- **Display prefs are seeded before the first render.** Theme, syntax
  highlighting and diff layout live in `localStorage`, so without seeding, the
  take looks different on a profile that had been used before.

## Tunables

```bash
DEMO_THEME=light scripts/demo/record.sh    # default: dark
WIDTH=1600 HEIGHT=1000 FPS=30 scripts/demo/record.sh
SKIP_BUILD=1 scripts/demo/record.sh        # dist/ is already current

GIF_START=12 GIF_DURATION=20 scripts/demo/encode.sh   # a tighter README loop
GIF_WIDTH=800 GIF_FPS=12 scripts/demo/encode.sh       # a smaller one
```

`SKIP_BUILD=1` is worth using: a full rebuild rewrites every package's `dist`,
and if this repo sits under a running daemon's `watchRoots`, that is a burst of
file events for whatever UI is open.

## Editing the choreography

The beats are a plain list at the bottom of `choreograph.ts` — a label and
something to await. Add, reorder or retime them there; the labels print with
their timestamps as the take runs, so you can see which beat drifted.

## Gotchas worth knowing

- **`--app` needs a real URL.** Chrome rejects `--app=about:blank` and falls
  back to a normal window, putting a tab strip and an address bar on camera.
- **Do not signal ffmpeg twice.** A second signal makes it abandon the trailer,
  leaving a file no player will open.
- **The driver exits explicitly.** Its stdin listener keeps the event loop
  alive, so without `process.exit(0)` the take looks like it hangs at the end.
