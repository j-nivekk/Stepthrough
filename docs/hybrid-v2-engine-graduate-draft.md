# Hybrid v2 Engine in Stepthrough (Graduate Draft)

## Who this is for

This draft is for readers who know basic Python and data processing, but are newer to scene detection, UI-video analysis, and Stepthrough's custom heuristics.

## What problem hybrid v2 is solving

A classical scene detector is good at finding obvious cuts: screen A, then screen B, then screen C.

That is not enough for many product walkthroughs. In a UI recording, important changes often happen inside one screen:

- a modal opens
- a toast appears
- a feed card changes
- a badge updates
- text changes in place
- a bottom sheet settles after sliding in

Hybrid v2 is built to catch those interface-level changes, not just hard cuts.

## The main idea

Hybrid v2 works like a small evidence-accumulation system:

1. Sample frames from the video at regular times.
2. Compare each sampled frame to the previous one, and sometimes also to an older anchor frame.
3. Measure several kinds of change:
   - structural change
   - localized changed regions
   - motion and scroll evidence
   - optional text change from OCR
4. Combine those signals into one score.
5. Group nearby changed samples into an event window instead of emitting a new candidate for every frame.
6. Pick one stable representative frame for that event.
7. Save that frame as a screenshot candidate for review.

So the engine is not asking, "Did the whole scene cut?" It is asking, "Did the interface enter a meaningfully new state?"

## Step-by-step view of the pipeline

### 1. Sample the video

The engine does not inspect every frame by default. It samples the recording at a preset-dependent rate such as 4, 6, or 8 frames per second.

Why this matters:

- higher sampling catches brief overlays and fast UI states
- lower sampling is calmer and less likely to overreact to noise

### 2. Shrink and normalize the frame

For analysis, the engine resizes the frame so the longest edge is at most `960 px`, converts it to grayscale, and computes edges.

Why this matters:

- it keeps the analysis fast
- it focuses on structure rather than raw color alone

The final screenshot is still extracted from the original video later.

### 3. Measure different kinds of change

Hybrid v2 does not rely on one number. It combines several signals.

#### Structural change

The engine compares local patches of the frame, not only the whole image.

This helps because a tiny but meaningful change, such as a badge or toast, may affect only a small part of the screen. If you only average over the full frame, that kind of change gets washed out.

#### Changed regions

The engine also finds bounding boxes where pixels changed enough to matter.

This gives it two advantages:

- it knows where the change happened
- it can OCR only those parts instead of scanning the whole frame every time

#### Motion and scroll evidence

Hybrid v2 estimates whether content moved, especially vertically, which helps it tell the difference between:

- scrolling
- feed-style card swaps
- larger navigation changes

#### Chrome versus content

The engine tries to distinguish repeated change in persistent top chrome from change in the main content area.

This reduces false positives from things like unstable header areas or repeated tiny changes in a fixed top bar.

#### OCR-based text change

If OCR is enabled and the change looks promising, the engine reads text from the changed areas. It then compares the tokens from the previous and current frame.

This helps catch cases where:

- the layout barely changes
- the visual structure is similar
- but the actual wording or value is different

## How the final score is formed

The current backend mostly trusts visual evidence, then motion, then text, with some extra weight for content-area change and scroll strength.

In plain language:

- visual change is the main signal
- motion matters, but less than visual change
- text change can rescue subtle UI events
- content-area change and scroll strength give extra context

Older docs describe a simpler 3-term formula, but the current backend uses a richer blend.

## Why the engine uses event windows

If the system emitted a candidate for every changed sample, you would get many redundant screenshots from the same interaction.

Instead, hybrid v2 opens an event window when change becomes strong enough, then keeps adding samples while the change is still active. Once the interaction settles, it emits one representative candidate.

This does two useful things:

- groups a short burst of motion into one logical event
- lets the engine choose a screenshot after the motion has calmed down

## How it chooses the representative screenshot

