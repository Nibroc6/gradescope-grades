// Nibroc's Gradescope Grades: weighted grade panel for Gradescope student course pages.
(() => {
  'use strict';

  const api = globalThis.browser ?? globalThis.chrome;
  const match = location.pathname.match(/^\/courses\/(\d+)\/?$/);
  const table = document.querySelector('#assignments-student-table');
  if (!match || !table || document.querySelector('.gg-panel')) return;

  const courseId = match[1];
  const STORE_KEY = `course:${courseId}`;
  const { EXCLUDE, normalize, compute, parseReply } = GGGrading;
  const courseName = document.querySelector('.courseHeader--title')?.textContent.trim() || `Course ${courseId}`;
  const term = document.querySelector('.courseHeader--term')?.textContent.trim() || '';

  // ---------- scraping ----------

  function scrape() {
    const items = [];
    for (const tr of table.querySelectorAll('tbody tr')) {
      const th = tr.querySelector('th');
      if (!th) continue;
      const link = th.querySelector('a, button');
      const name = (link ?? th).textContent.trim();
      if (!name) continue;
      let earned = null, possible = null;
      const scoreText = tr.querySelector('.submissionStatus--score')?.textContent ?? '';
      const s = scoreText.match(/(-?[\d.]+)\s*\/\s*([\d.]+)/);
      if (s) { earned = parseFloat(s[1]); possible = parseFloat(s[2]); }
      const status = tr.querySelector('.submissionStatus--text')?.textContent.trim() ?? '';
      // The last due-date <time> is the late deadline when there is one. Format: "2026-10-23 23:59:00 -0400".
      const due = [...tr.querySelectorAll('time.submissionTimeChart--dueDate')].pop()?.getAttribute('datetime');
      const dueAt = due ? Date.parse(due.replace(' ', 'T').replace(/ ([+-]\d\d)(\d\d)$/, '$1:$2')) : NaN;
      items.push({
        tr, th, name, earned, possible,
        graded: s != null,
        submitted: s != null || /^submitted/i.test(status),
        pastDue: dueAt < Date.now(),
      });
    }
    return items;
  }

  // ---------- storage ----------

  // Pull the first JSON object out of an AI reply (tolerates prose and ``` fences around it).
  async function load() {
    const got = await api.storage.local.get(STORE_KEY);
    return got[STORE_KEY] ?? null;
  }

  async function save(cfg) {
    await api.storage.local.set({ [STORE_KEY]: cfg });
  }

  // ---------- AI prompt ----------

  function buildPrompt(items, syllabus) {
    const lines = items.map(it => `- ${it.name}${it.graded ? ` (out of ${it.possible})` : ''}`).join('\n');
    const syl = syllabus.trim()
      ? `Syllabus:\n<<<\n${syllabus.trim()}\n>>>`
      : 'The syllabus is attached (or at the path/URL I give alongside this prompt).';
    return `I want to compute my weighted grade in a course on Gradescope. Read the grading policy in the syllabus and classify the course's Gradescope assignments.

Course: ${courseName}${term ? ` (${term})` : ''}

Reply with one JSON object inside a single \`\`\`json code block, and nothing else. Use only straight ASCII double quotes ("), never curly quotes. The object must have exactly this shape:

{
  "categories": [
    { "name": "Homework", "weight": 30, "mode": "points", "drop": 1, "patterns": ["^homework\\\\s*\\\\d+"] },
    { "name": "Midterms", "weight": 40, "mode": "average", "replaceLowestWith": "Final Exam", "patterns": ["midterm|exam\\\\s*[12]"] },
    { "name": "Final Exam", "weight": 30, "patterns": ["final"] }
  ],
  "assignments": { "Homework 1": "Homework", "Course survey": "__exclude" },
  "formula": "",
  "notes": "..."
}

Category fields (only name, weight and patterns are required):
- name: short category name from the syllabus grading breakdown. No curly braces.
- weight: percent of the final grade (0 for a bonus category that only appears in the formula).
- mode: "points" = total points earned / total points possible; "average" = every assignment counts equally regardless of its point value. Default "points".
- drop: number of lowest scores dropped. keep: alternatively, count only the best N ("best 10 of 12 quizzes" is keep 10).
- cap: maximum category score in percent, e.g. 100 if extra credit inside the category can't push it over 100%.
- completion: true if work counts as full credit just for being submitted (participation, in-class exercises). Submitted-but-ungraded items then count 100%, and past-due unsubmitted items count 0.
- replaceLowestWith: name of another category whose score replaces this category's single lowest score when higher ("the final exam replaces your lowest midterm").
- ifUngraded: percent to assume for this category while it has no scores. Use 0 for bonus/extra-credit categories; otherwise omit it (an ungraded category then counts as the student's current average).
- patterns: JavaScript regular expressions (matched case-insensitively against the Gradescope assignment name) that identify the category, general enough to also catch assignments that haven't been posted yet. Escape backslashes for JSON.

Top-level fields:
- assignments: map EVERY Gradescope assignment listed below, by its exact name, to a category name, or to "__exclude" if it doesn't count toward the grade (practice, surveys, ungraded check-ins, etc.).
- formula: leave "" when the final grade is just the weighted sum of the categories. Otherwise, write an expression for the final grade as a fraction, using {Category Name} for a category's score (a fraction, 0.9 = 90%), numbers (30% is allowed and means 0.3), + - * / ( ), comparisons < > <= >= == != (true = 1, false = 0), and functions min, max, avg, clamp(x, lo, hi), if(cond, a, b). Examples:
  - better of two schemes: "max(30%*{Homework} + 30%*{Midterm} + 40%*{Final}, 30%*{Homework} + 70%*{Final})"
  - final counts in place of the midterm if higher: "30%*{Homework} + 30%*max({Midterm}, {Final}) + 40%*{Final}"
  - up to 2% extra credit on top: "40%*{Homework} + 60%*{Exams} + 2%*{Bonus}" (give Bonus "weight": 0 and "ifUngraded": 0)
  - must average 50% on exams to pass: "if({Exams} >= 0.5, 40%*{Homework} + 60%*{Exams}, min(0.59, 40%*{Homework} + 60%*{Exams}))"
- notes: one or two sentences on anything still not captured (e.g. curves, attendance policies, letter-grade cutoffs).

Include every category in the grading breakdown, even ones with no Gradescope assignments yet (the student can type in those scores). If items within one syllabus category carry different weights (Exam 1 15%, Exam 2 20%), make them separate categories. Prefer category fields over a formula when they can express the rule.

Gradescope assignments:
${lines}

${syl}`;
  }

  // ---------- UI helpers ----------

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v != null) e.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null) e.append(c);
    return e;
  }

  const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
  const pct = x => (x == null ? '—' : `${round(x * 100)}%`);

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = el('textarea', {}, text);
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    const old = button.textContent;
    button.textContent = 'Copied!';
    setTimeout(() => (button.textContent = old), 1500);
  }

  function modal(title, ...body) {
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    const overlay = el('div', { class: 'gg-overlay', onclick: e => e.target === overlay && close() },
      el('div', { class: 'gg-modal', role: 'dialog', 'aria-label': title },
        el('div', { class: 'gg-modal-head' },
          el('h2', {}, title),
          el('button', { class: 'gg-x', 'aria-label': 'Close', onclick: close }, '×')),
        ...body));
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    return close;
  }

  function messageBox() {
    const box = el('div', { class: 'gg-msg' });
    box.show = (text, kind = 'info') => { box.className = `gg-msg gg-msg-${kind}`; box.textContent = text; };
    return box;
  }

  // ---------- main ----------

  const items = scrape();
  let cfg = null;
  const panel = el('section', { class: 'gg-panel', 'aria-label': 'Weighted grade' });
  (table.closest('.dataTables_wrapper') ?? table).before(panel);

  async function applyConfig(newCfg) {
    cfg = newCfg;
    if (cfg) await save(cfg); else await api.storage.local.remove(STORE_KEY);
    render();
  }

  function describe(c) {
    const parts = [c.completion ? 'completion credit' : c.mode === 'average' ? 'equal weight' : 'by points'];
    if (c.keep != null) parts.push(`best ${c.keep}`);
    if (c.drop) parts.push(`drop ${c.drop}`);
    if (c.replaceLowestWith) parts.push(`lowest replaced by ${c.replaceLowestWith} if higher`);
    if (c.cap != null) parts.push(`capped at ${c.cap}%`);
    if (c.ifUngraded != null) parts.push(`${c.ifUngraded}% until graded`);
    return parts.join(', ');
  }

  function render() {
    let r;
    try {
      r = compute(items, cfg);
    } catch (e) {
      panel.replaceChildren(el('p', { class: 'gg-warn' }, `Couldn't compute the grade: ${e.message}`),
        el('button', { class: 'gg-btn', onclick: openEditor }, 'Edit weights'));
      return;
    }
    panel.replaceChildren();

    const head = el('div', { class: 'gg-head' });
    if (cfg && r.current != null) {
      const pending = r.cats.filter(c => c.score == null && c.ifUngraded == null).length;
      head.append(
        el('div', { class: 'gg-big' }, pct(r.current)),
        el('div', { class: 'gg-sub' },
          cfg.formula
            ? `Grade so far from the formula; ${pending} ungraded categor${pending === 1 ? 'y counts' : 'ies count'} as this average`
            : `Weighted over the categories with grades so far (${pct(r.gradedShare)} of the course)`,
          el('br'),
          `Raw points, unweighted: ${pct(r.raw)}`));
    } else {
      head.append(
        el('div', { class: 'gg-big' }, pct(r.raw)),
        el('div', { class: 'gg-sub' }, cfg ? 'Nothing graded in a weighted category yet. Showing raw points.'
          : 'Raw points (all assignments). Set up the syllabus weighting for a real grade.'));
    }
    head.append(el('div', { class: 'gg-actions' },
      el('button', { class: 'gg-btn gg-primary', onclick: openAiSetup }, cfg ? 'Redo with AI' : 'Set up weights with AI'),
      el('button', { class: 'gg-btn', onclick: openEditor }, cfg ? 'Edit weights' : 'Enter manually'),
      cfg && el('button', { class: 'gg-btn', onclick: exportConfig }, 'Export')));
    panel.append(head);

    if (cfg) {
      panel.append(el('table', { class: 'gg-cats' },
        el('thead', {}, el('tr', {}, ['Category', 'Weight', 'Score', 'Counted', 'Rule'].map(h => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, r.cats.map(c => el('tr', { class: c.score == null ? 'gg-muted' : '' },
          el('td', {}, c.name),
          el('td', {}, `${round(c.weight)}%`),
          el('td', {}, c.count ? pct(c.score) : manualInput(c)),
          el('td', {}, c.dropped ? `${c.count} (${c.dropped} dropped)` : String(c.count)),
          el('td', {}, describe(c)))))));
      if (cfg.formula) {
        panel.append(el('p', { class: 'gg-formula' }, 'Final grade = ', el('code', {}, cfg.formula)));
      }
      if (cfg.notes) panel.append(el('p', { class: 'gg-notes' }, cfg.notes));
      if (r.unclassified.length) {
        panel.append(el('p', { class: 'gg-warn' },
          `${r.unclassified.length} assignment${r.unclassified.length > 1 ? 's' : ''} not in any category (highlighted below). `
          + 'Pick a category from its dropdown; your choice is remembered.'));
      }
    }
    decorateRows();
  }

  // Categories with nothing on Gradescope (attendance, labs graded elsewhere) take a typed-in score.
  function manualInput(c) {
    const input = el('input', {
      type: 'number', step: 'any', min: 0, class: 'gg-manual', placeholder: 'enter',
      'aria-label': `Score for ${c.name} in percent`, title: 'Not on Gradescope: type your score here',
      value: cfg.manual[c.name] ?? null,
      onchange: () => {
        const manual = { ...cfg.manual };
        if (input.value === '') delete manual[c.name]; else manual[c.name] = Number(input.value);
        applyConfig({ ...cfg, manual });
      },
    });
    return el('span', { class: 'gg-manual-wrap' }, input, '%');
  }

  function decorateRows() {
    for (const it of items) {
      it.th.querySelector('.gg-row')?.remove();
      it.tr.classList.toggle('gg-unclassified', !!cfg && it.category == null);
      it.tr.classList.toggle('gg-dropped', it.note === 'dropped');
      if (!cfg) continue;
      const select = el('select', { class: 'gg-select', 'aria-label': `Category for ${it.name}`,
        onchange: e => setOverride(it.name, e.target.value) },
        el('option', { value: '' }, '— uncategorized —'),
        cfg.categories.map(c => el('option', { value: c.name }, c.name)),
        el('option', { value: EXCLUDE }, "Doesn't count"));
      select.value = it.category ?? '';
      it.th.append(el('div', { class: 'gg-row' }, select, it.note ? el('span', { class: 'gg-tag' }, it.note) : null));
    }
  }

  async function setOverride(name, value) {
    const overrides = { ...cfg.overrides };
    if (value) overrides[name] = value; else delete overrides[name];
    // "Uncategorized" only sticks if no import mapping or pattern would categorize it anyway.
    await applyConfig({ ...cfg, overrides });
  }

  function openAiSetup() {
    const syllabus = el('textarea', { class: 'gg-ta', rows: 6,
      placeholder: 'Optional: paste the syllabus grading section here, or leave blank and attach the syllabus in the AI chat.' });
    const reply = el('textarea', { class: 'gg-ta', rows: 8, placeholder: "Paste the AI's JSON reply here." });
    const msg = messageBox();
    const copyBtn = el('button', { class: 'gg-btn gg-primary',
      onclick: () => copyText(buildPrompt(items, syllabus.value), copyBtn) }, 'Copy prompt');
    const close = modal('Set up weights with AI',
      el('ol', { class: 'gg-steps' },
        el('li', {}, el('strong', {}, 'Copy the prompt. '),
          'It lists this course\'s Gradescope assignments and asks for the weighting as JSON.', syllabus, copyBtn),
        el('li', {}, el('strong', {}, 'Ask an AI. '),
          'Paste it into Claude (or any chat assistant) with the syllabus PDF attached. With Claude Code, run this in PowerShell '
          + 'after copying (add the syllabus path to the box above first) and the reply lands on your clipboard:',
          el('code', { class: 'gg-code' }, 'Get-Clipboard -Raw | claude -p | Set-Clipboard')),
        el('li', {}, el('strong', {}, 'Paste the reply and import. '), reply,
          el('button', { class: 'gg-btn gg-primary', onclick: doImport }, 'Import'))),
      msg);

    async function doImport() {
      try {
        const { cfg: next, warnings } = normalize(parseReply(reply.value));
        // Keep manual overrides that still point to a category in the new weighting.
        const names = new Set(next.categories.map(c => c.name));
        for (const [k, v] of Object.entries(cfg?.overrides ?? {})) {
          if (v === EXCLUDE || names.has(v)) next.overrides[k] = v;
        }
        await applyConfig(next);
        if (warnings.length) msg.show(`Imported with warnings:\n${warnings.join('\n')}`, 'warn');
        else close();
      } catch (e) {
        msg.show(e.message, 'error');
      }
    }
  }

  function openEditor() {
    const blank = { categories: [{ name: 'Homework', weight: 40, drop: 0, mode: 'points', patterns: ['homework'] },
      { name: 'Exams', weight: 60, drop: 0, mode: 'points', patterns: ['exam|midterm|final'] }], assignments: {}, overrides: {}, notes: '' };
    const ta = el('textarea', { class: 'gg-ta gg-mono', rows: 20 }, JSON.stringify(cfg ?? blank, null, 2));
    const file = el('input', { type: 'file', accept: '.json,application/json', class: 'gg-hidden',
      onchange: async () => { if (file.files[0]) ta.value = await file.files[0].text(); } });
    const msg = messageBox();
    const close = modal('Edit weights (JSON)',
      el('p', { class: 'gg-help' },
        '"assignments" is the AI\'s classification; "overrides" holds your dropdown picks and wins over it. '
        + 'Anything matching neither is classified by the first category whose "patterns" regex matches.'),
      ta, file,
      el('div', { class: 'gg-actions' },
        el('button', { class: 'gg-btn gg-primary', onclick: doSave }, 'Save'),
        el('button', { class: 'gg-btn', onclick: () => file.click() }, 'Load file…'),
        cfg && el('button', { class: 'gg-btn gg-danger', onclick: doReset }, 'Remove weighting')),
      msg);

    async function doSave() {
      try {
        const { cfg: next, warnings } = normalize(parseReply(ta.value));
        await applyConfig(next);
        if (warnings.length) msg.show(`Saved with warnings:\n${warnings.join('\n')}`, 'warn');
        else close();
      } catch (e) {
        msg.show(e.message, 'error');
      }
    }

    async function doReset() {
      await applyConfig(null);
      close();
    }
  }

  function exportConfig() {
    const blob = new Blob([JSON.stringify({ course: courseName, term, ...cfg }, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `${courseName.replace(/[^\w-]+/g, '_')}-weights.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  load().then(stored => {
    if (stored) {
      try { cfg = normalize(stored).cfg; } catch { cfg = null; }
    }
    render();
  });
})();
