# Stepthrough Manual

## What Stepthrough Is

Stepthrough is a local-first research tool for turning screen recordings into a structured set of reviewable screenshots.

In practice, it helps you:

- import one or more screen recordings into a project
- detect likely step changes automatically
- review and curate those candidate steps
- add manual steps when the detector misses something important
- export a clean walkthrough package for analysis, reporting, or design review

Everything runs locally on your machine. Imported videos, generated frames, metadata, and exports are stored under the project's local data directory.

## Who This Manual Is For

This guide is written for new research users who want to understand:

- how Stepthrough is organized
- what happens after you import a recording
- when to use each analysis engine
- how to choose settings for different research use cases
- how review, comparison, and export work

## Core Mental Model

Stepthrough works in five layers:

1. **Project**: a container for one study, participant set, prototype, or product area.
2. **Recording**: an imported screen recording inside that project.
3. **Run**: one analysis pass over a recording using a specific parameter set.
4. **Candidate**: a proposed screenshot or moment that may represent a meaningful step.
5. **Accepted step**: a reviewed candidate you decided should be part of the final walkthrough.

You can run the same recording multiple times with different settings, compare completed runs, and export either only accepted steps or all candidate steps.

## Main Workflow

### 1. Create or Open a Project

Projects help you keep recordings and runs grouped by study or topic.

Use a separate project when:

- you are working on a different app or product area
- you want different default settings for a specific study
- you want recordings and exports separated cleanly

### 2. Import Recordings

In the **import** stage, upload one or more video files. Stepthrough supports common formats such as `.mp4`, `.mov`, `.m4v`, `.webm`, and `.mkv`.

Each imported recording keeps its own:

- filename
- duration
- frame rate
- later analysis history

### 3. Configure Analysis

In the **analysis** stage, select a recording and choose the settings you want to use before pressing **run analysis**.

Stepthrough currently supports two analysis engines:

- **Hybrid v2**: optimized for interface-level changes
- **Current v1**: the older scene-boundary detector

Hybrid v2 is the default and should usually be your starting point.

### 4. Run Analysis

When you run analysis, Stepthrough creates a task for that recording and parameter set.

Tasks move through phases such as:

- queued
- preparing
- scanning
- extracting
- completed
- failed
- aborted

You can keep multiple runs for the same recording and compare them later.

### 5. Review Candidates

After a run completes, review the proposed candidates.

Each candidate can be marked as:

- **pending**: not reviewed yet
- **accepted**: belongs in the final walkthrough
- **rejected**: not useful for the final walkthrough

You can also:

- add a title
- add notes
- review score details
- jump through candidates quickly
- compare accepted steps and repeated scenes

### 6. Add Manual Steps

If the detector misses an important moment, use **mark step** in the preview area or press `K` while the preview is focused.

This creates a **manual** candidate at the current video time. Manual steps are helpful when:

- the visual change is too subtle for automatic detection
- a step depends on timing rather than appearance
- a state is visible only very briefly
- you want to guarantee a specific frame appears in the final walkthrough

### 7. Export

Once review is complete, export the results.

Available export modes:

- **export accepted**: only the steps you approved
- **export all**: every detected candidate in order
- **export all completed**: bulk export across completed tasks

The export bundle includes:

- an `images/` folder with exported screenshots
- `steps.csv`
- `steps.json`
- a `.zip` archive of the bundle

If a task has been reviewed and contains accepted items, Stepthrough treats accepted steps as the canonical export set. If a task has not been reviewed yet, it can export all candidates.

## Understanding the Analysis Engines

### Hybrid v2

**Best for:** app walkthroughs, usability tests, prototypes, interface studies, and recordings where meaningful changes happen inside the UI rather than as hard cuts.

Hybrid v2 combines:

- visual difference signals
- timing rules
- optional OCR confirmation

This makes it much better than v1 for:

- menus opening and closing
- button or tab changes
- sheet and modal transitions
- content updates inside the same screen
- text-heavy interfaces

#### Under the Hood: Engine Modules and Calculations

The Hybrid v2 engine relies strongly on **OpenCV (`cv2`)** for image processing, **NumPy** for matrix mathematics, and optionally **PaddleOCR** for text extraction. Instead of a single tolerance threshold, each sampled frame is scored against the previous frame using a combination of metrics:

**1. Visual Score**
A composite score reflecting overall visual change, aggregating:
- **Structural Loss (45% weight):** A manual SSIM (Structural Similarity Index Measure) calculated using the mean, variance, and covariance of grayscale pixels.
- **Tile Change Ratio (25% weight):** The frame is divided into a 4x4 grid. OpenCV's `absdiff` calculates how many of the 16 tiles experienced significant pixel shifts.
- **Changed Regions (20% weight):** After dilating the thresholded difference, `cv2.findContours` maps localized bounding boxes of changed areas. The score is influenced by the intensity of the most drastically changed region.
- **Edge Differences (10% weight):** Uses `cv2.Canny` to extract outlines and calculates the proportion of edges that moved.

