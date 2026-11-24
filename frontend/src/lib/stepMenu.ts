/**
 * What the right-click menu of the steps views offers: for one step, or for the selected steps when the step clicked is
 * one of several. Plain data from plain data, so it can be tested without a page (components/ActionMenu.tsx shows it).
 */
import type { ActionItem } from '../components/ActionMenu';
import type { CandidateChanges, CandidateFrame, CandidateStatus } from '../types';
import type { SimilarLink } from './analysis';
import type { ReturnTarget } from './pathwayReturns';
import type { StepView } from './stepLayout';
import type { ReviewNumber } from './stepNumbers';

export interface StepMenuActions {
  setStatus: (candidate: CandidateFrame, status: CandidateStatus) => void;
  /** Every selected step at once, leaving those that are so already. */
  setStatusOfSelected: (status: CandidateStatus) => void;
  update: (candidateId: string, changes: CandidateChanges) => void;
  updateSeveral: (changes: Array<[string, CandidateChanges]>) => void;
  /** The steps from one to another, in or out ('') of a phase; null asks for the name of a new one. */
  setPhase: (first: CandidateFrame, last: CandidateFrame, name: string | null) => void;
  playFromHere: (candidate: CandidateFrame) => void;
  openScreenshot: (candidate: CandidateFrame) => void;
  /** Opens or closes the notes of a card; elsewhere, where they are always open, goes to the title. */
  annotate: (candidate: CandidateFrame) => void;
  jumpTo: (targetId: string) => void;
  toggleSelection: (candidateId: string, shift: boolean) => void;
  invertSelection: () => void;
  clearSelection: () => void;
}

export interface StepMenuContext {
  /** The step clicked. */
  step: CandidateFrame;
  /** The steps selected among those shown, in order. */
  selected: CandidateFrame[];
  /** Every step of the run, in order. */
  steps: CandidateFrame[];
  view: StepView;
  /** The notes of the step's card are open. */
  annotating: boolean;
  /** A step was selected before, so that a range can be selected from it. */
  anchor: string | null;
  /** The names of the run's phases, in order, and the one the moment of a step is in. */
  phases: string[];
  phaseAt: (ms: number) => string;
  numberOf: (candidate: CandidateFrame) => ReviewNumber;
  similar?: SimilarLink;
  back?: SimilarLink;
  thumbOf: (imageUrl: string) => string;
  /** The screens the user may have gone back to after `returningStep`; undefined while the pathway loads. */
  returns?: ReturnTarget[];
  isPopup: (candidate: CandidateFrame) => boolean;
  popupChange: (candidate: CandidateFrame, popup: boolean) => CandidateChanges;
  actions: StepMenuActions;
}

const DECISIONS: Array<[CandidateStatus, string, string]> = [
  ['accepted', 'accept', 'A'],
  ['rejected', 'reject', 'R'],
  ['pending', 'reset', 'U'],
];
const TICK = '✓';

/** Whether the menu is for the selected steps: the step clicked is one of several. */
export const forSelection = ({ step, selected }: Pick<StepMenuContext, 'step' | 'selected'>): boolean =>
  selected.length > 1 && selected.some((each) => each.id === step.id);

export const stepMenuHeading = (context: Pick<StepMenuContext, 'step' | 'selected' | 'numberOf'>): string =>
  forSelection(context) ? `${context.selected.length} selected steps` : context.numberOf(context.step).name;

export function stepMenuItems(context: StepMenuContext): ActionItem[] {
  return forSelection(context) ? itemsOfSeveral(context) : itemsOfOne(context);
}

/** The step after which the user may have gone back: the one clicked, or the last of several, when it is accepted. */
export function returningStep(context: Pick<StepMenuContext, 'step' | 'selected'>): CandidateFrame | undefined {
  if (!forSelection(context)) return context.step.status === 'accepted' ? context.step : undefined;
  const accepted = context.selected.filter((each) => each.status === 'accepted');
  return accepted[accepted.length - 1];
}

