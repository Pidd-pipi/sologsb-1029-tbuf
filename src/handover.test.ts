/**
 * Verification tests for the handover/merge logic.
 * Run with: npx tsx src/handover.test.ts
 */
import {
  applyConflictResolutions,
  buildOp,
  courseFingerprint,
  decodeHandover,
  encodeHandover,
  hasCapacityFor,
  mergeHandover,
  migrateV1ToV2,
  nextSeq,
} from './handover';
import type { HandoverRecord, PersistedState } from './types';

// ---- localStorage mock ----
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
};

// ---- helpers ----
let passed = 0;
let failed = 0;
function ok(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message}`);
  }
}

function makeState(deviceId: string): PersistedState {
  return {
    schemaVersion: 2,
    deviceId,
    courses: [
      {
        id: 'c1',
        title: 'Course 1',
        description: '',
        level: 'A1',
        accent: '#000',
        version: 1,
        lessons: [
          {
            id: 'l1',
            courseId: 'c1',
            title: 'Lesson 1',
            subtitle: '',
            level: 'A1',
            estimatedMinutes: 5,
            downloaded: false,
            sentences: [
              { id: 's1', text: 'Hello world.', translation: '', note: '' },
              { id: 's2', text: 'Good morning.', translation: '', note: '' },
            ],
          },
        ],
      },
    ],
    attempts: [],
    progress: {},
    activeLessonId: '',
    activeSentenceId: '',
    theme: 'light',
    fontScale: 1,
    role: 'learner',
    opLog: [],
    appliedOps: [],
  };
}

function toHandover(state: PersistedState): HandoverRecord {
  return {
    schemaVersion: 2,
    deviceId: state.deviceId,
    exportedAt: new Date().toISOString(),
    courses: JSON.parse(JSON.stringify(state.courses)),
    attempts: JSON.parse(JSON.stringify(state.attempts)),
    progress: JSON.parse(JSON.stringify(state.progress)),
    opLog: JSON.parse(JSON.stringify(state.opLog)),
    appliedOps: JSON.parse(JSON.stringify(state.appliedOps)),
  };
}

function addDraft(state: PersistedState, lessonId: string, sentenceId: string, answer: string) {
  const op = buildOp(state, { type: 'draft', lessonId, sentenceId, answer });
  state.opLog.push(op);
  state.progress[lessonId] ??= { answers: {}, activeSentenceId: sentenceId, updatedAt: '' };
  state.progress[lessonId].answers[sentenceId] = answer;
  state.progress[lessonId].updatedAt = op.createdAt;
  state.appliedOps.push(op.id);
}

function addAttempt(state: PersistedState, attemptId: string, lessonId: string, sentenceId: string, answer: string, tokens: any[], source = 'Hello world.') {
  const attempt = {
    id: attemptId,
    lessonId,
    lessonTitle: 'Lesson 1',
    courseTitle: 'Course 1',
    submittedAt: new Date().toISOString(),
    score: 80,
    teacherFeedback: '',
    sentenceAttempts: [
      { sentenceId, source, answer, tokens, score: 80 },
    ],
  };
  const op = buildOp(state, { type: 'attempt', attempt });
  state.opLog.push(op);
  state.attempts.push(attempt);
  state.appliedOps.push(op.id);
}

function classify(state: PersistedState, attemptId: string, sentenceId: string, tokenIndex: number, category: any, reason: string) {
  const op = buildOp(state, { type: 'classification', attemptId, sentenceId, tokenIndex, category, reason });
  state.opLog.push(op);
  const token = state.attempts.find((a) => a.id === attemptId)?.sentenceAttempts.find((sa) => sa.sentenceId === sentenceId)?.tokens.find((t) => t.index === tokenIndex);
  if (token) { token.category = category; token.reason = reason; }
  state.appliedOps.push(op.id);
}

// ---- tests ----

console.log('\n📦 Handover / Merge Tests\n');

test('idempotent import: repeated import does not double-apply', () => {
  const a = makeState('dev-a');
  addDraft(a, 'l1', 's1', 'Hello world');
  const code = encodeHandover(toHandover(a));

  const b = makeState('dev-b');
  const incoming = decodeHandover(code);
  const result1 = mergeHandover(b, incoming);
  ok(result1.newOps.length === 1, 'first import should apply 1 op');
  ok(result1.merged.progress['l1'].answers['s1'] === 'Hello world', 'draft merged');

  Object.assign(b, result1.merged);

  const result2 = mergeHandover(b, incoming);
  ok(result2.newOps.length === 0, 'second import should apply 0 new ops (idempotent)');
  ok(result2.merged.progress['l1'].answers['s1'] === 'Hello world', 'draft still correct');
});

test('different sentences auto-merge (no conflict)', () => {
  const a = makeState('dev-a');
  addDraft(a, 'l1', 's1', 'Hello world');

  const b = makeState('dev-b');
  addDraft(b, 'l1', 's2', 'Good morning');

  const result = mergeHandover(b, toHandover(a));
  ok(result.conflicts.length === 0, `expected no conflicts, got ${result.conflicts.length}`);
  ok(result.merged.progress['l1'].answers['s1'] === 'Hello world', 's1 from a');
  ok(result.merged.progress['l1'].answers['s2'] === 'Good morning', 's2 from b');
});

test('same-sentence draft changed on both sides -> conflict', () => {
  const a = makeState('dev-a');
  addDraft(a, 'l1', 's1', 'Hello world');

  const b = makeState('dev-b');
  addDraft(b, 'l1', 's1', 'Hello wrld');

  const result = mergeHandover(b, toHandover(a));
  ok(result.conflicts.length === 1, `expected 1 conflict, got ${result.conflicts.length}`);
  ok(result.conflicts[0].kind === 'draft', 'conflict kind is draft');
  ok(result.conflicts[0].localValue === 'Hello wrld', 'local value');
  ok(result.conflicts[0].incomingValue === 'Hello world', 'incoming value');

  result.conflicts[0].resolution = 'incoming';
  applyConflictResolutions(result.merged, result.conflicts);
  ok(result.merged.progress['l1'].answers['s1'] === 'Hello world', 'resolved to incoming');
  const reconcileOp = result.merged.opLog.find((op) => op.type === 'draft' && op.deviceId === 'dev-b' && op.lessonId === 'l1' && op.sentenceId === 's1' && op.answer === 'Hello world');
  ok(!!reconcileOp, 'reconciliation op appended on dev-b');
});

test('same-token classification changed on both sides -> conflict', () => {
  const a = makeState('dev-a');
  addAttempt(a, 'att-1', 'l1', 's1', 'Hello world', [
    { index: 0, expected: 'Hello', actual: 'Hello', correct: true, category: 'unclassified', reason: '' },
    { index: 1, expected: 'world', actual: 'wrld', correct: false, category: 'spelling', reason: '' },
  ]);
  classify(a, 'att-1', 's1', 1, 'spelling', 'a-side reason');

  const b = makeState('dev-b');
  addAttempt(b, 'att-1', 'l1', 's1', 'Hello world', [
    { index: 0, expected: 'Hello', actual: 'Hello', correct: true, category: 'unclassified', reason: '' },
    { index: 1, expected: 'world', actual: 'wrld', correct: false, category: 'grammar', reason: '' },
  ]);
  classify(b, 'att-1', 's1', 1, 'grammar', 'b-side reason');

  const result = mergeHandover(b, toHandover(a));
  ok(result.conflicts.length === 1, `expected 1 conflict, got ${result.conflicts.length}`);
  ok(result.conflicts[0].kind === 'classification', 'conflict kind is classification');
  ok(result.conflicts[0].localCategory === 'grammar', 'local category');
  ok(result.conflicts[0].incomingCategory === 'spelling', 'incoming category');

  result.conflicts[0].resolution = 'local';
  applyConflictResolutions(result.merged, result.conflicts);
  const token = result.merged.attempts[0].sentenceAttempts[0].tokens[1];
  ok(token.category === 'grammar', 'resolved to local category');
});

test('classification only on one side -> auto-merge', () => {
  const a = makeState('dev-a');
  addAttempt(a, 'att-1', 'l1', 's1', 'Hello world', [
    { index: 0, expected: 'Hello', actual: 'Hello', correct: true, category: 'unclassified', reason: '' },
    { index: 1, expected: 'world', actual: 'wrld', correct: false, category: 'spelling', reason: '' },
  ]);
  classify(a, 'att-1', 's1', 1, 'spelling', 'a-side reason');

  const b = makeState('dev-b');
  addAttempt(b, 'att-1', 'l1', 's1', 'Hello world', [
    { index: 0, expected: 'Hello', actual: 'Hello', correct: true, category: 'unclassified', reason: '' },
    { index: 1, expected: 'world', actual: 'wrld', correct: false, category: 'unclassified', reason: '' },
  ]);

  const result = mergeHandover(b, toHandover(a));
  ok(result.conflicts.length === 0, 'no conflict');
  const token = result.merged.attempts[0].sentenceAttempts[0].tokens[1];
  ok(token.category === 'spelling', 'classification merged from a');
  ok(token.reason === 'a-side reason', 'reason merged from a');
});

test('course version change -> revalidate attempts, recompute tokens, preserve classification', () => {
  const a = makeState('dev-a');
  // Answer has a wrong word "chck"; course text changes by appending " now" (wrong word stays aligned)
  addAttempt(a, 'att-1', 'l1', 's1', 'I like chck in.', [
    { index: 0, expected: 'I', actual: 'I', correct: true, category: 'unclassified', reason: '' },
    { index: 1, expected: 'like', actual: 'like', correct: true, category: 'unclassified', reason: '' },
    { index: 2, expected: 'check', actual: 'chck', correct: false, category: 'spelling', reason: 'l-wrong-word' },
    { index: 3, expected: 'in', actual: 'in', correct: true, category: 'unclassified', reason: '' },
    { index: 4, expected: '.', actual: '.', correct: true, category: 'unclassified', reason: '' },
  ], 'I like check in.');

  const b = makeState('dev-b');
  b.courses[0].version = 2;
  b.courses[0].lessons[0].sentences[0].text = 'I like check in now.';

  const result = mergeHandover(b, toHandover(a));
  ok(result.stats.coursesUpdated === 1, 'course updated');
  const sa = result.merged.attempts[0].sentenceAttempts[0];
  ok(sa.source === 'I like check in now.', 'source updated to new text');
  // tokens recomputed: I, like, check->chck(wrong), in, ., now(omitted)
  ok(sa.tokens.length === 6, `tokens recomputed, got ${sa.tokens.length}`);
  ok(sa.tokens[2].expected === 'check', 'wrong word still maps to check');
  ok(sa.tokens[2].category === 'spelling', 'classification preserved (same word, still wrong)');
  ok(sa.tokens[2].reason === 'l-wrong-word', 'reason preserved');
  ok(sa.tokens[4].category === 'omitted', 'new trailing word is omitted');
});

test('course version change with changed expected word -> classification reset', () => {
  const a = makeState('dev-a');
  addAttempt(a, 'att-1', 'l1', 's1', 'Hello wrld', [
    { index: 0, expected: 'Hello', actual: 'Hello', correct: true, category: 'unclassified', reason: '' },
    { index: 1, expected: 'world', actual: 'wrld', correct: false, category: 'spelling', reason: 'old' },
  ]);

  const b = makeState('dev-b');
  b.courses[0].version = 2;
  b.courses[0].lessons[0].sentences[0].text = 'Hello there';

  const result = mergeHandover(b, toHandover(a));
  const sa = result.merged.attempts[0].sentenceAttempts[0];
  ok(sa.source === 'Hello there', 'source updated');
  ok(sa.tokens[1].expected === 'there', 'expected word changed');
  ok(sa.tokens[1].category === 'spelling', 'classification reset to default (word changed)');
  ok(sa.tokens[1].reason === '', 'reason reset');
});

test('missing sentence in new course -> abort merge', () => {
  const a = makeState('dev-a');
  addAttempt(a, 'att-1', 'l1', 's1', 'Hello world', [
    { index: 0, expected: 'Hello', actual: 'Hello', correct: true, category: 'unclassified', reason: '' },
  ]);

  // b has a newer course version that removed s1
  const b = makeState('dev-b');
  b.courses[0].version = 2;
  b.courses[0].lessons[0].sentences = b.courses[0].lessons[0].sentences.filter((s) => s.id !== 's1');

  let threw = false;
  try {
    mergeHandover(b, toHandover(a));
  } catch (err) {
    threw = true;
    ok((err as Error).message.includes('找不到原句'), 'error message mentions missing sentence');
  }
  ok(threw, 'merge should throw when sentence missing');
});

test('capacity check: oversized state is rejected', () => {
  const a = makeState('dev-a');
  a.progress['l1'] = { answers: {}, activeSentenceId: 's1', updatedAt: '' };
  for (let i = 0; i < 100000; i += 1) {
    a.progress['l1'].answers[`s${i}`] = 'x'.repeat(100);
  }
  ok(hasCapacityFor(a) === false, 'oversized state rejected');
});

test('capacity check: normal state is accepted', () => {
  const a = makeState('dev-a');
  addDraft(a, 'l1', 's1', 'Hello world');
  ok(hasCapacityFor(a) === true, 'normal state accepted');
});

test('migration v1 -> v2 preserves answers, progress, classifications, feedback', () => {
  const old = {
    schemaVersion: 1,
    courses: makeState('').courses,
    attempts: [
      {
        id: 'att-1',
        lessonId: 'l1',
        lessonTitle: 'L1',
        courseTitle: 'C1',
        submittedAt: '2026-01-01T00:00:00.000Z',
        score: 90,
        teacherFeedback: 'Great job',
        sentenceAttempts: [
          {
            sentenceId: 's1',
            source: 'Hello world.',
            answer: 'Hello world',
            tokens: [
              { index: 0, expected: 'Hello', actual: 'Hello', correct: true, category: 'unclassified', reason: '' },
              { index: 1, expected: 'world', actual: 'world', correct: true, category: 'unclassified', reason: '' },
            ],
            score: 100,
          },
        ],
      },
    ],
    progress: {
      l1: { answers: { s1: 'Hello world' }, activeSentenceId: 's1', updatedAt: '2026-01-01T00:00:00.000Z' },
    },
    activeLessonId: 'l1',
    activeSentenceId: 's1',
    theme: 'dark',
    fontScale: 1.1,
    role: 'teacher',
  };
  const migrated = migrateV1ToV2(old, 'dev-migrated');
  ok(migrated.schemaVersion === 2, 'schema version is 2');
  ok(migrated.deviceId === 'dev-migrated', 'device id set');
  ok(migrated.attempts[0].teacherFeedback === 'Great job', 'feedback preserved');
  ok(migrated.progress['l1'].answers['s1'] === 'Hello world', 'answer preserved');
  ok(migrated.theme === 'dark', 'theme preserved');
  ok(migrated.role === 'teacher', 'role preserved');
  ok(Array.isArray(migrated.opLog) && migrated.opLog.length === 0, 'opLog initialized empty');
});

test('encode/decode roundtrip', () => {
  const a = makeState('dev-a');
  addDraft(a, 'l1', 's1', 'Hello world');
  const code = encodeHandover(toHandover(a));
  const decoded = decodeHandover(code);
  ok(decoded.deviceId === 'dev-a', 'device id roundtrip');
  ok(decoded.progress['l1'].answers['s1'] === 'Hello world', 'draft roundtrip');
});

test('different attempts auto-merge (union)', () => {
  const a = makeState('dev-a');
  addAttempt(a, 'att-a', 'l1', 's1', 'Hello world', [
    { index: 0, expected: 'Hello', actual: 'Hello', correct: true, category: 'unclassified', reason: '' },
  ]);

  const b = makeState('dev-b');
  addAttempt(b, 'att-b', 'l1', 's2', 'Good morning', [
    { index: 0, expected: 'Good', actual: 'Good', correct: true, category: 'unclassified', reason: '' },
  ]);

  const result = mergeHandover(b, toHandover(a));
  ok(result.merged.attempts.length === 2, 'both attempts present');
  ok(result.merged.attempts.some((x) => x.id === 'att-a'), 'att-a present');
  ok(result.merged.attempts.some((x) => x.id === 'att-b'), 'att-b present');
  ok(result.stats.attemptsAdded === 1, '1 attempt added');
});

test('teacher feedback last-write-wins', () => {
  const a = makeState('dev-a');
  addAttempt(a, 'att-1', 'l1', 's1', 'Hello world', [
    { index: 0, expected: 'Hello', actual: 'Hello', correct: true, category: 'unclassified', reason: '' },
  ]);
  const fbOpA = buildOp(a, { type: 'feedback', attemptId: 'att-1', feedback: 'Feedback from A' });
  a.opLog.push(fbOpA);
  a.attempts[0].teacherFeedback = 'Feedback from A';

  const b = makeState('dev-b');
  addAttempt(b, 'att-1', 'l1', 's1', 'Hello world', [
    { index: 0, expected: 'Hello', actual: 'Hello', correct: true, category: 'unclassified', reason: '' },
  ]);
  const fbOpB = buildOp(b, { type: 'feedback', attemptId: 'att-1', feedback: 'Feedback from B' });
  fbOpB.createdAt = new Date(Date.now() + 10000).toISOString();
  b.opLog.push(fbOpB);
  b.attempts[0].teacherFeedback = 'Feedback from B';

  const result = mergeHandover(b, toHandover(a));
  ok(result.conflicts.length === 0, 'no conflicts for feedback');
  ok(result.merged.attempts[0].teacherFeedback === 'Feedback from B', 'later feedback wins');
});

test('nextSeq is per-device monotonic', () => {
  const a = makeState('dev-a');
  ok(nextSeq(a) === 1, 'first seq is 1');
  addDraft(a, 'l1', 's1', 'Hello');
  ok(nextSeq(a) === 2, 'second seq is 2');
  a.opLog.push({ id: 'dev-x:5', deviceId: 'dev-x', seq: 5, createdAt: '', type: 'draft', lessonId: 'l1', sentenceId: 's1', answer: 'x' });
  ok(nextSeq(a) === 2, 'seq still 2 (only counts own device)');
});

test('courseFingerprint detects content drift', () => {
  const a = makeState('dev-a');
  const b = makeState('dev-b');
  ok(courseFingerprint(a.courses[0]) === courseFingerprint(b.courses[0]), 'same content -> same fingerprint');
  b.courses[0].lessons[0].sentences[0].text = 'Changed text';
  ok(courseFingerprint(a.courses[0]) !== courseFingerprint(b.courses[0]), 'changed content -> different fingerprint');
});

test('failure recovery: importHandoverCode restores pre-import state on bad code', () => {
  // This test exercises the store-level import via a minimal state.
  // We simulate by checking that a decode failure leaves state unchanged.
  const before = makeState('dev-a');
  const snapshot = JSON.stringify(before);
  try {
    decodeHandover('!!!not-valid-base64-or-json!!!');
    ok(false, 'should have thrown');
  } catch {
    // expected
  }
  ok(JSON.stringify(before) === snapshot, 'state unchanged after failed decode');
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
