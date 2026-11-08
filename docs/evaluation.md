# How well Stepthrough finds steps

This page reports how Stepthrough's step detection was tested, how well it does, and where it goes wrong. It
covers the engine that every new run uses, **stable screens** (`stable_v3`, engine version 1.0.0).
[Section 5 of the guide](../GUIDE.md#5-how-stepthrough-finds-steps) explains how it works in plain terms, and
[`backend/README.md`](../backend/README.md) lists its settings.

All numbers below were measured on 8 November 2026, with the code at commit `4300d4a`, on a Mac (Apple M4) with
FFmpeg 9.0.2, OpenCV 4.10 and Python 3.12. [Section 5](#5-reproducing-these-numbers) shows how to repeat them.

## Summary

- On 25 generated test recordings, encoded the way real uploads arrive and without a moving mouse pointer,
  Stepthrough found 48 or 49 of the 49 changes, with an F1 score of 0.97 to 0.98. Every matched screenshot
  showed the screen after it had settled.
- A mouse pointer that keeps moving is its weakest case (F1 0.86): typing is split into extra steps, and screens
  shorter than the minimum time on screen are skipped.
- The labels (navigation, scroll, and so on) match the kind of change about 63 % of the time. Treat them as
  hints, not as data.
- On four real iPhone recordings, the steps matched the screens a person could pick out by eye. On a real Mac
  recording, about a third of the steps lasted under a second, which is where in-between states end up. There
  is no labelled ground truth for real recordings yet, which is the biggest gap in this evaluation (see
  [section 4](#4-limits-and-edge-cases)).

## 1. What is being tested

A step is a screen that stays still for at least the **minimum time on screen**. For each such screen,
Stepthrough keeps one screenshot, taken 200 ms after the screen settles. In short:

1. Every upload is first turned into a *working copy*: a steady frame rate (at most 30 frames per second), the
   right way up, and standard colours (HDR recordings are converted).
2. The working copy is analysed at 15 frames per second, in grey, at 480 pixels on the long side.
3. Stepthrough measures how much the picture flickers from compression, and only counts a pixel as changed when
   it changes by several times that amount, and by at least 10 grey levels out of 255.
4. A screen ends when a connected area larger than the **smallest change** differs from the first frame of that
   screen. Areas that keep moving (a spinner, a blinking cursor), the phone's status bar and areas the user marks
   are ignored.
5. Afterwards, bursts of typing are grouped into one step, each step gets a label, and returns to an earlier
   screen are marked as revisits.

The defaults depend on the recording type:

| recording type | minimum time on screen | smallest change |
| --- | --- | --- |
| phone or tablet | 450 ms | 0.10 % of the screen |
| computer | 600 ms | 0.25 % of the screen |

## 2. How it was tested

### Generated recordings

The test suite in [`backend/tests/eval`](../backend/tests/eval) draws 25 short recordings of made-up
interfaces, and records exactly when each change happens (49 changes in total):

- **navigation:** plain cuts, fades, a dark theme, and screens that change quickly one after another;
- **scrolling:** a list, a very slow scroll, and a scroll followed by navigation;
- **feeds:** card swaps, a scrolling feed, full-screen swipes (fast and slow), and a feed with a fixed overlay;
- **overlays:** a dialog, a toast notification and a bottom sheet;
- **content:** changed numbers, a loading screen filling in, typing, and a long still screen;
- **sessions:** a longer browsing session, going back and forth between two screens, and a noisy recording;
- **what a step should be:** a chat message typed word by word with pauses (one step), two form fields filled
  in turn (one step each), and three switches toggled in a column (three steps, not one typing burst).

Real uploads are never as clean as a generated file, so each recording is also encoded the way uploads
actually arrive, and four common kinds of on-screen noise are added:

| variant | what it simulates |
| --- | --- |
| `raw` | the generated file itself, nearly lossless |
| `h264_cfr` | a compressed upload with a steady frame rate (H.264) |
| `h264_vfr` | a phone screen recording: a frame is only written when the screen changes (at least one per second) |
| `+cursor` | a blinking text cursor |
| `+spinner` | a loading spinner that keeps turning |
| `+pointer` | a mouse pointer that keeps moving (analysed with the **computer** recording type) |
| `+clock` | a status-bar clock that ticks every second |

Every variant goes through the app's own pipeline (working copy, then detection) with the default settings.
The scores are:

- **precision, recall and F1:** a step counts as found when it falls within 500 ms of a known change. Precision
  is the share of steps that match a change, recall the share of changes that were found, and F1 combines both.
- **right screenshot:** whether the exported screenshot shows the screen *after* the change, rather than the
  one before it or a frame half-way through an animation. This is judged in the part of the screen that
  changed, so that a small change such as a switch is not lost in compression noise.
- **opening screen:** whether step 0 is there and shows the first frame. The known changes do not include the
  opening screen, so it is left out of precision and recall.
- **labels:** how often a step's label describes the kind of change it matched.

### Real recordings

Five real screen recordings were analysed with the default settings:

- four iPhone recordings of a chat app (23 to 68 seconds, HEVC, one of them HDR), as **phone or tablet**;
- one Mac recording of a desktop session in a web browser (3 minutes 39 seconds, 3248 × 2122 pixels), as
  **computer**.

There is no ground truth for these. Each run was checked by eye against a contact sheet of all its screenshots.
The recordings are not published, because they show real accounts.

## 3. Results

### Generated recordings

| variant | precision | recall | F1 | right screenshot | opening screen | labels | detection time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `raw` | 0.96 | 0.98 | 0.97 | 48/48 | 25/25 | 62 % | 5 s |
| `h264_cfr` | 0.96 | 1.00 | 0.98 | 49/49 | 25/25 | 63 % | 5 s |
| `h264_vfr` | 0.96 | 1.00 | 0.98 | 49/49 | 25/25 | 63 % | 5 s |
| `h264_vfr+cursor` | 0.96 | 1.00 | 0.98 | 49/49 | 25/25 | 63 % | 5 s |
| `h264_vfr+spinner` | 0.96 | 0.98 | 0.97 | 48/48 | 25/25 | 62 % | 5 s |
| `h264_vfr+pointer` | 0.84 | 0.88 | 0.86 | 41/43 | 25/25 | 65 % | 6 s |
| `h264_vfr+clock` | 0.96 | 1.00 | 0.98 | 49/49 | 25/25 | 63 % | 6 s |

Detection time is for all 25 recordings together.

What goes wrong:

- **Extra steps (precision 0.96).** In two recordings, Stepthrough adds a step when the screen goes back to how
  it was before: a toast that disappears, and a dialog that is closed in the browsing session. These are real
  screens, but the known changes do not list them.
- **A moving mouse pointer.** With the pointer, a typed chat message and the two form fields are split into five
  extra steps, two screenshots show the wrong state, and six changes are missed. Four of the missed changes are
  in the "rapid" recordings, whose screens last 0.5 to 0.6 seconds: shorter than the computer type's 600 ms
  minimum.
- **Two misses that are not explained yet.** The plain list scroll is missed in the nearly lossless `raw` file,
  but found in every compressed version, and also when the same file is analysed without a working copy. The
  very slow scroll (under one pixel per frame) is missed when a spinner is added, and found otherwise. Both
  look like cases that sit right at a threshold.

### Real recordings

| recording | length | recording type | steps | detection time | peak memory |
| --- | --- | --- | --- | --- | --- |
| iPhone 1 | 23 s | phone | 7 | 1.6 s | 173 MB |
| iPhone 2 (HDR) | 25 s | phone | 8 | 2.4 s | 312 MB |
| iPhone 3 | 46 s | phone | 8 | 2.4 s | 314 MB |
| iPhone 4 | 68 s | phone | 8 | 2.8 s | 355 MB |
| Mac desktop | 3 min 39 s | computer | 61 | 26.8 s | 747 MB |

Detection time leaves out the working copy, which is made once per recording when it is imported.

- **iPhone recordings.** The steps match the screens that can be picked out by eye: Control Centre at the start,
  the app with the keyboard up, the typed prompt, the sent prompt, the streamed answer, and the places where
  scrolling stopped. In the 68-second recording, a prompt typed over 38 seconds with 16 pauses became one step
  showing the finished prompt. The HDR recording's screenshots have normal contrast.
- **Mac recording.** Most of the 61 steps are real changes of page or panel. 19 of them were on screen for less
  than a second, which is where in-between states, such as half-loaded pages, tend to end up. Raising the
  minimum time on screen to one second drops them. Most changes in this recording were labelled *navigation*, even when only one
  panel of the screen changed.

## 4. Limits and edge cases

### What it does not see

- **Changes in colour only.** Frames are compared in grey, so a change between two colours of about the same
  brightness can be missed. In a check with plain full-screen colours, a switch from green (`#20C997`) to orange
  (`#FD7E14`), about 7 grey levels apart, did not count as a change.
- **Changes below the smallest change.** On a phone, the default is 0.10 % of the screen (about a 55 × 55 pixel
  patch on a recent iPhone). Smaller changes, such as a badge appearing or a single character,
  may not end a screen on their own. Lower the setting if they matter.
- **Screens shorter than the minimum time on screen** are skipped, by design. This is the trade-off behind the
  missed changes in the "rapid" recordings above.
- **Something that never stops moving.** A playing video or a large animation keeps the screen from being
  still, so it hides the steps around it. Stepthrough only ignores moving areas by itself when they are small
  (under a quarter of the screen) and keep changing second after second, like a spinner. Anything slower or
  larger, such as a carousel that turns every few seconds or a full-screen video, needs an ignore area.

### What it sees too much

- **Returns to an earlier screen** (a toast going away, a dialog closing) are steps of their own, marked as
  revisits.
- **Notifications and system overlays** are real changes on screen and become steps. Turning on Do Not Disturb
  before recording avoids them.
- **iPhone recordings started from Control Centre** begin with one or two Control Centre steps. There is no way
  to trim the start of a recording yet, so these steps have to be rejected by hand.
- **Desktop recordings.** The computer type ignores small changes such as a moving pointer, but hover effects
  (tooltips, highlighted buttons) are real changes and can become steps. In-between states, such as half-loaded
  pages, show up when they last longer than the minimum time on screen.

### Typing

- The rules that group typing were tuned on one real recording (an iPhone keyboard, typing in English) and on
  the generated recordings. Android keyboards, typing on a computer, autocomplete suggestions, and right-to-left
  or non-Latin scripts have not been tested on real recordings.
- A pause of more than 6 seconds ends a burst of typing, so the text so far becomes a step.
- With a moving mouse pointer, typing is split into several steps (see the results above).

### Labels and revisits

- Labels describe the change and never decide what counts as a step. They agree with the kind of change about
  63 % of the time. Known mix-ups: full-screen video swipes are mostly labelled *navigation*, panels that slide
  in without dimming the screen are labelled *update*, and a swap of feed cards can only be told apart from a
  long scroll when the swipe covers about one full screen.
- A revisit means "the same picture by the same test that ends a screen", not "the same page". Two different
  pages that look alike can be linked as revisits, and the same page at a different scroll position is not.

### Recordings and formats

- **Variable frame rate.** Phone and computer recordings only store a frame when the screen changes. The working
  copy resamples them by real time, so every analysed frame has its true time. Recordings above 30 frames per
  second are resampled to 30.
- **HDR.** HDR10 recordings are converted with a tone curve that measures how bright the interface's white is.
  This was tested on one real iPhone HDR recording and on generated clips. HLG recordings are converted too, but
  have not been tested on a real recording.
- **Different FFmpeg versions** make the same working copy: the colour conversion is set up so that FFmpeg 7.1
  and 9.0.2 give identical pixels.
- **Long recordings.** The analysis keeps its small grey frames in memory up to 512 MB, which is about four
  minutes of a computer recording or five of a phone recording. Longer recordings are decoded a second time instead, which is slower but gives the same
  result.

### Text recognition

Text recognition (OCR) is not part of finding steps, and its accuracy has not been evaluated beyond a check that
it reads two large words correctly. On Intel and AMD processors it runs without PaddlePaddle's oneDNN
acceleration, which is broken in the version Stepthrough uses, so it is slower there.

### Limits of this evaluation

- The generated recordings are drawn by the same project that built the engine, so the engine may suit them
  better than real interfaces. 25 recordings with 49 changes is a small set.
- The real recordings are few, come from one person's devices, mostly show one app, and have no ground truth.
  No Android, Windows or tablet recordings have been tested yet.
- **Planned:** a labelled benchmark of real recordings, made with consent across phones, tablets and computers,
  with the settled screens marked by two people independently, so that their agreement can be reported too.

## 5. Reproducing these numbers

From the `backend` folder:

```bash
# the generated recordings, every variant (about two minutes)
uv run python -m tests.eval.stress --set all
# the regression checks that run with the normal tests
uv run pytest tests/eval/ -q
# real recordings of your own: prints what was measured and writes a contact sheet of every step
uv run python experiments/real_stable.py OUT_DIR CACHE_DIR path/to/recording.mp4 [--type desktop]
```

## 6. Background

Detecting steps as stable screens follows the steady-state keyframe method of GIFdroid (Feng and Chen, 2022),
which finds keyframes in GUI recordings as stretches where consecutive frames stay alike for a minimum time.
Earlier versions of Stepthrough instead scored every change with a weighted mix of signals and then looked for
a settled frame after it. That approach was harder to explain and to cite, and it broke down on the variable
frame rate of real phone recordings. Those engines are retired: runs made with them still open and export, and
their code is at the git tag `last-with-hybrid-v2`.

- Feng, S. and Chen, C. (2022). GIFdroid: An Automated Light-weight Tool for Replaying Visual Bug Reports.
  *ICSE 2022 Companion*, pp. 95–99. https://arxiv.org/abs/2112.04128
- Feng, S., Xie, M., Xue, Y. and Chen, C. (2023). Read It, Don't Watch It: Captioning Bug Recordings
  Automatically. *ICSE 2023*, pp. 2349–2361. https://arxiv.org/abs/2302.00886
