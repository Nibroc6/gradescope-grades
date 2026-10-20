// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, compute, parseFormula, evaluate, parseReply } = require('../grading.js');

const item = (name, earned, possible, extra = {}) =>
  ({ name, earned, possible, graded: earned != null, submitted: earned != null, pastDue: true, ...extra });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const run = (raw, items) => compute(items, normalize(raw).cfg);

test('formula language', () => {
  const v = n => ({ A: 0.8, 'B c': 0.5 })[n];
  close(evaluate(parseFormula('30%*{A} + 0.7*{B c}'), v), 0.59);
  close(evaluate(parseFormula('max({A}, {B c}) - -1'), v), 1.8);
  close(evaluate(parseFormula('if({A} >= 0.8, 1, 2) + clamp(5, 0, 1) + avg(1, 2, 3)'), v), 4);
  close(evaluate(parseFormula('(1 + 2) * 3 / 9'), v), 1);
  assert.throws(() => parseFormula('foo(1)'), /unknown function/);
  assert.throws(() => parseFormula('1 +'), /unexpected end/);
  assert.throws(() => parseFormula('(1'), /expected "\)"/);
  assert.throws(() => normalize({ categories: [{ name: 'A', weight: 1 }], formula: '{B}' }), /unknown category: B/);
});

test('weighted average re-normalizes over graded categories', () => {
  const r = run({ categories: [
    { name: 'HW', weight: 40, patterns: ['hw'] },
    { name: 'Exam', weight: 60, patterns: ['exam'] },
  ] }, [item('HW 1', 9, 10), item('HW 2', null, null)]);
  close(r.current, 0.9);
  close(r.gradedShare, 0.4);
});

test('keep best N, drop, cap', () => {
  const items = [item('Q1', 2, 10), item('Q2', 8, 10), item('Q3', 12, 10)];
  close(run({ categories: [{ name: 'Q', weight: 100, keep: 2, patterns: ['q'] }] }, items).current, 1.0);
  close(run({ categories: [{ name: 'Q', weight: 100, keep: 2, cap: 95, patterns: ['q'] }] }, items).current, 0.95);
  close(run({ categories: [{ name: 'Q', weight: 100, drop: 5, patterns: ['q'] }] }, items).current, 1.2); // keeps one
  assert.equal(items[0].note, 'dropped');
});

test('final replaces lowest midterm only when higher', () => {
  const raw = { categories: [
    { name: 'Midterms', weight: 50, mode: 'average', replaceLowestWith: 'Final', patterns: ['midterm'] },
    { name: 'Final', weight: 50, patterns: ['final'] },
  ] };
  const items = [item('Midterm 1', 60, 100), item('Midterm 2', 90, 100), item('Final', 40, 50)];
  const r = run(raw, items);
  close(r.cats[0].score, 0.85); // 60% replaced by 80%
  close(r.current, 0.825);
  assert.match(items[0].note, /replaced by Final/);
  const low = run(raw, [item('Midterm 1', 60, 100), item('Final', 10, 50)]);
  close(low.cats[0].score, 0.6);
  // A typed-in score for a category with nothing on Gradescope also replaces.
  close(run({ ...raw, manual: { Final: 95 } }, [item('Midterm 1', 60, 100), item('Midterm 2', 90, 100)]).cats[0].score, 0.925);
});

test('completion credit: submitted = 100%, missed = 0, upcoming ignored', () => {
  const r = run({ categories: [{ name: 'Ex', weight: 100, completion: true, patterns: ['ex'] }] }, [
    item('Ex 1', null, null, { submitted: true }),
    item('Ex 2', null, null, { submitted: false, pastDue: true }),
    item('Ex 3', null, null, { submitted: false, pastDue: false }),
    item('Ex 4', 1, 2),
  ]);
  close(r.current, 0.5); // (1 + 0 + 0.5) / 3
  assert.equal(r.cats[0].count, 3);
});

test('manual score for a category not on Gradescope', () => {
  const r = run({ categories: [
    { name: 'HW', weight: 50, patterns: ['hw'] },
    { name: 'Attendance', weight: 50 },
  ], manual: { Attendance: 100 } }, [item('HW 1', 8, 10)]);
  close(r.current, 0.9);
});

test('formula: better of two schemes, ungraded categories stand in for the average', () => {
  const raw = { categories: [
    { name: 'HW', weight: 30, patterns: ['hw'] },
    { name: 'Midterm', weight: 30, patterns: ['midterm'] },
    { name: 'Final', weight: 40, patterns: ['final'] },
  ], formula: 'max(30%*{HW} + 30%*{Midterm} + 40%*{Final}, 30%*{HW} + 70%*{Final})' };
  close(run(raw, [item('HW 1', 9, 10), item('Midterm', 5, 10), item('Final', 8, 10)]).current, 0.83);
  // Final not graded yet: solves g = max(.27 + .15 + .4g, .27 + .7g). Scheme B ignores the weak midterm, so g = .9.
  close(run(raw, [item('HW 1', 9, 10), item('Midterm', 5, 10)]).current, 0.9);
});

test('bonus category with ifUngraded 0 adds nothing until graded', () => {
  const raw = { categories: [
    { name: 'HW', weight: 100, patterns: ['hw'] },
    { name: 'Bonus', weight: 0, ifUngraded: 0, patterns: ['bonus'] },
  ], formula: '{HW} + 2%*{Bonus}' };
  close(run(raw, [item('HW 1', 9, 10)]).current, 0.9);
  close(run(raw, [item('HW 1', 9, 10), item('Bonus', 1, 1)]).current, 0.92);
});

test('parseReply: code fences, surrounding prose, curly quotes, trailing commas', () => {
  const want = { categories: [{ name: 'HW', weight: 100, patterns: ['^hw\s*\d+'] }], notes: 'it’s fine' };
  const json = JSON.stringify(want, null, 2);
  assert.deepEqual(parseReply('Here you go:\n```json\n' + json + '\n```\nLet me know {if} anything.'), want);
  assert.deepEqual(parseReply(json), want);
  const smart = json.replace(/"/g, (_, i) => (i % 2 ? '”' : '“')).replace(/\]\n}/, '],\n}');
  assert.deepEqual(parseReply(smart), want);
  assert.throws(() => parseReply('no json here'), /No JSON object/);
});
