import type {
  ConflictSide,
  HandoffEnvelope,
  ImportConflict,
  ImportResult,
  ImportStats,
  Lesson,
  PersistedState,
  PracticeAttempt,
  SentenceAttempt,
  SyncChange,
  TokenPatch,
  TokenResult
} from './types';
import { lessonFingerprint, recomputeSentenceAttempt, scoreAttempt } from './utils';

const HANDOFF_PREFIX = 'ECHOSTEP2:';
const emptyStats = (): ImportStats => ({
  attempts: 0,
  answers: 0,
  classifications: 0,
  feedback: 0,
  recomputedSentences: 0,
  droppedClassifications: 0
});

/* ---------------- 启动时课程对账 ---------------- */

/**
 * 应用启动 / 升级后对账：把内置课程刷新到最新版本（保留下载标记），
 * 课程句子一变，受影响作答里的错词用保存的答案失效重算；
 * 找不到原句的作答标记 stale 保留。返回的新 lessonHashes 用于下次比对。
 */
export function reconcileOnLoad(input: PersistedState, currentCourses: PersistedState['courses']): {
  courses: PersistedState['courses'];
  lessonHashes: Record<string, string>;
  attempts: PracticeAttempt[];
  notices: string[];
} {
  const notices: string[] = [];
  const downloads = new Map<string, boolean>();
  for (const course of input.courses) {
    for (const lesson of course.lessons) downloads.set(lesson.id, lesson.downloaded);
  }
  const courses: PersistedState['courses'] = structuredClone(currentCourses).map((course) => ({
    ...course,
    lessons: course.lessons.map((lesson) => ({ ...lesson, downloaded: downloads.get(lesson.id) ?? lesson.downloaded }))
  }));
  const index = buildLessonIndex(courses);
  const attempts = structuredClone(input.attempts);

  for (const attempt of attempts) {
    const ref = index.get(attempt.lessonId);
    if (!ref) continue;
    let changed = false;
    for (const sentenceAttempt of attempt.sentenceAttempts) {
      const currentText = ref.sentences.get(sentenceAttempt.sentenceId);
      if (currentText === undefined) {
        if (!sentenceAttempt.stale) { sentenceAttempt.stale = true; changed = true; }
        continue;
      }
      const knownHash = input.lessonHashes[attempt.lessonId] ?? attempt.lessonHash;
      if (currentText !== sentenceAttempt.source && knownHash !== ref.hash) {
        const before = sentenceAttempt.tokens.filter((token) => !token.correct && token.category !== 'unclassified').length;
        const recomputed = recomputeSentenceAttempt(sentenceAttempt, currentText);
        Object.assign(sentenceAttempt, recomputed);
        changed = true;
        if (before) notices.push(`「${ref.lesson.title}」课程已更新，相关错词分类已失效重算。`);
      } else {
        sentenceAttempt.stale = false;
        sentenceAttempt.source = currentText;
      }
    }
    if (changed) {
      attempt.lessonTitle = ref.lesson.title;
      attempt.courseTitle = ref.courseTitle;
      attempt.score = scoreAttempt(attempt.sentenceAttempts.filter((item) => !item.stale));
    }
    attempt.lessonHash = ref.hash;
  }

  const lessonHashes: Record<string, string> = {};
  for (const [id, ref] of index) lessonHashes[id] = ref.hash;
  return { courses, lessonHashes, attempts, notices };
}

/* ---------------- 交接码编码 ---------------- */

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToUtf8(payload: string): string {
  const binary = atob(payload);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 导出交接码：当前课程指纹 + 累计改动日志，整体 base64。 */
export function encodeHandoff(state: PersistedState): string {
  const lessonHashes: Record<string, string> = {};
  for (const course of state.courses) {
    for (const lesson of course.lessons) lessonHashes[lesson.id] = lessonFingerprint(lesson);
  }
  const envelope: HandoffEnvelope = {
    format: 'echostep-handoff',
    envelopeVersion: 1,
    exportedAt: new Date().toISOString(),
    device: { id: state.deviceId, name: state.deviceName },
    devices: { [state.deviceId]: state.deviceName, ...state.knownDevices },
    lessons: lessonHashes,
    changes: state.journal
  };
  return HANDOFF_PREFIX + utf8ToBase64(JSON.stringify(envelope));
}

export function decodeHandoff(code: string): HandoffEnvelope {
  const trimmed = code.trim();
  const payload = trimmed.startsWith(HANDOFF_PREFIX) ? trimmed.slice(HANDOFF_PREFIX.length) : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64ToUtf8(payload));
  } catch {
    // 兼容直接粘贴 JSON 的调试场景。
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('交接码无法识别');
    }
  }
  const envelope = parsed as HandoffEnvelope;
  if (!envelope || envelope.format !== 'echostep-handoff' || !Array.isArray(envelope.changes)) {
    throw new Error('交接码格式不正确');
  }
  if (!envelope.device?.id) throw new Error('交接码缺少设备信息');
  return envelope;
}

