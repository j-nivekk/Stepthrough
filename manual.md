# Stepthrough Manual

## What Stepthrough Is

Stepthrough is a local-first research tool for turning screen recordings into a structured set of reviewable screenshots. It is primarily developed for the "walkthrough method" and UI/UX research that offloads the manual work of taking screenshots every time a UI change happens. Works in principle for anything that can be screen-recorded, but bear in mind that the more animations (scrolling, fading, flashing, etc.) the more likely it is that the detector will miss steps.

## Why Start From A Screen Recording?

In walkthrough-driven research, a screen recording is often a better starting medium than taking screenshots manually during the session.

A recording helps because:

- it captures the whole interaction, including moments you may not have expected to matter
- it preserves dynamic behavior such as scrolling, fading, flashing, loading states, and overlays
- it removes the need to interrupt a session to reach for screenshot shortcuts
- it lets you backtrack later if you realize an important state was missed
- it works well for informal or fast-moving interfaces such as feeds, threaded conversations, and short-form video apps

This matters because many meaningful interface states are not stable enough to capture comfortably in real time. They appear briefly during motion, transition, or interaction and are easier to review afterward from a recording.

In practice, it helps you:

- import one or more screen recordings into a project
- detect likely step changes automatically
- review and curate those candidate steps
- add manual steps when the detector misses something important
- export a clean walkthrough package for analysis, reporting, or design review

If you are new to the app, the beginner onboarding pages in `docs/wiki/` are a good place to start before reading the full manual.

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

