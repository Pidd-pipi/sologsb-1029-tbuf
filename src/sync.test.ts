import { describe, expect, it } from 'vitest';
import { createInitialState, upgradeStateV1 } from './data';
import { commitImport, decodeHandoff, encodeHandoff, makeChange, previewImport, reconcileOnLoad } from './sync';
import type { HandoffEnvelope, PersistedState, PracticeAttempt, SyncChange, TokenPatch } from './types';
import { compareSentence, lessonFingerprint } from './utils';

function stateFor(deviceId: string, deviceName: string): PersistedState {
  const state = createInitialState();
  state.deviceId = deviceId;
  state.deviceName = deviceName;
  state.knownDevices = {};
  state.attempts = [];
  state.progress = {};
  state.journal = [];
  state.appliedSeq = {};
  state.deviceSeq = 0;
  state.lessonHashes = Object.fromEntries(state.courses.flatMap((course) => course.lessons.map((lesson) => [lesson.id, lessonFingerprint(lesson)])));
  return state;
}

function envelopeFor(deviceId: string, deviceName: string, changes: SyncChange[], lessons: Record<string, string> = {}): string {
  const envelope: HandoffEnvelope = {
    format: 'echostep-handoff',
    envelopeVersion: 1,
    exportedAt: new Date().toISOString(),
    device: { id: deviceId, name: deviceName },
    devices: { [deviceId]: deviceName },
    lessons,
    changes
  };
  return 'ECHOSTEP2:' + btoa(unescape(encodeURIComponent(JSON.stringify(envelope))));
}

function attempt(lessonId: string, hash: string, source: string, answer: string): PracticeAttempt {
  const tokens = compareSentence(source, answer);
  return {
    id: `att-${lessonId}`,
    lessonId,
    lessonTitle: '办理值机',
    courseTitle: '日常英语',
    submittedAt: new Date().toISOString(),
    score: 0,
    lessonHash: hash,
    teacherFeedback: '',
    sentenceAttempts: [{ sentenceId: 'airport-01-s1', source, answer, tokens, score: 0 }]
  };
}

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  clear() { this.map.clear(); }
}

describe('交接码编解码', () => {
  it('导出再导入得到同样的日志与课程指纹', () => {
    const state = stateFor('dev-A', '手机');
    state.journal = [makeChange({ device: 'dev-A', seq: 1, kind: 'answerDraft', lessonId: 'airport-01', sentenceId: 'airport-01-s1', to: 'hello' })];
    const code = encodeHandoff(state);
    const decoded = decodeHandoff(code);
    expect(decoded.changes).toHaveLength(1);
    expect(decoded.device).toEqual({ id: 'dev-A', name: '手机' });
    expect(decoded.lessons['airport-01']).toBe(lessonFingerprint(state.courses[0].lessons[0]));
  });

  it('手机 → 平板 → 再回手机：不同句子并合、已合并内容往返不重复', async () => {
    // 手机写第 1 句，平板写第 2 句。
    const phone = stateFor('dev-phone', '学生手机');
    phone.progress['airport-01'] = { answers: { 'airport-01-s1': 'phone one' }, activeSentenceId: 'airport-01-s1', updatedAt: new Date().toISOString() };
    phone.journal = [makeChange({ device: 'dev-phone', seq: 1, kind: 'answerDraft', lessonId: 'airport-01', sentenceId: 'airport-01-s1', from: '', to: 'phone one' })];
    phone.deviceSeq = 1;

    const tablet = stateFor('dev-tablet', '学生平板');
    tablet.progress['airport-01'] = { answers: { 'airport-01-s2': 'tablet two' }, activeSentenceId: 'airport-01-s2', updatedAt: new Date().toISOString() };
    tablet.journal = [makeChange({ device: 'dev-tablet', seq: 1, kind: 'answerDraft', lessonId: 'airport-01', sentenceId: 'airport-01-s2', from: '', to: 'tablet two' })];
    tablet.deviceSeq = 1;

    // 1) 手机 → 平板
    const codePhone = encodeHandoff(phone);
    const intoTablet = await commitImport(tablet, codePhone, {}, { storage: new MemoryStorage(), storageKey: 't' });
    expect(intoTablet.ok).toBe(true);
    Object.assign(tablet, intoTablet.result.candidate);
    expect(tablet.progress['airport-01'].answers['airport-01-s1']).toBe('phone one');
    expect(tablet.progress['airport-01'].answers['airport-01-s2']).toBe('tablet two');

    // 2) 平板导出（含双方日志）→ 回手机：手机已有自己的内容，只新增平板那句，不产生冲突。
    const codeTablet = encodeHandoff(tablet);
    const intoPhone = previewImport(phone, codeTablet);
    expect(intoPhone.ok).toBe(true);
    expect(intoPhone.stats.answers).toBe(1);
    expect(intoPhone.conflicts).toHaveLength(0);
    expect(intoPhone.candidate?.progress['airport-01'].answers['airport-01-s2']).toBe('tablet two');
  });
});