/* ---------------- 课程索引 ---------------- */

interface LessonRef {
  lesson: Lesson;
  hash: string;
  sentences: Map<string, string>;
  courseTitle: string;
}

function buildLessonIndex(courses: PersistedState['courses']): Map<string, LessonRef> {
  const index = new Map<string, LessonRef>();
  for (const course of courses) {
    for (const lesson of course.lessons) {
      index.set(lesson.id, {
        lesson,
        hash: lessonFingerprint(lesson),
        sentences: new Map(lesson.sentences.map((sentence) => [sentence.id, sentence.text])),
        courseTitle: course.title
      });
    }
  }
  return index;
}

/* ---------------- 三方合并 ---------------- */

/**
 * 三方值合并：base 为共同基线，incoming/local 为两边的新值。
 * 仅当两边都偏离基线且互不相等时才报冲突。
 */
function threeWay<T>(base: T | null, incoming: T, local: T, equal: (a: T, b: T) => boolean): { value: T; conflict: boolean } {
  if (base === null) {
    // 双方都没有共同基线（如各自离线独立创建），值不同即为冲突。
    return { value: incoming, conflict: !equal(incoming, local) };
  }
  const incomingChanged = !equal(base, incoming);
  const localChanged = !equal(base, local);
  if (!incomingChanged) return { value: local, conflict: false };
  if (!localChanged) return { value: incoming, conflict: false };
  return { value: incoming, conflict: !equal(incoming, local) };
}

const stringEqual = (a: string, b: string) => a === b;
const patchEqual = (a: TokenPatch, b: TokenPatch) => a.category === b.category && a.reason === b.reason;
const isPatch = (value: unknown): value is TokenPatch =>
  !!value && typeof value === 'object' && typeof (value as TokenPatch).category === 'string';

function valueLabel(value: string | TokenPatch): string {
  if (typeof value === 'string') return value.trim() ? value : '（空）';
  const categoryLabels: Record<string, string> = {
    unclassified: '未分类',
    spelling: '拼写错误',
    omitted: '漏词',
    extra: '多词',
    punctuation: '标点',
    grammar: '语法'
  };
  const reason = value.reason.trim() ? value.reason : '未填原因';
  return `${categoryLabels[value.category] ?? value.category} · ${reason}`;
}

function sameField(a: SyncChange, b: SyncChange): boolean {
  if (a.kind !== b.kind || a.lessonId !== b.lessonId) return false;
  switch (a.kind) {
    case 'answerDraft':
      return a.sentenceId === b.sentenceId;
    case 'feedback':
      return a.attemptId === b.attemptId;
    case 'tokenClass':
      return a.attemptId === b.attemptId && a.sentenceId === b.sentenceId && a.tokenIndex === b.tokenIndex;
    default:
      return false;
  }
}

/* ---------------- 导入预演 ---------------- */

export interface PreviewOptions {
  /** 容量（字节）上限，用于在不动原记录的前提下预演容量是否够。 */
  capacityBytes?: number;
  /** 已用容量估算，默认用当前 localStorage 全部键估算。 */
  usedBytes?: number;
}

/**
 * 在副本上预演导入，绝不修改原状态。返回：
 * - 自动合并的统计；
 * - 需要两边都改后人工选择的冲突；
 * - 课程版本变化导致的失效重算/丢弃清单；
 * - 任一句子在本机课程中找不到时，整单标记 missing-sentence（候选结果作废）。
 */
