import type { CandidateFrame, RunText, RunTextDetail } from '../types';

/** The text read on the screens of a run: how far it is, and finding words in it. */

/** Lower case, without accents, with single spaces: so that "Réglages " is found by "reglages". */
export function foldText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every word that is looked for, as it begins or stands in the text; words between quotation marks as one. */
export function searchWords(query: string): string[] {
  const words: string[] = [];
  for (const match of query.matchAll(/["“”]([^"“”]+)["“”]|\S+/g)) {
    const word = foldText(match[1] ?? match[0].replace(/["“”]/g, ''));
    if (word) words.push(word);
  }
  return words;
}

/** The steps whose text has every word that is looked for; null when nothing is looked for. */
export function stepsWithText(detail: RunTextDetail | undefined, query: string): Set<string> | null {
  const words = searchWords(query);
  if (!words.length || !detail) return null;
  const found = new Set<string>();
  for (const step of detail.steps) {
    const text = foldText(step.text ?? '');
    if (text && words.every((word) => text.includes(word))) found.add(step.candidate_id);
  }
  return found;
}

export interface RunTextNotice {
  kind: 'none' | 'reading' | 'problem' | 'earlier' | 'partly' | 'read';
  /** What to say; empty when there is nothing to say. */
  label: string;
  /** What can be done about it, as the button says it. */
  action: { does: 'read' | 'stop'; label: string } | null;
  title?: string;
}

export const EARLIER_TEXT =
  'text read by a version before 1.4.6 can be wrong: it could give a screen the text of an earlier one that looked much like it';

function steps(count: number): string {
  return `${count} ${count === 1 ? 'step' : 'steps'}`;
}

/** How far the text of a run with so many steps is, in words, and what to do next. */
export function runTextNotice(text: RunText, total: number): RunTextNotice {
  if (text.waiting > 0) {
    const done = Math.max(0, total - text.waiting);
    return {
      kind: 'reading',
      label: `reading text, ${done} of ${total}`,
      action: { does: 'stop', label: 'stop' },
      title: 'the text is read in the background. you can go on, and close the page',
    };
  }
  if (text.problem) {
    return { kind: 'problem', label: `text was not read. ${sentence(text.problem)}`, action: { does: 'read', label: 'try again' } };
  }
  if (text.earlier > 0) {
    return {
      kind: 'earlier',
      label: text.read > 0 ? `text of ${steps(text.earlier)} read by an earlier version` : 'text read by an earlier version',
      action: { does: 'read', label: 'read again' },
      title: EARLIER_TEXT,
    };
  }
  const missing = Math.max(0, total - text.read);
  if (text.read > 0 && missing > 0) {
    return {
      kind: 'partly',
      label: `text of ${steps(missing)} ${text.failed >= missing ? 'could not be read' : 'not read'}`,
      action: { does: 'read', label: text.failed >= missing ? 'try again' : missing === 1 ? 'read it' : 'read them' },
    };
  }
  if (text.read > 0 || total === 0) {
    return { kind: 'read', label: '', action: null };
  }
  if (text.failed > 0) {
    return { kind: 'partly', label: 'text could not be read', action: { does: 'read', label: 'try again' } };
  }
  return {
    kind: 'none',
    label: '',
    action: { does: 'read', label: 'read text' },
    title: 'read the text on every screenshot, to show, search and export it',
  };
}

/** Lower case at the start, as the app writes, and one full stop at the end. */
function sentence(words: string): string {
  return words.charAt(0).toLocaleLowerCase() + words.slice(1);
}

/** Whether there is text to show or to search. */
export function hasText(text: RunText): boolean {
  return text.read + text.earlier > 0;
}

/** What a step says about its text when there are no lines to show. */
export function stepTextNote(candidate: Pick<CandidateFrame, 'text_state'>): string {
  switch (candidate.text_state) {
    case 'waiting':
      return 'waiting to be read';
    case 'failed':
      return 'the text of this screenshot could not be read';
    case 'read':
    case 'earlier':
      return 'no text on this screen';
    default:
      return 'the text of this screenshot has not been read';
  }
}
