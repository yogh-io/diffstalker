# Feature review, 0.9.0

Why diffstalker is not growing new features right now, what was considered, and
what would change that. Written 2026-08-02, after a deliberate search for
missing features found mostly missing correctness instead.

Read this before starting a feature. It exists so the same ground does not get
re-covered, and so a future decision to build something is made against what was
already weighed rather than from scratch.

## 1. What was done

The project has one real user. That means the ordinary stream of feature
requests never arrives, so the usual signal for what to build next is absent.
Two structured searches were run to substitute for it.

**A gap hunt.** What is obviously in the tool's wheelhouse that a broader user
base would have asked for by now? Seven lenses — comparable tools, first-run
experience, scale and repo diversity, accessibility, deployment, workflow fit,
trust and recovery — each hunting independently, then every candidate checked
against the code to confirm it was genuinely absent.

**A capability hunt.** The journal is the one thing here that no comparable tool
has: a continuous, hunk-granular record of change over time, with lineage. What
does that make possible that a snapshot tool structurally cannot do? Six angles,
then a pass over prior art to find what had already been tried elsewhere.

Both reports were kept. They are not in the repo — see §7.

## 2. What came out of it, and what shipped

The gap hunt returned defects more than features. That is a real result rather
than a failed search: the filter asked for holes in what the tool already claims
to be, and holes of that shape are usually bugs.

Shipped from it:

- Two diff-parser bugs. The `\ No newline at end of file` marker consumed a line
  number on both sides, so every line after it in the hunk was off by one in
  every view, and split view lost its column alignment. Mode changes were parsed
  as file content, so a `chmod +x` rendered two fake lines numbered from zero.
- An unmerged path reported as an ordinary modified file, with staging offered
  on it — and `git add` on an unmerged path is how you tell git the conflict is
  resolved.
- An untracked file read whole with no size cap. One 405 MB file drove a single
  call to 919 MB resident.
- A refusal message erased by the next state-change, so the reason a click
  failed was wiped fastest by the event that most often caused it.
- Journal timestamps that lost the day, on a daemon with no idle timeout.
- An unknown CLI flag silently reinterpreted as a repo path; `~` refused with
  the wrong reason; the daemon accepting no repo path; neither binary answering
  `--version`.

Separately, a named pipe appearing in a watched tree froze the whole daemon
under bun. Found while reviewing something else, fixed, and it was never a
feature question.

Those were worth doing because the tool was stating things that were false.
Everything that survived after them is improvement, and improvement is where
this review says stop.

## 3. Why nothing further is being built

Four reasons, in the order they actually decided it.

**The journal is deliberately ephemeral, and features built on it inherit
that.** The capability hunt found real unique ground — a hunk's rewrite count,
work that was written and taken back, what moved while you were away. All of it
reads the in-memory journal, which holds roughly the last one to three hours and
dies with the daemon. The report treated that as a ceiling to be removed by
persisting to disk. That is the wrong goal. The journal is a live scratch view;
if it evaporates, nothing was lost that should have been relied on, and anyone
who would mind is using git wrongly. Persisting it would turn a deliberate
property into a storage problem, complete with retention policy, a byte budget
across repos, and worktree content — including reverted content, sometimes
secrets — written to disk outside git.

That property then argues against the features too. A signal on permanent chrome
that speaks or stays silent depending on daemon uptime is inconsistent by
construction, and an unreliable indicator in a place you look constantly is
worse than no indicator.

**The conventional gaps have cheap in-app workarounds.** The two most defensible
were expanding context around a hunk and an ignore-whitespace toggle. Both are
table stakes elsewhere. But this tool already has an Explorer and a view-file
button one click away in the same app, which is most of what expanding context
buys — and the reason it costs more in GitHub is a page load this tool does not
have. Ignore-whitespace matters in proportion to how much reformatting churn a
setup produces, which is a property of the user's toolchain, not of diffstalker.

**Absence of felt pain is weak evidence in general, but not here.** One user not
missing a feature usually says little. It says more when the workaround is one
click away in the same window: that combination is why these never surfaced, and
it is a reasonable basis for leaving them.

**Nothing outstanding is urgent.** The items that were, are fixed and shipped.

## 4. Considered and deliberately not built

Kept here so the same ideas do not get re-proposed as though they were new.

