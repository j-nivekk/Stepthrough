import { memo } from 'react';

import type { SimilarLink } from '../lib/analysis';
import type { StepHoverState } from '../features/analysis/useHoverClips';
import type { CandidateChanges, CandidateFrame, CandidateStatus } from '../types';
import { CandidateCard, CandidateRow, type CandidateCardProps, type CandidateRowProps } from './CandidateCard';

/** What can be done to a step in the review: one object for all of them, which stays the same (lib/useStable.ts). */
export interface StepActions {
  activate: (candidateId: string) => void;
  hoverChange: (candidateId: string, hovering: boolean) => void;
  jumpTo: (targetId: string) => void;
  paintEnter: (candidateId: string) => void;
  paintStart: (candidateId: string, selected: boolean) => void;
  setStatus: (candidate: CandidateFrame, status: CandidateStatus) => void;
  toggleSelection: (candidateId: string, shift: boolean) => void;
  toggleAnnotation: (candidateId: string) => void;
  update: (candidateId: string, payload: CandidateChanges) => void;
  clipStart: (candidate: CandidateFrame, slot: HTMLElement | null) => void;
  clipLeave: (candidateId: string) => void;
  playFromHere: (candidate: CandidateFrame) => void;
}

interface ReviewStepProps {
  candidate: CandidateFrame;
  actions: StepActions;
  hoverState: StepHoverState | null;
  isActive: boolean;
  isCrossHovered: boolean;
  isSelected: boolean;
  similarLink: SimilarLink | undefined;
  steps: CandidateFrame[];
  phases: CandidateCardProps['phases'];
}

/** The actions of one step, as its card or row takes them. */
function actionsOf({ actions, candidate, hoverState, isSelected, similarLink }: ReviewStepProps) {
  return {
    hover: {
      state: hoverState,
      onEnter: (slot: HTMLElement | null) => actions.clipStart(candidate, slot),
      onLeave: () => actions.clipLeave(candidate.id),
      onPlayFromHere: () => actions.playFromHere(candidate),
    },
    onActivate: () => actions.activate(candidate.id),
    onHoverChange: (hovering: boolean) => actions.hoverChange(candidate.id, hovering),
    onJumpToSimilar: similarLink ? () => actions.jumpTo(similarLink.targetId) : undefined,
    onPaintEnter: () => actions.paintEnter(candidate.id),
    onPaintStart: () => actions.paintStart(candidate.id, isSelected),
    onSetStatus: (status: CandidateStatus) => actions.setStatus(candidate, status),
    onToggleSelection: (shift: boolean) => actions.toggleSelection(candidate.id, shift),
    onUpdate: (payload: CandidateChanges) => actions.update(candidate.id, payload),
  };
}

type CardLooks = Pick<CandidateCardProps, 'compact' | 'imageWidth' | 'isAnnotationExpanded' | 'recordingHeight' | 'recordingWidth'>;

/** A step as a card: drawn again only when what it shows changes, not with every move of the pointer over the others. */
export const ReviewCard = memo(function ReviewCard(props: ReviewStepProps & CardLooks) {
  const { actions, hoverState: _hoverState, ...shown } = props;
  return <CandidateCard {...shown} {...actionsOf(props)} isSelectable onToggleAnnotation={() => actions.toggleAnnotation(shown.candidate.id)} />;
});

type RowLooks = Pick<CandidateRowProps, 'thumbHeight' | 'thumbWidth'>;

/** A step as a row of the list, likewise. */
export const ReviewRow = memo(function ReviewRow(props: ReviewStepProps & RowLooks) {
  const { actions: _actions, hoverState: _hoverState, ...shown } = props;
  return <CandidateRow {...shown} {...actionsOf(props)} isSelectable />;
});
