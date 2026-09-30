import { reactive, watch } from 'vue';
import { createInitialState, demoCourses, upgradeStateV1 } from './data';
import { encodeHandoff, previewImport, commitImport, reconcileOnLoad } from './sync';
import type {
  ConflictSide,
  ErrorCategory,
  Lesson,
  PersistedState,
  PracticeAttempt,
  SyncChange,
  SyncKind,
  TokenPatch
} from './types';
import { lessonFingerprint } from './utils';

const STORAGE_KEY = 'sologsb-1029-dictation-state-v1';

function applyReconcile(parsed: PersistedState): PersistedState {
  const result = reconcileOnLoad(parsed, demoCourses as PersistedState['courses']);
  parsed.courses = result.courses;
  parsed.lessonHashes = result.lessonHashes;
  parsed.attempts = result.attempts;
  return parsed;
}

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed?.schemaVersion === 2) return applyReconcile(parsed);
      if (parsed?.schemaVersion === 1) return applyReconcile(upgradeStateV1(parsed));
    }
  } catch {
    // 草稿损坏时回退到示例课程。
  }
  return createInitialState();
}

export const state = reactive<PersistedState>(loadState());

export const persist = (): boolean => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
};

watch(state, persist, { deep: true });

/* ---------------- 课程查询 ---------------- */

export const lessons = (): Lesson[] => state.courses.flatMap((course) => course.lessons);
export const lessonById = (id: string): Lesson | undefined => lessons().find((lesson) => lesson.id === id);
export const courseForLesson = (lessonId: string) => state.courses.find((course) => course.id === lessonById(lessonId)?.courseId);
export const lessonHashOf = (lessonId: string): string | undefined => {
  const lesson = lessonById(lessonId);
  return lesson ? lessonFingerprint(lesson) : undefined;
};

export function setDownloaded(lessonId: string, value: boolean) {
  const lesson = lessonById(lessonId);
  if (lesson) lesson.downloaded = value;
}

/* ---------------- 改动日志（设备号 + 序号） ---------------- */

function fieldMatches(change: SyncChange, kind: SyncKind, lessonId: string, extra: Partial<SyncChange>): boolean {
  if (change.kind !== kind || change.lessonId !== lessonId || change.device !== state.deviceId) return false;
  if (kind === 'answerDraft') return change.sentenceId === extra.sentenceId;
  if (kind === 'feedback') return change.attemptId === extra.attemptId;
  if (kind === 'tokenClass') {
    return change.attemptId === extra.attemptId && change.sentenceId === extra.sentenceId && change.tokenIndex === extra.tokenIndex;
  }
  return false;
}

/**
 * 追加一条本机改动。未导出过（seq 大于上次导流水位）的同一字段改动就地合并，
 * 避免离线连续编辑把日志撑爆；合并时保留最初的 from 作为三方合并基线。
 */
function emitChange(kind: SyncKind, lessonId: string, patch: Omit<SyncChange, 'device' | 'seq' | 'at' | 'kind' | 'lessonId'>, coalesce: boolean) {
  const exportedWatermark = state.lastExportedSeq[state.deviceId] ?? 0;
  if (coalesce) {
    for (let i = state.journal.length - 1; i >= 0; i -= 1) {
      const existing = state.journal[i];
      if (existing.device !== state.deviceId) continue;
      if (existing.seq <= exportedWatermark) break;
      if (fieldMatches(existing, kind, lessonId, patch)) {
        existing.to = patch.to;
        existing.at = new Date().toISOString();
        return;
      }
    }
  }
  state.deviceSeq += 1;
  state.journal.push({
    device: state.deviceId,
    seq: state.deviceSeq,
    at: new Date().toISOString(),
    kind,
    lessonId,
    ...patch
  });
}

function ensureProgress(lessonId: string, activeSentenceId: string): PersistedState['progress'][string] {
  const existing = state.progress[lessonId];
  if (existing) return existing;
  const created = { answers: {}, activeSentenceId, updatedAt: new Date().toISOString() };
  state.progress[lessonId] = created;
  return created;
}

/* ---------------- 学习端写操作（均产出可交接改动） ---------------- */

export function saveAnswerDraft(lessonId: string, sentenceId: string, answer: string) {
  const progress = ensureProgress(lessonId, sentenceId);
  if ((progress.answers[sentenceId] ?? '') === answer) return;
  const from = progress.answers[sentenceId] ?? '';
  progress.answers[sentenceId] = answer;
  progress.activeSentenceId = sentenceId;
  progress.updatedAt = new Date().toISOString();
  emitChange('answerDraft', lessonId, { sentenceId, from, to: answer }, true);
}

