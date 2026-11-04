import { useCallback, useEffect, useRef, useState } from 'react';
import { HOVER_INTENT_MS, stepClip } from '../../lib/stepClips';
import type { CandidateFrame } from '../../types';

export type StepHoverState = 'waiting' | 'armed';

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Hover intent on step screenshots, like a Live Photo. Resting the pointer on a screenshot starts a short
 * wait (shown as a filling line); after it, the step's clip plays once inside the card, ending on the
 * screenshot's frame, and "play from here" appears. Leaving cancels at any point.
 *
 * One <video> element is shared by every card and moved into the hovered card's slot, so a run with a
 * hundred steps does not create a hundred players. The clip starts loading when the wait starts, so it
 * is usually ready by the time the wait ends.
 */
export function useHoverClips(videoUrl: string | null) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const clipEndRef = useRef<number>(0);
  const [hover, setHover] = useState<{ id: string; state: StepHoverState } | null>(null);

  const getVideo = useCallback((): HTMLVideoElement | null => {
    if (!videoUrl) return null;
    if (!videoRef.current) {
      const video = document.createElement('video');
      video.className = 'candidate-live-video';
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.setAttribute('aria-hidden', 'true');
      video.addEventListener('timeupdate', () => {
        if (video.currentTime * 1000 >= clipEndRef.current) {
          video.pause();
        }
      });
      videoRef.current = video;
    }
    if (videoRef.current.dataset.src !== videoUrl) {
      videoRef.current.src = videoUrl;
      videoRef.current.dataset.src = videoUrl;
    }
    return videoRef.current;
  }, [videoUrl]);

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    activeIdRef.current = null;
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.classList.remove('visible');
    }
    setHover(null);
  }, []);

  const start = useCallback(
    (candidate: CandidateFrame, slot: HTMLElement | null) => {
      stop();
      activeIdRef.current = candidate.id;
      setHover({ id: candidate.id, state: 'waiting' });
      const clip = stepClip(candidate);
      const video = slot ? getVideo() : null;
      if (video && slot) {
        slot.appendChild(video);
        clipEndRef.current = clip.endMs;
        video.playbackRate = clip.rate;
        try {
          video.currentTime = clip.startMs / 1000;
        } catch {
          // metadata not loaded yet; the clip then starts from wherever the video is
        }
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (activeIdRef.current !== candidate.id) return;
        setHover({ id: candidate.id, state: 'armed' });
        if (video && !prefersReducedMotion()) {
          if (Math.abs(video.currentTime * 1000 - clip.startMs) > 150) {
            video.currentTime = clip.startMs / 1000;
          }
          video.classList.add('visible');
          void video.play().catch(() => undefined);
        }
      }, HOVER_INTENT_MS);
    },
    [getVideo, stop],
  );

  const leave = useCallback(
    (candidateId: string) => {
      if (activeIdRef.current === candidateId) stop();
    },
    [stop],
  );

  useEffect(() => stop, [stop, videoUrl]);

  // Scrolling cancels a hover, so screenshots passing under a resting pointer do not start clips.
  useEffect(() => {
    function onScroll() {
      if (activeIdRef.current !== null) stop();
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [stop]);

  return { hover, start, leave, stop };
}
