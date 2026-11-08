# Stepthrough Guide

Stepthrough turns a screen recording of an app or website into a series of screenshots: one for each screen
the person stopped on, in order. You go through these steps, keep the ones that matter, add notes, and export
them as images with a spreadsheet.

It is made for research on apps and interfaces, such as the walkthrough method, usability tests and
comparisons between platforms.

When you run Stepthrough on your own computer, your recordings, screenshots and exports stay on that computer.
Nothing is uploaded anywhere.

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

Taking screenshots by hand during a session interrupts what you are doing, and you miss anything you did not
think to capture. A screen recording keeps everything:

- **the whole interaction**, including moments you did not expect to matter;
- **screens that only last a moment**, such as menus, loading screens, pop-ups and notifications;
- **no interruptions**: nobody has to stop to take a screenshot;
- **a second look**: you can go back to the recording when you notice that a step is missing.

The downside is that a recording is one long video, while an analysis needs separate screens. Stepthrough
does that for you: it finds the screens the person actually stopped on and gives you one screenshot of each.

To see this as an animation, open Stepthrough and choose **about → how it works** at the bottom right.

## 2. Key terms

| term | meaning |
| --- | --- |
| **project** | a folder for one study, app or topic; it holds the recordings and their runs |
| **recording** | a screen recording you imported |
| **run** (or task) | one analysis of a recording with one set of settings; you can analyse a recording as often as you like |
| **step** | a screen that stayed still long enough to count, with one screenshot; until you review it, it is called a candidate |
| **accepted step** | a step you decided belongs in the walkthrough |
| **label** | the kind of change that led to a step, such as navigation, scroll or typing |
| **export** | a zip file with the screenshots and two files that describe the steps, `steps.csv` and `steps.json` |

## 3. Installing and starting Stepthrough