**2. Motion Score**
A secondary score focused entirely on movement rather than structural difference, favoring Edge Differences (55% weight), Tile Ratio (25%), and Region Strength (20%).

**3. Text Score**
If the Visual or Motion score trips an initial trigger threshold, the frame is passed into the local **PaddleOCR** neural network. Extracted text from the previous frame is compared to the current frame using a string-distance algorithm to calculate the Text Score.

**4. The Combined Score & Settle Mechanics**
Every parsed frame yields a final **Combined Score** (`Visual*0.60 + Motion*0.25 + Text*0.15`). 
When a frame exceeds the `proposal_threshold`, an **Event Window** is opened. Subsequent frames are evaluated and appended as active moving samples until the score dips below the `settle_threshold`. The engine then waits for the **Settle Window** to close without further motion. Finally, it drops the blurriest frames and records the specific frame with the lowest motion as the canonical representative screenshot.
### Hybrid v2 Presets

Hybrid v2 has three presets.

#### Subtle UI

Use this when you want to catch small or brief interface changes.

Good for:

- tiny badges or state indicators
- hover-like changes in prototypes
- overlays and short menus
- subtle text changes

Tradeoff:

- more sensitive
- usually produces more candidates
- may require more review cleanup

Current preset baseline:

- sample fps: 8
- minimum dwell: 250 ms
- settle window: 250 ms

#### Balanced

This is the default preset and the best starting point for most studies.

Good for:

- general app walkthroughs
- mobile task flows
- desktop product tours
- most prototype review sessions

Tradeoff:

- moderate sensitivity
- moderate noise resistance

Current preset baseline:

- sample fps: 6
- minimum dwell: 400 ms
- settle window: 400 ms

#### Ignore Noise

Use this when the recording contains a lot of motion or low-value change.

Good for:

- noisy compression artifacts
- scrolling-heavy recordings
- recordings with frequent micro-motion
- dynamic content that should not become a step every few frames

Tradeoff:

- calmer output
- more likely to miss short, subtle steps

Current preset baseline:

- sample fps: 4
- minimum dwell: 700 ms
- settle window: 700 ms

### Hybrid v2 Advanced Controls

You usually do not need to touch these until a preset gets close but not quite right.

#### Sample FPS Override

Controls how densely the recording is sampled.

Raise it when:

- a step is very brief
- menus appear and disappear quickly
- short overlays are getting missed

Lower it when:

- you are getting too many small changes
- the recording is noisy
- you want a calmer result

#### Minimum Dwell

Controls how long a change must persist before Stepthrough treats it as a candidate.

Lower it when:

- a valid state appears only briefly
- transitions are fast and meaningful

Raise it when:

- flicker is being detected as a step
- transient motion keeps producing false positives

#### Settle Window

Controls how long Stepthrough waits for motion to settle before capturing the representative frame.

Lower it when:

- screenshots feel late
- the captured frame lands after the key state

Raise it when:

- screenshots are caught mid-animation
- opening panels or sheets are still moving when captured

#### OCR Confirmation

OCR confirmation helps validate text-heavy UI changes.

Leave it **on** when:

- labels, menu items, and text changes matter
- you are studying information architecture or wording changes
- the interface is visually similar but text differs

Turn it **off** when:

- you want pure visual-diff behavior
- OCR adds no value for the recording

### Current v1

**Best for:** older scene-style workflows, hard cuts, obvious screen swaps, or situations where you want a simpler detector with direct manual tuning.

Current v1 is useful when:

- the recording changes mainly through hard screen boundaries
- you want tight control over tolerance and sampling
- Hybrid v2 feels unnecessarily complex for the source material

It is less specialized than v2 for subtle in-screen UI changes.

### Current v1 Controls

#### Tolerance

Controls how sensitive the detector is to visual change.

Lower tolerance:

- catches subtler changes
- is more likely to detect noise

Higher tolerance:

- ignores smaller differences
- is more likely to miss subtle but real steps

Use lower tolerance when:

- keyboard states are being missed
- small banners or small UI differences matter

Use higher tolerance when:

- scrolling, compression shimmer, or tiny motion keep creating too many candidates

#### Minimum Scene Gap

Sets the minimum time spacing between candidates.

Raise it when:

- you want fewer near-duplicate steps
- the recording includes bursts of rapid changes

Lower it when:

- true steps happen close together
- rapid flows are collapsing into one candidate

#### Sample FPS

Controls how often the video is sampled.

Raise it when:

- you are missing very brief steps
- UI states flash by quickly

Lower it when:

- the detector is overfiring
- the recording contains lots of low-value movement

#### Extract Offset

Controls how far after the detected change Stepthrough captures the screenshot.

Raise it when:

- screenshots are landing mid-animation
- the captured frame is too early

Lower it when:

- screenshots are arriving after the important state

#### High-FPS Sampling

Use this for recordings above 30 fps when you want to sample more densely or use the source frame rate.

Turn it on when:

- the recording is very high frame rate
- you need maximum temporal sensitivity

Leave it off when:

- standard sampling is enough
- you want to reduce noise and keep the run lighter

#### Detector Mode

