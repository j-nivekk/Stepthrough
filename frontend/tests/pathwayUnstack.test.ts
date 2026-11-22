import assert from 'node:assert/strict';
import test from 'node:test';

import { record, undoChanges } from '../src/lib/pathwayHistory';
import { unstackAllChanges, unstackByVisitChanges, unstackStepsChanges } from '../src/lib/pathwayUnstack';
import type { CandidateChanges, CandidateFrame, PathwayScreen, PathwayStep } from '../src/types';

const SAME_SCREEN_LABELS = new Set(['scroll', 'feed_card_swap', 'text_entry', 'small_ui_change', 'content_update']);

function makeCandidate(
  id: string,
  index: number,
  options: {
    transition?: string;
    screen_link?: string | null;
    similar_to?: string | null;
  } = {},
): CandidateFrame {
  return {
    id,
    run_id: 'run-1',
    recording_id: 'rec-1',
    detector_index: index,
    candidate_origin: 'detected',
    timestamp_ms: index * 1000,
    timestamp_tc: `00:00:0${index}.000`,
    image_path: `${id}.jpg`,
    image_url: `/${id}.jpg`,
    scene_score: 0.5,
    status: 'accepted',
    screen_link: options.screen_link ?? null,
    similar_to_candidate_id: options.similar_to ?? null,
    score_breakdown: {
      visual: 0,
      text: 0,
      motion: 0,
      changed_regions: [],
      transition_type: (options.transition ?? 'navigation') as NonNullable<CandidateFrame['score_breakdown']>['transition_type'],
    },
    created_at: '2026-11-22T00:00:00Z',
    updated_at: '2026-11-22T00:00:00Z',
  };
}

function makeStep(candidate: CandidateFrame, stepIndex: number, screenId = 'screen-01', visit = 1, groupedBy: string | null = null): PathwayStep {
  return {
    step_id: `step-${stepIndex}`,
    step_index: stepIndex,
    screen_id: screenId,
    visit,
    timestamp_ms: candidate.timestamp_ms,
    timestamp_tc: candidate.timestamp_tc,
    title: `Step ${stepIndex}`,
    image_path: candidate.image_path,
    image_url: candidate.image_url,
    grouped_by: groupedBy,
    screen_choice: candidate.screen_link === 'new' ? 'new_screen' : candidate.screen_link ? 'same_screen' : 'automatic',
    kind_choice: 'automatic',
    source_candidate_id: candidate.id,
  };
}

function applyChanges(candidates: CandidateFrame[], changes: Array<[string, CandidateChanges]>): CandidateFrame[] {
  const byId = new Map(changes);
  return candidates.map((candidate) => {
    const patch = byId.get(candidate.id);
    if (!patch) return candidate;
    return {
      ...candidate,
      screen_link: patch.screen_link === 'auto' ? null : (patch.screen_link ?? candidate.screen_link),
    };
  });
}

/** Faithful mirror of backend `_group_candidates` (detail='screens') to verify resulting box groups. */
function groupScreens(candidates: CandidateFrame[]): string[][] {
  const parent = new Map(candidates.map((c) => [c.id, c.id]));
  const position = new Map(candidates.map((c, idx) => [c.id, idx]));
  const find = (id: string): string => {
    let cur = id;
    while (parent.get(cur) !== cur) cur = parent.get(cur)!;
    parent.set(id, cur);
    return cur;
  };
  const union = (a: string, b: string) => {
    const [first, second] = [find(a), find(b)].sort((x, y) => position.get(x)! - position.get(y)!);
    parent.set(second, first);
  };

  let previous: CandidateFrame | null = null;
  for (const candidate of candidates) {
    const link = candidate.screen_link;
    let target: string | null = link && parent.has(link) && link !== candidate.id ? link : null;
    const label = candidate.score_breakdown?.transition_type ?? null;
    if (!target && link !== 'new') {
      if (candidate.similar_to_candidate_id && parent.has(candidate.similar_to_candidate_id)) {
        target = candidate.similar_to_candidate_id;
      } else if (label && SAME_SCREEN_LABELS.has(label) && previous) {
        target = previous.id;
      }
    }
    if (target) union(target, candidate.id);
    previous = candidate;
  }

  const groups = new Map<string, string[]>();
  for (const candidate of candidates) {
    const root = find(candidate.id);
    const list = groups.get(root) ?? [];
    list.push(candidate.id);
    groups.set(root, list);
  }
  return [...groups.values()];
}

