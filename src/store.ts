import { nextTick, reactive, ref, watch } from 'vue';
import { createInitialState } from './data';
import {
  applyConflictResolutions,
  buildOp,
  decodeHandover,
  encodeHandover,
  getOrCreateDeviceId,
  hasCapacityFor,
  mergeHandover,
  migrateV1ToV2,
  type MergeResult,
} from './handover';
import type { Conflict, HandoverRecord, Lesson, PersistedState, PracticeAttempt } from './types';

const STORAGE_KEY = 'sologsb-1029-dictation-state-v1';

function loadState(): PersistedState {
  const deviceId = getOrCreateDeviceId();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedState & { schemaVersion?: number };
      if (parsed.schemaVersion === 2) return parsed;
      if (parsed.schemaVersion === 1) return migrateV1ToV2(parsed as unknown as Record<string, unknown>, deviceId);
    }
  } catch {
    // Falls back to the sample course when the local draft is malformed.
  }
  return createInitialState(deviceId);
}

export const state = reactive<PersistedState>(loadState());

/**
 * When true, mutations do not record ops. Used during merge reconciliation and
 * state replacement so that imported data doesn't spawn duplicate local ops.
 */
let suppressOps = false;

export const persist = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
};

watch(state, persist, { deep: true });

export const lessons = (): Lesson[] => state.courses.flatMap((course) => course.lessons);
export const lessonById = (id: string): Lesson | undefined => lessons().find((lesson) => lesson.id === id);
export const courseForLesson = (lessonId: string) => state.courses.find((course) => course.id === lessonById(lessonId)?.courseId);

// ---------------------------------------------------------------------------
// Mutations (each records a synced op unless suppressed)
// ---------------------------------------------------------------------------

export function setDownloaded(lessonId: string, value: boolean) {
  const lesson = lessonById(lessonId);
  if (!lesson) return;
  lesson.downloaded = value;
  if (!suppressOps) state.opLog.push(buildOp(state, { type: 'download', lessonId, downloaded: value }));
}

export function saveAttempt(attempt: PracticeAttempt) {
  state.attempts.unshift(attempt);
  if (!suppressOps) state.opLog.push(buildOp(state, { type: 'attempt', attempt }));
}

export function updateTokenClassification(
  attemptId: string,
  sentenceId: string,
  tokenIndex: number,
  patch: { category?: PracticeAttempt['sentenceAttempts'][number]['tokens'][number]['category']; reason?: string },
) {
  const attempt = state.attempts.find((item) => item.id === attemptId);
  const token = attempt?.sentenceAttempts.find((item) => item.sentenceId === sentenceId)?.tokens.find((item) => item.index === tokenIndex);
  if (!token) return;
  Object.assign(token, patch);
  if (!suppressOps) {
    state.opLog.push(buildOp(state, {
      type: 'classification',
      attemptId,
      sentenceId,
      tokenIndex,
      category: token.category,
      reason: token.reason,
    }));
  }
}

/** Record a draft-answer op for a sentence (called from the answer watcher). */
export function recordDraftChange(lessonId: string, sentenceId: string, answer: string) {
  if (suppressOps) return;
  state.opLog.push(buildOp(state, { type: 'draft', lessonId, sentenceId, answer }));
}

/** Record a teacher-feedback op for an attempt. */
export function recordFeedbackChange(attemptId: string, feedback: string) {
  if (suppressOps) return;
  state.opLog.push(buildOp(state, { type: 'feedback', attemptId, feedback }));
}

// ---------------------------------------------------------------------------
// Handover export / import
// ---------------------------------------------------------------------------

export function buildHandoverRecord(): HandoverRecord {
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

export function exportHandoverCode(): string {
  return encodeHandover(buildHandoverRecord());
}

export interface ImportOutcome {
  ok: boolean;
  error?: string;
  conflicts?: Conflict[];
  stats?: MergeResult['stats'];
}

/**
 * Parse and merge a handover code. On conflict, returns the conflicts without
 * writing; the caller resolves them via `commitResolvedImport`. On hard failure
 * (bad code, missing sentence, quota) the pre-import state is restored.
 */
export function importHandoverCode(code: string): ImportOutcome {
  const snapshot = JSON.stringify(state);
  try {
    const incoming = decodeHandover(code);
    const result = mergeHandover(state, incoming);
    if (result.conflicts.length) {
      // Hold the merged result for the conflict-resolution step.
      pendingImport.value = { result, snapshot };
      return { ok: true, conflicts: result.conflicts, stats: result.stats };
    }
    commitMergedState(result.merged);
    return { ok: true, stats: result.stats };
  } catch (err) {
    restoreSnapshot(snapshot);
    return { ok: false, error: err instanceof Error ? err.message : '导入失败，已恢复原记录' };
  }
}

/** The in-flight merge awaiting conflict resolution. */
const pendingImport = ref<{ result: MergeResult; snapshot: string } | null>(null);

export function getPendingConflicts(): Conflict[] {
  return pendingImport.value?.result.conflicts ?? [];
}

/** Apply the user's conflict choices and commit the merged state. */
export function commitResolvedImport(): ImportOutcome {
  const pending = pendingImport.value;
  if (!pending) return { ok: false, error: '没有待处理的导入' };
  const { result, snapshot } = pending;
  try {
    applyConflictResolutions(result.merged, result.conflicts);
    commitMergedState(result.merged);
    pendingImport.value = null;
    return { ok: true, stats: result.stats };
  } catch (err) {
    restoreSnapshot(snapshot);
    pendingImport.value = null;
    return { ok: false, error: err instanceof Error ? err.message : '导入失败，已恢复原记录' };
  }
}

export function cancelPendingImport() {
  const pending = pendingImport.value;
  if (pending) restoreSnapshot(pending.snapshot);
  pendingImport.value = null;
}

function commitMergedState(merged: PersistedState) {
  if (!hasCapacityFor(merged)) {
    throw new Error('本机容量不足，已拒绝合并并保留原记录');
  }
  suppressOps = true;
  try {
    Object.assign(state, merged);
  } finally {
    // Keep suppression until after watchers flush so the merged state
    // doesn't spawn duplicate local ops.
    nextTick(() => { suppressOps = false; });
  }
  if (!persist()) {
    throw new Error('写入本机存储失败，已恢复导入前内容');
  }
}

function restoreSnapshot(snapshot: string) {
  try {
    const parsed = JSON.parse(snapshot) as PersistedState;
    suppressOps = true;
    try {
      Object.assign(state, parsed);
    } finally {
      nextTick(() => { suppressOps = false; });
    }
    persist();
  } catch {
    // Last resort: reload from storage.
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(state, JSON.parse(raw));
  }
}

// ---------------------------------------------------------------------------
// Records export
// ---------------------------------------------------------------------------

export function exportRecords(): string {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    application: 'EchoStep 移动听写',
    deviceId: state.deviceId,
    attempts: state.attempts,
    progress: state.progress
  }, null, 2);
}

export function resetDemo() {
  const fresh = createInitialState(state.deviceId);
  suppressOps = true;
  try {
    Object.assign(state, fresh);
  } finally {
    nextTick(() => { suppressOps = false; });
  }
}