export function previewImport(state: PersistedState, code: string, options: PreviewOptions = {}): ImportResult {
  let envelope: HandoffEnvelope;
  try {
    envelope = decodeHandoff(code);
  } catch (error) {
    return {
      ok: false,
      errorCode: 'bad-code',
      errorMessage: error instanceof Error ? error.message : '交接码无法识别',
      conflicts: [],
      stats: emptyStats(),
      notices: [],
      candidate: null,
      incomingDevice: null
    };
  }

  if (envelope.device.id === state.deviceId) {
    return {
      ok: true,
      conflicts: [],
      stats: emptyStats(),
      notices: ['这是本机导出的交接码，内容已在本机，未重复写入。'],
      candidate: null,
      incomingDevice: envelope.device
    };
  }

  const work = structuredClone(state);
  const stats = emptyStats();
  const notices: string[] = [];
  const conflicts: ImportConflict[] = [];
  const lessonIndex = buildLessonIndex(work.courses);
  const deviceName = (id: string): string =>
    (id === work.deviceId ? work.deviceName : undefined) ?? envelope.devices?.[id] ?? work.knownDevices[id] ?? `设备 ${id.slice(-4)}`;

  // 记录交接方带来的设备名称。
  work.knownDevices[envelope.device.id] = envelope.device.name;
  if (envelope.devices) {
    for (const [id, name] of Object.entries(envelope.devices)) {
      if (id !== work.deviceId) work.knownDevices[id] = name;
    }
  }

  // 日志累计去重：(设备号, 序号) 唯一，重复导入不重复生效。
  const seen = new Set(work.journal.map((change) => `${change.device}#${change.seq}`));
  const newChanges: SyncChange[] = [];
  for (const change of envelope.changes) {
    const key = `${change.device}#${change.seq}`;
    if (seen.has(key)) continue;
    if ((work.appliedSeq[change.device] ?? 0) >= change.seq) continue;
    seen.add(key);
    newChanges.push(change);
  }
  newChanges.sort((a, b) => (a.device === b.device ? a.seq - b.seq : a.at < b.at ? -1 : 1));

  const fail = (message: string): ImportResult => ({
    ok: false,
    errorCode: 'missing-sentence',
    errorMessage: message,
    conflicts: [],
    stats: emptyStats(),
    notices: [],
    candidate: null,
    incomingDevice: envelope.device
  });

  // 先整单预校验：任一处引用了本机课程找不到的句子，就整单停止、绝不写入。
  for (const change of newChanges) {
    if (change.kind === 'answerDraft' || change.kind === 'tokenClass') {
      const ref = lessonIndex.get(change.lessonId);
      if (!ref || !change.sentenceId || !ref.sentences.has(change.sentenceId)) {
        return fail(`交接记录引用了本机课程中找不到的句子（${change.lessonId} / ${change.sentenceId ?? '-'}），已停止写入。`);
      }
    }
    if (change.kind === 'attempt') {
      const ref = lessonIndex.get(change.lessonId);
      if (!ref) continue; // 没有的课节在应用阶段跳过
      const attempt = change.to as PracticeAttempt | null;
      if (!attempt) continue;
      const missing = attempt.sentenceAttempts.find((item) => !ref.sentences.has(item.sentenceId));
      if (missing) {
        return fail(`交接记录中的作答「${attempt.lessonTitle}」包含本机课程里已不存在的句子（${missing.sentenceId}），已停止写入。`);
      }
    }
  }

  // 预校验通过后，才把新日志纳入副本（三方合并查基线需要完整日志）。
  for (const change of newChanges) work.journal.push(structuredClone(change));

  for (const change of newChanges) {
    if (change.kind === 'attempt') {
      const ref = lessonIndex.get(change.lessonId);
      if (!ref) {
        notices.push(`一条作答记录属于本机没有的课节（${change.lessonId}），已跳过。`);
        continue;
      }
      const attempt = change.to as PracticeAttempt | null;
      if (!attempt) continue;
      mergeAttempt(work, ref, attempt, stats, notices);
      continue;
    }
    if (change.kind === 'tokenClass') {
      const ref = lessonIndex.get(change.lessonId)!;
      applyTokenClassChange(work, ref, change, conflicts, stats, notices, deviceName);
      continue;
    }
    if (change.kind === 'feedback') {
      applyFeedbackChange(work, change, conflicts, stats, deviceName);
    }
  }

  applyAnswerDrafts(work, newChanges, lessonIndex, conflicts, stats, deviceName);

  if (!newChanges.length) {
    notices.push('交接码里的改动此前都已在本机生效，重复导入未重复写入。');
  }

  // 冲突未解决时不允许提交，但候选结果已带上，界面选择后直接应用。
  if (conflicts.length) {
    return {
      ok: false,
      errorCode: 'unresolved',
      conflicts,
      stats,
      notices,
      candidate: work,
      incomingDevice: envelope.device
    };
  }

  const sizeIssue = checkCapacity(work, state, options);
  if (sizeIssue) {
    return {
      ok: false,
      errorCode: 'capacity',
      errorMessage: sizeIssue,
      conflicts: [],
      stats,
      notices,
      candidate: null,
      incomingDevice: envelope.device
    };
  }

  return { ok: true, conflicts: [], stats, notices, candidate: work, incomingDevice: envelope.device };
}