test('unstackAll separates every step of a consecutive stacked box into its own screen', () => {
  const candidates = [
    makeCandidate('c1', 1, { transition: 'opening_screen' }),
    makeCandidate('c2', 2, { transition: 'scroll' }),
    makeCandidate('c3', 3, { transition: 'text_entry' }),
  ];
  assert.deepEqual(groupScreens(candidates), [['c1', 'c2', 'c3']]);

  const steps = [
    makeStep(candidates[0], 1),
    makeStep(candidates[1], 2, 'screen-01', 1, 'scroll'),
    makeStep(candidates[2], 3, 'screen-01', 1, 'text_entry'),
  ];
  const changes = unstackAllChanges(steps, new Map(candidates.map((c) => [c.id, c])));
  const after = applyChanges(candidates, changes);
  assert.deepEqual(groupScreens(after), [['c1'], ['c2'], ['c3']]);

  // Undo restores the original single stacked screen
  const entry = record('unstacked all', candidates, changes);
  const undone = applyChanges(after, undoChanges(entry, after).changes);
  assert.deepEqual(groupScreens(undone), [['c1', 'c2', 'c3']]);
});

test('unstackByVisit splits multi-visit boxes even when merged with explicit screen_links', () => {
  // Visit 1: c1-c2, Visit 2: c4-c5 (both c4 and c5 explicitly linked to c1 via stackBox)
  const candidates = [
    makeCandidate('c1', 1, { transition: 'opening_screen' }),
    makeCandidate('c2', 2, { transition: 'scroll' }),
    makeCandidate('c3', 3, { transition: 'navigation' }),
    makeCandidate('c4', 4, { transition: 'navigation', screen_link: 'c1' }),
    makeCandidate('c5', 5, { transition: 'scroll', screen_link: 'c1' }),
  ];
  assert.deepEqual(groupScreens(candidates), [['c1', 'c2', 'c4', 'c5'], ['c3']]);

  const s1 = makeStep(candidates[0], 1, 'screen-01', 1);
  const s2 = makeStep(candidates[1], 2, 'screen-01', 1, 'scroll');
  const s4 = makeStep(candidates[3], 4, 'screen-01', 2, 'researcher');
  const s5 = makeStep(candidates[4], 5, 'screen-01', 2, 'researcher');
  const screen: PathwayScreen = {
    id: 'screen-01',
    index: 1,
    title: 'Screen 1',
    kind: 'screen',
    image_step_id: s1.step_id,
    visits: [
      { visit: 1, step_ids: [s1.step_id, s2.step_id], arrived_ms: 1000 },
      { visit: 2, step_ids: [s4.step_id, s5.step_id], arrived_ms: 4000 },
    ],
  };

  const stepById = new Map([s1, s2, s4, s5].map((s) => [s.step_id, s]));
  const changes = unstackByVisitChanges(screen, stepById, new Map(candidates.map((c) => [c.id, c])));
  const after = applyChanges(candidates, changes);
  assert.deepEqual(groupScreens(after), [['c1', 'c2'], ['c3'], ['c4', 'c5']]);
});

test('unstackSteps pops out first, middle, or last step cleanly while keeping remaining steps together', () => {
  const candidates = [
    makeCandidate('c1', 1, { transition: 'opening_screen' }),
    makeCandidate('c2', 2, { transition: 'scroll' }),
    makeCandidate('c3', 3, { transition: 'scroll' }),
  ];
  const steps = [
    makeStep(candidates[0], 1),
    makeStep(candidates[1], 2, 'screen-01', 1, 'scroll'),
    makeStep(candidates[2], 3, 'screen-01', 1, 'scroll'),
  ];
  const byId = new Map(candidates.map((c) => [c.id, c]));

  // Pull out the first step (c1) -> [c1] and [c2, c3]
  const popFirst = applyChanges(candidates, unstackStepsChanges([steps[0]], steps, byId));
  assert.deepEqual(groupScreens(popFirst), [['c1'], ['c2', 'c3']]);

  // Pull out the middle step (c2) -> [c1, c3] and [c2]
  const popMiddle = applyChanges(candidates, unstackStepsChanges([steps[1]], steps, byId));
  assert.deepEqual(groupScreens(popMiddle), [['c1', 'c3'], ['c2']]);

  // Pull out the last step (c3) -> [c1, c2] and [c3]
  const popLast = applyChanges(candidates, unstackStepsChanges([steps[2]], steps, byId));
  assert.deepEqual(groupScreens(popLast), [['c1', 'c2'], ['c3']]);
});

test('unstackSteps pops out the first step from a manually stacked pair', () => {
  const candidates = [
    makeCandidate('c1', 1, { transition: 'opening_screen' }),
    makeCandidate('c2', 2, { transition: 'navigation', screen_link: 'c1' }),
  ];
  const steps = [
    makeStep(candidates[0], 1),
    makeStep(candidates[1], 2, 'screen-01', 1, 'researcher'),
  ];
  const byId = new Map(candidates.map((c) => [c.id, c]));

  const popFirst = applyChanges(candidates, unstackStepsChanges([steps[0]], steps, byId));
  assert.deepEqual(groupScreens(popFirst), [['c1'], ['c2']]);
});
