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

The story is the one users actually live: *you built a feature, now review the
whole branch before you push it.* Ten seconds, because it loops in a README:

| at | beat |
| --- | --- |
| 0s | The branch as a review: 4 commits, 4 files, `+118 −1`, against `main` |
| 1.5s | **Tick `unstaged` and `untracked`** — the header goes `4 files` → `6` |
| 3.6s | **A file is written to disk.** Nothing clicks anything; the view refreshes itself and the header goes `6` → `7` |
| 5.6s | Open the file that did not exist when the take started |
| 8.4s | Hold on a stack mixing committed, unstaged and untracked diffs |

Three claims, and only three, because ten seconds does not fit more:

1. You can review an **unpushed** branch like a pull request.
2. Work you have not committed folds into that same review.
3. It **keeps up by itself** as you keep editing.

The third one is why the take writes a real file into the real working tree
instead of poking the UI. The daemon's watcher sees the write, emits a
`state-change`, and the open Compare re-pulls (`stores/repo.ts` refreshes
compare on every state-change, with the flags the view already had). If that
ever stops being true, this beat records nothing happening — which is the
correct outcome for a demo of a feature that broke.

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
  plausible "2 hours ago" rather than a frozen date.
- **The UI is driven through `Runtime.evaluate`, not mouse coordinates.** The
  app's keyboard layer listens on `window`, its rows carry data attributes,
  and `.click()` on a real checkbox fires a real change event. Pixel
  coordinates would break on the next re-layout; these beats do not.
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