/* ---------------- 各类改动的应用 ---------------- */

function mergeAttempt(
  work: PersistedState,
  ref: LessonRef,
  incoming: PracticeAttempt,
  stats: ImportStats,
  notices: string[]
) {
  const byId = new Map(incoming.sentenceAttempts.map((item) => [item.sentenceId, item]));
  const rebuilt: SentenceAttempt[] = [];

  let ordinal = 0;
  for (const sentenceId of ref.sentences.keys()) {
    ordinal += 1;
    const currentText = ref.sentences.get(sentenceId)!;
    const incomingSentence = byId.get(sentenceId);
    if (incomingSentence) {
      // 课程版本变化：用原答案按新句子重算错词，旧的人工分类不沿用。
      if (incoming.lessonHash && incoming.lessonHash !== ref.hash && incomingSentence.source !== currentText) {
        const before = incomingSentence.tokens.filter((token) => !token.correct && token.category !== 'unclassified').length;
        const recomputed = recomputeSentenceAttempt(incomingSentence, currentText);
        if (before) {
          stats.droppedClassifications += before;
          notices.push(`「${ref.lesson.title}」课程已更新，第 ${ordinal} 句的错词分类已失效重算。`);
        }
        stats.recomputedSentences += 1;
        rebuilt.push(recomputed);
      } else {
        rebuilt.push({ ...incomingSentence, source: currentText, stale: false });
      }
      byId.delete(sentenceId);
    }
  }

  // 本机已有同一次作答：保留本机独有句子，不覆盖教师在本机补的反馈（反馈走 feedback 改动合并）。
  const existing = work.attempts.find((item) => item.id === incoming.id);
  let merged: PracticeAttempt;
  if (existing) {
    const localOnly = existing.sentenceAttempts.filter((item) => !rebuilt.some((row) => row.sentenceId === item.sentenceId));
    merged = {
      ...existing,
      ...incoming,
      lessonTitle: ref.lesson.title,
      courseTitle: ref.courseTitle,
      lessonHash: ref.hash,
      teacherFeedback: existing.teacherFeedback,
      sentenceAttempts: [...rebuilt, ...localOnly]
    };
    Object.assign(existing, merged);
  } else {
    merged = {
      ...incoming,
      lessonId: ref.lesson.id,
      lessonTitle: ref.lesson.title,
      courseTitle: ref.courseTitle,
      lessonHash: ref.hash,
      teacherFeedback: incoming.teacherFeedback ?? '',
      sentenceAttempts: rebuilt
    };
    work.attempts.unshift(merged);
    stats.attempts += 1;
  }
  merged.score = scoreAttempt(merged.sentenceAttempts.filter((item) => !item.stale));
  work.lessonHashes[ref.lesson.id] = ref.hash;
}

function findToken(work: PersistedState, attemptId: string | undefined, sentenceId: string, tokenIndex: number | undefined): TokenResult | undefined {
  if (!attemptId || tokenIndex === undefined) return undefined;
  return work.attempts
    .find((attempt) => attempt.id === attemptId)
    ?.sentenceAttempts.find((item) => item.sentenceId === sentenceId)
    ?.tokens.find((token) => token.index === tokenIndex);
}

