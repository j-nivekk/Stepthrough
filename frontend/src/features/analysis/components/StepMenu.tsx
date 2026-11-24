import { useQuery } from '@tanstack/react-query';

import { getRunPathway } from '../../../api';
import { FloatingActionMenu } from '../../../components/ActionMenu';
import { pathwayQueryOptions } from '../../../lib/pathwayQuery';
import { returnTargets } from '../../../lib/pathwayReturns';
import { loadPathwayView } from '../../../lib/pathwayView';
import { returningStep, stepMenuHeading, stepMenuItems, type StepMenuContext } from '../../../lib/stepMenu';
import type { RunDetail } from '../../../types';

/** The right-click menu of the steps views (lib/stepMenu.ts). Only the pathway knows which screens a step can return
 *  to, so it is fetched when the menu opens, if the pathway was not shown yet. */
export function StepMenu({
  context,
  run,
  x,
  y,
  onClose,
}: {
  context: Omit<StepMenuContext, 'returns'>;
  run: RunDetail;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const returning = returningStep(context);
  const options = pathwayQueryOptions(run, loadPathwayView().detail, getRunPathway);
  const pathway = useQuery({ ...options, enabled: options.enabled && Boolean(returning) }).data;
  const whole: StepMenuContext = { ...context, returns: returning && pathway ? returnTargets(pathway, returning.id) : undefined };
  return <FloatingActionMenu heading={stepMenuHeading(whole)} items={stepMenuItems(whole)} onClose={onClose} x={x} y={y} />;
}
