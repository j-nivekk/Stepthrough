import { useEffect, type RefObject } from 'react';
import { playbackIntensity, type PlaybackWindow } from '../../lib/stepClips';

/**
 * While the preview plays, ring the step card (or list row) that is on screen. The ring strength is the
 * CSS variable --playback (0 to 1), written straight onto the elements every animation frame rather
 * than through React state, so a long run of steps does not re-render the page sixty times a second.
 */
export function usePlaybackHighlight(
  videoRef: RefObject<HTMLVideoElement | null>,
  windows: PlaybackWindow[],
  enabled: boolean,
  videoKey: string | null,
): void {
  useEffect(() => {
    const lit = new Set<string>();

    function clear() {
      for (const id of lit) {
        document.getElementById(`candidate-${id}`)?.style.removeProperty('--playback');
      }
      lit.clear();
    }

    const video = videoRef.current;
    if (!enabled || !video || windows.length === 0) {
      clear();
      return clear;
    }

    function paint() {
      const timeMs = (video as HTMLVideoElement).currentTime * 1000;
      const next = new Map<string, number>();
      for (const step of windows) {
        if (step.startMs - step.marginMs > timeMs) break;
        const value = playbackIntensity(step, timeMs);
        if (value > 0) next.set(step.id, value);
      }
      for (const id of lit) {
        if (!next.has(id)) document.getElementById(`candidate-${id}`)?.style.removeProperty('--playback');
      }
      lit.clear();
      for (const [id, value] of next) {
        document.getElementById(`candidate-${id}`)?.style.setProperty('--playback', value.toFixed(3));
        lit.add(id);
      }
    }

    let frame: number | null = null;
    function loop() {
      paint();
      frame = video && !video.paused ? window.requestAnimationFrame(loop) : null;
    }
    function onPlay() {
      if (frame === null) frame = window.requestAnimationFrame(loop);
    }

    const events = ['seeked', 'timeupdate', 'loadedmetadata', 'pause'] as const;
    events.forEach((name) => video.addEventListener(name, paint));
    video.addEventListener('play', onPlay);
    paint();
    if (!video.paused) onPlay();

    return () => {
      events.forEach((name) => video.removeEventListener(name, paint));
      video.removeEventListener('play', onPlay);
      if (frame !== null) window.cancelAnimationFrame(frame);
      clear();
    };
  }, [enabled, videoKey, videoRef, windows]);
}
