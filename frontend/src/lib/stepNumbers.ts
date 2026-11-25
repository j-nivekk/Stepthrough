/**
 * What steps are called, in the review and in the pathway.
 *
 * A step is a change of the screen. Nothing led to the screen a recording starts on, so it is where the steps start
 * and not one of them: number 0 in the files, "start" here. The first step is the change that leaves it. The numbers
 * themselves come from the server (backend/app/services/export.py and pathway.py), the same as in steps.csv.
 */
import type { AcceptedStep, CandidateFrame, PathwayStep } from '../types';
import type { SimilarLink } from './analysis';

/** The opening screen, where other steps have a number. */
export const START = 'start';

/** On the line of a return the reviewer added, where a move has the number of the step it leads to. */
export const BACK = 'back';

const shown = (number: string): string => (number === '0' ? START : number);

/** "step 5", or just "start". */
export const stepName = (number: string): string => (number === START ? START : `step ${number}`);

// ── in the review: accepted steps have the number they have in the pathway and the files, the others are candidates ──

export interface ReviewNumber {
  /** "5" or "start". */
  number: string;
  /** "step 5", "start", or "candidate 7" for a screenshot that is not (or not yet) accepted. */
  name: string;
  /** As in "same as 5": the number of an accepted step, the name of a candidate. */
  short: string;
}

export function candidateNumber(index: number): ReviewNumber {
  const name = `candidate ${index}`;
  return { number: String(index), name, short: name };
}

/**
 * What every screenshot of a run is called, by candidate id. Candidates count in the order they were found, from 0 for
 * the opening screen as well, so that a candidate has the same number as the step it becomes when all are accepted.
 */
export function reviewNumbers(candidates: CandidateFrame[], acceptedSteps: AcceptedStep[]): Map<string, ReviewNumber> {
  const steps = new Map(acceptedSteps.map((step) => [step.source_candidate_id, step.step_index]));
  const first = candidates.some((candidate) => candidate.score_breakdown?.transition_type === 'opening_screen') ? 1 : 0;
  return new Map(
    candidates.map((candidate) => {
      const index = steps.get(candidate.id);
      if (index === undefined) return [candidate.id, candidateNumber(candidate.detector_index - first)];
      const number = shown(String(index));
      return [candidate.id, { number, name: stepName(number), short: number }];
    }),
  );
}

/**
 * Where the user went back to after a step, for the accepted steps the reviewer said so of (in the pathway): what to
 * call it, and the step to jump to, by candidate id.
 */
export function returnLinks(candidates: CandidateFrame[], numbers: Map<string, ReviewNumber>): Map<string, SimilarLink> {
  const links = new Map<string, SimilarLink>();
  for (const candidate of candidates) {
    const to = candidate.status === 'accepted' && candidate.returns_to ? numbers.get(candidate.returns_to) : undefined;
    if (!to) continue;
    const name = to.name === START ? `the ${START}` : to.name;
    links.set(candidate.id, { targetId: `candidate-${candidate.returns_to}`, label: `then back to ${name}` });
  }
  return links;
}

/**
 * The earlier step of which this one shows the screen again, with other screens in between, as the engine found it
 * (a screen that is the same as just before, scrolled or changed a little, is no return).
 */
export function returnsTo(candidate: CandidateFrame, candidates: CandidateFrame[]): CandidateFrame | undefined {
  if (candidate.same_screen_reason !== 'same_page' && candidate.same_screen_reason !== 'overlay_closed') return undefined;
  const found = candidates.filter((each) => each.candidate_origin !== 'manual');
  const position = found.findIndex((each) => each.id === candidate.id);
  const earlier = found.findIndex((each) => each.id === candidate.same_screen_as);
  return earlier >= 0 && earlier < position - 1 ? found[earlier] : undefined;
}

// ── in the pathway ──

type Numbered = Pick<PathwayStep, 'step_index' | 'path_step'>;

/**
 * The step's number in the pathway. With the optional detours left out (`leaveOut`), the numbers count on along the
 * main way, and the steps of a detour have a letter after the step they leave from: 13a, 13b.
 */
export const pathwayNumber = (step: Numbered, leaveOut = false): string =>
  shown(leaveOut ? step.path_step ?? String(step.step_index) : String(step.step_index));

/** "7–12", or "13a–d" for a stretch of one detour. */
export function numberRange(first: string, last: string): string {
  if (first === last) return first;
  const [, from, fromLetters] = /^(\d+)([a-z]+)$/.exec(first) ?? [];
  const [, to, toLetters] = /^(\d+)([a-z]+)$/.exec(last) ?? [];
  return `${first}–${fromLetters && from === to ? toLetters : last}`;
}

/** A stretch of steps from one to another: "step 5", "steps 7–12", "start to step 5". */
export function stretchName(first: string, last: string): string {
  if (first === last) return stepName(first);
  return first === START ? `${START} to ${stepName(last)}` : `steps ${numberRange(first, last)}`;
}

/** The steps of a box or a selection, in order: "step 5", "steps 7–12 and 21", "start and steps 1–2". */
export function stepsPhrase(steps: Array<Numbered & Pick<PathwayStep, 'detour'>>, leaveOut = false): string {
  // Stretches of steps in a row; with the detours left out, a detour's steps are a stretch of their own.
  const stretches: Array<{ first: Numbered; last: Numbered; detour: boolean }> = [];
  for (const step of steps) {
    if (step.step_index === 0) continue;
    const current = stretches[stretches.length - 1];
    const detour = leaveOut && Boolean(step.detour);
    if (current && current.detour === detour && step.step_index === current.last.step_index + 1) current.last = step;
    else stretches.push({ first: step, last: step, detour });
  }
  const numbers = stretches.map(({ first, last }) => numberRange(pathwayNumber(first, leaveOut), pathwayNumber(last, leaveOut)));
  const start = steps.some((step) => step.step_index === 0);
  if (!numbers.length) return start ? START : 'step';
  const list = numbers.length > 1 ? `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}` : numbers[0];
  const many = numbers.length > 1 || stretches[0].first !== stretches[0].last;
  const rest = `${many ? 'steps' : 'step'} ${list}`;
  return start ? `${START}${numbers.length > 1 ? ',' : ' and'} ${rest}` : rest;
}