/** Where the user went back to after a step, as in the pathway; nothing for a step with nowhere to go back to. */
function returnItem(context: StepMenuContext, step: CandidateFrame, label: string): ActionItem[] {
  const { returns, thumbOf, actions } = context;
  if (!returns) return [{ label, hint: '…', disabled: true }];
  if (!returns.length && !step.returns_to) return [];
  return [
    {
      label,
      items: [
        ...(step.returns_to ? [{ label: 'no return', run: () => actions.update(step.id, { returns_to: 'auto' }) }] : []),
        ...returns.map((target, index): ActionItem => ({
          label: target.label,
          hint: target.current ? TICK : undefined,
          thumb: target.imageUrl ? thumbOf(target.imageUrl) : undefined,
          divider: index === 0 && Boolean(step.returns_to),
          run: () => actions.update(step.id, { returns_to: target.id }),
        })),
      ],
    },
  ];
}

/** The phases to put a stretch of accepted steps in; `current` is the one it is in, when it is all in one. */
function phaseItems(context: StepMenuContext, first: CandidateFrame, last: CandidateFrame, current: string | null): ActionItem[] {
  const { phases, actions } = context;
  return [
    ...phases.map((name): ActionItem => ({ label: name, hint: name === current ? TICK : undefined, run: () => actions.setPhase(first, last, name) })),
    { label: 'no phase', hint: current === '' ? TICK : undefined, run: () => actions.setPhase(first, last, '') },
    { label: 'new phase…', divider: true, run: () => actions.setPhase(first, last, null) },
  ];
}

function itemsOfOne(context: StepMenuContext): ActionItem[] {
  const { step, selected, steps, view, annotating, anchor, phaseAt, numberOf, similar, back, thumbOf, isPopup, popupChange, actions } = context;
  const items: ActionItem[] = DECISIONS.map(([status, label, key]) => ({
    label,
    hint: step.status === status ? TICK : key,
    disabled: step.status === status,
    run: () => actions.setStatus(step, status),
  }));

  items.push({ label: 'play from here', hint: 'P', divider: true, run: () => actions.playFromHere(step) });
  items.push({
    label: view !== 'grid' ? 'edit title' : annotating ? 'hide notes' : step.title || step.notes ? 'edit notes' : 'annotate',
    run: () => actions.annotate(step),
  });
  items.push({ label: 'open screenshot', run: () => actions.openScreenshot(step) });

  // Where it goes in the pathway: as under stacking and phases on the step itself.
  const earlier = steps.filter((each) => each.detector_index < step.detector_index && each.status !== 'rejected').reverse();
  items.push({
    label: 'stacking',
    divider: true,
    items: [
      { label: 'automatic', hint: step.screen_link ? undefined : TICK, run: () => actions.update(step.id, { screen_link: 'auto' }) },
      { label: 'a new screen', hint: step.screen_link === 'new' ? TICK : undefined, run: () => actions.update(step.id, { screen_link: 'new' }) },
      ...earlier.map((each, index): ActionItem => ({
        label: `same as ${numberOf(each).short}${each.title ? `: ${each.title}` : `, at ${each.timestamp_tc.slice(3, 8)}`}`,
        hint: step.screen_link === each.id ? TICK : undefined,
        thumb: thumbOf(each.image_url),
        divider: index === 0,
        run: () => actions.update(step.id, { screen_link: each.id }),
      })),
    ],
  });
  items.push({
    label: isPopup(step) ? 'not a pop-up' : 'a pop-up',
    run: () => actions.update(step.id, popupChange(step, !isPopup(step))),
  });
  if (step.status === 'accepted') {
    items.push({ label: 'phase', items: phaseItems(context, step, step, phaseAt(step.timestamp_ms)) });
    items.push(...returnItem(context, step, 'return to'));
  }

  const links: ActionItem[] = [];
  if (similar) links.push({ label: `go to ${similar.label.replace(/^similar to /, '')}, which looks the same`, run: () => actions.jumpTo(similar.targetId) });
  if (back) links.push({ label: `go to ${back.label.replace(/^then back to /, '')}, where this went back`, run: () => actions.jumpTo(back.targetId) });
  links.forEach((item, index) => items.push({ ...item, divider: index === 0 }));

  const isSelected = selected.some((each) => each.id === step.id);
  items.push({ label: isSelected ? 'deselect' : 'select', hint: 'X', divider: true, run: () => actions.toggleSelection(step.id, false) });
  const from = anchor && anchor !== step.id ? steps.find((each) => each.id === anchor) : undefined;
  if (from && !isSelected) {
    items.push({ label: `select from ${numberOf(from).name} to here`, hint: '⇧X', run: () => actions.toggleSelection(step.id, true) });
  }
  return items;
}

