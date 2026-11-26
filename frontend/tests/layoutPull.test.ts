import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRE_SNAP_MAX,
  PULL_EVENT_MAX,
  PULL_THRESHOLD,
  SETTLE_IDLE_MS,
  createPullState,
  normalizeUpwardDelta,
  onPullRelease,
  onScrollPosition,
  onWheelPull,
  pullVisualProgress,
} from '../src/lib/layoutPull';

test('visual pull follows a friction curve capped below 1 until the detent breaks', () => {
  assert.equal(pullVisualProgress(0), 0);
  const quarter = pullVisualProgress(PULL_THRESHOLD * 0.25);
  const half = pullVisualProgress(PULL_THRESHOLD * 0.5);
  const near = pullVisualProgress(PULL_THRESHOLD * 0.95);
  const full = pullVisualProgress(PULL_THRESHOLD);

  assert.ok(quarter > 0.2 && quarter < half);
  assert.ok(half < near && near < full);
  assert.equal(full, PRE_SNAP_MAX);
  // Friction increases: the first half covers more visual distance than the second half.
  assert.ok(half > full - half);
});

test('notched mouse wheels are normalized and capped per tick', () => {
  assert.equal(normalizeUpwardDelta(10, 0), 0);
  assert.equal(normalizeUpwardDelta(-20, 0), 20);
  assert.equal(normalizeUpwardDelta(-200, 0), PULL_EVENT_MAX);
  assert.equal(normalizeUpwardDelta(-1, 1), 28);
  assert.equal(normalizeUpwardDelta(-3, 1), PULL_EVENT_MAX);
});

test('pulling upward at the top slides toward workspace and snaps once threshold is crossed', () => {
  let state = createPullState(0);
  let lastVisual = 0;
  let triggered = false;

  const maxTicks = Math.ceil(PULL_THRESHOLD / 40) + 2;
  for (let i = 0; i < maxTicks; i += 1) {
    const step = onWheelPull(state, { deltaY: -40, deltaMode: 0, scrollY: 0, nowMs: 1000 + i * 20 });
    state = step.state;
    assert.equal(step.consume, true);
    if (step.triggered) {
      triggered = true;
      assert.equal(step.visual, 1);
      assert.equal(state.pull, 0);
      break;
    }
    assert.ok(step.visual > lastVisual);
    assert.ok(step.visual <= PRE_SNAP_MAX);
    lastVisual = step.visual;
  }
  assert.equal(triggered, true);
});

test('a fast fling arriving at the top does not open workspace from decaying inertia', () => {
  let state = createPullState(600);
  state = onScrollPosition(state, 0, 1000);
  assert.equal(state.settling, true);

  // Decaying trackpad momentum ticks right after hitting y=0
  for (const [dt, delta] of [
    [16, -32],
    [32, -24],
    [48, -18],
    [64, -12],
    [80, -6],
    [96, -2],
  ] as const) {
    const step = onWheelPull(state, { deltaY: delta, deltaMode: 0, scrollY: 0, nowMs: 1000 + dt });
    state = step.state;
    assert.equal(step.visual, 0);
    assert.equal(step.triggered, false);
    assert.equal(step.consume, false);
  }

  // After the quiet settle gap, a deliberate upward pull immediately engages the slider.
  const fresh = onWheelPull(state, {
    deltaY: -40,
    deltaMode: 0,
    scrollY: 0,
    nowMs: 1096 + SETTLE_IDLE_MS + 10,
  });
  assert.equal(fresh.consume, true);
  assert.ok(fresh.visual > 0);
});

test('a deliberate fresh push breaks through settling, and scrolling down or releasing springs back', () => {
  let state = onScrollPosition(createPullState(200), 0, 1000);
  // One gentle residual tick
  state = onWheelPull(state, { deltaY: -4, deltaMode: 0, scrollY: 0, nowMs: 1020 }).state;
  // User pushes deliberately upward
  const push = onWheelPull(state, { deltaY: -35, deltaMode: 0, scrollY: 0, nowMs: 1040 });
  assert.equal(push.consume, true);
  assert.ok(push.visual > 0);

  // Scrolling down cancels immediately without consuming the scroll
  const down = onWheelPull(push.state, { deltaY: 12, deltaMode: 0, scrollY: 0, nowMs: 1060 });
  assert.equal(down.visual, 0);
  assert.equal(down.consume, false);
  assert.equal(down.state.pull, 0);

  // Releasing after a partial pull resets cleanly
  const partial = onWheelPull(down.state, { deltaY: -50, deltaMode: 0, scrollY: 0, nowMs: 1100 });
  assert.ok(partial.state.pull > 0);
  assert.equal(onPullRelease(partial.state).pull, 0);
});

test('a wheel event arriving at the top before the scroll event still arms the fling guard', () => {
  // Scrolling upward while still below y=0
  let state = onWheelPull(createPullState(200), { deltaY: -36, deltaMode: 0, scrollY: 16, nowMs: 1000 }).state;
  assert.equal(state.settling, false);

  // Next wheel tick arrives at scrollY=0 before window scroll has fired
  const arrival = onWheelPull(state, { deltaY: -28, deltaMode: 0, scrollY: 0, nowMs: 1016 });
  assert.equal(arrival.visual, 0);
  assert.equal(arrival.consume, false);
  assert.equal(arrival.state.settling, true);

  // Follow-up scroll event at y=0 preserves the armed guard and decaying inertia stays ignored
  state = onScrollPosition(arrival.state, 0, 1017);
  const decay = onWheelPull(state, { deltaY: -18, deltaMode: 0, scrollY: 0, nowMs: 1032 });
  assert.equal(decay.visual, 0);
  assert.equal(decay.consume, false);
});
