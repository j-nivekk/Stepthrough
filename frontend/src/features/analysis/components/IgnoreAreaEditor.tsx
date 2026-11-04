import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { sanitizeIgnoreRegion, STABLE_MAX_IGNORE_REGIONS } from '../../../lib/stableSettings';
import type { IgnoreRegion } from '../../../types';

export interface IgnoreAreaEditorProps {
  videoUrl: string | null;
  width: number;
  height: number;
  durationMs: number;
  regions: IgnoreRegion[];
  statusBarShare: number;
  onChange: (regions: IgnoreRegion[]) => void;
}

const STAGE_MAX_HEIGHT = 340;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Draw boxes on a frame of the recording; the stable engine ignores any change inside them. */
export function IgnoreAreaEditor({
  videoUrl,
  width,
  height,
  durationMs,
  regions,
  statusBarShare,
  onChange,
}: IgnoreAreaEditorProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [frameMs, setFrameMs] = useState(Math.min(500, Math.max(0, durationMs - 1)));
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (video && Number.isFinite(frameMs)) {
      video.currentTime = frameMs / 1000;
    }
  }, [frameMs, videoUrl]);

  const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
  const full = regions.length >= STABLE_MAX_IGNORE_REGIONS;

  function pointFromEvent(event: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } | null {
    const stage = stageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    return { x: clamp01((event.clientX - rect.left) / rect.width), y: clamp01((event.clientY - rect.top) / rect.height) };
  }

  function finishDraft() {
    if (!draft) return;
    const region = sanitizeIgnoreRegion({
      x: Math.min(draft.x0, draft.x1),
      y: Math.min(draft.y0, draft.y1),
      width: Math.abs(draft.x1 - draft.x0),
      height: Math.abs(draft.y1 - draft.y0),
    });
    setDraft(null);
    if (region && region.width >= 0.01 && region.height >= 0.01) {
      onChange([...regions, region]);
    }
  }

  const draftBox = draft
    ? {
        left: `${Math.min(draft.x0, draft.x1) * 100}%`,
        top: `${Math.min(draft.y0, draft.y1) * 100}%`,
        width: `${Math.abs(draft.x1 - draft.x0) * 100}%`,
        height: `${Math.abs(draft.y1 - draft.y0) * 100}%`,
      }
    : null;

  return (
    <div className="stable-ignore-editor">
      <div
        aria-label="drag on the frame to add an area to ignore"
        className={`stable-ignore-stage ${full ? 'full' : ''}`}
        onPointerDown={(event) => {
          if (full || event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
          const point = pointFromEvent(event);
          if (!point) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          setDraft({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
        }}
        onPointerMove={(event) => {
          if (!draft) return;
          const point = pointFromEvent(event);
          if (point) setDraft({ ...draft, x1: point.x, y1: point.y });
        }}
        onPointerUp={finishDraft}
        onPointerCancel={() => setDraft(null)}
        ref={stageRef}
        role="application"
        style={{ aspectRatio: `${width || 16} / ${height || 9}`, width: `min(100%, ${STAGE_MAX_HEIGHT * aspect}px)` }}
      >
        {videoUrl ? (
          <video className="stable-ignore-frame" muted playsInline preload="auto" ref={videoRef} src={videoUrl} />
        ) : (
          <div className="stable-ignore-frame placeholder">select a recording to draw on its frames</div>
        )}
        {statusBarShare > 0 ? (
          <div className="stable-ignore-box status-bar" style={{ left: 0, top: 0, width: '100%', height: `${statusBarShare * 100}%` }}>
            <span>status bar</span>
          </div>
        ) : null}
        {regions.map((region, index) => (
          <div
            className="stable-ignore-box"
            key={`${region.x}-${region.y}-${index}`}
            style={{
              left: `${region.x * 100}%`,
              top: `${region.y * 100}%`,
              width: `${region.width * 100}%`,
              height: `${region.height * 100}%`,
            }}
          >
            <button
              aria-label={`remove ignored area ${index + 1}`}
              className="stable-ignore-remove"
              onClick={() => onChange(regions.filter((_region, other) => other !== index))}
              type="button"
            >
              ×
            </button>
          </div>
        ))}
        {draftBox ? <div className="stable-ignore-box draft" style={draftBox} /> : null}
      </div>
      <label className="stable-ignore-scrub">
        <span>frame</span>
        <input
          aria-label="frame to draw on"
          disabled={!videoUrl || durationMs <= 0}
          max={Math.max(0, durationMs - 1)}
          min={0}
          onChange={(event) => setFrameMs(Number(event.target.value))}
          step={100}
          type="range"
          value={frameMs}
        />
        <span className="stable-ignore-scrub-time">{(frameMs / 1000).toFixed(1)}s</span>
      </label>
      <div className="stable-ignore-footer">
        <span>
          {regions.length
            ? `${regions.length} area${regions.length === 1 ? '' : 's'} ignored`
            : 'drag on the frame to ignore an area, such as a live clock or an embedded video'}
        </span>
        {regions.length ? (
          <button className="analysis-task-link subtle" onClick={() => onChange([])} type="button">
            clear all
          </button>
        ) : null}
      </div>
    </div>
  );
}