> **Update, 2026-08-05: the §6 trigger fired for search.** The author asked for
> workspace search, which is the "real users arrive" trigger applied to the one
> user there is. `docs/search-design.md` records the whole decision. What it
> changes here:
>
> - **Built:** the changed-set filter (listed below as "filtering or sorting the
>   changed-file set") shipped as bare `/`. Bare `e` expands the diffs the size
>   gate withholds, which is a mount fix, not a feature.
> - **Lifted from the rejected list:** repo-wide content search, and in-file
>   symbol search. Both are planned in §10 of the search doc, neither is built
>   yet.
> - **Still rejected, and re-confirmed:** workspace symbol search,
>   find-references, go-to-definition, search and replace, the pickaxe
>   (`git log -S`/`-G`), a command palette, cross-repo search, saved searches,
>   search history, regex or DSL query modifiers, an in-app find-in-diff, a
>   query in the URL, and configurable keybindings.
>
> Lifting two rejections does not open the rest. Everything else in this
> document still needs its own trigger.

Conventional viewer features, judged real but not worth it now: expanding
context around a hunk; an ignore-whitespace toggle; marking a file as seen;
filtering or sorting the changed-file set; bounding a very large changeset with a
collapse-all; widening Compare's base picker beyond remote branches.

Journal-derived features, judged real and unique but resting on an ephemeral
store: the hunk header as a time object with a rewrite count; unseen-since-you-
last-looked; bracketing a burst of activity as one reviewable unit; marking
reverted work in place.

Rejected on the boundary rather than on merit: commit and other git mutations
from the browser; conflict resolution of any kind; desktop notifications; a
cross-repo journal or dashboard; a free-text revspec box; a journal query
language; an onboarding wizard; a plugin system; anything AI-powered.

Rejected because the prior art is a graveyard: a scrubbable time axis over the
worktree, and reconstructing a version that was never saved. CMU's Azurite built
the fine-grained edit timeline with selective undo, published it twice, evaluated
it on two users, and it died. `magit-wip-mode` has auto-committed the worktree
for a decade and the only interface anyone built on it is a log.

Rejected on principle, and this one is a standing rule rather than a judgement
call: anything that measures the person instead of describing the code. No
time-on-task, no edit rates, no session totals, no churn scores. There is no
actor field in the journal schema and none should be added. The copy rule that
keeps the whole family on the right side of this is to state a timestamp and
never a duration — `since 14:02`, never `away for 43 minutes`.

## 5. Known broken, deliberately deferred

Not fixed, and a real defect rather than a missing feature:

- **Combined diffs are unparsed.** `git show` on a merge commit emits
  `diff --cc`, `mode 100644,100644..100644` and `@@@ -1,1 -1,1 +1,1 @@@`. The
  first two fall through to the context branch — the same bug class as the mode
  lines fixed in 0.9.0 — and `@@@` reaches the hunk branch but `parseHunkHeader`
  returns null, so line counters keep running from the previous hunk. Merge
  commits in History therefore render with wrong line numbers. Fixing it needs
  real support for two-column content lines, which is why it was not folded into
  the parser batch.
- **Word-diff pairing across a no-newline marker** in the web row builder was
  fixed, but the equivalent path in the CLI was not re-checked.
- **Conflicted paths still emit two status entries**, one staged and one not.
  Collapsing them to one ripples into `fileCategories` index math, which CLI list
  navigation depends on. It belongs with the fuller conflict UI, not before it.

## 6. What would change this

Revisit when one of these actually happens, not on a schedule.

- **Real users arrive.** A single bug report or feature request from someone else
  outweighs everything in this document, because it is evidence and this is
  inference.
- **The author's own toolchain changes.** Format-on-save alongside an assistant
  that reindents would make ignore-whitespace matter within a week.
- **A repo shape breaks something.** A monorepo, a several-hundred-file
  changeset, or heavy submodule use would each turn a deferred item urgent. The
  scale findings in the gap report are the place to look first.
- **The journal stops being ephemeral for some other reason.** If persistence
  ever arrives for a different purpose, the four journal features become
  available and should be re-read then.
- **Merge commits start mattering.** The combined-diff defect above is the one
  known-wrong thing left.

## 7. The reports

Both were produced outside the repo and are not checked in — they are long,
they capture a moment, and their durable conclusions are in this document.
They were written to the session scratchpad:

- the gap hunt: 11 primary findings, 14 second tier, 17 rejected with reasons
- the capability hunt: 4 features, 7 second tier, 10 rejected, plus an honest
  statement of what the journal data cannot answer

If they are gone and the detail is wanted again, the method is reproducible: the
value was in the filters, not the search. Ground the agents in an exhaustive
capability inventory first so nothing already built gets proposed, write the
wheelhouse boundary before any ideas exist so it cannot be bent to fit one, and
make the verification pass default to rejecting. State plainly which parts are
evidence and which are inference about users who do not exist yet.
