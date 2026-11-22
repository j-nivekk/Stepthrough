import type { CandidateChanges, CandidateFrame, PathwayScreen, PathwayStep } from '../types';

/**
 * Computes candidate updates to unstack every step in `screen` into a screen of its own.
 * Every step after the first gets `screen_link: 'new'`; the first step is also cleared to `'new'` if it had an
 * explicit link pointing to another member of the same box.
 */
export function unstackAllChanges(
  steps: PathwayStep[],
  candidateById: Map<string, CandidateFrame>,
): Array<[string, CandidateChanges]> {
  if (steps.length < 2) return [];
  const memberIds = new Set(steps.map((step) => step.source_candidate_id));
  const changes: Array<[string, CandidateChanges]> = [];

  const firstId = steps[0].source_candidate_id;
  const firstLink = candidateById.get(firstId)?.screen_link;
  if (firstLink && memberIds.has(firstLink)) {
    changes.push([firstId, { screen_link: 'new' }]);
  }

  for (const step of steps.slice(1)) {
    changes.push([step.source_candidate_id, { screen_link: 'new' }]);
  }
  return changes;
}

/**
 * Computes candidate updates to split a multi-visit box into one screen per visit, keeping consecutive steps within
 * each visit grouped together (even if they were previously merged onto an earlier visit with `screen_link`).
 */
export function unstackByVisitChanges(
  screen: PathwayScreen,
  stepById: Map<string, PathwayStep>,
  candidateById: Map<string, CandidateFrame>,
): Array<[string, CandidateChanges]> {
  if (screen.visits.length < 2) return [];
  const visits = screen.visits
    .map((visit) =>
      visit.step_ids
        .map((id) => stepById.get(id))
        .filter((step): step is PathwayStep => Boolean(step)),
    )
    .filter((visitSteps) => visitSteps.length > 0);
  if (visits.length < 2) return [];

  const allMemberIds = new Set(visits.flatMap((visitSteps) => visitSteps.map((step) => step.source_candidate_id)));
  const changes: Array<[string, CandidateChanges]> = [];

  visits.forEach((visitSteps, visitIndex) => {
    const visitIds = new Set(visitSteps.map((step) => step.source_candidate_id));
    const anchorId = visitSteps[0].source_candidate_id;
    const anchorLink = candidateById.get(anchorId)?.screen_link;

    if (visitIndex > 0) {
      changes.push([anchorId, { screen_link: 'new' }]);
    } else if (anchorLink && allMemberIds.has(anchorLink) && !visitIds.has(anchorLink)) {
      changes.push([anchorId, { screen_link: 'new' }]);
    }

    for (const step of visitSteps.slice(1)) {
      const candidate = candidateById.get(step.source_candidate_id);
      const link = candidate?.screen_link;
      const linkedOutsideVisit = Boolean(link && allMemberIds.has(link) && !visitIds.has(link));
      const revisitOutsideVisit = Boolean(
        !link &&
          candidate?.similar_to_candidate_id &&
          allMemberIds.has(candidate.similar_to_candidate_id) &&
          !visitIds.has(candidate.similar_to_candidate_id),
      );
      if (linkedOutsideVisit || revisitOutsideVisit || (!link && step.grouped_by === 'modal_close')) {
        changes.push([step.source_candidate_id, { screen_link: anchorId }]);
      }
    }
  });

  return changes;
}

/**
 * Computes candidate updates to pop `targetSteps` (a single step or a visit subset) out of `allSteps` into a screen of
 * their own, while keeping the remaining steps of the box stacked together. Works whether `targetSteps` includes the
 * box's first step, a middle step, or the last step.
 */
export function unstackStepsChanges(
  targetSteps: PathwayStep[],
  allSteps: PathwayStep[],
  candidateById: Map<string, CandidateFrame>,
): Array<[string, CandidateChanges]> {
  if (allSteps.length < 2 || !targetSteps.length) return [];
  const targetIds = new Set(targetSteps.map((step) => step.source_candidate_id));
  const orderedTarget = allSteps.filter((step) => targetIds.has(step.source_candidate_id));
  const remaining = allSteps.filter((step) => !targetIds.has(step.source_candidate_id));
  if (!orderedTarget.length || !remaining.length) return [];

  const remainingIds = new Set(remaining.map((step) => step.source_candidate_id));
  const position = new Map(allSteps.map((step, index) => [step.source_candidate_id, index]));
  const firstStepId = allSteps[0].source_candidate_id;
  const targetAnchorId = orderedTarget[0].source_candidate_id;
  const remainingAnchorId = remaining[0].source_candidate_id;
  const firstTargetPos = position.get(targetAnchorId) ?? 0;
  const firstRemainingPos = position.get(remainingAnchorId) ?? 0;

  const changes: Array<[string, CandidateChanges]> = [];

  // Detach target's anchor from the remaining group (or clear an explicit forward link into remaining).
  const targetAnchorLink = candidateById.get(targetAnchorId)?.screen_link;
  if (targetAnchorId !== firstStepId || (targetAnchorLink && remainingIds.has(targetAnchorLink))) {
    changes.push([targetAnchorId, { screen_link: 'new' }]);
  }

  // Keep any additional steps in `orderedTarget` attached to `targetAnchorId` rather than `remaining`.
  for (const step of orderedTarget.slice(1)) {
    const id = step.source_candidate_id;
    const candidate = candidateById.get(id);
    const link = candidate?.screen_link;
    const pos = position.get(id) ?? 0;
    const linkedToRemaining = Boolean(link && remainingIds.has(link));
    const couldAutoJoinRemaining =
      !link &&
      (pos > firstRemainingPos ||
        Boolean(candidate?.similar_to_candidate_id && remainingIds.has(candidate.similar_to_candidate_id)) ||
        step.grouped_by === 'modal_close');
    if (linkedToRemaining || couldAutoJoinRemaining) {
      changes.push([id, { screen_link: targetAnchorId }]);
    }
  }

  // Detach remaining's anchor if target took the box's first step (or if remaining's anchor linked into target).
  const remainingAnchorLink = candidateById.get(remainingAnchorId)?.screen_link;
  if (remainingAnchorId !== firstStepId || (remainingAnchorLink && targetIds.has(remainingAnchorLink))) {
    changes.push([remainingAnchorId, { screen_link: 'new' }]);
  }

  // Keep every later remaining step attached to `remainingAnchorId` so it doesn't follow `targetSteps`.
  for (const step of remaining.slice(1)) {
    const id = step.source_candidate_id;
    const candidate = candidateById.get(id);
    const link = candidate?.screen_link;
    const pos = position.get(id) ?? 0;
    const linkedToTarget = Boolean(link && targetIds.has(link));
    const couldAutoJoinTarget =
      !link &&
      (pos > firstTargetPos ||
        Boolean(candidate?.similar_to_candidate_id && targetIds.has(candidate.similar_to_candidate_id)) ||
        step.grouped_by === 'modal_close');
    if (linkedToTarget || couldAutoJoinTarget) {
      changes.push([id, { screen_link: remainingAnchorId }]);
    }
  }

  return changes;
}
