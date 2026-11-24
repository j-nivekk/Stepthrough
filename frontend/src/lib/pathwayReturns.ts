/**
 * Where someone may have gone back to after a step, when no step shows it (`returns_to`): the screens seen before it.
 * For the menus of the pathway and of the steps views.
 */
import type { Pathway, PathwayScreen, PathwayStep } from '../types';
import { stepsPhrase } from './stepNumbers';

/** How much of a title the status line, the menus and the labels show; the box itself shows all of it. */
const TITLE_IN_LABELS = 40;

export function shorten(text: string, length = TITLE_IN_LABELS): string {
  const trimmed = text.trim();
  return trimmed.length > length ? `${trimmed.slice(0, length - 1).trimEnd()}…` : trimmed;
}

/** "Screen 7", with its title when it has one. */
export const screenName = (screen: PathwayScreen): string =>
  screen.title === `Screen ${screen.index}` ? `Screen ${screen.index}` : `Screen ${screen.index}, ${shorten(screen.title)}`;

export interface ReturnTarget {
  /** The candidate that stands for the screen. */
  id: string;
  name: string;
  /** With the steps on it: "Screen 7 (steps 12–15)". */
  label: string;
  imageUrl?: string;
  /** Where the reviewer said they went back to. */
  current: boolean;
}

/** The screens seen before a step, the latest first. Not its own: someone on a screen does not go back to it. */
export function returnTargets(pathway: Pathway, candidateId: string, leaveOut = false): ReturnTarget[] {
  const step = pathway.steps.find((each) => each.source_candidate_id === candidateId);
  if (!step) return [];
  const byId = new Map(pathway.steps.map((each) => [each.step_id, each]));
  const stepsOf = (screen: PathwayScreen): PathwayStep[] =>
    screen.visits.flatMap((visit) => visit.step_ids).map((id) => byId.get(id)).filter((each): each is PathwayStep => Boolean(each));
  return pathway.screens
    .filter((screen) => screen.id !== step.screen_id && (stepsOf(screen)[0]?.step_index ?? Infinity) < step.step_index)
    .reverse()
    .map((screen) => {
      const image = byId.get(screen.image_step_id);
      const name = screenName(screen);
      return {
        id: image?.source_candidate_id ?? '',
        name,
        label: `${name} (${stepsPhrase(stepsOf(screen), leaveOut)})`,
        imageUrl: image?.image_url,
        current: step.returns_to === screen.id,
      };
    });
}
