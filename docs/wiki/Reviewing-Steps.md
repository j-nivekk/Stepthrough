Once an analysis finishes, click the run under **tasks** to review its steps.

## Workspace, review mode, and navigating long runs

- **Workspace and review modes:** Opening a finished run puts the page in **review** mode, tucking the **videos**,
  **parameters** and **tasks** columns out of the way so the steps have the full page. Switch between **workspace**
  and **review** in the top navigation bar whenever you want them back (opening a run that is still running, or no
  run, leaves the workspace open).
- **Sticky review toolbar:** The filters, selection and layout controls stay at the top of the window as you scroll,
  and decisions, titles and notes show on screen immediately.
- **Resuming where you left off:** A finished run reopens at the last step you worked on (**back at step N**, with a
  link **to the start**).
- **Back to the top:** Once you scroll down, an orange **↑ top** tab slides out beside the watermark at the bottom
  right to jump straight back to the top without scrolling or opening the [command bar](Command-Bar-and-Shortcuts.md).

## The video preview

Click **preview** next to a recording to open its video. The bar under the video shows every step as a pin,
and the labels as coloured stretches. With the buttons you can jump to the previous or next step, go one
frame back or forward (`,` and `.`), play and pause (space bar), change the speed, background and size, and
**mark** a step by hand (`k`). The × at the top right closes the preview.

While the video plays, the card of the step on screen is outlined, so you can see where you are.

## Steps

| to | do this |
| --- | --- |
| accept, reject, or set back to pending | ✓ ✕ ↺ on the card, or `a` `r` `u` for the selected step |
| go to the previous or next step | `←` `→`, or click the step |
| see the clip that led to a step | rest the pointer on its screenshot for a moment |
| play the video from a step | **play from here** on the screenshot, or `p` for the selected step |
| add a title and notes | **annotate** on a card, or type directly in the list or gallery view |
| show only some steps | **all**, **pending**, **accepted** or **rejected** above the steps |
| show the strip of accepted steps | it starts folded away: click **accepted steps** above the timeline to show it, and again to fold it |
| hide steps with a certain label | click the label in the legend above the timeline; click again to show them |
| change the layout | **grid**, **list** or **gallery**; the slider sets the size of the images, and **fit** goes back to fitting the view to the window |
| select several steps | tick or drag across their boxes; shift-click a box (or shift/⌘/ctrl-click thumbnails in gallery view) to select a range or toggle items. **select all**, **clear** and **invert** above the steps act on the steps shown, as does the box above the list; `x` (and `shift+x`) does the same for the step in focus |
| accept, reject or reset many steps at once | select them, then **accept**, **reject** or **reset** next to how many are selected. Steps that are so already are left as they are, and the selection stays, so a mistaken choice can be put right at once |
| do any of this from a menu | right-click a step, in any of the three views (or `shift+F10` for the step in focus). On one of several selected steps, the menu is for all of them |
| read the text on a screen | **text** on a card or beside the screenshot in the gallery view, once it has been read (see [Text recognition (OCR)](Text-Recognition.md)) |
| show only the steps with certain words on the screen | **find text**, beside **export** |
| go to an earlier visit of the same screen | **similar to step N** (the same picture) or **same screen as step N** (scrolled, or with something changed) |
| go to the screen someone went back to | **then back to step N**, on a step you said so of |
| say that someone went back to an earlier screen where no step shows it | right-click the step they went back after, **return to** (see [Pathways](Pathways.md)) |
| say which screen a step shows in the pathway | **stacking** under **annotate** on a card, in the **label, screen** column of the list, or in the gallery inspector |

The menu of one step decides on it, plays it, opens its screenshot or its notes, and says where it goes in the pathway:
**stacking**, **a pop-up**, **phase**, **return to**. The menu of several selected steps (it says how many) has the same for all of them
at once. **accept 3 of 5** changes the three that are not accepted yet. **stacking** makes them **all the same** screen as
the first of them, **each a new screen**, or **automatic** again. **phase** takes in every step from the first accepted one
to the last, also those in between that are not selected, and **return to** is about the last accepted one. A right click
on a step outside the selection is about that step only, and the selection stays. In a text field, and on text you selected, the browser's own menu opens, to copy and paste.

An accepted step has the number it has in the pathway and the export, **step 5**; a screenshot you have not accepted
is a **candidate**, numbered in the order it was found. So rejecting a candidate leaves no gap: the steps after it
count on. The opening screen is **start**.

## Comparing runs

Changed a setting and ran the analysis again? When a recording has two or more finished runs, **compare** next
to it in the tasks list shows two of them side by side: the settings that differ, a timeline with each run's
steps, and the screenshots of the steps only one of the runs found (or found at another moment). It starts with
the newest run and the earlier one with the most accepted steps; pick other runs with the two lists at the top.

To go on with the newer run without reviewing it from scratch, press **review run #2 with the review of
run #1** (with your run numbers) at the bottom of the window. Your decisions, titles, notes and screen and row
choices go to the steps both runs found, and steps you added by hand are added again at the same moment. The phases
come along too, when the newer run has none yet. Only what is still
empty in the newer run is filled in, so nothing you already did there is lost; the review of steps only the
earlier run found stays with that run. **review run #2 as it is** and **back to run #1** leave both runs as they
are.

## Tasks

Every run is listed under **tasks** with its number of steps; one that is analysed or waits its turn says how far it is
and, once the server has analysed a few recordings, when it should be ready (**34%, ready in about 20 s**). That is an
estimate from how long the server's earlier analyses took for recordings of that length and size: it can be off by half
or more, more often too soon than too late. Runs of the same recording are grouped; click
the arrow next to a recording's name to fold its runs away or show them again. While a video is selected, the
runs of the other videos are folded away until you open them or select another video. Resting the pointer on a finished
run preloads it; click a run's name to open it, at its steps once it has any. **compare** sets two runs of a recording
side by side (see [Comparing runs](#comparing-runs)), and **select** lets you delete or export several runs at once.

**⋯** next to a run, or a right click on it, has **details**, **rename**, **duplicate** and **delete**. **details**
shows under the run the settings it used and who changed it last and when. **duplicate** copies a
finished run, with its steps, your decisions, titles and notes, screen choices and phases, as a new run of the
same recording named after it ("first try copy"). Try another way of correcting it there, and keep the original
as it was; the copy keeps when the analysis ran, but not the export.

Each run of a recording gets a number, run #1, run #2 and so on, which it keeps: deleting a run does not
renumber the others, and a new run never takes the number of a deleted one. **rename** gives a run a name, such
as "second try, phone settings". The number stays under the name, and it is the
number that the comparison and the export use (`number` and `name` under `run` in `steps.json`). To take the
name away, rename the run back to its number, such as `run #2`. The project list says, for each project, who
changed something in it last and when; viewing, exporting and saving settings for yourself do not count as
changes.

A run you opened shows its video and when it finished at the top. **logs**, in a run's **details** under **tasks**,
lists what the analysis did, step by step, which helps when a run failed or took longer than expected.

See also: [Command bar and shortcuts](Command-Bar-and-Shortcuts.md), [Text recognition (OCR)](Text-Recognition.md),
and [Pathways](Pathways.md).