describe('重复导入幂等', () => {
  it('同一份交接码导入两次，第二次不产生任何改动', async () => {
    const local = stateFor('dev-L', '平板');
    const code = envelopeFor('dev-P', '手机', [
      makeChange({ device: 'dev-P', seq: 1, kind: 'answerDraft', lessonId: 'airport-01', sentenceId: 'airport-01-s1', from: '', to: 'phone draft one' })
    ]);
    const first = previewImport(local, code);
    expect(first.ok).toBe(true);
    expect(first.stats.answers).toBe(1);
    expect(first.candidate?.progress['airport-01'].answers['airport-01-s1']).toBe('phone draft one');

    const storage = new MemoryStorage();
    const committed = await commitImport(local, code, {}, { storage, storageKey: 'k' });
    expect(committed.ok).toBe(true);
    Object.assign(local, committed.result.candidate);

    const second = previewImport(local, code);
    expect(second.ok).toBe(true);
    expect(second.stats.answers).toBe(0);
    expect(second.notices.join('')).toContain('重复导入未重复写入');
  });
});

describe('不同句子自动并合', () => {
  it('两台设备各写不同句子，合并后两句都在', () => {
    const local = stateFor('dev-L', '平板');
    local.progress['airport-01'] = { answers: { 'airport-01-s1': 'tablet s1' }, activeSentenceId: 'airport-01-s1', updatedAt: new Date().toISOString() };
    local.journal = [makeChange({ device: 'dev-L', seq: 1, kind: 'answerDraft', lessonId: 'airport-01', sentenceId: 'airport-01-s1', from: '', to: 'tablet s1' })];

    const code = envelopeFor('dev-P', '手机', [
      makeChange({ device: 'dev-P', seq: 1, kind: 'answerDraft', lessonId: 'airport-01', sentenceId: 'airport-01-s2', from: '', to: 'phone s2' })
    ]);
    const result = previewImport(local, code);
    expect(result.ok).toBe(true);
    expect(result.conflicts).toHaveLength(0);
    expect(result.candidate?.progress['airport-01'].answers['airport-01-s1']).toBe('tablet s1');
    expect(result.candidate?.progress['airport-01'].answers['airport-01-s2']).toBe('phone s2');
  });
});