function applyTokenClassChange(
  work: PersistedState,
  ref: LessonRef,
  change: SyncChange,
  conflicts: ImportConflict[],
  stats: ImportStats,
  notices: string[],
  deviceName: (id: string) => string
) {
  const patch = change.to;
  if (!isPatch(patch)) return;
  const target = findToken(work, change.attemptId, change.sentenceId!, change.tokenIndex);
  if (!target) {
    notices.push('一条错因修改对应的错词已不存在（可能已重算），已忽略。');
    return;
  }
  // 改动基于的课程版本与本机不同：该分类失效，不参与合并。
  if (change.lessonHash && change.lessonHash !== ref.hash) {
    stats.droppedClassifications += 1;
    notices.push('课程版本变化，一条跨设备错因分类已失效，请在重算后的结果上重新分类。');
    return;
  }

  const basePatch = isPatch(change.from) ? change.from : null;
  const localPatch: TokenPatch = { category: target.category, reason: target.reason };
  const result = threeWay<TokenPatch>(basePatch, patch, localPatch, patchEqual);
  if (result.conflict) {
    const localChange = work.journal.find((item) =>
      item.device !== change.device && item.device === work.deviceId && sameField(item, change)
      && isPatch(item.to) && (basePatch ? !patchEqual(item.to as TokenPatch, basePatch) : true));
    const ordinal = ref.lesson.sentences.findIndex((sentence) => sentence.id === change.sentenceId) + 1;
    const localDeviceId = localChange?.device ?? work.deviceId;
    conflicts.push({
      id: `token-${change.attemptId}-${change.sentenceId}-${change.tokenIndex}`,
      kind: 'tokenClass',
      lessonId: change.lessonId,
      lessonTitle: ref.lesson.title,
      sentenceId: change.sentenceId,
      sentenceOrdinal: ordinal,
      attemptId: change.attemptId,
      tokenIndex: change.tokenIndex,
      expectedWord: target.expected || target.actual,
      localLabel: valueLabel(localPatch),
      incomingLabel: valueLabel(patch),
      localValue: localPatch,
      incomingValue: patch,
      localDevice: localDeviceId,
      incomingDevice: change.device,
      localDeviceName: deviceName(localDeviceId),
      incomingDeviceName: deviceName(change.device)
    });
    return;
  }
  if (result.value.category !== target.category || result.value.reason !== target.reason) {
    target.category = result.value.category;
    target.reason = result.value.reason;
    stats.classifications += 1;
  }
}

function applyFeedbackChange(
  work: PersistedState,
  change: SyncChange,
  conflicts: ImportConflict[],
  stats: ImportStats,
  deviceName: (id: string) => string
) {
  const attempt = work.attempts.find((item) => item.id === change.attemptId);
  if (!attempt) return;
  const incomingValue = typeof change.to === 'string' ? change.to : '';
  const baseValue = typeof change.from === 'string' ? change.from : null;
  const localValue = attempt.teacherFeedback ?? '';
  const result = threeWay<string>(baseValue, incomingValue, localValue, stringEqual);
  if (result.conflict) {
    const localChange = work.journal.find((item) =>
      item.device !== change.device && item.device === work.deviceId && sameField(item, change)
      && typeof item.to === 'string' && (baseValue !== null ? item.to !== baseValue : true));
    const localDeviceId = localChange?.device ?? work.deviceId;
    conflicts.push({
      id: `feedback-${change.attemptId}`,
      kind: 'feedback',
      lessonId: change.lessonId,
      lessonTitle: attempt.lessonTitle,
      attemptId: change.attemptId,
      localLabel: valueLabel(localValue),
      incomingLabel: valueLabel(incomingValue),
      localValue,
      incomingValue: incomingValue,
      localDevice: localDeviceId,
      incomingDevice: change.device,
      localDeviceName: deviceName(localDeviceId),
      incomingDeviceName: deviceName(change.device)
    });
    return;
  }
  if (result.value !== localValue) {
    attempt.teacherFeedback = result.value;
    stats.feedback += 1;
  }
}