Current v1 offers two detector modes.

##### Content

Compares each sampled frame to the previous sampled frame.

Best for:

- hard cuts
- screen swaps
- more abrupt UI changes

##### Adaptive

Compares against a rolling average of recent frames.

Best for:

- softer transitions
- fades
- menus that emerge gradually

## Which Settings Should I Use?

### Recommended Starting Points

| Research situation | Recommended starting point |
| --- | --- |
| Standard app walkthrough | Hybrid v2 + Balanced |
| Prototype with subtle state changes | Hybrid v2 + Subtle UI |
| Noisy remote recording or compression artifacts | Hybrid v2 + Ignore noise |
| Text-heavy interface where wording changes matter | Hybrid v2 + Balanced with OCR on |
| Hard cuts between distinct screens | Current v1 + Content mode |
| Fade-heavy transitions or softer screen changes | Current v1 + Adaptive mode |
| Very brief menus, popovers, or sheets | Hybrid v2 + Subtle UI, then raise sample fps if needed |
| Too many duplicate or noisy steps | Hybrid v2 + Ignore noise, or Current v1 with higher tolerance and larger scene gap |

## Troubleshooting by Symptom

### "It missed important steps"

Try this order:

1. If you are on Hybrid v2, switch to **Subtle UI**.
2. Raise sampling density.
3. Lower dwell if the missing state is brief.
4. Lower settle window if capture timing is lagging.
5. Add a manual step for critical moments.

If you are on Current v1:

1. Raise sample fps first.
2. Lower tolerance.
3. Lower minimum scene gap.

### "It found too many steps"

Try this order:

1. If you are on Hybrid v2, switch to **Ignore noise**.
2. Raise dwell.
3. Raise settle window if motion-heavy transitions are being captured too early.
4. Turn off high-fps behavior if it is not needed.

If you are on Current v1:

1. Raise tolerance.
2. Raise minimum scene gap.
3. Lower sample fps.

### "The screenshots are correct moments, but the captured frame is ugly"

Use timing controls:

- Hybrid v2: raise or lower **settle window**
- Current v1: raise or lower **extract offset**

### "The recording has lots of scrolling"

Recommended:

- Hybrid v2 + Ignore noise
- or Current v1 with higher tolerance and a larger minimum scene gap

### "The change is mostly text, not layout"

Recommended:

- Hybrid v2
- keep OCR confirmation on

## Review Workspace Features

### Task List

Each run appears as a task.

From the task area you can:

- filter tasks by status
- open logs
- jump to review outputs
- export completed tasks
- compare completed runs for the same recording

Use multiple runs when you want to answer questions such as:

- Which preset is best for this recording?
- Does higher sensitivity add useful detail or just noise?
- Is v2 actually better than v1 for this material?

### Candidate Review

Each candidate includes:

- screenshot
- timestamp
- origin (`detected` or `manual`)
- status
- notes and title fields
- score information

This is the main curation surface for building a final walkthrough.

### Accepted Steps

Accepted candidates are turned into ordered steps such as:

- `step-001`
- `step-002`
- `step-003`

The accepted-steps strip is your draft final walkthrough. If Stepthrough detects a returning scene, the UI can show a link back to the earlier accepted step.

## Presets, Defaults, and Reuse

Stepthrough gives you several ways to reuse settings:

- **Save for this project**: use these settings as the default for one project on this machine
- **Save as universal defaults**: use these settings everywhere on this machine unless a project override exists
- **Preset text**: copy a portable text block that describes the current settings
- **Load preset text**: paste a text block back into the app
- **Reset**: return to project or universal defaults

This is helpful when:

- a whole study uses the same type of recording
- you want one workstation to keep a stable default recipe
- multiple researchers need to align on a run recipe by sharing preset text
- you want to keep a successful parameter set for later comparison

## Practical Research Workflows

### Usability Test Review

Recommended approach:

- create one project per study
- import all participant recordings
- start with Hybrid v2 + Balanced
- review accepted steps into a final walkthrough for each participant
- compare runs only when a recording behaves unusually

### Product Walkthrough Documentation

Recommended approach:

- use Hybrid v2 first
- use Subtle UI for polished interfaces with small state changes
- annotate accepted steps with action-oriented titles
- export accepted steps as the final documentation package

### Competitive or Comparative Analysis

Recommended approach:

- keep each product or prototype in its own project
- use comparable settings across runs
- use notes on accepted steps to capture observations
- export `steps.csv` and `steps.json` for structured downstream analysis

### Slide-Like or Hard-Cut Material

Recommended approach:

- try Current v1 first
- start with Content mode
- use Adaptive mode only if fades are important

## Final Advice

If you are unsure where to begin:

1. Start with **Hybrid v2 + Balanced**.
2. Run once.
3. Review whether the result is missing steps or producing noise.
4. Change only one thing at a time.
5. Use a second run for comparison instead of trying to reason from memory.

In most research workflows, the fastest path is:

- begin with the v2 default
- use presets before advanced tuning
- review candidates carefully
- add manual steps only for important misses
- export accepted steps once the walkthrough is clean
