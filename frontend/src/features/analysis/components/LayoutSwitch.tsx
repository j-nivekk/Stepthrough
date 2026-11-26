// Centred workspace / review layout switcher on the analysis page's top navigation bar.
// A sliding white thumb glides between the two segments on click, and in review mode scrolling upward past the top of
// the page pulls the thumb toward workspace with progressive friction until it breaks past the detent and opens the
// videos, parameters and tasks shelf.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import {
  RELEASE_IDLE_MS,
  createPullState,
  onPullRelease,
  onScrollPosition,
  onWheelPull,
  type PullState,
} from '../../../lib/layoutPull';

export type AnalysisLayoutMode = 'workspace' | 'review';

export interface LayoutSwitchProps {
  controlsId: string;
  mode: AnalysisLayoutMode;
  onChange: (mode: AnalysisLayoutMode) => void;
}

interface ThumbMetrics {
  workspace: { left: number; width: number };
  review: { left: number; width: number };
}

/** True when an ancestor between the wheel target and the page root can still scroll upward itself. */
function hasScrollableAncestorUp(target: EventTarget | null): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== document.body && node !== document.documentElement) {
    if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight + 1) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
        return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

export function LayoutSwitch({ controlsId, mode, onChange }: LayoutSwitchProps) {
  const groupRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLButtonElement | null>(null);
  const reviewRef = useRef<HTMLButtonElement | null>(null);
  const [metrics, setMetrics] = useState<ThumbMetrics | null>(null);
  const [pullVisual, setPullVisual] = useState(0);

  const pullStateRef = useRef<PullState>(createPullState(typeof window === 'undefined' ? 0 : window.scrollY));
  const releaseTimerRef = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const measure = useCallback(() => {
    const ws = workspaceRef.current;
    const rv = reviewRef.current;
    if (!ws || !rv) return;
    const next: ThumbMetrics = {
      workspace: { left: ws.offsetLeft, width: ws.offsetWidth },
      review: { left: rv.offsetLeft, width: rv.offsetWidth },
    };
    setMetrics((prev) =>
      prev &&
      prev.workspace.left === next.workspace.left &&
      prev.workspace.width === next.workspace.width &&
      prev.review.left === next.review.left &&
      prev.review.width === next.review.width
        ? prev
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    measure();
    const group = groupRef.current;
    const observer = typeof ResizeObserver === 'undefined' || !group ? null : new ResizeObserver(measure);
    if (group && observer) observer.observe(group);
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) measure();
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [measure]);

  useEffect(() => {
    const clearRelease = () => {
      if (releaseTimerRef.current !== null) {
        window.clearTimeout(releaseTimerRef.current);
        releaseTimerRef.current = null;
      }
    };

    // Reset pull state whenever switching out of review mode.
    if (mode !== 'review') {
      clearRelease();
      pullStateRef.current = createPullState(window.scrollY);
      setPullVisual(0);
      return;
    }

    pullStateRef.current = createPullState(window.scrollY);

    function handleScroll() {
      const next = onScrollPosition(pullStateRef.current, window.scrollY, performance.now());
      pullStateRef.current = next;
      if (next.pull === 0) {
        clearRelease();
        setPullVisual(0);
      }
    }

    function handleWheel(event: WheelEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (document.querySelector('[aria-modal="true"], dialog[open], .command-bar')) return;
      if (hasScrollableAncestorUp(event.target)) return;

      const step = onWheelPull(pullStateRef.current, {
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        scrollY: window.scrollY,
        nowMs: performance.now(),
      });
      pullStateRef.current = step.state;

      if (step.consume) event.preventDefault();

      if (step.triggered) {
        clearRelease();
        setPullVisual(0);
        onChangeRef.current('workspace');
        return;
      }

      setPullVisual(step.visual);
      clearRelease();
      if (step.visual > 0) {
        releaseTimerRef.current = window.setTimeout(() => {
          releaseTimerRef.current = null;
          pullStateRef.current = onPullRelease(pullStateRef.current);
          setPullVisual(0);
        }, RELEASE_IDLE_MS);
      }
    }

    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      clearRelease();
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('wheel', handleWheel);
    };
  }, [mode]);

  const pulling = mode === 'review' && pullVisual > 0;
  let thumbStyle: CSSProperties | undefined;
  if (metrics) {
    const left =
      mode === 'workspace'
        ? metrics.workspace.left
        : metrics.review.left + (metrics.workspace.left - metrics.review.left) * pullVisual;
    const width =
      mode === 'workspace'
        ? metrics.workspace.width
        : metrics.review.width + (metrics.workspace.width - metrics.review.width) * pullVisual;
    thumbStyle = {
      transform: `translateX(${left}px)`,
      width: `${width}px`,
    };
  }

  return (
    <div
      aria-label="page layout"
      className={`analysis-layout-switch ${metrics ? 'has-thumb' : ''} ${pulling ? 'is-pulling' : ''}`}
      ref={groupRef}
      role="group"
      style={pulling ? ({ '--layout-pull': pullVisual } as CSSProperties) : undefined}
    >
      {metrics ? <span aria-hidden="true" className="analysis-layout-thumb" style={thumbStyle} /> : null}
      <button
        aria-controls={controlsId}
        aria-pressed={mode === 'workspace'}
        className={`analysis-layout-btn is-workspace ${mode === 'workspace' ? 'active' : ''}`}
        onClick={() => onChange('workspace')}
        ref={workspaceRef}
        title="show videos, parameters and tasks above the review"
        type="button"
      >
        <svg aria-hidden="true" fill="none" height="12" stroke="currentColor" strokeWidth="1.2" viewBox="0 0 14 12" width="14">
          <rect height="10.5" width="12.5" x="0.75" y="0.75" />
          <line x1="0.75" x2="13.25" y1="5.5" y2="5.5" />
          <line x1="5" x2="5" y1="0.75" y2="5.5" />
          <line x1="9" x2="9" y1="0.75" y2="5.5" />
        </svg>
        <span>workspace</span>
      </button>
      <button
        aria-controls={controlsId}
        aria-pressed={mode === 'review'}
        className={`analysis-layout-btn is-review ${mode === 'review' ? 'active' : ''}`}
        onClick={() => onChange('review')}
        ref={reviewRef}
        title="focus on the run review"
        type="button"
      >
        <svg aria-hidden="true" fill="none" height="12" stroke="currentColor" strokeWidth="1.2" viewBox="0 0 14 12" width="14">
          <rect height="10.5" width="12.5" x="0.75" y="0.75" />
          <line strokeOpacity="0.45" x1="3" x2="11" y1="4.2" y2="4.2" />
          <line strokeOpacity="0.45" x1="3" x2="9" y1="7.2" y2="7.2" />
        </svg>
        <span>review</span>
      </button>
    </div>
  );
}
