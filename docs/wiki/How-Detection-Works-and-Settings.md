The main rule is short enough to report in a methods section: **a step is a screen that stays still for at
least the minimum time on screen.** For each such screen, Stepthrough keeps one screenshot, taken 200
milliseconds after the screen comes to rest, so that a screenshot never catches an animation half-way.

## How Stepthrough finds steps

What happens to a recording:

1. **Working copy.** Phones and computers only save a new frame when something on screen changes, so a screen
   recording has no steady number of frames per second. Stepthrough turns every upload into a working copy
   with a steady frame rate, the right way up, and with standard colours (HDR recordings are converted). This
   way every frame has its true time. Your original file is kept as it was.
2. **Comparing frames.** Stepthrough looks at 15 frames per second of the working copy. It compares each frame
   with the *first frame of the screen it belongs to*, not just with the frame before it. That way, slow
   changes, such as a page that loads over a few seconds, still add up.
3. **Ignoring flicker.** Video compression makes colours flicker slightly from frame to frame. Stepthrough
   measures how much they flicker in each recording, and only counts a pixel as changed when it changes by
   several times that amount (and always by at least 10 shades out of 255).
4. **What is ignored.** Small moving things do not end a screen: a blinking text cursor, a loading spinner,
   the phone's status bar (clock, battery, recording indicator) and any area you marked to ignore.
5. **Still screens.** When the screen stays still for at least the minimum time on screen, it becomes a step.
   A notification that disappears again within that time does not add a step, and going back to the screen
   you saw just before counts as the same step.
6. **Typing.** Every pause while typing would otherwise look like a new screen. Instead, a burst of typing
   becomes one step that shows the finished text.
7. **Labels and returns.** At the end, Stepthrough compares the screenshots with each other. It looks for areas whose
   content moved up or down (also one pane of several), for something that lies over the screen (new edges all round
   it, with the rest of the screen as it was, or dimmed), and for details that are found again on another screenshot.
   From that, every step gets a label for the kind of change that led to it (see below), and a step that goes back to
   a screen seen earlier gets a link to it: **similar to step N** when it is the same picture again, **same screen as
   step N** when the screen is scrolled, or something on it changed. Details that many screens of the recording have,
   such as a window frame or a side panel, count for little. This never changes which steps there are.

## Labels

Labels describe the change. They never decide what counts as a step.

| label | meaning |
| --- | --- |
| opening | the screen the recording starts on (the start, step 0) |
| navigation | most of the screen changed: a new page or view |
| scroll | the content moved and then stopped: of the whole screen, or of one pane |
| modal | a menu, dialog, sheet or panel appeared over the screen, whether or not it dims it |
| modal closed | it went away, and the screen under it was still there |
| feed swap | a full-screen swipe to the next item, as in short-video apps |
| update | part of the screen changed, for example because content loaded |
| ui change | a small change, such as a switch, a badge or a button |
| typing | a burst of typing, shown as one step with the finished text |

## What it cannot do

- **Something that never stops moving never becomes a step.** A playing video or a looping animation keeps
  the screen from being still. Draw an ignore area over it.
- **Screens shorter than the minimum time on screen are skipped.** Lower the minimum, or add the moment by
  hand.
- **Changes smaller than the smallest change are usually ignored.** Stepthrough measures changes in small
  blocks, so a change a little smaller than the setting can still count, but one much smaller does not. Lower
  the setting, or add the moment by hand.
- **It sees pixels, not meaning.** Two screens that look alike count as the same screen. A big change that
  means nothing, such as switching to dark mode, counts as a step, and as another screen. A long answer that
  writes itself over a whole screen can count as another screen too.

[Evaluation and benchmarks](Evaluation-and-Benchmarks.md) describes how Stepthrough was tested, how well it does,
and more cases where it goes wrong.

## Settings

If you leave a setting empty, Stepthrough uses the default for the recording type: 450 milliseconds and
0.10 % for a phone or tablet, 600 milliseconds and 0.25 % for a computer. Press **show hints** above the
settings for a short explanation of each one.

| setting | what it does | when to change it |
| --- | --- | --- |
| **recording type** | **phone or tablet** ignores the status bar; **computer** ignores small changes such as a moving mouse pointer | always choose the device you recorded |
| **minimum time on screen** | how long a screen must stay still to count as a step | lower it (for example to 250 ms) to catch short menus; raise it to skip screens the person only passed through |
| **smallest change** | the smallest change, as a share of the screen, that ends a screen | lower it for tiny badges or switches; raise it if small animations add steps |
| **ignore areas** | boxes, drawn on the video, in which changes are ignored | for a live clock, a moving banner or a video playing on the page |
| **phone status bar** | include or ignore the clock, battery and recording indicator | include it only if it matters for your question |
| **scrolling** | **each stop**: every place where the page stops is a step; **merge stops**: only the first one is kept | merge stops when only the end of a long scroll matters |
| **group typing** | a burst of typing with short pauses becomes one step | turn it off if every pause matters |
| **opening screen** | include the screen the recording starts on, as step 0 | turn it off if the first screen is not part of the task |
| **read text (ocr)** | reads the text on each screenshot after the steps are found, to show, search and export it | when you need the words themselves; it does not help find steps. You can also ask for it afterwards, see [Text recognition (OCR)](Text-Recognition.md) |
| **pixel threshold** (advanced) | how much a pixel must change, compared with the flicker measured in the recording | raise it for very grainy recordings |
| **analysis rate** (advanced) | how many frames per second are compared | rarely; lower is faster |

### Saving and sharing settings

**presets**, above the settings on the left, opens a menu for saving and sharing parameters:

- **save for this project** keeps the current settings as your default for this project, and **save as universal
  defaults** uses them for every project you have not saved settings for.
- Saved settings belong to your account, not to the browser: on a shared server they are there on any computer
  you log in from, and other people in a shared project keep their own.
- **show preset text…** shows the settings as a short piece of text that you can copy, for example into a methods
  section or to share with others. **load preset text…** reads such a text back in.

The purple **reset** button on the right opens the reset menu: **reset to project defaults** and **reset to
universal defaults** go back to your saved defaults, and **restore factory settings…** forgets the settings you
saved (for this project and as universal defaults) and goes back to Stepthrough's own.