For normal events, the engine usually chooses the lowest-motion sample after the change starts settling.

That means it is trying to avoid screenshots that are:

- mid-animation
- mid-scroll
- blurry or unstable looking

For very tiny "micro-change" events, it can instead use the strongest sample directly.

## The presets: what they really do

A preset is not just a label. It changes several internal values at once:

- how often the video is sampled
- how long a change must persist
- how long the engine waits for motion to settle
- how easily a change opens or continues an event
- how readily OCR is triggered

### Subtle UI

Use this when you care about small or brief interface changes.

Current backend baseline:

- sample FPS: `8`
- minimum dwell: `250 ms`
- settle window: `250 ms`

What it feels like:

- more sensitive
- catches brief overlays and small text-led changes more often
- produces more candidates

Good when:

- a tooltip, toast, badge, or short menu matters
- small wording changes matter
- a prototype has subtle state shifts

### Balanced

This is the default starting point.

Current backend baseline:

- sample FPS: `6`
- minimum dwell: `350 ms`
- settle window: `350 ms`

What it feels like:

- middle-ground sensitivity
- good first pass for most walkthroughs
- less noisy than Subtle UI, less strict than Ignore Noise

Good when:

- you are analyzing normal app flows
- you do not yet know how noisy the recording is
- you want a reasonable default before tuning

### Ignore Noise

Use this when the recording has a lot of motion, shimmer, or low-value change.

Current backend baseline:

- sample FPS: `4`
- minimum dwell: `700 ms`
- settle window: `700 ms`

What it feels like:

- calmer
- more conservative
- more likely to skip short or subtle events

Good when:

- the recording is scroll-heavy
- compression noise is high
- the interface is constantly moving but only some changes matter

## What changing each parameter does

### Preset

Changing the preset changes the detector's personality.

- Move toward `subtle_ui` when real states are being missed.
- Move toward `noise_resistant` when too many low-value candidates appear.

### Sample FPS override

This changes how densely the video is sampled.

Raise it when:

- a state appears very briefly
- menus or overlays show up and disappear quickly
- short-lived UI events are being missed

Lower it when:

- you are getting too many tiny candidates
- the recording is noisy
- you want a calmer result

Tradeoff:

- higher sampling improves sensitivity
- higher sampling also increases compute and candidate volume

### Minimum dwell

This is how long a change should persist before the engine is comfortable keeping it as a meaningful event.

Lower it when:

- a real state exists only briefly
- transitions are fast but important

Raise it when:

- flicker keeps getting detected
- transient motion is causing false positives

Mental model:

- lower dwell means "be willing to trust short-lived changes"
- higher dwell means "wait for proof that this is not just noise"

### Settle window

This controls how long the engine waits for motion to calm down before choosing the screenshot.

Lower it when:

- screenshots feel too late
- the chosen frame lands after the key state

Raise it when:

- screenshots are caught mid-animation
- panels or sheets are still moving when captured

Mental model:

- lower settle means "capture sooner"
- higher settle means "capture more calmly"

### Proposal threshold

This controls how much combined evidence the engine needs before it starts a new event window.

Lower it when:

- subtle but real UI changes are being missed
- a brief overlay or menu does not start an event cleanly
- you want more sensitivity after the preset gets close but still feels too strict

Raise it when:

- too many low-value event windows are opening
- tiny motion or shimmer keeps creating candidates
- the detector feels too eager

Mental model:

- lower proposal threshold means "start events more easily"
- higher proposal threshold means "wait for stronger proof before starting"

### Settle threshold

This controls how easily an event window stays alive once it has already started.

Lower it when:

- one real interaction is splitting into several nearby events
- the engine gives up too quickly while motion is still settling
- a change should stay grouped a little longer

Raise it when:

- events linger too long after the important part is over
- nearby motion keeps getting folded into the same event
- you want the detector to settle faster

Mental model:

- lower settle threshold means "stay committed longer"
- higher settle threshold means "end the event sooner"

### OCR trigger threshold