describe('同一句两边都改 → 冲突', () => {
  it('草稿冲突会列出两个来源供选择，选择后落盘', async () => {
    const local = stateFor('dev-L', '平板');
    local.progress['airport-01'] = { answers: { 'airport-01-s1': 'tablet version' }, activeSentenceId: 'airport-01-s1', updatedAt: new Date().toISOString() };
    local.journal = [makeChange({ device: 'dev-L', seq: 1, kind: 'answerDraft', lessonId: 'airport-01', sentenceId: 'airport-01-s1', from: '', to: 'tablet version' })];

    const code = envelopeFor('dev-P', '手机', [
      makeChange({ device: 'dev-P', seq: 7, kind: 'answerDraft', lessonId: 'airport-01', sentenceId: 'airport-01-s1', from: '', to: 'phone version' })
    ]);
    const preview = previewImport(local, code);
    expect(preview.errorCode).toBe('unresolved');
    expect(preview.conflicts).toHaveLength(1);
    const conflict = preview.conflicts[0];
    expect(conflict.localDeviceName).toBe('平板');
    expect(conflict.incomingDeviceName).toBe('手机');
    expect(conflict.localValue).toBe('tablet version');
    expect(conflict.incomingValue).toBe('phone version');

    const storage = new MemoryStorage();
    const pickedLocal = await commitImport(local, code, { [conflict.id]: 'local' }, { storage, storageKey: 'k' });
    expect(pickedLocal.ok).toBe(true);
    expect(pickedLocal.result.candidate?.progress['airport-01'].answers['airport-01-s1']).toBe('tablet version');

    // 选另一边：用一份尚未导入过的原状态重试。
    const fresh = stateFor('dev-L', '平板');
    fresh.progress['airport-01'] = { answers: { 'airport-01-s1': 'tablet version' }, activeSentenceId: 'airport-01-s1', updatedAt: new Date().toISOString() };
    fresh.journal = [makeChange({ device: 'dev-L', seq: 1, kind: 'answerDraft', lessonId: 'airport-01', sentenceId: 'airport-01-s1', from: '', to: 'tablet version' })];
    const pickedIncoming = await commitImport(fresh, code, { [conflict.id]: 'incoming' }, { storage: new MemoryStorage(), storageKey: 'k2' });
    expect(pickedIncoming.result.candidate?.progress['airport-01'].answers['airport-01-s1']).toBe('phone version');
  });

  it('同一错词分类两边都改 → 冲突', () => {
    const local = stateFor('dev-L', '平板');
    const hash = local.lessonHashes['airport-01'];
    const a = attempt('airport-01', hash, 'How many bags are you checking in today?', 'How bags');
    // 本机把第一处错分为 grammar
    const wrong = a.sentenceAttempts[0].tokens.find((token) => !token.correct)!;
    wrong.category = 'grammar';
    wrong.reason = '本地标注';
    local.attempts = [structuredClone(a)];
    const localJournal: SyncChange[] = [makeChange({
      device: 'dev-L', seq: 1, kind: 'tokenClass', lessonId: 'airport-01',
      attemptId: a.id, sentenceId: 'airport-01-s1', tokenIndex: wrong.index, lessonHash: hash,
      from: { category: wrong.category, reason: '' } as TokenPatch,
      to: { category: 'grammar', reason: '本地标注' }
    })];
    local.journal = localJournal;

    // 对端的初始值要和本机基线一致：构造一份对端把同一 token 标为 spelling 的改动。
    const incomingPatch: TokenPatch = { category: 'spelling', reason: '手机标注' };
    const code = envelopeFor('dev-P', '手机', [makeChange({
      device: 'dev-P', seq: 3, kind: 'tokenClass', lessonId: 'airport-01',
      attemptId: a.id, sentenceId: 'airport-01-s1', tokenIndex: wrong.index, lessonHash: hash,
      from: { category: 'omitted', reason: '' },
      to: incomingPatch
    })]);
    const result = previewImport(local, code);
    // 本机当前 grammar / reason 与对端 from 基线不一致时正是“两边都改”的场景。
    const tokenConflicts = result.conflicts.filter((item) => item.kind === 'tokenClass');
    expect(tokenConflicts.length).toBeGreaterThanOrEqual(1);
    expect(tokenConflicts[0].expectedWord).toBeTruthy();
  });

  it('反馈两边都补 → 冲突，只一边改则自动采用新值', () => {
    const local = stateFor('dev-L', '平板');
    const hash = local.lessonHashes['airport-01'];
    const a = attempt('airport-01', hash, 'How many bags are you checking in today?', 'How bags');
    a.teacherFeedback = '老师在平板写的反馈';
    local.attempts = [structuredClone(a)];
    local.journal = [makeChange({ device: 'dev-L', seq: 1, kind: 'feedback', lessonId: 'airport-01', attemptId: a.id, from: '', to: '老师在平板写的反馈' })];

    const conflictCode = envelopeFor('dev-P', '手机', [
      makeChange({ device: 'dev-P', seq: 1, kind: 'feedback', lessonId: 'airport-01', attemptId: a.id, from: '', to: '老师在手机写的反馈' })
    ]);
    const conflictResult = previewImport(local, conflictCode);
    expect(conflictResult.conflicts.filter((item) => item.kind === 'feedback')).toHaveLength(1);

    // 本机没动过反馈时，对端反馈自动并入。
    const quiet = stateFor('dev-Q', '安静的平板');
    quiet.attempts = [structuredClone({ ...a, teacherFeedback: '' })];
    const autoResult = previewImport(quiet, conflictCode);
    expect(autoResult.ok).toBe(true);
    expect(autoResult.stats.feedback).toBe(1);
    expect(autoResult.candidate?.attempts[0].teacherFeedback).toBe('老师在手机写的反馈');
  });
});

