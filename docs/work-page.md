# Work page and PR drafts

Decision document, written 2026-11-23. Amends `docs/feature-review-0.9.0.md`
§4: it lifts "anything that talks to GitHub" (through `gh`) and "a
cross-repo dashboard" (this page, not a journal). See §9 for what stays
rejected.

## 1. The trigger

The author asked for one page that holds all the work he has to keep in
mind, so he can stop keeping it in mind. His workflow:

- Work happens in worktrees, mostly one per branch, mostly in AERIUS repos
  (fork on `origin`, PRs to `upstream`).
- A PR body has two zones (the `/human-pr` skill): his own words on top,
  then `---` and a collapsed AI-written block. He wants to write and
  rewrite the top zone in diffstalker, before the PR exists and after.
- Claude Code sessions are not part of diffstalker. They read his drafts
  and fill in their own part, through files.
- He does no bookkeeping. The page finds the work by itself. At most he
  confirms ("Track") or hides ("Dismiss") what it found.

This is the §6 "the author asks" trigger.

Two parts:

1. **The Work page** at `/work`, opened by clicking the diffstalker wordmark.
2. **PR drafts**: three files per branch in the repo's git dir, edited from
   the Work page (and from a panel in Compare) and shared with agents.

Round 2, the same day, after the first look at the page with 45 open PRs
on it: real columns, rows grouped by repo, a colour and progress icon per
stage, review state, CI, stacks, the last activity, grouping by repository
and by time, sorting by column, one click to the PR, a fold-out per row with the activity and the
draft editor, and one write to GitHub: "Update GitHub" (§3.6). The first
version was read-only by rule; the author asked for that button.

## 2. Hard rules

- **diffstalker changes a pull request in one way only: "Update GitHub".**
  It reads PR state with `gh`. The one write replaces the top zone of an
  open PR's body with `top.md` and keeps everything from the `---` line
  down as GitHub has it. It runs only when the author clicks the button and
  confirms with a second click, never on its own (§3.6). diffstalker never
  creates, comments on, closes or merges a PR, and never changes its title
  or its lower zone. Until round 2 this rule said "never changes a pull
  request"; the author lifted it for this button.
- **The author's words and agent words live in different files.** The
  daemon writes `top.md` only from the author's typing (or an explicit
  "start from this" click). It never writes `top.suggested.md` or `ai.md`.
  Agents never write `top.md`.
- **No background work.** The page scans when it is opened and when the
  refresh button is pressed. No polling, no timers, no watchers for repos
  nobody is looking at (CLAUDE.md, "Daemon-side managers and events").
- **Nothing measures the person** (`docs/feature-review-0.9.0.md` §4): no
  "away for", no time on task, no totals. An item's time says how long ago
  something happened to a piece of work (`3 days 12 hours ago`, the date
  and time on hover), as History and Compare already do for commits. The
  gh line keeps a clock time (`PRs checked 14:02`).

## 3. PR drafts

### 3.1 Where

```
<git-common-dir>/diffstalker/pr/<branch>/
  top.md            the author's zone. Written by the daemon only.
  top.suggested.md  an agent's suggestion or placeholder. Agents only.
  ai.md             everything below the `---`. Agents only.
  adopted           sha256 (hex) of the text "start from this" copied. Daemon only.
```

An agent finds it with:

```bash
d="$(git rev-parse --path-format=absolute --git-common-dir)/diffstalker/pr/$(git branch --show-current)"
```