Start by picking the **recording type**: phone or tablet, or computer. It sets sensible defaults for everything else. The settings are explained in [How Stepthrough Finds Steps](#how-stepthrough-finds-steps); press **show hints** above them for a short explanation of each.

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

## How Stepthrough Finds Steps

Stepthrough has one analysis engine, **stable screens** (`stable_v3`). Its idea is simple enough to state in a methods section: **a step is a screen that stays still for at least the minimum time on screen.** For every such screen, Stepthrough takes one screenshot from inside it, 200 ms after it settles, so a screenshot never catches an animation half-way.

A few details make this work on real recordings:

- **Every frame is compared with the first frame of the current screen**, not only with the frame before it. A page that loads slowly over a few seconds therefore still counts as a change.
- **The pixel threshold comes from the recording itself.** Stepthrough measures the compression noise of each recording and only counts a pixel as changed when it differs by several times that noise (and never by less than 10 grey levels).
- **Small moving things do not break a stable screen**: a blinking text cursor, a spinner, or anything inside an area you told it to ignore.
- **Recordings are analysed at 15 frames per second**, from a constant-frame-rate working copy made when the video is imported. Phone recordings, which have a variable frame rate, give the same result as any other upload.

### Labels

Each step gets a label that describes the change that led to it. Labels are descriptive only: they never decide whether something is a step. You can hide steps by label by clicking the label legend above the timeline.

| label | meaning |
| --- | --- |
| opening | the screen the recording starts on (step 0) |
| navigation | most of the screen changed: a new page or view |
| scroll | the content moved up or down and came to rest |
| modal | a dialog or sheet appeared over a dimmed screen |
| feed swap | a full-screen vertical swipe to the next item, as in short-video feeds |
| update | part of the screen changed, such as content loading in |
| ui change | a small change, such as a toggle, badge or button state |
| typing | a burst of typing, grouped into one step that shows the finished text |

A step that returns to a screen seen earlier is marked as a **revisit**, with a link back to the earlier step.

### Settings

Settings left empty follow the recording type: 450 ms and 0.10 % for a phone or tablet, 600 ms and 0.25 % for a computer.

| setting | what it does | when to change it |
| --- | --- | --- |
| recording type | phone or tablet ignores the status bar; computer ignores small changes such as a moving mouse pointer | pick the one that matches the device |
| minimum time on screen | how long a screen must stay still to count as a step | lower it to catch brief menus and popovers; raise it to skip screens the user only passed through |
| smallest change | the smallest connected change, as a share of the screen, that ends a stable screen | lower it for tiny badges or toggles; raise it if small animations create extra steps |
| ignore areas | boxes, drawn on a frame of the recording, in which changes are ignored | a live clock, an animated banner, an embedded video |
| phone status bar | include or ignore the clock, battery and recording indicator | include it only if it matters for your analysis |
| scrolling | each stop: every place the page comes to rest is a step; merge stops: keep only the first | merge stops when only the end of a long scroll matters |
| group typing | a burst of typing with short pauses becomes one step | turn it off if every pause matters |
| opening screen | include the screen the recording starts on as step 0 | turn it off if the first screen is not part of the task |
| read text (OCR) | reads the text of each screenshot into exports (`ocr_text`) | when you need the words for coding; it does not help find steps and makes runs slower |
| sensitivity (advanced) | the pixel threshold, in multiples of the measured noise | raise it for very noisy recordings |
| analysis rate (advanced) | frames per second analysed | rarely; lower is faster |

Every run stores the settings it actually used, the engine version and what it measured (noise, pixel threshold, number of stable screens). Exports include all of this, so a run can be described and repeated exactly.

### What It Cannot Do

- **Content that never stops moving never becomes a step.** A playing video or a looping animation keeps the screen from being still. Draw an ignore area over it.
- **Screens shorter than the minimum time on screen are skipped.** Lower the minimum, or mark the moment by hand.
- **Changes smaller than the smallest change are ignored.** Lower it, or mark the moment by hand.

### Earlier Engines

Runs made before November 2026 with the earlier engines, **hybrid v2** and **v1**, still open, review, compare and export as before; they are marked *(retired)*. New runs always use stable screens. To repeat an old run exactly, the earlier engines are kept at the git tag `last-with-hybrid-v2`.

## Which Settings Should I Use?

### Recommended Starting Points

| Research situation | Recommended starting point |
| --- | --- |
| Phone or tablet app walkthrough | phone or tablet (the default) |
| Desktop or browser recording with a mouse | computer |
| App with a live clock, ticker or animated banner | draw an ignore area over it |
| Feed or video app where content keeps playing | draw an ignore area over the video |
| Chat, search or forms | keep group typing on, so each typed message is one step |
| Long scrolls where only the end matters | scrolling: merge stops |
| You need the visible text for coding | turn on read text (OCR) |
| Very brief menus, popovers or sheets | lower the minimum time on screen, for example to 250 ms |

## Troubleshooting by Symptom

### "It missed important steps"

Try this order:

1. Check the recording type.
2. Lower the minimum time on screen if the missing screen was brief.
3. Lower the smallest change if the missing change was small.
4. Mark critical moments by hand.

### "It found too many steps"

Try this order:

1. If something on screen keeps moving, draw an ignore area over it.
2. If a mouse pointer causes the extra steps, use the computer recording type.
3. Raise the minimum time on screen to skip screens the user only passed through.
4. Raise the smallest change.
5. For very noisy recordings, raise the sensitivity under advanced.

### "A page that keeps loading gives two steps"

When a page settles, then loads more content, the loaded state is a step of its own, labelled *update*. Reject the earlier one, or raise the minimum time on screen so the first state is skipped.

### "The recording has lots of scrolling"

By default, every place the page comes to rest is a step. Use **scrolling: merge stops** to keep only the first.

### "The change is mostly text, not layout"

Text changes are visual changes, so they are found without OCR. Turn on **read text (OCR)** only if you need the words themselves in the export.

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

- Which recording type fits this material?
- Does a shorter minimum time on screen add useful detail or just noise?
- Does an ignore area remove the extra steps without hiding real ones?

### Candidate Review

Each candidate includes:

- screenshot
- timestamp
- origin (`detected` or `manual`)
- label, and how long the screen stayed on screen
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
- start with the recording type that matches the device
- review accepted steps into a final walkthrough for each participant
- compare runs only when a recording behaves unusually

### Product Walkthrough Documentation

Recommended approach:

- start with the default settings
- lower the smallest change for polished interfaces with small state changes
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

- each slide that stays on screen becomes a step, so the defaults usually work
- use the computer recording type for screen-shared slides with a mouse pointer

## Final Advice

If you are unsure where to begin:

1. Pick the **recording type** and keep the other defaults.
2. Run once.
3. Review whether the result is missing steps or producing noise.
4. Change only one thing at a time.
5. Use a second run for comparison instead of trying to reason from memory.

In most research workflows, the fastest path is:

- begin with the defaults for your recording type
- change the minimum time on screen or the smallest change before anything under advanced
- review candidates carefully
- add manual steps only for important misses
- export accepted steps once the walkthrough is clean