describe('课程版本变化', () => {
  it('受影响错词用原答案按新句子失效重算，人工分类不沿用', () => {
    const local = stateFor('dev-L', '平板');
    const newHash = local.lessonHashes['airport-01'];
    const oldSource = 'OLD SENTENCE TEXT HERE';
    const incoming = attempt('airport-01', 'old-hash-value', oldSource, 'new word answer');
    // 给旧错词打上人工分类，重算后应被清掉。
    incoming.sentenceAttempts[0].tokens.forEach((token) => {
      if (!token.correct) { token.category = 'grammar'; token.reason = '旧分类原因'; }
    });
    const code = envelopeFor('dev-P', '手机', [
      makeChange({ device: 'dev-P', seq: 1, kind: 'attempt', lessonId: 'airport-01', attemptId: incoming.id, to: incoming })
    ], { 'airport-01': 'old-hash-value' });

    const result = previewImport(local, code);
    expect(result.ok).toBe(true);
    expect(result.stats.recomputedSentences).toBe(1);
    expect(result.stats.droppedClassifications).toBeGreaterThan(0);
    const merged = result.candidate!.attempts[0].sentenceAttempts[0];
    expect(merged.recomputed).toBe(true);
    expect(merged.source).toBe(local.courses[0].lessons[0].sentences[0].text);
    expect(merged.answer).toBe('new word answer');
    expect(merged.tokens.every((token) => token.reason === '')).toBe(true);
    expect(newHash).toBeTruthy();
  });

  it('旧版本 hash 上的跨设备错因分类直接失效', () => {
    const local = stateFor('dev-L', '平板');
    const hash = local.lessonHashes['airport-01'];
    const a = attempt('airport-01', hash, 'How many bags are you checking in today?', 'How bags');
    local.attempts = [a];
    const tokenIndex = a.sentenceAttempts[0].tokens.find((token) => !token.correct)!.index;
    const code = envelopeFor('dev-P', '手机', [
      makeChange({
        device: 'dev-P', seq: 1, kind: 'tokenClass', lessonId: 'airport-01',
        attemptId: a.id, sentenceId: 'airport-01-s1', tokenIndex, lessonHash: 'stale-hash',
        from: { category: 'omitted', reason: '' }, to: { category: 'grammar', reason: '过期分类' }
      })
    ]);
    const result = previewImport(local, code);
    expect(result.ok).toBe(true);
    expect(result.stats.droppedClassifications).toBe(1);
    expect(result.stats.classifications).toBe(0);
  });
});

describe('找不到原句 → 整单停止', () => {
  it('作答引用了本机课程不存在的句子时，拒绝写入任何内容', () => {
    const local = stateFor('dev-L', '平板');
    const hash = local.lessonHashes['airport-01'];
    const bad = attempt('airport-01', hash, 'whatever', 'whatever');
    bad.sentenceAttempts[0].sentenceId = 'removed-sentence-id';
    const code = envelopeFor('dev-P', '手机', [
      makeChange({ device: 'dev-P', seq: 1, kind: 'attempt', lessonId: 'airport-01', attemptId: bad.id, to: bad })
    ]);
    const before = JSON.stringify(local);
    const result = previewImport(local, code);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('missing-sentence');
    expect(result.candidate).toBeNull();
    expect(JSON.stringify(local)).toBe(before);
  });

  it('同一批里既有有效草稿又有失效句子时，有效草稿也不落库；修正交接码后可重试成功', () => {
    const local = stateFor('dev-L', '平板');
    const hash = local.lessonHashes['airport-01'];

    const validDraft = makeChange({ device: 'dev-P', seq: 1, kind: 'answerDraft', lessonId: 'airport-01', sentenceId: 'airport-01-s2', from: '', to: 'should not land' });
    const bad = attempt('airport-01', hash, 'whatever', 'whatever');
    bad.sentenceAttempts[0].sentenceId = 'removed-id';
    const badChange = makeChange({ device: 'dev-P', seq: 2, kind: 'attempt', lessonId: 'airport-01', attemptId: bad.id, to: bad });

    const rejected = previewImport(local, envelopeFor('dev-P', '手机', [validDraft, badChange]));
    expect(rejected.errorCode).toBe('missing-sentence');
    expect(local.progress['airport-01']).toBeUndefined();
    expect(local.journal).toHaveLength(0);

    // 去掉失效记录后重试同一份有效草稿：应当成功。
    const retried = previewImport(local, envelopeFor('dev-P', '手机', [validDraft]));
    expect(retried.ok).toBe(true);
    expect(retried.candidate?.progress['airport-01'].answers['airport-01-s2']).toBe('should not land');
  });
});