Why the common git dir: it is shared by every worktree of the repo and is
never committed. A worktree's own git dir (`<common>/worktrees/<name>`) is
deleted with the worktree, and a draft must outlive the worktree (the PR
outlives it). Why keyed by branch: a PR belongs to a branch, and a branch is
checked out in at most one worktree. Why not `branch.<name>.description`
(git's own slot, used by `format-patch --cover-letter`): it lives in
`.git/config`, so a markdown body is stored escaped and an agent has to edit
it through `git config`. Plain files are what agents handle best.

The branch name is used as a relative path, so `feature/x` nests as
`pr/feature/x/`. Before any read or write the daemon checks the name with
the same ref-shape check `?base=` uses. That check only refuses an empty
name and a leading `-`, so the daemon also checks the name as a path: no
empty, `.` or `..` component, no component that starts with `.` or ends in
`.lock`, no backslash, no control character. Then it checks that the
resolved directory is inside `<common>/diffstalker/pr/`, symlinks resolved.
A branch name with a component equal to one of the four file names above is
refused (a 400), since a directory would collide with a file.

The daemon's git-dir watcher already skips everything in the common dir
except `info/` and `refs/` (`WorkingTreeManager.watchGitDirs`), so writing
drafts never triggers a git refresh. §6 adds a separate, narrow watch.

### 3.2 The body

The PR body is composed as:

```
<top.md, trimmed>

---
<ai.md, trimmed>
```

When `ai.md` is missing or empty, the body is `top.md` alone. `ai.md` holds
the whole `<details>` block exactly as it goes on GitHub; the skill owns that
format. The composition is one pure function (`core/view/prBody.ts`), used by
the web preview, and the skill follows the same rule.

### 3.3 Placeholders

`{{...}}` on one line, with something inside, marks a gap to fill:
`{{why nginx and not caddy?}}`. Pattern: `/\{\{[^{}\n]+\}\}/g`.

- Anyone may write one: an agent in a suggestion, the author in his own
  text as a note to self.
- diffstalker counts them, highlights them in the preview, and the Work
  page shows `2 placeholders` on the item.
- `/human-pr` refuses to create a PR while `top.md` has one.

Why not an HTML comment: GitHub hides comments, so a placeholder that slipped
through would be invisible in the published body. `{{ }}` renders as typed.

### 3.4 Suggestions

When an agent drafts the top zone (because the author asked), it writes
`top.suggested.md`. In Compare:

- `top.md` empty and a suggestion present: the suggestion shows greyed and
  labelled "agent suggestion", with a **start from this** button.
- **start from this** copies the suggestion into `top.md` and writes its
  sha256 to `adopted`. While `sha256(top.md)` equals `adopted`, the editor
  shows "agent text, not edited". The first edit clears the marker (the
  `adopted` file stays, it just no longer matches).
- `top.md` not empty and a suggestion present: the suggestion shows below
  the editor, collapsed, for reference. No merge, no replace button. The
  author copies what he wants.

diffstalker never edits or deletes `top.suggested.md` or `ai.md`. They show
read-only.

### 3.5 "Edited since submitted"

For a branch with an open PR and a `top.md`: take the PR body from GitHub,
cut it at the first line that is exactly `---` followed (after optional blank
lines) by a line starting with `<details>`; without such a line the whole
body is the top zone. Normalize line endings (`\r\n` to `\n`) and trim both
sides. If they differ, the panel says **Your words differ from the PR on
GitHub** and offers the two buttons of §3.6. No stored hash: the live body
is the truth.

### 3.6 Syncing with GitHub

- **Open PR, no `top.md`:** the editor starts with the PR's top zone,
  marked "From the PR on GitHub. Saved as top.md once you edit." Nothing is
  written until the author types. It starts so once per load: an editor
  the author cleared stays clear.
- **Take GitHub's text:** reads that one PR fresh (`POST /repos/:id/pr/check`),
  then saves its top zone as `top.md` through the normal save (§6).
- **Update GitHub:** asks once more ("Replace the top zone of PR #9087 on
  GitHub with your words? The part below the line stays as it is."), then
  `POST /repos/:id/pr/top` with `{ branch, version, expectedTop }`:
  `version` is the `top.md` it was shown, `expectedTop` is GitHub's top
  zone it was shown. The daemon sends `top.md` from disk, never text from
  the request. It refuses, writing nothing:

  | Why | Status |
  | --- | --- |
  | `top.md` changed since it was shown | 409 |
  | `top.md` is empty | 422 |
  | `top.md` has a `{{...}}` placeholder (also greyed out in the panel) | 422 |
  | no PR is known for the branch | 404 |
  | the PR is not open | 409 |
  | GitHub's top zone is not `expectedTop`: someone changed it since | 409 |

  Otherwise it reads the PR fresh, builds the body with `replaceTopZone`
  (`core/view/prBody.ts`: `top.md`, a blank line, then GitHub's own body
  from the `---` line on), and sends GraphQL `updatePullRequest` with it.
  The cached PR becomes GitHub's answer, so the flag clears. On a 409 the
  panel reads the PR again, so it shows GitHub's text as it is now.
- The preview under the editor shows, for an open PR, the body "Update
  GitHub" would make, not the one composed from `ai.md`.

## 4. GitHub through `gh`

### 4.1 The queries

`gh search prs` does not return the head branch, which is what links a PR to
a worktree. GraphQL search does. The daemon runs, with `execFile` and no
shell:

```
gh api graphql -f query=<fixed query string> -f q=<fixed search>
```

for three searches, as three requests side by side: `is:pr author:@me
is:open`, `is:pr author:@me is:closed sort:updated-desc` (closed includes
merged), and `is:pr is:open review-requested:@me` (PRs the author is asked
to review, read with the open search's fields; their `reviewRequested` is
true). In one request the first two passed GitHub's 10 s limit and came
back as HTTP 502.
The closed search has no date window: an old closed PR is how the page
knows a branch is finished (§5.2). **No value from a request ever becomes a
`gh` argument.** Variables go in with `-f` (raw text), never `-F`, which
reads `@file`. A page cursor comes from GitHub's own answer and is
shape-checked before it is passed back. Per PR: `number title url state
isDraft merged mergedAt closedAt updatedAt headRefName headRefOid
headRepositoryOwner{login} repository{nameWithOwner} author{login}`, plus
`viewer{login}`.
Both read `baseRefName` (for stacks). The open search also reads `body`
(only an open PR's body is compared with a draft, §3.5, so a closed PR's
`body` is null) and its progress (`PrProgress`, null for a closed PR):
`reviewDecision`, `mergeable` (conflicts), the requested reviewers (the
first 20: logins, `team:<slug>` for a team, and the total), the reviewers
whose latest approving-or-not review asks for changes
(`latestOpinionatedReviews`),
the last 20 reviews and 20 comments, the first 100 review threads
(resolved or not, and each one's last comment), and the head commit's
`statusCheckRollup`. From those it keeps the open-thread count and the
newest 10 events by people: a review (`approved`, `changes requested`,
`reviewed`) or a comment. Bots (`__typename` `Bot`: SonarCloud, Amplify)
and deleted accounts are left out; a review and its inline comments in the
same minute count once per kind.

Two more queries, both with their variables as JSON on stdin (`gh api
graphql --input -`), so not even GitHub's own values go in as arguments:
one PR by owner, name and number (with its node `id`), and the one write,
`updatePullRequest { pullRequestId, body }` (§3.6). Paged, at most 300 PRs per
search (the author has 45 open today). The closed search always reaches
that cap once the author has 300 closed PRs, so only a capped open search
sets `capped`. Timeout 20 s.

### 4.2 Errors

| What happened | `status` | The page says |
| --- | --- | --- |
| `gh` not on PATH (`ENOENT`) | `gh-missing` | gh not found — PR state unknown |
| exit code 4 (auth needed) | `gh-logged-out` | gh not logged in — PR state unknown |
| any other failure, timeout, bad JSON | `error` | could not reach GitHub: <message> |
| never asked yet | `never` | (nothing; the page asks on open) |

Everything that comes from git keeps working in every case. Failures are
logged at `warn` once per refresh. `GET /health` gains `gh: boolean`: the
binary is on PATH (a PATH lookup, no spawn).

### 4.3 Routes and caching

- `GET /work/prs` returns the last snapshot (cached in memory, never
  spawns).
- `POST /work/prs/refresh` runs the query, single-flight (a refresh while
  one runs joins it), and returns the new snapshot.
- A refresh that fails sets the status and message, and keeps the list and
  the `checkedAt` of the last one that worked. The page shows both.
- `GET /repos/:id/pr?branch=<name>` returns the PR for one branch of an
  open repo from that snapshot (never spawns `gh`). The draft panel uses
  it, so opening Compare never runs `gh`.
- `POST /work/repo` with `{ path }` returns one repo's facts (§5.1).
- `POST /repos/:id/pr/check` `{ branch }` reads that branch's PR fresh and
  puts it in the snapshot. A 404 when the snapshot has no PR for it.
- `POST /repos/:id/pr/top` `{ branch, version, expectedTop }`: "Update
  GitHub" (§3.6).

Two of these are POST on purpose. `security.ts` applies its CSRF check to
non-GET requests only. Spawning `gh` sends the author's token over the
network. A repo scan runs git over a whole repo, and as a GET any website
could start scans and time them. Same reasoning as search being POST
(`docs/search-design.md`).

### 4.4 Matching a PR to a repo

- A repo's GitHub identities come from its remotes: every remote URL of the
  form `git@github.com:o/n(.git)`, `ssh://git@github.com/o/n(.git)` or
  `https://github.com/o/n(.git)`. Compared case-insensitively.
- A PR belongs to the repo that has a remote matching
  `repository.nameWithOwner` (the PR's base repo, `aerius/calculator`).
- Its branch is the local branch `headRefName`, when it exists. It is in a
  worktree when that worktree has the branch checked out.
- A PR with no matching repo, or no local branch, is still Work: it shows
  with a link to the PR and the reason (`no local clone`, `no local branch`).

### 4.5 Verified 2026-11-23

- `gh` 2.105.0 at `/usr/bin/gh`. The token is in `~/.config/gh/hosts.yml`,
  not a keyring.
- A transient user unit with the service's sandbox options
  (`ProtectSystem=strict`, `PrivateTmp=yes`, `NoNewPrivileges=yes`) ran
  `gh api graphql` and got the viewer login back. So the systemd daemon
  can run it.
- The GraphQL search returns `headRefName` and `headRepositoryOwner` for
  fork PRs (`JornC` → `aerius/calculator`).
- Limit: `author:@me` is gh's active account only (`JornC`). PRs by a second
  logged-in account (`yogh-io`) do not show. Accepted.
- Round 2: the open search with its progress fields costs 105 rate-limit
  points (of 5,000 an hour) and takes 6 to 8 s on GitHub's side, whatever
  the page size. Open and closed side by side: 344 PRs in 7.2 s.
- `gh api graphql --input -` takes `{ query, variables }` on stdin.

## 5. The Work page

### 5.1 What it scans

Every repo under the watch directories (`daemon.json` `watchRoots`, the same
list the repo picker shows), plus repos open on the daemon. For each repo,
`POST /work/repo` with `{ path: <repo path> }` returns its facts. It is POST
because it runs a full git scan (§4.3). The path must be a discovered or
open repo; anything else is a 404. The page fetches repos with at most 4
requests in flight and fills in as answers arrive.

Per repo (`core/git/workScan.ts`):

- worktrees (`listWorktrees`, which already counts commits ahead of the
  base with the same rule as Compare, cached by HEAD and mainline refs;
  the scan also needs that base's name, which the same cache gains);
- per non-bare worktree: number of uncommitted paths (changed + untracked),
  from `git status --porcelain -z` with optional locks off, the way the
  daemon's own status runs, so a scan never rewrites an index;
- per non-bare worktree: `changedAt`, the newest mtime of its uncommitted
  paths. A plain edit touches neither the index nor HEAD, so without it a
  worktree being edited right now can look months old. At most 200 paths
  are read per worktree, with `lstat`. A deleted file is listed but not on
  disk, so a miss is skipped; any other failure logs one warning;
- local branches with their tips, and for each, whether a remote copy of
  the same name exists on any remote and how many commits are not on it
  (the "pushed" rule of `docs/stacked-compare.md` §3 rule 6);
- the GitHub identities from the remotes (§4.4);
- the drafts under `<common>/diffstalker/pr/`: branch, which files exist,
  `top.md` text, adopted-unedited, newest mtime. The page counts the
  placeholders from the text (`git/` may not import `view/prBody`).

Git work per worktree runs through the same pool size as worktree listing
(8 spawns), so a full scan does not block other requests. The `lstat`s of
one worktree take one slot of that pool too.

### 5.2 The three sections

Classification is one pure function, `core/view/workModel.ts`
(`classifyWork(repos, prs, marks, now)`), run in the browser. The daemon
serves facts; the page decides where they go. One item per branch (or per
detached worktree, or per PR with no local branch).

**Work**: shown without any click.

- a PR by the author that is open;
- a branch with a draft (`top.md` exists and is not empty);
- an item the author tracked.

**Candidates**: plausible work, not yet confirmed.

- a worktree with uncommitted changes;
- a worktree whose branch has commits not on its base;
- a branch with commits not pushed;
- a fresh worktree on a branch that is not its base branch, with nothing in
  it yet (future work: making the worktree is enough to show it);
- an open PR the author is asked to review. It never takes a local branch
  (its head branch name is someone else's choice and would clash with the
  author's), so it shows like a PR with no local branch. **Track** moves it
  to Work. It leaves when the review is no longer asked for.

Candidates are folded by age. A candidate active in the last 14 days
(`CANDIDATE_RECENT_DAYS`), or one that someone waits on (§5.4, the alert),
shows. An older one, or one with no known activity, sits in a collapsed `N older candidates` list right below, with
the same Track and Dismiss buttons. Nothing is dropped. On the author's
machine 290 candidates came out of 87 repos, and only 12 of them were
under a week old. Activity (`WorkActivity`) is the newest of: the
worktree's `changedAt` (§5.1, "files edited"), its index or HEAD mtime
("committed or staged"), the draft's mtime, the newest event by a person on
its PR (§4.1), and the PR's merge or close. The PR's `updatedAt` does not
count: bots comment on every push and kept moving it.

Not shown at all: a branch that is in no worktree and has no PR and no
draft (backups, old experiments). A main worktree that is on its base
branch, clean and not ahead is not work either.

**Done**: a PR merged or closed in the last 7 days, with the date
(`merged 18 Nov`). A leftover worktree shows as a note (`worktree still on
disk`). It leaves after 7 days on its own. No marking done.

**Finished**: after those 7 days the branch is done for good. A local
branch whose PR closed or merged before the window gives no item, in a
worktree or not, with a draft or not, tracked or not. Two things bring it
back. If its tip is not the PR's last commit (`headRefOid`), there is new
work: it is a plain branch with no PR. If the tip is still the PR's last
commit but the worktree has uncommitted changes, these are leftovers: it
is a candidate that keeps its PR, with the state `merged` or `closed` and
the uncommitted count. A draft whose branch is gone is finished the same
way. When several PRs match a branch,
an open one wins, else the newest by `updatedAt`. Only an `ok` PR list that
is not capped can call a branch finished; without one the page does not
guess. The marks of a finished item are pruned like any mark whose item is
gone (§5.3).

Limits: the closed search reads the newest 300 closed PRs, so a branch whose
PR is older than that can come back. A tip that is only behind the PR's
last commit also brings the branch back (GitHub's "Update branch" adds a
commit the local branch does not have).

### 5.3 Marks

The only state the page keeps. `$XDG_STATE_HOME/diffstalker/work.json`,
written atomically like `daemon.json`, owned by the daemon:

```ts
interface WorkMarks {
  tracked: Record<string, { at: number }>;
  dismissed: Record<string, { fingerprint: string; at: number }>;
}
```

- **Track** (candidates): moves the item to Work.
- **Dismiss** (any item): hides it while its fingerprint is unchanged. The
  fingerprint is the branch tip, whether there are uncommitted changes, and
  the draft's newest mtime for a local item (the head and whether there are
  changes for a detached worktree), and `updatedAt` for a PR with no local
  branch. Something new happening brings it back. Whether, not how many: a
  repo whose changes keep moving (one of the author's has 15,274 untracked
  files) would otherwise come back after every dismiss.
- **Drop** (tracked items): removes the track mark.

Keys: `<repo path>\n<branch>`, `<worktree path>` for a detached worktree,
`pr:<owner>/<name>#<number>` for a PR with no local branch. `PUT
/work/marks` takes `{ key, action: 'track' | 'dismiss' | 'drop' | 'undismiss',
fingerprint?, prune? }` and returns the marks; `GET /work/marks` reads them.
Marks whose item no longer exists are pruned when the file is next written.
Only the page knows which items exist, so it sends their keys as `prune`,
and only after a scan where every repo and the PR query answered.

### 5.4 One row

Every section is one CSS grid with one shared column template, and each row
is a subgrid of it, so the columns line up across rows and sections. One
line per row; nothing wraps (long text ends in `…`, the tooltip has all of
it). Inside a section the rows sit under a heading per repo, the repo with
the newest item first; a PR stack's layers sit together, bottom first.

A click on a column heading sorts the rows inside each repo by that column;
the sections and the repo headings stay where they are. A second click
reverses, a third goes back to the default order. A row with no value for
the column goes last either way. Not stored.

Tooltips are not the native `title`: `HoverTip.vue`, one element for the
whole app, shows a `data-tip` at once, just above the pointer, and follows
it.

| Column | Shows |
| --- | --- |
| Stage | five progress pips, the row's colour (left edge), and a red alert when someone waits on the author (below) |
| Branch | the branch, a red `conflicts` label when GitHub says the PR has merge conflicts (`mergeable: CONFLICTING`), then the PR title, dimmed |
| Stack | `3/8`: the layer and the size of the PR stack |
| PR | `#9087`, a link to GitHub: one click |
| Review | approved, changes requested, or waiting; open review threads |
| CI | the head commit's checks: passed, failed or running |
| Local | uncommitted and unpushed counts, or why there is no local copy |
| Draft | `top.md` exists (dimmed while agent text is not edited), placeholders, differs from GitHub |
| Status | where it stands and whose move it is (below); bold when it is the author's |
| When | how long ago the last activity was (`3 days 12 hours ago`, two units at most); on hover what it was, who did it, and the date and time; bold in the last day. Re-rendered every 30 s |
| (buttons) | Track for a candidate, Compare, open the fold-out |

Stage (`WorkStage`), first match wins:

| Stage | When | Pips | Colour |
| --- | --- | --- | --- |
| `merged` / `closed` | the PR is merged / closed | 5 / 0 | purple / dim |
| `draft` | open PR with GitHub's draft flag | 3 | teal |
| `changes` | open PR, changes requested | 4 | red |
| `approved` | open PR, approved | 5 | green |
| `review` | any other open PR | 4 | yellow |
| `gone` | state `branch gone` | 0 | red |
| `pushed` | state `pushed, no PR` | 2 | blue |
| `local` | anything else | 1 | dim |

Stack: an open PR whose base branch is another open PR's head in the same
repo is a layer. Position 1 is the bottom, the layer that merges into
something that is no PR; the size counts the open PRs that walk down to the
same bottom. PR stacks only: a stack that exists only locally, before it is
submitted, is not detected.

The alert (`WorkAttention`, reasons on hover and at the top of the
fold-out's facts) means someone waits on the author:

- `changes-requested`: the author's open PR, a reviewer whose latest
  review asks for changes, and that reviewer not asked to review again.
  Re-requesting a review does not clear GitHub's `CHANGES_REQUESTED`
  decision; it puts the reviewer back among the requested reviewers, which
  is what clears the alert. Checked against real PRs: #8998 and #8966 were
  re-requested and get none; #755, #9078, #77 and #149 do.
- `review-requested`: the author is asked to review it. Such a row says
  `by <author>`.

Failing CI and conflicts have their own column and label, and no alert.

Status (`workStatus` in `utils/workFormat.ts`), first that applies:

| Status | When | Whose move |
| --- | --- | --- |
| `your review` | the author is asked to review it | the author |
| `merged` / `closed` | the PR is done (`…, leftovers` with uncommitted changes left) | nobody (the author) |
| `draft` | GitHub's draft flag | the author |
| `conflicts` | `mergeable: CONFLICTING` | the author |
| `checks failing` | the head's checks failed | the author |
| `changes requested` | the `changes-requested` alert | the author |
| `approved` | approved; or no decision (a repo that needs no review) and someone else approved | the author (merge) |
| `awaiting re-review` | changes requested, and every reviewer who asked for them is asked again | others |
| `awaiting review` | reviewers asked | others |
| `reviewed, no decision` | someone reviewed with comments only, nobody asked now | the author |
| `needs reviewer` | nobody asked, no reviews | the author |
| `no PR yet` / `not pushed` / `uncommitted` | no PR: pushed / commits on no remote / changes only | the author |
| `nothing yet` / `branch gone` | a fresh worktree / the branch was deleted | nobody |

The local activity kinds read `files edited` (a changed file's mtime) and
`commit, stage or checkout` (the worktree's index or HEAD file moved).

Two toggles in the header group the rows, in every section:

- **By repository** (on by default): a heading per repo, the repo with the
  newest item first.
- **By time** (off by default): a heading per age of the last activity,
  with its count: `Last day` (24 hours), `Last week` (7 days), `Last month`
  (30 days), `Older` (and unknown). A stack's layers may land under
  different headings.

With both on, the repo headings sit inside each time heading; with both
off the section is one plain list. Both are reader preferences in
`prefs.ts` (localStorage).

Beside them, a filter: `All`, `Last day`, `Last week`, `Last month`, each
with how many items it keeps. It uses the same windows as the time
headings and keeps only items with activity in that window, in every
section, with either grouping. It is not stored, so a filter left on
cannot hide work the next time the page opens.

A sort heading's tooltip says what it sorts by and in which order.

On `/work` the view tabs and the view toolbar are gone, and the repo picker
names no repo (`repo`). Picking a repo there leaves the page for it.

The model still has one **state** per item, which decides the stage of an
item without a PR, the Local column and the dismiss fingerprint. State,
first match wins:

| State | When |
| --- | --- |
| `merged` / `closed` | the PR is merged / closed (Done, or a candidate with leftovers, §5.2) |
| `PR open` | open PR (`draft PR` when GitHub's draft flag is set) |
| `pushed, no PR` | remote copy exists, nothing unpushed, no PR |
| `not pushed` | commits not on a remote copy, or no remote copy and ahead of base |
| `uncommitted` | uncommitted changes only |
| `empty` | fresh worktree, nothing yet |
| `branch gone` | a tracked item or draft whose branch no longer exists |

A click on a row opens its fold-out (§5.5). The compare button opens
Compare for it: the worktree when the branch is checked out; otherwise the
main worktree (the newest worktree when the repo is bare) with
`?head=<branch>`. The daemon's `head` already takes any ref, but the
web only took a layer of the stack. So a `head` that is not a layer and does
resolve is now compared against the trunk; one that does not resolve keeps
the `is not a layer of this stack` line. This amends
`docs/stacked-compare.md` §5. A PR with no local branch has no compare
button; its PR number still links to GitHub.

Order: Work, Candidates and the older candidates by newest activity
(§5.2), Done by close date. The page header shows the `gh` line
(`PRs checked 14:02 as JornC`, or the §4.2 notice), the two grouping toggles and a
refresh button.

### 5.5 The fold-out

- **Activity**: the PR's events (§4.1), its merge or close, and the local
  times (files edited, committed or staged, draft edited), newest first, at
  most 8, each with how long ago (the date and time on hover). Someone
  else's in full colour.
- **Facts**: stage, base, stack, review (decision, reviewers asked, open
  threads), checks and conflicts, worktree, uncommitted / unpushed / ahead,
  a note, tracked.
- **Buttons**: Open in Compare, **Copy for a session**, Open #N on GitHub,
  Stop tracking, Dismiss (or Show again). A row with no compare button (a
  PR with no local branch, so every review request) has the copy button on
  the row itself.
- **Copy for a session** puts facts that find the change again on the
  clipboard, one per line, for pasting into an agent session: the PR URL,
  title, author (and whether the author is asked to review it), head branch
  and its owner, base branch and repo, head commit, the local clone (or the
  `git clone` URL when there is none), and the worktree. No command to run:
  diffstalker does not decide how the session checks the change out.
- **The PR draft editor** (§6) for a local branch with a checkout. The
  Work page is the main place to edit drafts. The draft routes need the
  repo open in the daemon, so the fold-out opens it (`POST /repos`, without
  making it the active repo) and releases it (`DELETE /repos/:id`) once its
  last save has settled. It follows no repo stream, so an agent's write
  shows on "check again", a reopen or Refresh, not live.

## 6. The draft panel

The same panel (`PrDraftPanel.vue`) sits in a row's fold-out (§5.5) and in
Compare. The editing (load, save, conflict, adopt, the GitHub side) is one
draft session (`composables/draftSession.ts`) per panel, bound to one repo
and branch; Compare's store picks the branch and feeds it `draft-change`.

- A **PR draft** toggle in Compare's top bar. Shown or hidden is a reader
  preference, so it lives in `prefs.ts` (localStorage), not the URL
  (`useUrlSync`'s ownership test).
- The branch is the picked stack layer's local branch when a layer is
  picked, else HEAD's branch. Detached HEAD, or a layer with only a
  remote-tracking name: the panel says there is no local branch to draft for.
- The panel, top to bottom: the PR line (`PR #9087 open`, link, "check
  again"), the top-zone editor, the GitHub flag and its buttons (§3.5,
  §3.6), the suggestion (§3.4), the AI zone (read-only, collapsed), and a
  raw preview of the body with placeholders highlighted (§3.6 for an open
  PR). "check again" reads that one PR fresh when one is known, else asks
  for every PR.
- Saving: 400 ms after the last keystroke, `PUT /repos/:id/draft` with the
  text and the `version` it was based on. A version mismatch (a second tab
  saved first) is a 409; the panel shows "changed elsewhere" with a reload
  button and keeps the unsaved text in the editor until then. An empty
  editor deletes `top.md` and `adopted` (and the branch's directory when
  nothing is left in it).
- Live updates: an open repo's common-dir watcher also walks
  `diffstalker/pr/` and emits `draft-change { branch, prefix }` for any
  change there, with no git refresh. `prefix` is true when a directory
  changed: then every branch under `branch/` may have a new draft (a file
  written right after `mkdir -p` has no event of its own). The repo SSE
  stream carries it, so it reaches a client only while the repo is viewed;
  the panel re-reads its draft when the branch matches. The daemon's own
  write comes back the same way and is a no-op (same version).

Routes, both API modes (the web needs them; none touches git state):

- `GET /repos/:id/draft?branch=<name>`
- `PUT /repos/:id/draft` `{ branch, top, version }`
- `POST /repos/:id/draft/adopt` `{ branch, version }`
- `GET /repos/:id/pr?branch=<name>` (§4.3)
- `POST /repos/:id/pr/check` `{ branch }` and `POST /repos/:id/pr/top`
  `{ branch, version, expectedTop }` (§3.6). POST: they run `gh`.

Response:

```ts
interface PrDraft {
  branch: string;
  top: string | null;          // null: no top.md
  suggested: string | null;
  ai: string | null;
  adoptedUnedited: boolean;
  version: string;             // opaque; changes whenever top.md changes
}
```

## 7. What changes outside this repo

The skills that write PR bodies (`~/.claude/commands/human-pr.md`, and the
same rule in `trivial-pr` and `stack-pr`):

- read the top zone from `top.md`, not from chat;
- fact-check it (step 4) as today, and report in chat, never in the file;
- when asked to draft or rewrite the top zone, write `top.suggested.md`,
  never `top.md`;
- write the AI zone to `ai.md`, the whole `<details>` block;
- compose the body by §3.2 for `gh pr create --body-file`;
- refuse to create the PR while `top.md` has a `{{...}}`, or when `top.md`
  is empty and only a suggestion exists.

Top-zone text the author types in chat, or passes as the skill's argument,
also goes to `top.suggested.md`, not `top.md`. The author takes it over with
**start from this**. The cost is known and accepted: his own words then show
"agent text, not edited" until he changes a character. Decided 2026-11-23.

These edits were made on 2026-11-23. Round 2 changed one line: "GitHub
body differs from draft" shows until the body is updated, by `gh pr edit`
or by "Update GitHub" in diffstalker.

## 8. Files, by package

- **core**: `types/work.ts` (wire types: repo facts, draft facts,
  `PrDraft`, PR info, PR snapshot, marks), `view/prBody.ts` (compose,
  placeholders, top-zone cut), `view/workModel.ts` (`classifyWork`, keys,
  fingerprints), `utils/githubRemote.ts` (remote URL to owner/name),
  `git/prDraft.ts` (path check, read, atomic write, adopt, list drafts),
  `git/workScan.ts` (per-repo facts), `git/worktree.ts` (the base's name,
  the shared spawn pool), `managers/WorkingTreeManager.ts`
  (`draft-change`), `view/urlGrammar.ts` (`/work`). Tests for each.
- **daemon**: `github.ts` (the `gh` runner, injectable, stdin for the
  one-PR read and the write, single-flight refresh, cache, `checkOne`,
  `setTopZone`), `workMarks.ts` (marks store), `routes/work.ts`,
  `routes/draft.ts` (with `/pr/check` and `/pr/top`; tests in
  `prTop.test.ts`), `routes/health.ts` (`gh`), `server.ts` (register in
  both modes), `index.ts` (the real `gh` runner and the marks file; a
  daemon made without a runner acts as if `gh` were missing), SSE wiring
  for `draft-change`, `README.md` endpoint table.
  Tests: self-contained daemons as usual; the `gh` runner is always a fake.
  No test ever runs the real `gh`.
- **web**: `api/client.ts`, `stores/work.ts`, `stores/draft.ts`,
  `composables/draftSession.ts`, `views/WorkView.vue`,
  `components/WorkRow.vue`, `components/WorkRowDetail.vue`,
  `components/WorkDraftEditor.vue`, `components/WorkIcon.vue`,
  `components/HoverTip.vue` (mounted once in `App.vue`),
  `utils/workFormat.ts`, `components/PrDraftPanel.vue`, `CompareView.vue`
  (toggle + panel), `AppHeader.vue` (the wordmark becomes a link to
  `/work`; no worktree or branch there), `RepoSwitcher.vue` (names no repo
  on `/work`), `App.vue` (render the Work page for `/work`, without the
  view tabs and toolbar),
  `composables/useUrlSync.ts`, `prefs.ts`, `stores/ui.ts` (the page is
  open or not), `stores/repo.ts` (a `head` that is not a layer). Tests for
  stores and components.
- **client / cli**: nothing. The CLI is demoted.
- **docs**: `FEATURES.md`, this document, `feature-review-0.9.0.md`.

## 9. Not built, and still rejected

- **Any other write to GitHub**: creating, commenting, closing, merging,
  the title, the lower zone. The one write is "Update GitHub" (§3.6).
- Background `gh` polling, notifications, a badge in the header.
- A manual "add item" or "mark done". The page finds work; the author only
  tracks or dismisses.
- The text of reviews and comments, replying, resolving threads. The page
  says that something happened and who did it, and links to the PR.
- Stacks that exist only locally, before they are submitted.
- A second GitHub account, GitHub Enterprise hosts, other forges.
- A rendered markdown preview. The preview is the raw body, which is what
  `gh` sends. A renderer is a new dependency for a zone that is plain text
  by the skill's own rule.
- Editing `top.suggested.md` or `ai.md` in diffstalker, and deleting drafts
  in bulk.
- The title. The skill proposes it at PR time.
- Still rejected from `feature-review-0.9.0.md` §4: git mutations from the
  browser, a cross-repo journal, anything AI-powered inside diffstalker,
  anything that measures the person.
