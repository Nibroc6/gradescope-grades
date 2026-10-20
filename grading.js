// Grading engine: config validation, the formula language and grade computation.
// No DOM access, so it also loads in Node for tests (see test/grading.test.js).
var GGGrading = (() => {
  'use strict';

  const EXCLUDE = '__exclude';

  // ---------- formula language ----------
  // Expressions over category scores as fractions (0.93 = 93%): {Category Name}, numbers (30% means 0.3),
  // + - * / ( ), comparisons (1 or 0), and the functions below.

  const FUNCS = {
    min: (...a) => Math.min(...a),
    max: (...a) => Math.max(...a),
    avg: (...a) => a.reduce((x, y) => x + y, 0) / a.length,
    clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
    if: (c, a, b) => (c ? a : b),
  };

  function tokenize(src) {
    const re = /(\d+(?:\.\d+)?|\.\d+)(%?)|\{([^{}]+)\}|([A-Za-z_]\w*)|(<=|>=|==|!=|[-+*/(),<>])/y;
    const tokens = [];
    let i = 0;
    while (i < src.length) {
      if (/\s/.test(src[i])) { i++; continue; }
      re.lastIndex = i;
      const m = re.exec(src);
      if (!m) throw new Error(`Formula: unexpected "${src.slice(i, i + 12)}"`);
      if (m[1]) tokens.push({ t: 'num', v: parseFloat(m[1]) / (m[2] ? 100 : 1) });
      else if (m[3]) tokens.push({ t: 'cat', v: m[3].trim() });
      else if (m[4]) tokens.push({ t: 'id', v: m[4] });
      else tokens.push({ t: 'op', v: m[5] });
      i = re.lastIndex;
    }
    return tokens;
  }

  function parseFormula(src) {
    const toks = tokenize(src);
    let p = 0;
    const isOp = (...ops) => toks[p]?.t === 'op' && ops.includes(toks[p].v);
    const expect = v => {
      if (!isOp(v)) throw new Error(`Formula: expected "${v}"${toks[p] ? ` before "${toks[p].v}"` : ' at the end'}`);
      p++;
    };
    const binary = (next, ...ops) => () => {
      let a = next();
      while (isOp(...ops)) { const op = toks[p++].v; a = { t: 'bin', op, a, b: next() }; }
      return a;
    };
    const primary = () => {
      const tk = toks[p++];
      if (!tk) throw new Error('Formula: unexpected end');
      if (tk.t === 'num') return { t: 'num', v: tk.v };
      if (tk.t === 'cat') return { t: 'cat', name: tk.v };
      if (tk.t === 'id') {
        const fn = tk.v.toLowerCase();
        if (!(fn in FUNCS)) throw new Error(`Formula: unknown function "${tk.v}"`);
        expect('(');
        const args = [];
        if (!isOp(')')) {
          args.push(cmp());
          while (isOp(',')) { p++; args.push(cmp()); }
        }
        expect(')');
        return { t: 'call', fn, args };
      }
      if (tk.v === '(') { const e = cmp(); expect(')'); return e; }
      throw new Error(`Formula: unexpected "${tk.v}"`);
    };
    const unary = () => (isOp('-') ? (p++, { t: 'neg', a: unary() }) : primary());
    const mul = binary(unary, '*', '/');
    const add = binary(mul, '+', '-');
    const cmp = binary(add, '<', '>', '<=', '>=', '==', '!=');
    const ast = cmp();
    if (p < toks.length) throw new Error(`Formula: unexpected "${toks[p].v}"`);
    return ast;
  }

  function evaluate(n, value) {
    switch (n.t) {
      case 'num': return n.v;
      case 'cat': return value(n.name);
      case 'neg': return -evaluate(n.a, value);
      case 'call': return FUNCS[n.fn](...n.args.map(a => evaluate(a, value)));
      case 'bin': {
        const a = evaluate(n.a, value), b = evaluate(n.b, value);
        switch (n.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return a / b;
          case '<': return +(a < b);
          case '>': return +(a > b);
          case '<=': return +(a <= b);
          case '>=': return +(a >= b);
          case '==': return +(Math.abs(a - b) < 1e-9);
          case '!=': return +(Math.abs(a - b) >= 1e-9);
        }
      }
    }
    throw new Error(`Formula: bad node ${n.t}`);
  }

  function catRefs(n, out = new Set()) {
    if (n.t === 'cat') out.add(n.name);
    for (const k of ['a', 'b']) if (n[k]) catRefs(n[k], out);
    for (const a of n.args ?? []) catRefs(a, out);
    return out;
  }

  // ---------- config ----------

  // Stored shape:
  // { categories: [{ name, weight, mode, drop, keep, cap, completion, replaceLowestWith, ifUngraded, patterns }],
  //   assignments: {name: cat}, overrides: {name: cat}, formula, manual: {cat: percent}, notes }
  // `assignments` comes from the AI import; `overrides` are the user's dropdown picks and survive re-imports.

  const optNumber = (v, ok) => (v == null || v === '' || !Number.isFinite(Number(v)) || !ok(Number(v)) ? null : Number(v));

  function normalize(raw) {
    const warnings = [];
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.categories)) {
      throw new Error('Expected a JSON object with a "categories" array.');
    }
    const categories = [];
    for (const c of raw.categories) {
      if (!c || typeof c.name !== 'string' || !c.name.trim()) { warnings.push('Skipped a category with no name.'); continue; }
      const name = c.name.trim();
      if (name === EXCLUDE || /[{}]/.test(name) || categories.some(x => x.name === name)) {
        warnings.push(`Skipped duplicate/invalid category "${name}".`);
        continue;
      }
      const weight = Number(c.weight ?? 0);
      if (!Number.isFinite(weight) || weight < 0) throw new Error(`Category "${name}" has an invalid weight.`);
      const patterns = [];
      for (const p of Array.isArray(c.patterns) ? c.patterns : []) {
        try { new RegExp(p, 'i'); patterns.push(String(p)); } catch { warnings.push(`Dropped invalid pattern ${JSON.stringify(p)} in "${name}".`); }
      }
      const completion = c.completion === true;
      // Completion items have no real point values, so those categories are always averaged per assignment.
      if (completion && c.mode === 'points') warnings.push(`"${name}" uses completion credit, so it is averaged per assignment.`);
      const mode = completion || c.mode === 'average' ? 'average' : 'points';
      const keep = optNumber(c.keep, x => x >= 1);
      const drop = Math.max(0, Math.floor(Number(c.drop) || 0));
      if (keep != null && drop) warnings.push(`"${name}" has both keep and drop; using keep.`);
      categories.push({
        name,
        weight,
        mode,
        drop: keep != null ? 0 : drop,
        keep: keep != null ? Math.floor(keep) : null,
        cap: optNumber(c.cap, x => x > 0),
        completion,
        replaceLowestWith: typeof c.replaceLowestWith === 'string' && c.replaceLowestWith.trim() ? c.replaceLowestWith.trim() : null,
        ifUngraded: optNumber(c.ifUngraded, () => true),
        patterns,
      });
    }
    if (!categories.length) throw new Error('No usable categories found.');
    const names = new Set(categories.map(c => c.name));
    for (const c of categories) {
      if (c.replaceLowestWith && (!names.has(c.replaceLowestWith) || c.replaceLowestWith === c.name)) {
        warnings.push(`"${c.name}": replaceLowestWith "${c.replaceLowestWith}" isn't another category; ignored.`);
        c.replaceLowestWith = null;
      }
    }
    const cleanMap = (m, label) => {
      const out = {};
      for (const [k, v] of Object.entries(m && typeof m === 'object' ? m : {})) {
        if (v === EXCLUDE || names.has(v)) out[k] = v;
        else warnings.push(`${label}: "${k}" points to unknown category "${v}"; ignored.`);
      }
      return out;
    };

    const formula = typeof raw.formula === 'string' ? raw.formula.trim() : '';
    if (formula) {
      const unknown = [...catRefs(parseFormula(formula))].filter(n => !names.has(n));
      if (unknown.length) throw new Error(`Formula refers to unknown categor${unknown.length > 1 ? 'ies' : 'y'}: ${unknown.join(', ')}`);
    } else {
      const total = categories.reduce((a, c) => a + c.weight, 0);
      if (total <= 0) throw new Error('All weights are 0 and there is no formula.');
      if (Math.abs(total - 100) > 0.01) warnings.push(`Weights add up to ${Math.round(total * 100) / 100}, not 100; they will be scaled.`);
    }

    const manual = {};
    for (const [k, v] of Object.entries(raw.manual && typeof raw.manual === 'object' ? raw.manual : {})) {
      const n = optNumber(v, () => true);
      if (names.has(k) && n != null) manual[k] = n;
    }

    return {
      cfg: {
        categories,
        assignments: cleanMap(raw.assignments, 'assignments'),
        overrides: cleanMap(raw.overrides, 'overrides'),
        formula,
        manual,
        notes: typeof raw.notes === 'string' ? raw.notes : '',
      },
      warnings,
    };
  }

  // Pull the JSON object out of an AI reply: tolerates prose and ``` fences around it, and, if strict parsing
  // fails, curly quotes and trailing commas (chat apps "smarten" quotes outside code blocks).
  function parseReply(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const t = fenced ? fenced[1] : text;
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('No JSON object found in the pasted text.');
    const json = t.slice(start, end + 1);
    try {
      return JSON.parse(json);
    } catch (e) {
      try {
        return JSON.parse(json.replace(/[“”„‟″]/g, '"').replace(/,(\s*[}\]])/g, '$1'));
      } catch {
        throw new Error(`Couldn't parse JSON: ${e.message}`);
      }
    }
  }

  // ---------- grading ----------

  function classify(name, cfg) {
    if (!cfg) return null;
    if (name in cfg.overrides) return cfg.overrides[name];
    if (name in cfg.assignments) return cfg.assignments[name];
    for (const c of cfg.categories) {
      if (c.patterns.some(p => new RegExp(p, 'i').test(name))) return c.name;
    }
    return null;
  }

  const frac = e => (e.possible > 0 ? e.earned / e.possible : null);

  // The scores that count toward a category. Completion categories also count ungraded work:
  // submitted = full credit, past due with no submission = 0.
  function entriesFor(c, items) {
    const out = [];
    for (const it of items) {
      if (it.category !== c.name) continue;
      if (it.graded) out.push({ it, earned: it.earned, possible: it.possible, note: null });
      else if (c.completion && it.submitted) out.push({ it, earned: 1, possible: 1, note: 'assumed full credit' });
      else if (c.completion && it.pastDue) out.push({ it, earned: 0, possible: 1, note: 'missing, counts 0' });
    }
    return out;
  }

  function scoreCategory(c, entries) {
    // Drop the lowest percentages (or keep only the best N), always leaving at least one. Extra credit (0 possible) stays.
    const ranked = entries.filter(e => e.possible > 0).sort((a, b) => frac(a) - frac(b));
    const n = Math.max(0, Math.min(c.keep != null ? ranked.length - c.keep : c.drop, ranked.length - 1));
    const dropped = new Set(ranked.slice(0, n));
    for (const e of dropped) e.note = 'dropped';
    const kept = entries.filter(e => !dropped.has(e));
    let score = null;
    if (c.mode === 'average') {
      const fs = kept.map(frac).filter(f => f != null);
      if (fs.length) score = fs.reduce((a, b) => a + b, 0) / fs.length;
    } else {
      const p = kept.reduce((a, e) => a + e.possible, 0);
      if (p > 0) score = kept.reduce((a, e) => a + e.earned, 0) / p;
    }
    if (score != null && c.cap != null) score = Math.min(score, c.cap / 100);
    return { score, dropped: dropped.size };
  }

  // The grade so far: categories without scores stand in for the grade itself, i.e. solve g = f(scores, missing = g).
  // For a weighted average this is exactly the average re-normalized over the graded categories; it also gives
  // sensible answers for max(...) schemes and other formulas.
  function solveSoFar(f, scores) {
    const known = [...scores.values()].filter(v => v != null);
    let g = known.reduce((a, b) => a + b, 0) / known.length;
    for (let i = 0; i < 2000; i++) {
      const next = f(name => scores.get(name) ?? g);
      if (!Number.isFinite(next)) return null;
      if (Math.abs(next - g) < 1e-12) return next;
      g = next;
    }
    return g;
  }

  // items: [{ name, graded, earned, possible, submitted, pastDue }]. Sets it.category and it.note on each.
  function compute(items, cfg) {
    let earned = 0, possible = 0;
    for (const it of items) {
      it.category = classify(it.name, cfg);
      it.note = null;
      if (it.graded) { earned += it.earned; possible += it.possible; }
    }
    const result = { raw: possible > 0 ? earned / possible : null, cats: [], unclassified: [], current: null };
    if (!cfg) return result;

    const entries = new Map(cfg.categories.map(c => [c.name, entriesFor(c, items)]));
    const manualScore = (c, list) => (!list.length && cfg.manual[c.name] != null ? cfg.manual[c.name] / 100 : null);
    // First pass: plain category scores, which replaceLowestWith reads.
    const base = new Map(cfg.categories.map(c => {
      const list = entries.get(c.name);
      return [c.name, manualScore(c, list) ?? scoreCategory(c, list.map(e => ({ ...e }))).score];
    }));

    for (const c of cfg.categories) {
      const list = entries.get(c.name);
      const sub = c.replaceLowestWith ? base.get(c.replaceLowestWith) : null;
      if (sub != null) {
        const lowest = list.filter(e => e.possible > 0).reduce((lo, e) => (!lo || frac(e) < frac(lo) ? e : lo), null);
        if (lowest && sub > frac(lowest)) {
          lowest.earned = sub * lowest.possible;
          lowest.note = `replaced by ${c.replaceLowestWith} (${Math.round(sub * 1000) / 10}%)`;
        }
      }
      let { score, dropped } = scoreCategory(c, list);
      const manual = manualScore(c, list) != null;
      if (manual) score = manualScore(c, list);
      for (const e of list) e.it.note = e.note;
      result.cats.push({ ...c, score, dropped, manual, count: list.length });
    }

    result.unclassified = items.filter(it => it.category == null);
    const totalWeight = cfg.categories.reduce((a, c) => a + c.weight, 0);
    result.gradedShare = totalWeight > 0
      ? result.cats.filter(c => c.score != null).reduce((a, c) => a + c.weight, 0) / totalWeight
      : null;
    if (!result.cats.some(c => c.score != null)) return result;

    const scores = new Map(result.cats.map(c => [c.name, c.score ?? (c.ifUngraded != null ? c.ifUngraded / 100 : null)]));
    let f;
    if (cfg.formula) {
      const ast = parseFormula(cfg.formula);
      f = value => evaluate(ast, value);
    } else {
      f = value => cfg.categories.reduce((a, c) => a + c.weight * value(c.name), 0) / totalWeight;
    }
    result.current = solveSoFar(f, scores);
    return result;
  }

  return { EXCLUDE, normalize, compute, parseFormula, evaluate, parseReply };
})();

if (typeof module !== 'undefined') module.exports = GGGrading;