export function markActiveSentence(lessonId: string, sentenceId: string) {
  const progress = ensureProgress(lessonId, sentenceId);
  progress.activeSentenceId = sentenceId;
  progress.updatedAt = new Date().toISOString();
}

export function saveAttempt(attempt: PracticeAttempt) {
  state.attempts.unshift(attempt);
  attempt.lessonHash = lessonHashOf(attempt.lessonId);
  emitChange('attempt', attempt.lessonId, { attemptId: attempt.id, to: structuredClone(attempt) }, false);
}

export function updateTokenClassification(
  attemptId: string,
  lessonId: string,
  sentenceId: string,
  tokenIndex: number,
  patch: { category: ErrorCategory; reason: string }
) {
  const attempt = state.attempts.find((item) => item.id === attemptId);
  const token = attempt?.sentenceAttempts.find((item) => item.sentenceId === sentenceId)?.tokens.find((item) => item.index === tokenIndex);
  if (!token) return;
  if (token.category === patch.category && token.reason === patch.reason) return;
  const from: TokenPatch = { category: token.category, reason: token.reason };
  const to: TokenPatch = { ...patch };
  token.category = patch.category;
  token.reason = patch.reason;
  emitChange('tokenClass', lessonId, {
    sentenceId,
    attemptId,
    tokenIndex,
    lessonHash: attempt?.lessonHash ?? lessonHashOf(lessonId),
    from,
    to
  }, true);
}

export function persistTeacherFeedback(attemptId: string, feedback: string) {
  const attempt = state.attempts.find((item) => item.id === attemptId);
  if (!attempt) return;
  const trimmed = feedback.trim();
  if ((attempt.teacherFeedback ?? '') === trimmed) return;
  const from = attempt.teacherFeedback ?? '';
  attempt.teacherFeedback = trimmed;
  emitChange('feedback', attempt.lessonId, { attemptId, from, to: trimmed }, true);
}

export function renameDevice(name: string) {
  const trimmed = name.trim() || '本机';
  state.deviceName = trimmed;
  state.knownDevices[state.deviceId] = trimmed;
}

/* ---------------- 导出 / 导入交接码 ---------------- */

/** 未导出的本机改动数量。 */
export const pendingChangeCount = (): number =>
  state.journal.filter((change) => change.device === state.deviceId && change.seq > (state.lastExportedSeq[state.deviceId] ?? 0)).length;

export function exportHandoff(): string {
  const code = encodeHandoff(state);
  // 记录水位：此后同一字段的新编辑会另起或合并为新改动，不再改写已导出的内容。
  state.lastExportedSeq[state.deviceId] = state.deviceSeq;
  persist();
  return code;
}

export { previewImport };

export interface CommitResult {
  ok: boolean;
  message: string;
  result: Awaited<ReturnType<typeof commitImport>>['result'];
}

/**
 * 提交一次交接合并。失败时 state 与 localStorage 都保持导入前内容，可直接重试。
 */
export async function importHandoff(code: string, resolutions: Record<string, ConflictSide> = {}): Promise<CommitResult> {
  const before = JSON.stringify(state);
  const capacityOptions: { capacityBytes?: number; usedBytes?: number } = {};
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      if (typeof estimate.quota === 'number') {
        capacityOptions.capacityBytes = estimate.quota;
        capacityOptions.usedBytes = estimate.usage ?? undefined;
      }
    } catch {
      // 拿不到配额就只依赖写入时的真实异常兜底。
    }
  }
  const outcome = await commitImport(state, code, resolutions, { storageKey: STORAGE_KEY, ...capacityOptions });
  if (!outcome.ok) {
    const fallback = JSON.parse(before) as PersistedState;
    Object.assign(state, fallback);
    return { ok: false, message: outcome.result.errorMessage ?? '合并未完成，原记录已保留。', result: outcome.result };
  }
  if (outcome.result.candidate) {
    Object.assign(state, outcome.result.candidate);
    persist();
  }
  return { ok: true, message: '合并完成。', result: outcome.result };
}

/* ---------------- 记录导出 / 重置 ---------------- */

export function exportRecords(): string {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    application: 'EchoStep 移动听写',
    device: { id: state.deviceId, name: state.deviceName },
    attempts: state.attempts,
    progress: state.progress
  }, null, 2);
}

export function resetDemo() {
  const fresh = createInitialState();
  // 重置演示时沿用本机设备身份，避免变成“另一台设备”。
  fresh.deviceId = state.deviceId;
  fresh.deviceName = state.deviceName;
  Object.assign(state, fresh);
}
