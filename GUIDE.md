# Stepthrough Guide

Stepthrough turns a screen recording of an app or website into an ordered set of screenshots, one for every
screen the user stopped on. You review those steps, keep the ones that matter, annotate them and export them
as images with a spreadsheet. It is built for app and interface research, such as the walkthrough method,
usability studies and comparisons of platforms, and is used in the Digital Methods Initiative and in
hands-on app analysis seminars at the University of Amsterdam.

Everything runs on your own computer. Recordings, screenshots and exports stay in a local data folder and
are never uploaded anywhere.

**Contents**

1. [Why work from screen recordings](#1-why-work-from-screen-recordings)
2. [Key terms](#2-key-terms)
3. [Installing and starting Stepthrough](#3-installing-and-starting-stepthrough)
4. [Tutorial: your first walkthrough](#4-tutorial-your-first-walkthrough)
5. [How Stepthrough finds steps](#5-how-stepthrough-finds-steps)
6. [Settings](#6-settings)
7. [Reviewing steps](#7-reviewing-steps)
8. [Exports](#8-exports)
9. [Making good recordings](#9-making-good-recordings)
10. [Troubleshooting](#10-troubleshooting)
11. [Using Stepthrough in research](#11-using-stepthrough-in-research)
12. [Credits and references](#12-credits-and-references)

---

## 1. Why work from screen recordings

Taking screenshots by hand during a session interrupts the interaction and misses whatever you did not think
to capture. A screen recording keeps everything:

- **the whole interaction**, including moments you did not expect to matter;
- **dynamic states**, such as menus, loading screens, dialogs, notices and feeds that only exist for a moment;
- **no interruptions**: neither the researcher nor the participant has to stop and take screenshots;
- **a second look**: you can go back to the recording when you notice a missing step later.

The cost is that a recording is long and continuous, while an analysis needs discrete states. Stepthrough
does that conversion: it finds the screens the user actually stopped on and gives you one screenshot of
each, ready to review.

To see the process animated, open Stepthrough and choose **about → how it works** at the bottom right.

## 2. Key terms

| term | meaning |
| --- | --- |
| **project** | a container for one study, app or topic, holding its recordings and runs |
| **recording** | one imported screen recording |
| **run** (or task) | one analysis of a recording with one set of settings; you can run a recording as often as you like |
| **step** | a screen that stayed still long enough to matter, with one screenshot; called a candidate until you review it |
| **accepted step** | a step you decided belongs in the walkthrough |
| **label** | a description of the change that led to a step, such as navigation, scroll or typing |
| **export** | a zip with the screenshots, `steps.csv` and `steps.json` |

## 3. Installing and starting Stepthrough

If your course or lab provides a shared Stepthrough server, skip this section and open the address you were
given.

**Requirements:** Python 3.11 or later, Node.js 18 or later, [uv](https://docs.astral.sh/uv/) and
[FFmpeg](https://ffmpeg.org/) (with `ffprobe`) on your path.

```bash
git clone https://github.com/j-nivekk/stepthrough.git
cd stepthrough
./setup.sh        # installs the backend and frontend dependencies
./start.sh        # starts both; open http://localhost:5173
```

Text recognition (OCR) is optional and needs a large extra download (PaddleOCR):

```bash
cd backend && uv sync --group ocr
```

Your data lives in `data/` inside the project folder. To keep it somewhere else, start the backend with
`STEPTHROUGH_DATA_ROOT=/path/to/folder`.

Stepthrough is designed for a laptop or desktop browser window of at least 1120 × 760 pixels.

## 4. Tutorial: your first walkthrough

This takes 15 to 20 minutes. You need one short screen recording (one to three minutes) of a simple task,
such as signing in, searching for something, or changing a setting. See [section 9](#9-making-good-recordings)
for how to record.

### Step 1: create a project

On the start screen, type a name under **create a project** and press **enter**. Use one project per study
or app; projects keep their recordings, runs and preferred settings together.

To return to a project later, pick it from the list. Hovering over a project shows **import**,
**analysis** and **delete**.

### Step 2: import the recording

Drag the video onto the drop area, or click it to choose a file. Stepthrough accepts `.mp4`, `.mov`, `.m4v`,
`.webm` and `.mkv`. Each file shows **uploaded** when it is ready. Press **done** to go to the analysis.

While you continue, Stepthrough prepares a *working copy* of each recording in the background (see
[section 5](#5-how-stepthrough-finds-steps)). The first run waits for it if it is not ready yet.

### Step 3: choose settings and run

The analysis screen has three columns: **videos**, **parameters** and **tasks**.

1. In **videos**, click your recording to select it.
2. In **parameters**, set **recording type** to **phone or tablet** or **computer**, matching the device you
   recorded. Leave everything else at its default for the first run. **show hints** explains each setting.
3. Press **run analysis**.

The run appears under **tasks**, with its progress. A typical recording of a few minutes is analysed in
seconds; the first run on a new recording also waits for its working copy.

### Step 4: review the steps

When the run is done, click **review outputs**. Below the timeline you see every step as a card with its
screenshot, time, label and status.

For each step, ask:

- Does this show a meaningful state in the task?
- Would another reader need it to follow the walkthrough?
- Is it a duplicate, or a moment the user only passed through?

Then:

- **accept** (✓, or press `a`) the steps that belong in the walkthrough;
- **reject** (✕, or `r`) duplicates and noise;
- press **annotate** to give a step a title and notes, for example the action that led to it.

Hover over a screenshot for a moment to see the clip that led to that step, or choose **play from here** to
watch it in the video preview. [Section 7](#7-reviewing-steps) lists every review feature.

### Step 5: add a step by hand

If an important moment is missing, open the video with **preview** next to the recording's name, pause on
the moment, and press **mark** (or `k`). The moment is added to the run as a manual step.

Automatic detection is a starting point; your judgement decides what the walkthrough contains.

### Step 6: export

Press **export** above the steps and choose **export accepted**. The zip contains the screenshots,
`steps.csv` for a spreadsheet and `steps.json` with everything about the run (see [section 8](#8-exports)).

### Reflection

1. Which steps were clearly useful, and which were noise?
2. Did the detection miss any state that matters for your question?
3. When was a manual step needed, and why did the detection miss it?
4. What would have been harder or easier with screenshots taken live?

## 5. How Stepthrough finds steps

The principle is simple enough to report in a methods section: **a step is a screen that stays still for at
least the minimum time on screen.** For each such screen, Stepthrough keeps one screenshot, taken 200 ms after
the screen settles, so a screenshot never catches an animation half-way.

What happens to a recording:

1. **Working copy.** Phones and computers store a new frame only when the screen changes, so their
   recordings have no fixed frame rate. Stepthrough converts every upload into a working copy with a steady
   frame rate, the right orientation and standard colours (HDR recordings are converted), so every frame has
   its true time. The original file is kept unchanged.
2. **Comparison.** The working copy is analysed at 15 frames per second. Each frame is compared with the
   *first frame of the screen it belongs to*, not only with the frame before it, so slow changes such as a
   page loading over a few seconds still add up.
3. **Noise threshold.** Video compression makes pixels flicker slightly. Stepthrough measures that noise on
   each recording and only counts a pixel as changed when it differs by several times the noise (never less
   than 10 grey levels out of 255).
4. **What is ignored.** Small moving things do not end a screen: a blinking text cursor, a spinner, the
   phone status bar (clock, battery, recording indicator), and any area you mark as ignored.
5. **Stable screens.** When the screen stays still for at least the minimum time on screen, it becomes a
   step. A notice that is gone again within that time adds no step, and returning to a screen seen just
   before is merged with it.
6. **Typing.** Each pause while typing would look like a screen of its own. A burst of typing becomes one
   step that shows the finished text.
7. **Labels and revisits.** Every step gets a label for the change that led to it (see below). A step that
   returns to a screen seen earlier is marked as a revisit, with a link to the earlier step.

### Labels

Labels describe the change; they never decide what counts as a step.

| label | meaning |
| --- | --- |
| opening | the screen the recording starts on (step 0) |
| navigation | most of the screen changed: a new page or view |
| scroll | the content moved and came to rest |
| modal | a dialog or sheet appeared over a dimmed screen |
| feed swap | a full-screen swipe to the next item, as in short-video feeds |
| update | part of the screen changed, such as content loading in |
| ui change | a small change, such as a toggle, badge or button state |
| typing | a burst of typing, grouped into one step showing the finished text |

### What it cannot do

- **Content that never stops moving never becomes a step.** A playing video or a looping animation keeps the
  screen from being still. Draw an ignore area over it.
- **Screens shorter than the minimum time on screen are skipped.** Lower the minimum, or mark the moment by
  hand.
- **Changes smaller than the smallest change are ignored.** Lower it, or mark the moment by hand.
- **It sees pixels, not meaning.** Two screens that look alike count as the same; a large visual change
  without meaning (a colour theme switching) counts as a step.

## 6. Settings

Settings left empty follow the recording type: 450 ms and 0.10 % for a phone or tablet, 600 ms and 0.25 %
for a computer. Press **show hints** above the settings for a short explanation of each.

| setting | what it does | when to change it |
| --- | --- | --- |
| **recording type** | phone or tablet ignores the status bar; computer ignores small changes such as a moving mouse pointer | always match the device you recorded |
| **minimum time on screen** | how long a screen must stay still to count as a step | lower it (for example to 250 ms) to catch brief menus; raise it to skip screens the user only passed through |
| **smallest change** | the smallest connected change, as a share of the screen, that ends a screen | lower it for tiny badges or toggles; raise it if small animations add steps |
| **ignore areas** | boxes, drawn on a frame of the recording, in which changes are ignored | a live clock, an animated banner, an embedded video |
| **phone status bar** | include or ignore the clock, battery and recording indicator | include it only if it matters for your question |
| **scrolling** | **each stop**: every place the page comes to rest is a step; **merge stops**: keep only the first | merge stops when only the end of a long scroll matters |
| **group typing** | a burst of typing with short pauses becomes one step | turn it off if every pause matters |
| **opening screen** | include the screen the recording starts on as step 0 | turn it off if the first screen is not part of the task |
| **read text (ocr)** | reads the text of each screenshot into the export (`ocr_text`) | when you need the words for coding; it does not help find steps and makes runs slower |
| **pixel threshold** (advanced) | how much a pixel must change, in multiples of the measured noise | raise it for very noisy recordings |
| **analysis rate** (advanced) | frames per second analysed | rarely; lower is faster |

### Saving and sharing settings

- **save… → save for this project** keeps the current settings as the project's default in this browser.
- **save… → save as universal defaults** uses them everywhere in this browser.
- **preset text** shows the settings as a short text block you can copy, for example into a methods section
  or to share with your group; **load** pastes one back.
- The reset button (★ **reset**) returns to the project or universal defaults.

## 7. Reviewing steps

### The video preview

Click **preview** next to a recording to open its video. The scrubber shows every step as a pin and the labels
as coloured segments. The controls step to the previous or next step, step one frame back or forward
(`,` and `.`), play and pause (space), change the speed, background and size, and **mark** a manual step
(`k`). The × at the top right closes the preview.

While the video plays, the card of the step on screen is outlined, so you can follow where you are.

### Steps

| action | how |
| --- | --- |
| accept, reject, reset to pending | ✓ ✕ ↺ on the card, or `a` `r` `u` for the selected step |
| move between steps | `←` `→`, or **prev** and **next** |
| see the clip that led to a step | rest the pointer on its screenshot for a moment |
| play the video from a step | **play from here** on the screenshot, or `p` for the selected step |
| title and notes | **annotate** on a card, or type directly in the list view |
| filter by status | **all**, **pending**, **accepted**, **rejected** above the steps |
| hide steps by label | click a label in the legend above the timeline; click again to show them |
| switch layout | **grid** or **list**; the slider sets the image size |
| accept or reject many at once | tick the boxes on pending steps, then **accept selected** or **reject selected** |
| jump to an earlier visit of the same screen | **similar to candidate N** on a revisit |

### Comparing runs

Under **compare runs**, choose a second completed run of the same recording to see which steps both runs
found, which only one found, and which were found at slightly different times. This is useful for checking
what a change of settings does.

### Tasks

Every run is listed under **tasks** with its number of steps. **details** shows the settings it used,
**review outputs** opens it, and **select** lets you delete or export several runs at once.

## 8. Exports

**export accepted** exports the steps you accepted; **export all** exports every step. Under **tasks**,
**select** can export several runs at once. Each export is a zip with:

- `images/`: one PNG screenshot per step, named by recording, step number and time;
- `steps.csv`: one row per step, for a spreadsheet;
- `steps.json`: the same steps plus everything about the run.

Per step you get its time, screenshot path, status, title and notes, label (`transition_type`), when the
change started (`change_started_ms`), when the screen settled (`settled_ms`), how long it stayed on screen
(`time_on_screen_ms`), how many typing states were grouped (`grouped_states`), revisit links, the changed
regions and, with OCR on, the text read from the screenshot (`ocr_text`).

`steps.json` also records the recording's size and frame rate, the settings as chosen and as actually
applied, what was measured (such as the noise level), and `field_notes` explaining every field, so the
export can be read and cited without the app.

## 9. Making good recordings

### How to record

- **iPhone and iPad:** open Control Centre and tap **Screen Recording** (add it to Control Centre first if
  it is missing). Recordings are saved to Photos.
- **Android:** use the **Screen record** tile in Quick Settings (Android 11 and later).
- **Mac:** press Shift-Command-5 and choose to record the whole screen or a part of it.
- **Windows:** use the Snipping Tool's record mode, or the Xbox Game Bar (Windows-G) for a single app.

Transfer the file to the computer running Stepthrough (AirDrop, a cable, or a cloud folder) and import it.

### Tips

- **Turn on Do Not Disturb.** Notifications appear as extra steps and may show private messages.
- **Keep the orientation fixed** for the whole recording.
- **On a computer, keep the mouse still** when you are not using it, and record only the app's window if
  you can.
- **Pause briefly on each screen** if you are recording a walkthrough yourself, so every state is clearly
  stable.
- **Avoid autoplaying video** where you can, or plan to draw an ignore area over it.
- **Short is better than long.** Several recordings of one task each are easier to review than one long
  session.

## 10. Troubleshooting

### It missed important steps

1. Check that the recording type matches the device.
2. If the missing screen was brief, lower the **minimum time on screen**.
3. If the missing change was small, lower the **smallest change**.
4. Mark critical moments by hand.

### It found too many steps

1. If something on screen keeps moving, draw an **ignore area** over it.
2. If a mouse pointer causes extra steps, use the **computer** recording type.
3. Raise the **minimum time on screen** to skip screens the user only passed through.
4. Raise the **smallest change**.
5. For very noisy recordings, raise the **pixel threshold** under advanced.

### A page that keeps loading gives two steps

When a page settles and then loads more content, the loaded state is a step of its own, labelled *update*.
Reject the earlier one, or raise the minimum time on screen so the first state is skipped.

### There are many scroll steps

By default, every place the page comes to rest is a step. Use **scrolling: merge stops** to keep only the first.

### Text changes are missed

Text changes are visual changes and are found without OCR. If a single changed word is missed, lower the
**smallest change**. Turn on **read text (ocr)** only if you need the words themselves in the export.

### The run found almost no steps

The screen probably never stays still, for example because a video or animation keeps playing. Draw an ignore
area over it, or lower the minimum time on screen.

## 11. Using Stepthrough in research

### Reporting what you did

Every run stores the exact settings it used and what it measured, and every export includes them. A methods
section can say, for example:

> Screen recordings were segmented with Stepthrough. A step was defined as a screen that remained unchanged
> for at least 450 ms, ignoring changes smaller than 0.10 % of the screen and the phone status bar; bursts of
> typing were grouped into single steps. Detected steps were reviewed by the researcher; N of M were
> accepted and K added manually.

Copy the **preset text** of your settings into an appendix so others can repeat the analysis. Use the same
settings for all recordings you compare, and report manual additions and rejections.

### Typical uses

- **Walkthrough studies:** record the registration, everyday use and leaving of an app, and use the
  accepted steps and their notes as the basis of the walkthrough's description.
- **Usability tests:** one project per study, one recording per participant; compare where participants
  paused or went back (revisits show returns to earlier screens).
- **Platform comparisons:** one project per app or version, the same task recorded in each, with comparable
  settings; analyse `steps.csv` side by side.
- **Interface change over time:** record the same flow at different dates and compare the exported steps.

### Privacy and consent

Screen recordings often show names, messages, notifications and account details. Get consent before
recording someone's device, turn on Do Not Disturb, use test accounts where you can, and store recordings
and exports as research data under your institution's rules. Stepthrough keeps everything in its local data
folder; deleting a project in the app deletes its recordings, screenshots and exports from that folder (but
not copies you downloaded).

## 12. Credits and references

Stepthrough is created and maintained by H. "Kevin" Jin at the University of Amsterdam. The source code is at
[github.com/j-nivekk/Stepthrough](https://github.com/j-nivekk/Stepthrough) under the MIT licence.

Background reading:

- Light, B., Burgess, J., & Duguay, S. (2018). The walkthrough method: An approach to the study of apps.
  *New Media & Society, 20*(3), 881–900.
- Rogers, R. (2019). *Doing Digital Methods*. SAGE.
