// Overscroll-at-top physics for sliding the top layout switcher from "review" into "workspace".
//
// In review mode, scrolling up past the top of the page moves the white switcher thumb toward "workspace" with
// progressive friction up to a detent (PRE_SNAP_MAX). Crossing PULL_THRESHOLD breaks past the detent and switches to
// workspace; stopping early lets the thumb spring back to review. A settle guard keeps a fast upward fling from deep
// in the page from accidentally opening workspace via leftover trackpad inertia.

/** Normalized upward wheel travel (px) required to break past the detent into workspace. */
export const PULL_THRESHOLD = 360;
/** Cap on one wheel event so each notched wheel tick or trackpad pulse moves with weight. */
export const PULL_EVENT_MAX = 70;
/** Maximum visual travel (0..1) before breaking past the detent, so the thumb never looks seated before snapping. */
export const PRE_SNAP_MAX = 0.74;
/** Quiet gap (ms) after hitting y=0 before residual fling inertia is considered finished. */
export const SETTLE_IDLE_MS = 140;
/** Quiet gap (ms) after the last upward pull tick before the thumb springs back to review. */
export const RELEASE_IDLE_MS = 220;
/** Upward delta jump (px) that signals a deliberate fresh push while settling, disarming the fling guard early. */
export const MOMENTUM_SPIKE_PX = 6;

export interface PullState {
  pull: number;
  lastScrollY: number;
  settling: boolean;
  lastEventAt: number;
  lastUpwardDelta: number;
}

export interface PullStepResult {
  state: PullState;
  /** Friction-curved visual travel (0..PRE_SNAP_MAX) from review toward workspace. */
  visual: number;
  /** True the instant the pull crosses PULL_THRESHOLD and should snap to workspace. */
  triggered: boolean;
  /** True when the wheel event was absorbed by the pull (caller may preventDefault). */
  consume: boolean;
}

export function createPullState(scrollY = 0): PullState {
  return {
    pull: 0,
    lastScrollY: scrollY,
    settling: false,
    lastEventAt: 0,
    lastUpwardDelta: 0,
  };
}

/** Convert a WheelEvent's deltaY into pixels, clamping one event so the slider always moves visibly. */
export function normalizeUpwardDelta(deltaY: number, deltaMode: number): number {
  if (deltaY >= 0) return 0;
  const scale = deltaMode === 1 ? 28 : deltaMode === 2 ? 240 : 1;
  return Math.min(PULL_EVENT_MAX, -deltaY * scale);
}

/** Rubber-band friction curve: weighted from the start, heavier near the detent, capped at PRE_SNAP_MAX. */
export function pullVisualProgress(pull: number, threshold = PULL_THRESHOLD): number {
  if (pull <= 0 || threshold <= 0) return 0;
  const raw = Math.min(1, pull / threshold);
  return PRE_SNAP_MAX * (1 - Math.pow(1 - raw, 1.35));
}

/** Update state when the window scrolls; reaching y=0 from below arms the fling-inertia guard. */
export function onScrollPosition(state: PullState, scrollY: number, nowMs: number): PullState {
  const atTop = scrollY <= 1;
  const wasBelow = state.lastScrollY > 1;
  if (!atTop) {
    return {
      pull: 0,
      lastScrollY: scrollY,
      settling: false,
      lastEventAt: nowMs,
      lastUpwardDelta: 0,
    };
  }
  if (wasBelow) {
    return {
      pull: 0,
      lastScrollY: scrollY,
      settling: true,
      lastEventAt: nowMs,
      lastUpwardDelta: 0,
    };
  }
  return { ...state, lastScrollY: scrollY };
}

/** Feed a vertical wheel event while at the top of the page in review mode. */
export function onWheelPull(
  state: PullState,
  event: { deltaY: number; deltaMode: number; scrollY: number; nowMs: number },
): PullStepResult {
  const { deltaY, deltaMode, scrollY, nowMs } = event;

  // Not at the top of the page: never interfere with normal scrolling.
  if (scrollY > 1) {
    const next = onScrollPosition(state, scrollY, nowMs);
    return { state: next, visual: 0, triggered: false, consume: false };
  }

  // If a wheel event arrives at y=0 before the matching scroll event fired,
  // arm the fling-inertia guard unless the user has already paused since scrolling.
  const current =
    state.lastScrollY > 1 && (state.lastEventAt === 0 || nowMs - state.lastEventAt < SETTLE_IDLE_MS)
      ? onScrollPosition(state, scrollY, nowMs)
      : state.lastScrollY > 1
        ? { ...state, lastScrollY: scrollY }
        : state;

  // Scrolling down immediately releases any partial pull and scrolls normally.
  if (deltaY > 0) {
    return {
      state: { ...current, pull: 0, settling: false, lastEventAt: nowMs, lastUpwardDelta: 0 },
      visual: 0,
      triggered: false,
      consume: false,
    };
  }

  const upward = normalizeUpwardDelta(deltaY, deltaMode);
  if (upward <= 0) {
    return { state: current, visual: pullVisualProgress(current.pull), triggered: false, consume: false };
  }

  // Guard against residual trackpad momentum right after arriving at y=0 from below.
  let settling = current.settling;
  if (settling) {
    const quietGap = nowMs - current.lastEventAt >= SETTLE_IDLE_MS;
    const deliberatePush = current.lastUpwardDelta > 0 && upward > current.lastUpwardDelta + MOMENTUM_SPIKE_PX;
    if (quietGap || deliberatePush) {
      settling = false;
    } else {
      return {
        state: { ...current, lastEventAt: nowMs, lastUpwardDelta: upward },
        visual: 0,
        triggered: false,
        consume: false,
      };
    }
  }

  const nextPull = current.pull + upward;
  if (nextPull >= PULL_THRESHOLD) {
    return {
      state: { pull: 0, lastScrollY: scrollY, settling: false, lastEventAt: nowMs, lastUpwardDelta: 0 },
      visual: 1,
      triggered: true,
      consume: true,
    };
  }

  return {
    state: { pull: nextPull, lastScrollY: scrollY, settling: false, lastEventAt: nowMs, lastUpwardDelta: upward },
    visual: pullVisualProgress(nextPull),
    triggered: false,
    consume: true,
  };
}

/** Spring back to 0 when the user stops pulling before crossing the threshold. */
export function onPullRelease(state: PullState): PullState {
  return { ...state, pull: 0, lastUpwardDelta: 0 };
}