function itemsOfSeveral(context: StepMenuContext): ActionItem[] {
  const { selected, phaseAt, numberOf, isPopup, popupChange, actions } = context;
  const all = selected.length;
  const items: ActionItem[] = DECISIONS.map(([status, label]) => {
    const changing = selected.filter((each) => each.status !== status).length;
    return {
      label: changing === all || changing === 0 ? label : `${label} ${changing} of ${all}`,
      hint: changing === 0 ? TICK : undefined,
      disabled: changing === 0,
      run: () => actions.setStatusOfSelected(status),
    };
  });

  /** A change to those of them that are not so yet; ticked when there are none. */
  const change = (label: string, changes: (step: CandidateFrame) => CandidateChanges | null): ActionItem => {
    const changing = selected.flatMap((step): Array<[string, CandidateChanges]> => {
      const changed = changes(step);
      return changed ? [[step.id, changed]] : [];
    });
    return {
      label,
      hint: changing.length ? undefined : TICK,
      disabled: !changing.length,
      run: () => actions.updateSeveral(changing),
    };
  };
  // The rejected are not in the pathway, so nothing is the same screen as one of them.
  const first = selected.find((step) => step.status !== 'rejected');
  const after = first ? selected.slice(selected.indexOf(first) + 1) : [];
  items.push({
    label: 'stacking',
    divider: true,
    items: [
      change('automatic', (step) => (step.screen_link ? { screen_link: 'auto' } : null)),
      change('each a new screen', (step) => (step.screen_link === 'new' ? null : { screen_link: 'new' })),
      ...(first && after.length
        ? [
            change(`all the same as ${numberOf(first).short}`, (step) =>
              after.includes(step) && step.screen_link !== first.id ? { screen_link: first.id } : null,
            ),
          ]
        : []),
    ],
  });
  const popups = selected.filter(isPopup).length;
  if (popups < all) items.push(change(popups ? `pop-ups, ${all - popups} of ${all}` : 'pop-ups', (step) => (isPopup(step) ? null : popupChange(step, true))));
  if (popups > 0) items.push(change(popups < all ? `not pop-ups, ${popups} of ${all}` : 'not pop-ups', (step) => (isPopup(step) ? popupChange(step, false) : null)));

  // A phase is a stretch: from the first of them to the last, with what is in between.
  const accepted = selected.filter((step) => step.status === 'accepted');
  if (accepted.length) {
    const last = accepted[accepted.length - 1];
    const names = new Set(accepted.map((step) => phaseAt(step.timestamp_ms)));
    const from = numberOf(accepted[0]).short;
    const to = numberOf(last).short;
    items.push({
      label: accepted.length > 1 ? `phase, from ${from} to ${to}` : `phase of ${numberOf(last).name}`,
      items: phaseItems(context, accepted[0], last, names.size === 1 ? [...names][0] : null),
    });
    items.push(...returnItem(context, last, `after ${to}, return to`));
  }

  items.push({ label: 'invert selection', divider: true, run: actions.invertSelection });
  items.push({ label: 'clear selection', hint: 'Esc', run: actions.clearSelection });
  return items;
}