This controls how strong the signal should be before Hybrid v2 escalates to OCR confirmation.

Lower it when:

- text changes matter a lot
- labels or numbers change inside a visually stable layout
- subtle text-led changes are being missed

Raise it when:

- OCR should stay more selective
- most useful changes are already obvious visually
- you want less OCR work on noisy recordings

Mental model:

- lower OCR trigger threshold means "ask OCR for help sooner"
- higher OCR trigger threshold means "only ask OCR when the visual evidence is already strong"

### OCR confirmation

When OCR is on, hybrid v2 can use text changes as extra evidence.

Keep it on when:

- wording matters
- labels or numbers change inside a mostly stable layout
- you are studying information architecture or text changes

Turn it off when:

- text does not matter for this recording
- you want purely visual behavior
- you want to avoid OCR startup or runtime cost

Important behavior:

- OCR is selective, not constant
- the backend can disable it automatically if OCR is unavailable
- if OCR initialization fails, the run continues with visual-only logic instead of failing completely

### Minimum scene gap

This is the minimum spacing allowed between emitted candidates on the timeline.

Raise it when:

- many nearby candidates are really part of the same interaction
- the output feels too dense

Lower it when:

- you want tightly spaced events to remain separate
- several important steps happen close together in time

Important nuance:

Hybrid does not simply "pause detection" during the gap. It detects events normally, then keeps the stronger one when two finalized events land too close together.

## Parameters that currently do not drive hybrid behavior

The app uses one shared run-settings model for both the old scene detector and hybrid v2. Because of that, some controls still exist in the payload even though the current hybrid backend does not use them.

In the current implementation, these do not change hybrid detection:

- `tolerance`
- `sample_fps` (the older global sampling field)
- `detector_mode`
- `allow_high_fps_sampling`
- `extract_offset_ms`

The parameter that often surprises people is `extract_offset_ms`.

In the old scene-based engine, extract offset changes where inside a detected segment the screenshot is taken. In the current hybrid engine, the screenshot is taken at the event's chosen representative timestamp, so changing `extract_offset_ms` does not currently move the hybrid screenshot.

## A practical tuning cheat sheet

### If hybrid misses a very short overlay or menu

Try, in order:

1. switch to `subtle_ui`
2. raise sample FPS override
3. lower minimum dwell a bit
4. lower proposal threshold slightly

### If hybrid catches too many tiny, low-value changes

Try, in order:

1. switch to `noise_resistant`
2. lower sample FPS override
3. raise minimum dwell
4. raise minimum scene gap
5. raise proposal threshold slightly

### If screenshots are landing mid-animation

Raise settle window.

### If screenshots feel too late

Lower settle window.

### If text changes matter and are being missed

Make sure OCR stays on, then consider:

1. `subtle_ui`
2. higher sample FPS
3. lower minimum dwell
4. lower OCR trigger threshold slightly

### If the recording is mostly scrolling and the output feels cluttered

Use `noise_resistant`, then consider a larger minimum scene gap.

## Important implementation caveats

At the time of this draft:

- the backend is the source of truth for preset values
- the app now exposes backend-owned preset metadata so frontend copy can stay aligned with the engine
- older docs also describe a simpler combined score than the one the backend now uses
- deeper engine constants such as tile-grid size, contour cutoffs, OCR cache limits, and transition heuristics are still intentionally internal

## Summary

Hybrid v2 is best understood as a custom UI-state detector rather than a classic scene-cut detector.

Its core strengths are:

- local-change sensitivity
- selective OCR for text-led updates
- scroll and motion awareness
- event-window grouping instead of one-candidate-per-frame behavior
- stable screenshot selection after motion settles

In practice, the most useful controls are:

- preset
- sample FPS override
- minimum dwell
- settle window
- proposal threshold
- settle threshold
- OCR trigger threshold
- OCR on/off
- minimum scene gap

Those are the parameters that meaningfully change how hybrid behaves on real recordings.