If someone has set up a Stepthrough server for your group, you do not need to install anything: open the web
address they gave you and go on to [section 4](#4-tutorial-your-first-walkthrough).

Otherwise, there are two ways to run Stepthrough on your own computer:

- **With Docker (recommended).** You install one program, Docker Desktop, and type three commands. It works
  the same way on Windows and on a Mac.
- **From the source code.** This is for people who want to change Stepthrough, or who want text recognition
  on a Mac with an Apple chip (M1 or later). It needs more programs.

Both ways use a **terminal**: a window in which you type commands. You do not need to know how it works. Copy
the commands below one line at a time, and press Enter after each line.

- **Windows:** open the Start menu, type `Command Prompt` and open it. Use Command Prompt, not PowerShell:
  the commands in this guide are written for Command Prompt.
- **Mac:** press Command-Space, type `Terminal` and press Return.

Stepthrough works best on a laptop or desktop computer, in a browser window of at least 1120 × 760 pixels.

### With Docker

1. **Install Docker Desktop** from [docker.com](https://www.docker.com/products/docker-desktop/) and open it.
   On Windows, it may ask to install or update WSL, a part of Windows that Docker needs. Say yes, and restart
   the computer if it asks you to. Wait until Docker Desktop says that it is running.

2. **Make a Stepthrough folder and download the set-up file.** In the terminal, type:

   ```
   mkdir Stepthrough
   cd Stepthrough
   curl -fsSLO https://raw.githubusercontent.com/j-nivekk/Stepthrough/main/compose.yaml
   ```

   The same commands work on Windows and on a Mac. They make a folder called `Stepthrough` in your user
   folder and save a file called `compose.yaml` in it, which tells Docker how to run Stepthrough.

3. **Start Stepthrough:**

   ```
   docker compose up -d
   ```

   The first time, this downloads Stepthrough (about 300 MB), which can take a few minutes. When it is done,
   open **http://localhost:8080** in your browser.

From now on, Stepthrough starts by itself whenever Docker Desktop is running.

**Everyday use**

- **To open Stepthrough,** start Docker Desktop, wait until it is running, and go to http://localhost:8080.
  You can bookmark this address.
- **To stop Stepthrough,** go to **Containers** in Docker Desktop and press the stop button next to
  **stepthrough**. The start button runs it again.
- **To update to a new version,** open a terminal and type:

  ```
  cd Stepthrough
  docker compose pull
  docker compose up -d
  ```

- **Where your data is.** Your projects, recordings, screenshots and exports are stored inside Docker, in a
  *volume* called `stepthrough_data`. They stay there when you stop, restart or update Stepthrough. To use
  screenshots somewhere else, export them in the app (see [section 8](#8-exports)). If you delete the
  `stepthrough_data` volume in Docker Desktop, all your Stepthrough data is deleted with it.

Commands that start with `docker compose` only work inside your Stepthrough folder. In every new terminal
window, type `cd Stepthrough` first.

**Settings.** You can change a few things by adding lines to a settings file called `.env` in your Stepthrough
folder. Each command below adds one line; afterwards, type `docker compose up -d` to apply it. To undo your
settings, delete the file (`del .env` on Windows, `rm .env` on a Mac) and type `docker compose up -d` again.

- **Text recognition (OCR).** Reading the text in each screenshot needs a larger version of Stepthrough
  (about 600 MB to download), and the first run that uses it downloads its recognition models as well. It
  works on Windows computers and on Macs with an Intel processor, but not on Macs with an Apple chip (M1 or
  later). On those, install Stepthrough from the source code instead.

  ```
  echo STEPTHROUGH_TAG=stable-ocr>>.env
  ```

- **A different address.** If another program already uses port 8080, choose another port, such as 8090,
  and then open http://localhost:8090 instead:

  ```
  echo STEPTHROUGH_PORT=8090>>.env
  ```

**If something goes wrong**

- *"docker" is not recognised* or *command not found*: Docker Desktop is not installed or not running. Start
  it, wait until it is running, and open a new terminal window.
- *no configuration file provided*: the terminal is not in your Stepthrough folder. Type `cd Stepthrough` and
  try again.
- *port is already allocated*: another program uses port 8080. Choose a different port (see **Settings**
  above).

### From the source code

You need Git, uv (which also installs the right version of Python), Node.js 18 or later and FFmpeg 5.1 or
later.

**On Windows**, install these programs with winget, which comes with Windows 10 and 11. In Command Prompt,
type:

```
winget install --id Git.Git -e
winget install --id astral-sh.uv -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Gyan.FFmpeg -e
```

Close Command Prompt and open it again, so that it finds the new programs. Then download and set up
Stepthrough:

```
git clone https://github.com/j-nivekk/Stepthrough.git
cd Stepthrough\backend
uv sync
cd ..\frontend
npm install
```

Stepthrough has two parts that each run in their own window. To start it, open two Command Prompt windows.
In the first, type:

```
cd Stepthrough\backend
uv run uvicorn app.main:app
```

In the second, type:

```
cd Stepthrough\frontend
npm run dev
```

Then open **http://localhost:5173** in your browser. To stop Stepthrough, press Ctrl-C in both windows.

**On a Mac**, install [Homebrew](https://brew.sh) first if you do not have it. Then type:

```
brew install git uv node ffmpeg
git clone https://github.com/j-nivekk/Stepthrough.git
cd Stepthrough
./setup.sh
./start.sh
```

Then open **http://localhost:5173** in your browser. To stop Stepthrough, press Control-C in the terminal.
Next time, you only need `cd Stepthrough` and `./start.sh`.

**Text recognition (OCR)** is optional and needs a large extra download. In the Stepthrough folder, type:

```
cd backend
uv sync --group ocr
```

From then on, use `uv sync --group ocr` whenever you update. A plain `uv sync` (which `./setup.sh` runs)
removes text recognition again.

**Where your data is.** Everything is stored in the `data` folder inside the Stepthrough folder.

**To update,** type `git pull` in the Stepthrough folder, then run the set-up commands again: `uv sync` in
`backend` and `npm install` in `frontend` (on a Mac, `./setup.sh` does both).

## 4. Tutorial: your first walkthrough

This takes 15 to 20 minutes. You need one short screen recording (one to three minutes) of a simple task, such
as signing in, searching for something or changing a setting. [Section 9](#9-making-good-recordings) explains
how to record.

### Step 1: create a project

On the start screen, type a name under **create a project** and press **enter**. Use one project per study or
app: a project keeps its recordings, runs and preferred settings together.

To come back to a project later, pick it from the list. When you point at a project, you see **import**,
**analysis** and **delete**.

### Step 2: import the recording

Drag the video onto the drop area, or click the area to choose a file. Stepthrough accepts `.mp4`, `.mov`,
`.m4v`, `.webm` and `.mkv` files. Each file shows **uploaded** when it is ready. Press **done** to go to the
analysis.

In the background, Stepthrough now makes a *working copy* of each recording (see
[section 5](#5-how-stepthrough-finds-steps)). If the first run starts before the copy is ready, it waits for
it.

### Step 3: choose settings and run

The analysis screen has three columns: **videos**, **parameters** and **tasks**.

1. In **videos**, click your recording to select it.
2. In **parameters**, set **recording type** to **phone or tablet** or to **computer**, to match the device
   you recorded. Leave everything else as it is for your first run. **show hints** explains each setting.
3. Press **run analysis**.

The run appears under **tasks** and shows its progress. A recording of a few minutes usually takes seconds. The
first run on a new recording can take longer, because it also waits for the working copy.

### Step 4: review the steps

When the run is done, click **review outputs**. Below the timeline, each step is shown as a card with its
screenshot, time, label and status.

For each step, ask yourself:

- Does it show something meaningful in the task?
- Would someone else need it to follow the walkthrough?
- Is it a duplicate, or a moment the person only passed through?

Then:

- **accept** (✓, or press `a`) the steps that belong in the walkthrough;
- **reject** (✕, or press `r`) duplicates and noise;
- press **annotate** to give a step a title and notes, such as the action that led to it.

Rest the pointer on a screenshot for a moment to see the clip that led to that step, or choose **play from
here** to watch it in the video preview. [Section 7](#7-reviewing-steps) lists everything you can do while
reviewing.

### Step 5: add a step by hand

If an important moment is missing, open the video with **preview** next to the recording's name, pause at that
moment and press **mark** (or `k`). The moment is added to the run as a manual step.

The automatic steps are a starting point. Your own judgement decides what the walkthrough contains.

### Step 6: export

Press **export** above the steps and choose **export accepted**. You get a zip file with the screenshots,
`steps.csv` to open in a spreadsheet, and `steps.json` with everything about the run (see
[section 8](#8-exports)).

### Questions to reflect on

1. Which steps were clearly useful, and which were noise?
2. Did Stepthrough miss a screen that matters for your question?
3. When did you need to add a step by hand, and why was it missed?
4. What would have been harder or easier with screenshots taken during the session?

## 5. How Stepthrough finds steps

The main rule is short enough to report in a methods section: **a step is a screen that stays still for at
least the minimum time on screen.** For each such screen, Stepthrough keeps one screenshot, taken 200
milliseconds after the screen comes to rest, so that a screenshot never catches an animation half-way.

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
7. **Labels and revisits.** Every step gets a label for the kind of change that led to it (see below). A step
   that goes back to a screen seen earlier is marked as a revisit, with a link to the earlier step.

### Labels

Labels describe the change. They never decide what counts as a step.

| label | meaning |
| --- | --- |
| opening | the screen the recording starts on (step 0) |
| navigation | most of the screen changed: a new page or view |
| scroll | the content moved and then stopped |
| modal | a pop-up or panel appeared over a dimmed screen |
| feed swap | a full-screen swipe to the next item, as in short-video apps |
| update | part of the screen changed, for example because content loaded |
| ui change | a small change, such as a switch, a badge or a button |
| typing | a burst of typing, shown as one step with the finished text |

### What it cannot do

- **Something that never stops moving never becomes a step.** A playing video or a looping animation keeps
  the screen from being still. Draw an ignore area over it.
- **Screens shorter than the minimum time on screen are skipped.** Lower the minimum, or add the moment by
  hand.
- **Changes smaller than the smallest change are ignored.** Lower it, or add the moment by hand.
- **It sees pixels, not meaning.** Two screens that look alike count as the same screen. A big change that
  means nothing, such as switching to dark mode, counts as a step.

[`docs/evaluation.md`](docs/evaluation.md) describes how Stepthrough was tested, how well it does, and more
cases where it goes wrong.

## 6. Settings

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
| **opening screen** | include the screen the recording starts on as step 0 | turn it off if the first screen is not part of the task |
| **read text (ocr)** | reads the text in each screenshot into the export (`ocr_text`) | when you need the words themselves; it does not help find steps, and it makes runs slower |
| **pixel threshold** (advanced) | how much a pixel must change, compared with the flicker measured in the recording | raise it for very grainy recordings |
| **analysis rate** (advanced) | how many frames per second are compared | rarely; lower is faster |

### Saving and sharing settings

- **save… → save for this project** keeps the current settings as this project's default, in this browser.
- **save… → save as universal defaults** uses them for every project, in this browser.
- **preset text** shows the settings as a short piece of text that you can copy, for example into a methods
  section or to share with others. **load** reads such a text back in.
- The **reset** button (★) goes back to the project's or the universal defaults.

## 7. Reviewing steps

### The video preview

Click **preview** next to a recording to open its video. The bar under the video shows every step as a pin,
and the labels as coloured stretches. With the buttons you can jump to the previous or next step, go one
frame back or forward (`,` and `.`), play and pause (space bar), change the speed, background and size, and
**mark** a step by hand (`k`). The × at the top right closes the preview.

While the video plays, the card of the step on screen is outlined, so you can see where you are.

### Steps

| to | do this |
| --- | --- |
| accept, reject, or set back to pending | ✓ ✕ ↺ on the card, or `a` `r` `u` for the selected step |
| go to the previous or next step | `←` `→`, or **prev** and **next** |
| see the clip that led to a step | rest the pointer on its screenshot for a moment |
| play the video from a step | **play from here** on the screenshot, or `p` for the selected step |
| add a title and notes | **annotate** on a card, or type directly in the list view |
| show only some steps | **all**, **pending**, **accepted** or **rejected** above the steps |
| hide steps with a certain label | click the label in the legend above the timeline; click again to show them |
| change the layout | **grid** or **list**; the slider sets the size of the images |
| accept or reject many steps at once | tick the boxes on pending steps, then press **accept selected** or **reject selected** |
| go to an earlier visit of the same screen | **similar to candidate N** on a revisit |

### Comparing runs

Under **compare runs**, choose a second finished run of the same recording. You then see which steps both runs
found, which steps only one of them found, and which were found at slightly different times. This helps you
see what a change of settings does.

### Tasks

Every run is listed under **tasks** with its number of steps. Runs of the same recording are grouped; click
the arrow next to a recording's name to fold its runs away or show them again. **details** shows the settings
a run used, **review outputs** opens it, and **select** lets you delete or export several runs at once.

## 8. Exports

**export accepted** exports the steps you accepted; **export all** exports every step. Under **tasks**,
**select** lets you export several runs at once. Each export is a zip file with:

- `images/`: one screenshot (PNG) per step, named after the recording, the step number and the time;
- `steps.csv`: one row per step, to open in a spreadsheet;
- `steps.json`: the same steps, plus everything about the run, for use in your own scripts.

For each step, the export has its time, the screenshot's file name, its status, title and notes, and its label
(`transition_type`). It also has when the change started (`change_started_ms`), when the screen came to rest
(`settled_ms`), how long it stayed on screen (`time_on_screen_ms`), how many typing states were grouped
together (`grouped_states`), links to earlier visits of the same screen, the areas that changed and, if text
recognition was on, the text in the screenshot (`ocr_text`).

`steps.json` also records the size and frame rate of the recording, the settings as you chose them and as
they were actually used, what was measured (such as the flicker level), and `field_notes` explaining every
field. That way, the export can be read and cited without the app.

## 9. Making good recordings

### How to record

- **iPhone and iPad:** open Control Centre and tap **Screen Recording** (if it is missing, add it to Control
  Centre first). Recordings are saved to Photos.
- **Android:** use the **Screen record** tile in Quick Settings (Android 11 and later).
- **Mac:** press Shift-Command-5 and choose to record the whole screen or part of it.
- **Windows:** use the Snipping Tool's record mode, or the Xbox Game Bar (Windows-G) to record a single app.

Move the file to the computer that runs Stepthrough (for example with AirDrop, a cable or a cloud folder),
then import it.

### Tips

- **Turn on Do Not Disturb.** Notifications show up as extra steps and may show private messages.
- **Do not rotate the device** during the recording.
- **On a computer, keep the mouse still** when you are not using it, and record only the app's window if you
  can.
- **Pause briefly on each screen** if you record a walkthrough yourself, so that every screen is clearly
  still.
- **Avoid videos that play by themselves** where you can, or plan to draw an ignore area over them.
- **Keep recordings short.** Several short recordings, one task each, are easier to review than one long
  session.

## 10. Troubleshooting

### Stepthrough does not start or does not open

See **If something goes wrong** in [section 3](#3-installing-and-starting-stepthrough). If you installed with
Docker, check that Docker Desktop is running. If you installed from the source code, check that both parts are
running.

### It missed important steps

1. Check that the recording type matches the device.
2. If the missing screen was short, lower the **minimum time on screen**.
3. If the missing change was small, lower the **smallest change**.
4. Add important moments by hand.

### It found too many steps

1. If something on screen keeps moving, draw an **ignore area** over it.
2. If a mouse pointer causes extra steps, use the **computer** recording type.
3. Raise the **minimum time on screen** to skip screens the person only passed through.
4. Raise the **smallest change**.
5. For very grainy recordings, raise the **pixel threshold** under **advanced**.

### A page that keeps loading gives two steps

When a page comes to rest and then loads more content, the loaded page is a step of its own, labelled
*update*. Reject the earlier step, or raise the minimum time on screen so that the first one is skipped.

### There are many scroll steps

By default, every place where the page stops is a step. Choose **scrolling: merge stops** to keep only the
first.

### Changes in text are missed

Changes in text are visual changes, so Stepthrough finds them without text recognition. If a single changed
word is missed, lower the **smallest change**. Only turn on **read text (ocr)** if you need the words
themselves in the export.

### The run found almost no steps

The screen probably never stays still, for example because a video or an animation keeps playing. Draw an
ignore area over it, or lower the minimum time on screen.

## 11. Using Stepthrough in research

### Reporting what you did

Every run stores the exact settings it used and what it measured, and every export includes them. A methods
section could say, for example:

> Screen recordings were segmented with Stepthrough. A step was defined as a screen that remained unchanged
> for at least 450 ms, ignoring changes smaller than 0.10 % of the screen and the phone status bar; bursts of
> typing were grouped into single steps. Detected steps were reviewed by the researcher; N of M were
> accepted and K added manually.

Copy the **preset text** of your settings into an appendix, so that others can repeat the analysis. Use the
same settings for all recordings you compare, and report the steps you added and rejected by hand.

### Typical uses

- **Walkthrough studies:** record signing up for an app, using it day to day and leaving it, and use the
  accepted steps and their notes as the basis for describing the walkthrough.
- **Usability tests:** one project per study and one recording per participant. Compare where participants
  paused or went back (revisits show returns to earlier screens).
- **Comparing platforms:** one project per app or version, with the same task recorded in each and the same
  settings. Compare the `steps.csv` files side by side.
- **Changes over time:** record the same task at different dates and compare the exported steps.

### Privacy and consent

Screen recordings often show names, messages, notifications and account details. Ask for consent before you
record someone's device, turn on Do Not Disturb, use test accounts where you can, and store recordings and
exports as research data under your institution's rules.

When you run Stepthrough yourself, everything stays in its own data storage: the `data` folder, or the
`stepthrough_data` volume with Docker. Deleting a project in the app deletes its recordings, screenshots and
exports from there (but not copies you downloaded).

On a shared Stepthrough server, your recordings are stored on that server. Stepthrough does not have user
accounts yet, so everyone who can open the server's address can see every project. Ask the people who run it
who can reach it and how long recordings are kept, and do not upload recordings that show other people
without their consent.

## 12. Credits and references

Stepthrough is created and maintained by H. "Kevin" Jin at the University of Amsterdam. The source code is at
[github.com/j-nivekk/Stepthrough](https://github.com/j-nivekk/Stepthrough) under the MIT licence.

Background reading:

- Light, B., Burgess, J., & Duguay, S. (2018). The walkthrough method: An approach to the study of apps.
  *New Media & Society, 20*(3), 881–900.
- Rogers, R. (2019). *Doing Digital Methods*. SAGE.
