# render performance strategy — decision record

Scope: the strategy decision requested by issue #31 ("perf: plan render
performance strategy"). The issue body is self-contained (two-cost model,
profiling findings, tooling, non-goals); this doc records the decisions and
the evidence bars, and does not duplicate the issue. No perf code lands with
this doc.

## decision 1 — measurement order

1. **Render-invocation instrumentation first** (issue work item 2, first
   half): a render counter plus an inputs-changed flag, to quantify the idle
   re-render question. Cheapest artifact, answers the highest-leverage
   question, and its result decides which cost to attack.
2. **Keystroke/render replay benchmark second** (issue work item 1): committed
   fixtures (widths, long prompts, insert/normal/EX labels, ANSI labels, wide
   graphemes) and a committed baseline, covering cache hit and miss paths.
3. **Leaf follow-ups measured last** (issue work item 3): `visibleWidth`
   hoisting on the footer path only once the benchmark exists to prove the
   residual cost.

Rationale: structural cost bounds leaf cost — a skipped frame pays zero leaf
cost, while a cheaper leaf still runs every tick. The instrumentation is a
few lines; the benchmark is the expensive artifact and should not be built
around the wrong target.

## decision 2 — which cost to attack first

**Structural (idle re-render short-circuit), not leaf.** The issue's profile
already shows: after PR #20 the pi-vim subtree collapses and identical stacks
repeat on every render-timer tick with unchanged content. If instrumentation
confirms that, a short-circuit eliminates whole frames including their leaf
cost; the reverse is not true.

Hard prerequisite carried over from the issue's non-goals: document
`ModalEditor.render` inputs and side effects first, and split the
cursor-shape sequence write out of the pure render path so a skipped frame
cannot drop a needed escape sequence.

## decision 3 — evidence bars (what triggers implementation)

- **Render short-circuit**: implement only when instrumentation shows that at
  steady-state idle (no input for 10 s, default render timer) more than half
  of render invocations run with the inputs-changed flag false, AND the
  render-input set is documented. Below that bar, defer and re-measure after
  the next host (`pi-tui`/`pi-coding-agent`) upgrade.
- **Footer cache extension** (hoist `visibleWidth(lastLine)` /
  `visibleWidth(rawLabel)` on the hit path): only if the replay benchmark
  attributes a measurable share of frame time (target bar: >5% of the frame
  budget at 80-col/long-prompt fixtures) to those two calls. The issue warns
  the cache key must include label visible width to avoid stale fallback —
  keep that constraint.
- **Measured terminal text in `pi-tui`**: only if repeated measurement is
  still material after both of the above; this is an upstream design
  conversation, not a pi-vim patch.
- **Defer** is the standing default whenever a bar is not met; each deferral
  is recorded on issue #31 per its acceptance criteria.

## packaging constraint (current, measured this run)

`pack:check` headroom is 366 B packed / 355 B unpacked (34634/35000,
149645/150000). Consequences:

- instrumentation and benchmark harness code must live in `script/` or
  `test/` (not packed); only a counter hook small enough to fit the headroom
  may touch `index.ts`, and the issue's non-goal forbids raising the budget
  without fresh `pack:check` output and rationale;
- this reinforces measurement-first: a benchmark in `script/` costs zero
  packed bytes.

## branch triage — perf/last-line-caching

- The branch's only unmerged commit vs main is `40ce74c` "perf: last line
  render caching" (+12/−1 on index.ts).
- Main already contains the same cache, landed by PR #20 (merged
  2026-06-11): compare `lastLineCacheKey/lastLineCacheResult` in `40ce74c`
  with the `lastLineCache = { l, w, label, result }` field of `ModalEditor`
  and the identical key comparison + truncation where `render` truncates the
  last line (search `lastLineCache` in index.ts; line numbers shift with the
  issue #32 modularization). Only field names differ; logic and cached
  expression are the same.
- The branch also predates the `@earendil-works` package rename.
- Recommendation: **archive the branch** (superseded). Archiving is a user
  action via worktree-tending, not this run's.

## status vs issue #31 acceptance criteria

This doc records the "next optimization decision" as: build measurement
(instrumentation, then benchmark), then implement the render short-circuit if
its evidence bar is met, else defer with recorded rationale. The benchmark
command, committed baseline, and idle quantification remain open work items
tracked by issue #31.

## visual-selection correctness patch evidence

`script/visual-render-compare.ts` is the narrow replay benchmark for the visual
selection painter. It uses the public editor surface, accepts a base checkout
through `PIVIM_ENTRY`, warms each fixture for 100 renders, then records nine
2,000-render samples in microseconds per render. The fixtures cover an 80-column
long ASCII selection, an 80-column selection containing repeated ZWJ emoji, a
20-line line-wise selection with cursor/selection ANSI, and a wrapped 32-column
selection.

Measured on Node v24.20.0, Apple arm64, with three alternating base/head runs;
the table reports the median of each run's median. Base is `0ee544e`; head is
`fix/visual-highlight-graphemes`.

| fixture | base µs/render | head µs/render | delta |
| --- | ---: | ---: | ---: |
| `long_ascii_80` | 41.313 | 45.870 | +4.557 (+11.0%) |
| `long_zwj_80` | 44.588 | 48.221 | +3.634 (+8.1%) |
| `multiline_ansi_80` | 68.104 | 78.113 | +10.009 (+14.7%) |
| `wrapped_ascii_32` | 41.385 | 44.401 | +3.016 (+7.3%) |

The largest absolute increase is 0.0101 ms per visual-mode render, under 0.07%
of a 16.67 ms frame budget. The branch accepts that bounded cost to keep the
render walk grapheme-safe while matching Pi's reverse-video transcript
selection. Normal and insert rendering return before this path.

Reproduce against a nested base worktree so both entries reuse this checkout's
dependencies:

```sh
git worktree add --detach .tmp/visual-highlight-base 0ee544e
for round in 1 2 3; do
  PIVIM_ENTRY=.tmp/visual-highlight-base/index.ts \
    node --import tsx/esm script/visual-render-compare.ts \
    > "/tmp/pi-vim-render-base-$round.json"
  node --import tsx/esm script/visual-render-compare.ts \
    > "/tmp/pi-vim-render-head-$round.json"
done
node <<'NODE'
const fs = require("fs");
const fixtures = [
  "long_ascii_80",
  "long_zwj_80",
  "multiline_ansi_80",
  "wrapped_ascii_32",
];
const median = (values) =>
  [...values].sort((left, right) => left - right)[
    Math.floor(values.length / 2)
  ];
for (const fixture of fixtures) {
  const medians = (side) =>
    [1, 2, 3].map(
      (round) =>
        JSON.parse(
          fs.readFileSync(`/tmp/pi-vim-render-${side}-${round}.json`),
        ).metrics[fixture].medianUs,
    );
  const base = median(medians("base"));
  const head = median(medians("head"));
  const delta = head - base;
  console.log({ fixture, base, head, delta, percent: (delta / base) * 100 });
}
NODE
git worktree remove .tmp/visual-highlight-base
rm -f /tmp/pi-vim-render-{base,head}-{1,2,3}.json
```
