# Nibroc's Gradescope Grades (Firefox)

Adds a panel to each Gradescope course page (`gradescope.com/courses/<id>`) showing:

- your **weighted grade** across the syllabus categories that have grades so far,
- a per-category breakdown (weight, score, how many graded, dropped scores),
- your raw unweighted points total (shown even before any weighting is set up),
- a category dropdown under every assignment. Uncategorized ones are highlighted.

## Setting up a course's weighting

1. On the course page click **Set up weights with AI** → **Copy prompt**. The prompt contains the
   course's assignment names and asks for the grading policy as JSON. You can paste the syllabus
   grading section into the box first, or attach the syllabus in the chat instead.
2. Paste it into Claude (or any assistant) with the syllabus.
   With Claude Code, you can skip the chat window entirely. Put the syllabus file path in the box before copying, then run
   `Get-Clipboard -Raw | claude -p | Set-Clipboard` in PowerShell.
3. Paste the reply back and click **Import**. Code fences and surrounding prose are fine.

### How assignments are classified (and cached)

In order:

1. **overrides**: your picks from the per-row dropdown. They are saved per course and kept when you re-import.
2. **assignments**: the AI's explicit name → category map from the import.
3. **patterns**: each category's regexes, which the AI writes to also catch assignments posted later.

Anything that matches none of these is highlighted, and you pick its category once. Everything is saved in the
extension's local storage. There is no server, and nothing leaves the browser.

**Edit weights** opens the raw JSON (and can load a file). **Export** saves it so classmates can use it via
**Edit weights → Load file…**.

### Grading model

Per category (the AI fills these in; all optional except `name`/`weight`/`patterns`):

| field | meaning |
|---|---|
| `mode` | `"points"` (Σ earned / Σ possible, default) or `"average"` (each assignment equal) |
| `drop` / `keep` | drop the N lowest, or count only the best N (at least one score is always kept) |
| `cap` | max category score in %, e.g. `100` |
| `completion` | submitted-but-ungraded counts 100%, past-due unsubmitted counts 0 |
| `replaceLowestWith` | another category whose score replaces this one's lowest score when higher (e.g. final → lowest midterm) |
| `ifUngraded` | % to assume until something is graded (`0` for bonus categories) |

Categories with nothing on Gradescope get a box in the panel where you can type your score. This also works for what-ifs,
like "what if I get 85% on the final?".

`formula` (optional) replaces the plain weighted sum for anything else. It's an expression over `{Category}` scores
with `+ - * /`, `30%`-style numbers, comparisons, and `min max avg clamp if`, e.g.
`max(30%*{HW} + 30%*{Midterm} + 40%*{Final}, 30%*{HW} + 70%*{Final})`.

"Grade so far": ungraded categories count as your current grade. In other words, it solves g = formula(…, ungraded = g). For a
plain weighted sum that's exactly the average over the graded categories. It's how you're doing so far, not a
projected final.

Tests for the grading engine: `node --test test/grading.test.js`.

## Install

- **Try it**: `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* → pick `manifest.json`
  (removed when Firefox restarts).
- **Keep it**: sign it as an unlisted add-on on addons.mozilla.org (`npx web-ext sign --channel unlisted`
  with AMO API keys), then install the resulting `.xpi`. Firefox Developer Edition/Nightly can instead
  set `xpinstall.signatures.required` to `false` and install the unsigned `.xpi` directly.

Requires Firefox 140+.