function applyAnswerDrafts(
  work: PersistedState,
  newChanges: SyncChange[],
  lessonIndex: Map<string, LessonRef>,
  conflicts: ImportConflict[],
  stats: ImportStats,
  deviceName: (id: string) => string
) {
  // 只看本次新到的草稿；按 (设备, 句子) 各取最新一条。
  const latestByDevice = new Map<string, SyncChange>();
  for (const change of newChanges) {
    if (change.kind !== 'answerDraft' || !change.sentenceId) continue;
    latestByDevice.set(`${change.device}:${change.lessonId}:${change.sentenceId}`, change);
  }
  const bySentence = new Map<string, SyncChange[]>();
  for (const change of latestByDevice.values()) {
    const key = `${change.lessonId}:${change.sentenceId}`;
    const list = bySentence.get(key) ?? [];
    list.push(change);
    bySentence.set(key, list);
  }

  for (const [key, incomingList] of bySentence) {
    const [lessonId, sentenceId] = key.split(':');
    const ref = lessonIndex.get(lessonId);
    if (!ref) continue;
    // 同一台对端设备的多条只取最新。
    const incoming = incomingList.sort((a, b) => b.seq - a.seq)[0];
    const incomingValue = typeof incoming.to === 'string' ? incoming.to : '';
    const localValue = work.progress[lessonId]?.answers[sentenceId] ?? '';

    // 基线：优先用改动自带 from；否则从完整日志找该句子上一版（可能来自本机或更早的交接）。
    let baseValue: string | null = typeof incoming.from === 'string' ? incoming.from : null;
    if (baseValue === null) {
      const prior = work.journal
        .filter((item) => item.kind === 'answerDraft' && item.lessonId === lessonId && item.sentenceId === sentenceId
          && !(item.device === incoming.device && item.seq >= incoming.seq))
        .sort((a, b) => (a.at < b.at ? 1 : -1))[0];
      baseValue = prior && typeof prior.to === 'string' ? prior.to : null;
    }

    // 本机是否也相对基线改过：有本机日志改动，或当前值偏离基线且不是本次导入带来的值。
    const localEdited = work.journal.some((item) =>
      item.device === work.deviceId && item.kind === 'answerDraft'
      && item.lessonId === lessonId && item.sentenceId === sentenceId
      && (baseValue === null ? true : (typeof item.to === 'string' && item.to !== baseValue)));
    const localDiffersFromBase = baseValue === null ? localValue !== '' : localValue !== baseValue;
    const result = threeWay<string>(baseValue, incomingValue, localValue, stringEqual);
    if (result.conflict || (baseValue === null && localEdited && localDiffersFromBase && incomingValue !== localValue)) {
      const ordinal = ref.lesson.sentences.findIndex((sentence) => sentence.id === sentenceId) + 1;
      conflicts.push({
        id: `draft-${lessonId}-${sentenceId}`,
        kind: 'answerDraft',
        lessonId,
        lessonTitle: ref.lesson.title,
        sentenceId,
        sentenceOrdinal: ordinal,
        localLabel: valueLabel(localValue),
        incomingLabel: valueLabel(incomingValue),
        localValue,
        incomingValue,
        localDevice: work.deviceId,
        incomingDevice: incoming.device,
        localDeviceName: deviceName(work.deviceId),
        incomingDeviceName: deviceName(incoming.device)
      });
      continue;
    }
    if (result.value !== localValue) {
      const progress = work.progress[lessonId] ?? { answers: {}, activeSentenceId: sentenceId, updatedAt: incoming.at };
      progress.answers[sentenceId] = result.value;
      progress.updatedAt = incoming.at;
      work.progress[lessonId] = progress;
      stats.answers += 1;
    }
  }
}

/* ---------------- 容量预检 ---------------- */

function currentStorageBytes(storage?: Storage): number {
  const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  if (!target) return 0;
  let total = 0;
  for (let i = 0; i < target.length; i += 1) {
    const key = target.key(i);
    if (key) total += key.length + (target.getItem(key)?.length ?? 0);
  }
  return total * 2; // UTF-16 每字符约 2 字节
}

function checkCapacity(candidate: PersistedState, base: PersistedState, options: PreviewOptions): string | null {
  if (options.capacityBytes === undefined) return null;
  const used = options.usedBytes ?? currentStorageBytes();
  const serialized = JSON.stringify(candidate);
  const baseSize = JSON.stringify(base).length * 2;
  const nextSize = serialized.length * 2 + Math.max(0, used - baseSize);
  // 留 10% 安全余量，逼近配额时拒绝合并、原记录不动。
  if (nextSize > options.capacityBytes * 0.9) {
    const freeKb = Math.max(0, Math.round((options.capacityBytes - used) / 1024));
    return `本机剩余空间约 ${freeKb} KB，不足以保存合并结果，已拒绝合并并保留原记录。`;
  }
  return null;
}

