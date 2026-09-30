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
  version: number;
  title: string;
  description: string;
  level: string;
  accent: string;
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
  /** 课程内容升级后，本句错词已按新课程重新比对计算。 */
  recomputed?: boolean;
  /** 新课程里已找不到原句，保留旧记录但不再参与重算。 */
  stale?: boolean;
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
  /** 提交时对应的课程句子指纹，用于跨设备判断课程版本。 */
  lessonHash?: string;
}

export interface LessonProgress {
  answers: Record<string, string>;
  activeSentenceId: string;
  updatedAt: string;
}

/** 可跨设备交接的改动类型。 */
export type SyncKind = 'answerDraft' | 'attempt' | 'tokenClass' | 'feedback';

/** 错词分类 + 错因的整体补丁。 */
export interface TokenPatch {
  category: ErrorCategory;
  reason: string;
}

/**
 * 单条交接改动：device + seq 在该设备上单调递增，
 * 任何设备重复收到都按 (device, seq) 跳过，保证重复导入不重复生效。
 */
export interface SyncChange {
  device: string;
  seq: number;
  at: string;
  kind: SyncKind;
  lessonId: string;
  sentenceId?: string;
  attemptId?: string;
  tokenIndex?: number;
  /** 改动产生时的课程指纹；与当前课程不一致时，错词类改动失效。 */
  lessonHash?: string;
  /** 三方合并的共同基线值（答案/反馈为字符串，错词为 TokenPatch）。 */
  from?: string | TokenPatch | null;
  /** 改动后的新值（attempt 类型时为整份 PracticeAttempt）。 */
  to?: string | TokenPatch | PracticeAttempt | null;
}

export interface HandoffEnvelope {
  format: 'echostep-handoff';
  envelopeVersion: 1;
  exportedAt: string;
  device: { id: string; name: string };
  /** 导出方日志中出现过的设备号 → 名称，便于冲突时辨认来源。 */
  devices: Record<string, string>;
  /** 导出方已知的课程指纹。 */
  lessons: Record<string, string>;
  changes: SyncChange[];
}

export type ConflictKind = 'answerDraft' | 'tokenClass' | 'feedback';
export type ConflictSide = 'local' | 'incoming';

export interface ImportConflict {
  id: string;
  kind: ConflictKind;
  lessonId: string;
  lessonTitle: string;
  sentenceId?: string;
  /** 句子在课节中的序号（从 1 开始），便于人工辨认。 */
  sentenceOrdinal?: number;
  attemptId?: string;
  tokenIndex?: number;
  /** 冲突错词对应的原词。 */
  expectedWord?: string;
  localLabel: string;
  incomingLabel: string;
  localValue: string | TokenPatch;
  incomingValue: string | TokenPatch;
  localDevice: string;
  incomingDevice: string;
  localDeviceName: string;
  incomingDeviceName: string;
}

export interface ImportStats {
  attempts: number;
  answers: number;
  classifications: number;
  feedback: number;
  /** 因课程版本变化被失效重算的错词句数 / 丢弃的旧分类数。 */
  recomputedSentences: number;
  droppedClassifications: number;
}

export interface ImportResult {
  ok: boolean;
  errorCode?: 'bad-code' | 'missing-sentence' | 'capacity' | 'unresolved' | 'write-failed';
  errorMessage?: string;
  conflicts: ImportConflict[];
  stats: ImportStats;
  notices: string[];
  candidate: PersistedState | null;
  incomingDevice: { id: string; name: string } | null;
}

export interface PersistedState {
  schemaVersion: 2;
  deviceId: string;
  deviceName: string;
  /** 本机已用掉的最大序号。 */
  deviceSeq: number;
  /** 累计改动日志（含导入的其他设备改动），导出时整包带走。 */
  journal: SyncChange[];
  /** 每台设备已生效的最大序号，用于幂等去重。 */
  appliedSeq: Record<string, number>;
  /** 本机上次导出时的序号水位，未导出的连续编辑就地合并。 */
  lastExportedSeq: Record<string, number>;
  /** 上次写入时各课节的句子指纹，用于课程版本变化检测。 */
  lessonHashes: Record<string, string>;
  /** 交接中遇到过的设备号 → 名称，冲突时显示来源。 */
  knownDevices: Record<string, string>;
  courses: Course[];
  attempts: PracticeAttempt[];
  progress: Record<string, LessonProgress>;
  activeLessonId: string;
  activeSentenceId: string;
  theme: ThemeMode;
  fontScale: number;
  role: 'learner' | 'teacher';
}

export interface TextSegment {
  index: number;
  display: string;
  normalized: string;
}
