export type ErrorCategory = 'unclassified' | 'spelling' | 'omitted' | 'extra' | 'punctuation' | 'grammar';
export type PracticeView = 'library' | 'practice' | 'result' | 'teacher';
export type ThemeMode = 'light' | 'dark';

export interface Sentence {
  id: string;
  text: string;
  translation: string;
  note: string;
}

export interface Lesson {
  id: string;
  courseId: string;
  title: string;
  subtitle: string;
  level: string;
  estimatedMinutes: number;
  downloaded: boolean;
  sentences: Sentence[];
}

export interface Course {
  id: string;
  title: string;
  description: string;
  level: string;
  accent: string;
  /** Content version; bumped when sentence text/ids change so imports can invalidate stale results. */
  version: number;
  lessons: Lesson[];
}

export interface TokenResult {
  index: number;
  expected: string;
  actual: string;
  correct: boolean;
  category: ErrorCategory;
  reason: string;
}

export interface SentenceAttempt {
  sentenceId: string;
  source: string;
  answer: string;
  tokens: TokenResult[];
  score: number;
}

export interface PracticeAttempt {
  id: string;
  lessonId: string;
  lessonTitle: string;
  courseTitle: string;
  submittedAt: string;
  score: number;
  sentenceAttempts: SentenceAttempt[];
  teacherFeedback: string;
}

export interface LessonProgress {
  answers: Record<string, string>;
  activeSentenceId: string;
  updatedAt: string;
}

/**
 * A single synced change. Every mergeable mutation is recorded as an append-only
 * op tagged with the originating device and a per-device monotonic sequence number.
 * The op id (`${deviceId}:${seq}`) is globally unique and makes repeated imports idempotent.
 */
export interface BaseOp {
  id: string;
  deviceId: string;
  seq: number;
  createdAt: string;
}

export type Op =
  | (BaseOp & { type: 'draft'; lessonId: string; sentenceId: string; answer: string })
  | (BaseOp & { type: 'classification'; attemptId: string; sentenceId: string; tokenIndex: number; category: ErrorCategory; reason: string })
  | (BaseOp & { type: 'feedback'; attemptId: string; feedback: string })
  | (BaseOp & { type: 'attempt'; attempt: PracticeAttempt })
  | (BaseOp & { type: 'download'; lessonId: string; downloaded: boolean });

/** A conflict surfaced to the user when both sides changed the same field differently. */
export interface Conflict {
  id: string;
  kind: 'draft' | 'classification';
  label: string;
  localValue: string;
  incomingValue: string;
  /** Exact resolution payloads (display strings are lossy for category+reason). */
  localAnswer?: string;
  incomingAnswer?: string;
  localCategory?: ErrorCategory;
  localReason?: string;
  incomingCategory?: ErrorCategory;
  incomingReason?: string;
  /** Target coordinates used when applying the resolution. */
  lessonId?: string;
  sentenceId?: string;
  attemptId?: string;
  tokenIndex?: number;
  resolution?: 'local' | 'incoming';
}

/** The portable handover record exported from one device and imported on another. */
export interface HandoverRecord {
  schemaVersion: 2;
  deviceId: string;
  exportedAt: string;
  courses: Course[];
  attempts: PracticeAttempt[];
  progress: Record<string, LessonProgress>;
  opLog: Op[];
  appliedOps: string[];
}

export interface PersistedState {
  schemaVersion: 2;
  deviceId: string;
  courses: Course[];
  attempts: PracticeAttempt[];
  progress: Record<string, LessonProgress>;
  activeLessonId: string;
  activeSentenceId: string;
  theme: ThemeMode;
  fontScale: number;
  role: 'learner' | 'teacher';
  /** Append-only change log; source of truth for idempotent import and conflict detection. */
  opLog: Op[];
  /** Op ids already applied to this device, so re-importing the same record is a no-op. */
  appliedOps: string[];
}

export interface TextSegment {
  index: number;
  display: string;
  normalized: string;
}
