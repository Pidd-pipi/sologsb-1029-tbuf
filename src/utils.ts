import type { SentenceAttempt, TextSegment, TokenResult } from './types';
import type { Lesson } from './types';

export const segmentText = (text: string): TextSegment[] => {
  const matches = text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]+/gu) ?? [];
  return matches.map((display, index) => ({
    index,
    display,
    normalized: normalizeToken(display)
  }));
};

export const normalizeToken = (token: string): string => token
  .toLocaleLowerCase('en')
  .replaceAll('’', "'")
  .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

export function compareSentence(expected: string, answer: string): TokenResult[] {
  const expectedTokens = segmentText(expected);
  const actualTokens = segmentText(answer);
  const rows = expectedTokens.length + actualTokens.length;
  const table = Array.from({ length: rows + 1 }, () => Array<number>(rows + 1).fill(0));
  const move = Array.from({ length: rows + 1 }, () => Array<string>(rows + 1).fill(''));

  for (let i = 0; i <= expectedTokens.length; i += 1) {
    table[i][0] = i;
    move[i][0] = 'delete';
  }
  for (let j = 0; j <= actualTokens.length; j += 1) {
    table[0][j] = j;
    move[0][j] = 'insert';
  }

  for (let i = 1; i <= expectedTokens.length; i += 1) {
    for (let j = 1; j <= actualTokens.length; j += 1) {
      const substitution = table[i - 1][j - 1] + (expectedTokens[i - 1].normalized === actualTokens[j - 1].normalized ? 0 : 1);
      const deletion = table[i - 1][j] + 1;
      const insertion = table[i][j - 1] + 1;
      table[i][j] = Math.min(substitution, deletion, insertion);
      move[i][j] = substitution <= deletion && substitution <= insertion
        ? 'match'
        : deletion <= insertion ? 'delete' : 'insert';
    }
  }

  const reversed: TokenResult[] = [];
  let i = expectedTokens.length;
  let j = actualTokens.length;
  while (i > 0 || j > 0) {
    const direction = move[i][j];
    if (direction === 'match' && i > 0 && j > 0) {
      const expectedToken = expectedTokens[i - 1];
      const actualToken = actualTokens[j - 1];
      const correct = expectedToken.normalized === actualToken.normalized;
      reversed.push({
        index: i - 1,
        expected: expectedToken.display,
        actual: actualToken.display,
        correct,
        category: correct ? 'unclassified' : 'spelling',
        reason: ''
      });
      i -= 1;
      j -= 1;
    } else if (direction === 'delete' && i > 0) {
      reversed.push({ index: i - 1, expected: expectedTokens[i - 1].display, actual: '', correct: false, category: 'omitted', reason: '' });
      i -= 1;
    } else if (j > 0) {
      reversed.push({ index: Math.max(0, i - 1), expected: '', actual: actualTokens[j - 1].display, correct: false, category: 'extra', reason: '' });
      j -= 1;
    } else {
      break;
    }
  }

  const result = reversed.reverse();
  return result.map((token, index) => ({ ...token, index }));
}

export function scoreSentence(tokens: TokenResult[]): number {
  if (!tokens.length) return 0;
  return Math.round((tokens.filter((token) => token.correct).length / tokens.length) * 100);
}

export function scoreAttempt(sentenceAttempts: SentenceAttempt[]): number {
  const totals = sentenceAttempts.flatMap((attempt) => attempt.tokens);
  if (!totals.length) return 0;
  const correct = totals.filter((token) => token.correct).length;
  return Math.max(0, Math.round((correct / totals.length) * 100));
}

/**
 * 课程版本指纹：只由句子 id 与原文决定，句子文本一变，指纹就变。
 * 不包含 downloaded 等仅本机的标记。
 */
export function lessonFingerprint(lesson: Lesson): string {
  const raw = lesson.sentences.map((sentence) => `${sentence.id}${sentence.text}`).join('');
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `lh-${(hash + raw.length).toString(36)}`;
}

/** 生成设备号：一次安装长期固定。 */
export function createDeviceId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `dev-${Date.now().toString(36)}-${rand}`;
}

/**
 * 课程内容升级后，用保存下来的答案重新比对一句。
 * 用户原有的错词分类/错因不自动沿用（分类指向的可能已不是同一处错误）。
 */
export function recomputeSentenceAttempt(attempt: SentenceAttempt, currentText: string): SentenceAttempt {
  if (attempt.source === currentText) return attempt;
  const tokens = compareSentence(currentText, attempt.answer);
  return {
    ...attempt,
    source: currentText,
    tokens,
    score: scoreSentence(tokens),
    recomputed: true,
    stale: false
  };
}