/* ---------------- 提交合并 ---------------- */

export interface CommitOptions extends PreviewOptions {
  storage?: Storage;
  storageKey?: string;
}

export interface CommitOutcome {
  ok: boolean;
  result: ImportResult;
}

/**
 * 把界面上已选择好冲突方案的候选结果落盘。
 * 写入失败（如真实配额超限）时原记录保持不动，允许整理空间后重试。
 */
export async function commitImport(
  state: PersistedState,
  code: string,
  resolutions: Record<string, ConflictSide>,
  options: CommitOptions = {}
): Promise<CommitOutcome> {
  const preview = previewImport(state, code, options);
  if (!preview.ok && preview.errorCode !== 'unresolved') return { ok: false, result: preview };

  let candidate = preview.candidate;
  if (!candidate) {
    return { ok: preview.ok, result: preview };
  }

  if (preview.errorCode === 'unresolved') {
    const unresolved = preview.conflicts.filter((conflict) => !resolutions[conflict.id]);
    if (unresolved.length) {
      return { ok: false, result: { ...preview, errorMessage: `还有 ${unresolved.length} 处冲突未选择。` } };
    }
    candidate = structuredClone(candidate);
    for (const conflict of preview.conflicts) {
      const side = resolutions[conflict.id];
      const chosen = side === 'local' ? conflict.localValue : conflict.incomingValue;
      applyResolution(candidate, conflict, chosen);
    }
    const sizeIssue = checkCapacity(candidate, state, options);
    if (sizeIssue) {
      return { ok: false, result: { ...preview, ok: false, errorCode: 'capacity', errorMessage: sizeIssue, candidate: null } };
    }
  }

  // 对端设备的所有改动记为已生效水位。
  if (preview.incomingDevice) {
    const maxSeq = candidate.journal
      .filter((change) => change.device === preview.incomingDevice!.id)
      .reduce((max, change) => Math.max(max, change.seq), candidate.appliedSeq[preview.incomingDevice.id] ?? 0);
    candidate.appliedSeq[preview.incomingDevice.id] = maxSeq;
  }

  const storage = options.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  const key = options.storageKey ?? 'sologsb-1029-dictation-state-v1';
  const serialized = JSON.stringify(candidate);
  try {
    if (storage) {
      storage.setItem(key, serialized);
    }
  } catch (error) {
    return {
      ok: false,
      result: {
        ...preview,
        ok: false,
        errorCode: 'write-failed',
        errorMessage: '写入本机存储失败，原记录未改动，可清理空间后重试。',
        candidate: null
      }
    };
  }
  return { ok: true, result: { ...preview, ok: true, errorCode: undefined, errorMessage: undefined, candidate } };
}

function applyResolution(candidate: PersistedState, conflict: ImportConflict, chosen: string | TokenPatch) {
  if (conflict.kind === 'answerDraft') {
    const progress = candidate.progress[conflict.lessonId] ?? {
      answers: {},
      activeSentenceId: conflict.sentenceId!,
      updatedAt: new Date().toISOString()
    };
    progress.answers[conflict.sentenceId!] = String(chosen);
    candidate.progress[conflict.lessonId] = progress;
    return;
  }
  if (conflict.kind === 'feedback') {
    const attempt = candidate.attempts.find((item) => item.id === conflict.attemptId);
    if (attempt) attempt.teacherFeedback = String(chosen);
    return;
  }
  const token = findToken(candidate, conflict.attemptId, conflict.sentenceId!, conflict.tokenIndex);
  if (token && isPatch(chosen)) {
    token.category = chosen.category;
    token.reason = chosen.reason;
  }
}

/* 仅供测试：构造一条改动。 */
export function makeChange(partial: Partial<SyncChange> & Pick<SyncChange, 'device' | 'seq' | 'kind' | 'lessonId'>): SyncChange {
  return { at: new Date().toISOString(), sentenceId: undefined, ...partial };
}

export function recomputeStaleScores(attempt: PracticeAttempt): number {
  return scoreAttempt(attempt.sentenceAttempts.filter((item) => !item.stale));
}