describe('容量不足拒绝合并', () => {
  it('预检超配额时保留原记录，且失败后可用更大配额重试成功', async () => {
    const local = stateFor('dev-L', '平板');
    const code = envelopeFor('dev-P', '手机', [
      makeChange({ device: 'dev-P', seq: 1, kind: 'answerDraft', lessonId: 'airport-01', sentenceId: 'airport-01-s1', from: '', to: 'x'.repeat(200) })
    ]);
    const tiny = previewImport(local, code, { capacityBytes: 10 });
    expect(tiny.ok).toBe(false);
    expect(tiny.errorCode).toBe('capacity');
    expect(tiny.candidate).toBeNull();
    expect(local.progress['airport-01']).toBeUndefined();

    const storage = new MemoryStorage();
    const retry = await commitImport(local, code, {}, { storage, storageKey: 'k', capacityBytes: 50 * 1024 * 1024 });
    expect(retry.ok).toBe(true);
    expect(retry.result.candidate?.progress['airport-01'].answers['airport-01-s1']).toBe('x'.repeat(200));
  });
});

describe('v1 数据升级', () => {
  it('保留原有答案、进度、分类和教师反馈', () => {
    const legacy = {
      schemaVersion: 1,
      courses: createInitialState().courses,
      attempts: [{
        id: 'old-att',
        lessonId: 'airport-01',
        lessonTitle: '办理值机',
        courseTitle: '日常英语 · 机场与出行',
        submittedAt: '2026-09-01T00:00:00.000Z',
        score: 50,
        teacherFeedback: '旧反馈要保留',
        sentenceAttempts: [{
          sentenceId: 'airport-01-s2',
          source: 'Could I have a window seat, please?',
          answer: 'Could I have a seat',
          score: 50,
          tokens: compareSentence('Could I have a window seat, please?', 'Could I have a seat').map((token) =>
            !token.correct ? { ...token, category: 'omitted' as const, reason: '旧错因' } : token)
        }]
      }],
      progress: { 'airport-01': { answers: { 'airport-01-s1': '旧草稿' }, activeSentenceId: 'airport-01-s1', updatedAt: '2026-09-01T00:00:00.000Z' } },
      activeLessonId: 'airport-01',
      activeSentenceId: 'airport-01-s1',
      theme: 'dark' as const,
      fontScale: 1.1,
      role: 'teacher' as const
    };
    const upgraded = upgradeStateV1(legacy);
    expect(upgraded.schemaVersion).toBe(2);
    expect(upgraded.progress['airport-01'].answers['airport-01-s1']).toBe('旧草稿');
    expect(upgraded.attempts[0].teacherFeedback).toBe('旧反馈要保留');
    const tokens = upgraded.attempts[0].sentenceAttempts[0].tokens;
    expect(tokens.some((token) => token.category === 'omitted' && token.reason === '旧错因')).toBe(true);
    expect(upgraded.theme).toBe('dark');
    expect(upgraded.role).toBe('teacher');
  });
});

describe('启动时课程对账', () => {
  it('课程句子修订后，旧作答的错词失效重算，句子移除则标记 stale', () => {
    const state = stateFor('dev-A', '手机');
    const currentAirport = state.courses[0].lessons[0];
    const staleHash = 'will-not-match';
    state.lessonHashes['airport-01'] = staleHash;
    state.attempts = [{
      id: 'a1',
      lessonId: 'airport-01',
      lessonTitle: '办理值机',
      courseTitle: '日常英语',
      submittedAt: new Date().toISOString(),
      score: 10,
      lessonHash: staleHash,
      teacherFeedback: '反馈保留',
      sentenceAttempts: [
        { sentenceId: 'airport-01-s1', source: 'old wording', answer: currentAirport.sentences[0].text, tokens: compareSentence('old wording', currentAirport.sentences[0].text).map((token) => !token.correct ? { ...token, category: 'grammar' as const, reason: '旧人工分类' } : token), score: 10 },
        { sentenceId: 'removed-id', source: 'gone', answer: 'gone', tokens: [], score: 0 }
      ]
    }];

    const result = reconcileOnLoad(state, state.courses);
    const merged = result.attempts[0].sentenceAttempts;
    const first = merged.find((item) => item.sentenceId === 'airport-01-s1')!;
    expect(first.recomputed).toBe(true);
    expect(first.source).toBe(currentAirport.sentences[0].text);
    expect(first.tokens.every((token) => token.reason === '')).toBe(true);
    expect(merged.find((item) => item.sentenceId === 'removed-id')?.stale).toBe(true);
    expect(result.attempts[0].teacherFeedback).toBe('反馈保留');
    expect(result.lessonHashes['airport-01']).toBe(lessonFingerprint(currentAirport));
  });

  it('课程未变化时不重算、不打扰', () => {
    const state = stateFor('dev-A', '手机');
    const result = reconcileOnLoad(state, state.courses);
    expect(result.notices).toHaveLength(0);
  });
});
