 # Scroll/Dwell Timeline Visualization

## Context

The hybrid v2 detection engine already computes scroll displacement (phase correlation), transition classification, dwell durations, and event time spans — but two things are missing:

1. **`event_start_ms`/`event_end_ms` are not persisted**: They're computed in `_finalize_event()` as top-level keys on the internal event dict, used to compute dwell_before/after, then dropped during candidate serialization. The frontend never sees them.

2. **The frontend timelines only show point markers**: Both the preview scrubber (4px track under the video) and the candidate timeline (24px rail in the review panel) render candidates as thin pin markers at a single timestamp. There are no range/segment visualizations for scroll spans, dwell durations, or event windows.

This plan adds `event_start_ms`/`event_end_ms` to the persisted `score_breakdown` and renders colored segments on both timelines to show event spans and dwell gaps.

---

## Step 1: Backend — persist event time range in score_breakdown

**`backend/app/services/hybrid_detection.py`** — `_finalize_event()` (line 1257)

Add `event_start_ms` and `event_end_ms` into the `score_breakdown` dict:

```python
"score_breakdown": {
    ...existing keys...
    "event_start_ms": event.started_at_ms,
    "event_end_ms": event.last_active_ms,
},
```

Keep the existing top-level `event_start_ms`/`event_end_ms` keys — they're consumed by `_annotate_dwell_durations()` before persistence. The duplication is intentional.

Also add them to the fallback candidate at line 1419 (`event_start_ms: 0`, `event_end_ms: 0`).

**`backend/app/models.py`** — `CandidateScoreBreakdown`

Add two optional fields:

```python
event_start_ms: int | None = None
event_end_ms: int | None = None
```

No database migration needed — `score_breakdown` is stored as a JSON string column. Pydantic picks up new keys automatically. Old data without these fields will read as `None`.

---

## Step 2: Frontend types

**`frontend/src/types.ts`** — `CandidateScoreBreakdown`

Add:

```typescript
event_start_ms?: number | null;
event_end_ms?: number | null;
```

---

## Step 3: Derive timeline segments from candidates

**`frontend/src/features/analysis/AnalysisScreen.tsx`**

Add a `useMemo` near the existing `timelineCandidates` memo (~line 419) that derives segment data:

```typescript
const timelineSegments = useMemo(() => {
  // For each candidate with a score_breakdown:
  //   1. Event span segment: event_start_ms → event_end_ms, colored by transition_type
  //   2. Dwell-before segment: (event_start_ms - dwell_before_ms) → event_start_ms
  // Returns array of { startPct, endPct, type, candidateId }
}, [timelineCandidates, selectedRecordingSummary]);
```

- Minimum dwell visibility threshold: 500ms (don't render tiny imperceptible gaps)
- Min segment width: 0.15% (preview) / 0.2% (candidate timeline) to keep hairline-visible

---

## Step 4: Render segments on both timelines

**Preview scrubber** (line 1276): Render `<span>` elements inside `.preview-scrubber-track` before the pin markers:

```tsx
{timelineSegments.map((seg, i) => (
  <span
    className={`preview-scrubber-segment seg-${seg.type}`}
    style={{ left: `${seg.startPct}%`, width: `${seg.endPct - seg.startPct}%` }}
  />
))}
```

**Candidate timeline** (line 1696): Same pattern inside `.candidate-timeline-rail` before the playhead.

---

## Step 5: CSS — segment styles

**`frontend/src/styles.css`**

Positioning (shared):
```css
.preview-scrubber-segment,
.candidate-timeline-segment {
  position: absolute;
  top: 0;
  bottom: 0;
  pointer-events: none;
  z-index: 0;
}
```

Colors by transition type, using the app's existing CSS variables at low opacity:

| Type | Color | Opacity |
|------|-------|---------|
| `scroll` | `--info` (#2f6482) | 25% / 30% |
| `dwell` | `--warning` (#a2691b) | 12% / 15% |
| `navigation` | `--accent` (#d16d38) | 20% / 25% |
| `modal` | `--danger` (#b1453c) | 18% / 22% |
| `feed_card_swap` | `--success` (#2d7a5a) | 20% / 25% |
| `content_update` | `--muted` (#6f665a) | 15% / 18% |

Lower opacity values are for the compact preview scrubber, higher for the 24px candidate timeline. Also add `[data-bg='light']` variants with slightly reduced opacity.

---

## Edge cases

- **Old runs** without `event_start_ms`/`event_end_ms`: segments fall back to `timestamp_ms`, producing zero-width spans that aren't rendered. Dwell segments still work since `dwell_before_ms`/`dwell_after_ms` are already persisted.
- **Manual candidates**: No `score_breakdown` → skipped entirely by the segment derivation.
- **Overlapping events**: Low-opacity backgrounds stack visually — overlapping regions appear slightly darker, which is actually helpful feedback.
- **Single-sample events**: `event_start_ms === event_end_ms` → zero-width → not rendered (correct — they're point events, already shown as pins).

---

## Files to modify

| File | Change |
|------|--------|
| `backend/app/services/hybrid_detection.py` | Add event_start_ms/event_end_ms to score_breakdown in `_finalize_event()` and the fallback candidate |
| `backend/app/models.py` | Add event_start_ms/event_end_ms to CandidateScoreBreakdown |
| `frontend/src/types.ts` | Mirror the new fields |
| `frontend/src/features/analysis/AnalysisScreen.tsx` | Add timelineSegments useMemo + render segments on both timelines |
| `frontend/src/styles.css` | Segment positioning + color classes |

## Verification

1. Run existing backend tests: `pytest backend/tests/ -x`
2. Start the app, run an analysis on a recording
3. Inspect the API response: `score_breakdown` should contain `event_start_ms`, `event_end_ms`
4. Check both timelines: colored segments should appear for scroll events, navigation spans, dwell gaps
5. Verify old runs still render correctly (pins only, no segments — graceful degradation)
