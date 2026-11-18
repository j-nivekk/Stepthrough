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
| **screen** | one or more steps that show the same screen of the app, such as a page before and after scrolling |
| **pathway** | the accepted steps drawn as a chart: the screens, and the moves between them |
| **export** | a zip file with the screenshots and files that describe the steps: `steps.csv`, `steps.json` and `pathway.json` |

## 3. Installing and starting Stepthrough

If someone has set up a Stepthrough server for your group, you do not need to install anything. They send you a
link with which you choose a password; after that, open the server's address, log in with your name and that
password, and go on to [section 4](#4-tutorial-your-first-walkthrough). Your name at the bottom right opens your
account: change your password or log out there. If you forget your password, ask them for a new link. A password
needs at least 8 characters; very common ones, and ones containing your name, are refused. You stay logged in
for up to 30 days, or until you have not used Stepthrough for a week.

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
   echo STEPTHROUGH_AUTH=none>>.env
   ```

   The same commands work on Windows and on a Mac. They make a folder called `Stepthrough` in your user
   folder and save a file called `compose.yaml` in it, which tells Docker how to run Stepthrough. The last line
   saves a setting in a file called `.env`: Stepthrough runs for you alone, so it opens without logging in.
   (The same set-up on a server, for a group, leaves that line out, and people there log in.)

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
settings, delete the file (`del .env` on Windows, `rm .env` on a Mac), add the line from step 2 again
(`echo STEPTHROUGH_AUTH=none>>.env`) and type `docker compose up -d`.

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
- *Stepthrough asks you to log in* (for example after an update): the `.env` file is missing the line from
  step 2. Type `echo STEPTHROUGH_AUTH=none>>.env` and then `docker compose up -d`, and reload the page.

### From the source code

You need Git, uv (which also installs the right version of Python), Node.js 20.19 or later and FFmpeg 5.1 or
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

To come back to a project later, pick it from the list: a project with videos opens on the analysis page, and an
empty one on the import page. When you point at a project, you see **import**, **analysis** and **delete**.

### Step 2: import the recording

Drag the video onto the drop area, or click the area to choose a file. Stepthrough accepts `.mp4`, `.mov`,
`.m4v`, `.webm` and `.mkv` files. Videos upload straight away, one after the other: each shows how far it is,
then **uploaded**. **cancel** stops a video that is still on its way, and **retry** sends one again if its upload
failed. Press **done** to go to the analysis; videos still uploading carry on and appear in the videos column when
they are in. Keep the page open until then.

To delete a video, point at it here or in the videos column of the analysis and press **delete**. Every run,
screenshot and export made from it goes with it, so Stepthrough asks first.

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
| modal closed | a pop-up or panel went away, and the screen under it was still there |
| feed swap | a full-screen swipe to the next item, as in short-video apps |
| update | part of the screen changed, for example because content loaded |
| ui change | a small change, such as a switch, a badge or a button |
| typing | a burst of typing, shown as one step with the finished text |

### What it cannot do

- **Something that never stops moving never becomes a step.** A playing video or a looping animation keeps
  the screen from being still. Draw an ignore area over it.
- **Screens shorter than the minimum time on screen are skipped.** Lower the minimum, or add the moment by
  hand.
- **Changes smaller than the smallest change are usually ignored.** Stepthrough measures changes in small
  blocks, so a change a little smaller than the setting can still count, but one much smaller does not. Lower
  the setting, or add the moment by hand.
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

- **save… → save for this project** keeps the current settings as your default for this project.
- **save… → save as universal defaults** uses them for every project you have not saved settings for.
- Saved settings belong to your account, not to the browser: on a shared server they are there on any computer
  you log in from, and other people in a shared project keep their own.
- **preset text** shows the settings as a short piece of text that you can copy, for example into a methods
  section or to share with others. **load** reads such a text back in.
- The **reset** button (★) goes back to the project's or the universal defaults. **restore factory settings…**
  in the same menu forgets the settings you saved, for this project and as universal defaults, and goes back to
  Stepthrough's own.

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
| fold away the strip of accepted steps | click **accepted steps** above it; click again to show it |
| hide steps with a certain label | click the label in the legend above the timeline; click again to show them |
| change the layout | **grid** or **list**; the slider sets the size of the images, and **fit** goes back to images sized to fill the width of the window |
| accept or reject many steps at once | tick the boxes on pending steps, then press **accept selected** or **reject selected** |
| go to an earlier visit of the same screen | **similar to candidate N** on a revisit |
| say which screen a step shows in the pathway | **screen** under **annotate** on a card, or in the **label, screen** column of the list |

### Comparing runs

Changed a setting and ran the analysis again? When a recording has two or more finished runs, **compare** next
to it in the tasks list shows two of them side by side: the settings that differ, a timeline with each run's
steps, and the screenshots of the steps only one of the runs found (or found at another moment). It starts with
the newest run and the earlier one with the most accepted steps; pick other runs with the two lists at the top.

To go on with the newer run without reviewing it from scratch, press **review run #2 with the review of
run #1** (with your run numbers) at the bottom of the window. Your decisions, titles, notes and screen choices go
to the steps both runs found, and steps you added by hand are added again at the same moment. Only what is still
empty in the newer run is filled in, so nothing you already did there is lost; the review of steps only the
earlier run found stays with that run. **review run #2 as it is** and **back to run #1** leave both runs as they
are.

### Pathway

Above the steps of a finished run you can switch from **steps** to **pathway**. The pathway draws the
accepted steps as a chart: one box per screen, with a screenshot, and arrows for the moves between screens.
A recording is a straight line in time; the chart shows where that line went back to a screen, left it again
another way, or took a detour.

New to pathways? The first time you open one, an invitation above the chart offers a hands-on tutorial of about
five minutes (**start the tutorial**); after that it is under **about** at the bottom right, as **how to work with
pathways**. On a practice recording you fold steps into screens, follow the journey, find what the automatic
grouping got wrong, correct it, and prepare the figure. Nothing in it changes your own runs.

How to read it:

- The black numbers are step numbers, the same as in the step list and in `steps.csv`. A screen shows the
  steps taken on it, each with its time. An arrow shows the number of the step it leads to, so you can
  follow the journey from 1 onwards.
- A solid arrow goes onwards; a dashed arrow goes back to a screen that was first seen earlier.
- A doubled frame means several steps in a row on that screen (for example `6–7` after scrolling).
- A box shows the screenshot of its first step. Rest the pointer on a step number under the box to see that
  step instead; a number for several steps in a row, such as `6–7`, shows them in turn.
- A dashed frame is a pop-up, when the change that led to it was labelled as one (**modal**).
- A screen takes the title of its first step that has one. Notes appear under the screen, with the step
  number in front when the screen has several steps.

Which steps count as the same screen is decided automatically, from two things. A step that shows an earlier
screen again (a revisit) always shares its box. A step reached by scrolling, typing, swiping to the next
item of a feed or a small change stays in the box of the step before it. Choose **boxes: steps** to give
every step its own box, so that only revisits share one. A step you added by hand always has its own box.
When a pop-up closes (**modal closed**), the step after it goes back into the box of the screen under the
pop-up, also when something on that screen changed in the meantime, such as a switch that is now on.
As with labels, this goes by what the screen looks like: two screens that look alike count as one, and the
same screen in a different state can count as two.

**When the pathway gets it wrong**, correct it on the step itself, under **steps**. Each step has a **screen**
choice (under **annotate** on a card, or in the **label, screen** column of the list):

- **automatic** leaves the step where the rules above put it;
- **a new screen** gives the step a box of its own, for two pages that look alike and were taken for one;
- **the same screen as** another step, picked from a list with screenshots, puts the step in that step's
  box, for a return that was not recognised or the same page in a different state. It moves this step alone
  (with the steps that scroll or type on from it), not the rest of its box;
- **this step is a pop-up** marks a menu or dialog that was not recognised (or, unticked, one that was
  recognised by mistake). A pop-up always starts a box of its own.

Your choice comes before everything automatic and applies to both kinds of boxes. A card shows it as
`screen: same as 3`; switch to **pathway** to see the result.

You can make the same corrections in the pathway itself. Click a screen in the chart (or choose it under
**screen** above the chart) and the strip above the chart shows that box:

- **title** renames the box. A box is named after its first step that has a title, so this is that step's
  title, and the step list shows it too;
- **pop-up** marks the box as a pop-up or as an ordinary screen;
- **steps and where they belong** lists the steps in the box, each with its **screen** choice, where you can
  move one step to another box or give it a box of its own. Steps that follow a moved step by scrolling or
  typing move with it;
- **merge into** moves all the steps of the box together into another one.

Which one to use depends on what is wrong. When one step is in the wrong box, move that step with its own
choice, **the same screen as**. When two boxes show one screen, move one box into the other with **merge
into**. For a box with a single step, both do the same. In the pathway, steps are numbered as in `steps.csv`
(the accepted steps only), and both lists say which box each step is in: **merge into** offers the boxes as
"Screen 4 (step 6)", and **the same screen as** shows "in Screen 4" under each step.

Everything you change here is stored on the steps, exactly as if you had chosen it in the step list.

| to | do this |
| --- | --- |
| see another step of a box | rest the pointer on its number under the box |
| give every step its own box | **boxes: steps** (the default, **screens**, groups them) |
| move the notes | **notes: under screens** (cut after four lines), **in a key** below the chart (in full), or **off** |
| leave out the times, or the title and legend | **show: times** and **title and legend** |
| change the size on the page | the slider; **fit** fills the width of the window |
| save the chart | **download: svg** or **png** |

**svg** saves one SVG image with the screenshots inside it, so it needs no other files. Its text stays text
and every screen is a group of its own, so you can finish the figure in a drawing program such as Inkscape,
Illustrator or Affinity. The title and legend are separate groups that are easy to delete.

**png** saves the same figure as a picture, to put straight into slides, a document or a web page. It is
drawn at twice the size the figure has on the page at 100%, and records that resolution (192 dpi), so a word
processor places it at the figure's own size and it stays sharp when printed. The text is set in the app's
own typeface, so it looks the same on every computer. A very large figure is drawn somewhat smaller, so that
every browser can make it.

At the bottom right, every figure carries a small badge: a QR code that leads to Stepthrough's repository,
the date the figure was made, the version of Stepthrough that made it, and the addresses to find and cite
it. The badge is drawn as shapes, not as text, so it looks the same on every computer. It is a group of its
own too, which you can move or resize in a drawing program.

### Tasks

Every run is listed under **tasks** with its number of steps. Runs of the same recording are grouped; click
the arrow next to a recording's name to fold its runs away or show them again. **details** shows the settings
a run used, **review outputs** opens it, **compare** sets two runs of a recording side by side (see
[Comparing runs](#comparing-runs)), and **select** lets you delete or export several runs at once.

A run you opened shows its number and when it finished at the top. **view logs**, at the right, lists what the
analysis did, step by step, which helps when a run failed or took longer than expected.

## 8. Exports

**export accepted** exports the steps you accepted; **export all** exports every step. Under **tasks**,
**select** lets you export several runs at once. An export is made from the task as it is at that moment, so
Stepthrough keeps only the latest of each task: export again whenever you need it. Each export is a zip file with:

- `images/`: one screenshot (PNG) per step, named after the recording, the step number and the time;
- `steps.csv`: one row per step, to open in a spreadsheet;
- `steps.json`: the same steps, plus everything about the run, for use in your own scripts;
- `pathway.json`: the same steps as a pathway: which screen each step is on, the visits to each screen, and
  the moves between screens with the steps they lead to.

For each step, the export has its time, the screenshot's file name, its status, title and notes, and its label
(`transition_type`). It also has when the change started (`change_started_ms`), when the screen came to rest
(`settled_ms`), how long it stayed on screen (`time_on_screen_ms`), how many typing states were grouped
together (`grouped_states`), links to earlier visits of the same screen, the areas that changed and, if text
recognition was on, the text in the screenshot (`ocr_text`).

`steps.json` also records the size and frame rate of the recording, the settings as you chose them and as
they were actually used, what was measured (such as the flicker level), and `field_notes` explaining every
field. That way, the export can be read and cited without the app.

`pathway.json` uses the step numbers and image names of `steps.json`. For every step it gives the screen it
is on and why it shares that screen with an earlier step (`grouped_by`: `researcher` when you chose it, a
revisit, a pop-up closing, or a label such as scroll), and what you chose for the step (`screen_choice`,
`kind_choice`), so your decisions and the automatic ones can be told apart. It has its own `field_notes`.
The chart itself is not in the zip; save it with **download: svg** or **png**.

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

### Typing on a computer is split up or shows unfinished text

On a computer screen, each typed character is a tiny change, far below the default smallest change for the
**computer** recording type. Set the **smallest change** to 0.05 % for recordings with typing, and keep the
mouse still while typing. The same setting helps when a scroll through a list of similar-looking rows is
missed: try 0.10 %.

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
same settings for all recordings you compare, and report the steps you added and rejected by hand. Name the
version of Stepthrough as well: **about**, at the bottom right, shows it with the commit it was built from, and
the DOI to cite.

### Typical uses

- **Walkthrough studies:** record signing up for an app, using it day to day and leaving it, and use the
  accepted steps and their notes as the basis for describing the walkthrough.
- **Usability tests:** one project per study and one recording per participant. Compare where participants
  paused or went back (revisits show returns to earlier screens, and the pathway draws them).
- **Comparing platforms:** one project per app or version, with the same task recorded in each and the same
  settings. Compare the `steps.csv` files side by side.
- **Changes over time:** record the same task at different dates and compare the exported steps.

### Working under a shared account

An administrator can give a regular account the `shared` tag, for a group that works under one login: up to
about 30 people at once, each in their own browser. Administrator accounts cannot have the tag. Everyone can
create projects, import videos, run analyses and review at the same time, and nothing has to be reserved first.

What one person does shows in everyone else's browser within a moment, without reloading: new projects and
videos, analyses starting and finishing, steps accepted, rejected, titled or annotated, and changes to the
pathway.

Where two people could get in each other's way, Stepthrough shows it in orange with moving stripes:

- **a step someone is writing in.** While someone has the title or notes of a step open in a field, the others
  see "being edited in another browser" on that step, and its title and notes are read-only for them until that
  person leaves the field. Accepting and rejecting the step still work. If two people do save different text at
  the same moment, the first is kept, and the second person sees a message with their own text in it, so
  nothing is lost.
- **a task being changed as a whole.** Adding a step by hand (which renumbers the steps), bringing a review over
  from another run, merging two screens of the pathway and exporting take a moment. Meanwhile the others see a
  **busy** banner on the task and a **busy** mark next to it under **tasks**; their own changes to the task wait
  their turn and are then saved as usual, and it cannot be deleted until the change is done.
- **a video on its way in.** A video someone else is uploading appears on the import page and under **videos**
  with how far it is, and joins the list when it is in.

A rename made from a name that someone else changed meanwhile is refused, with the new name in the message.
Every export of a shared account stays downloadable for ten minutes, even when someone exports the same task
again, so two people exporting it at the same time each get their own. A browser that loses its connection
catches up when it is back.

The password of a shared account cannot be changed from the app, because that would log everyone else out.
An administrator gives the account a new link instead; setting a password with it logs every other browser out.

### Privacy and consent

Screen recordings often show names, messages, notifications and account details. Ask for consent before you
record someone's device, turn on Do Not Disturb, use test accounts where you can, and store recordings and
exports as research data under your institution's rules.

When you run Stepthrough yourself, everything stays in its own data storage: the `data` folder, or the
`stepthrough_data` volume with Docker. Deleting a project in the app deletes its recordings, screenshots and
exports from there (but not copies you downloaded).

On a shared Stepthrough server, your recordings are stored on that server. Your projects are visible only to you
and to the server's administrators. Your account may have a deletion date: from then on, the account and your
projects are deleted from the server, and you see a notice in the month before, so download your exports in
time. Ask the people who run the server how long recordings are kept, and do not upload recordings that show
other people without their consent.

A server also keeps a record of how Stepthrough is used, for the people who teach with it: when people are in the
app, what they do (such as uploading, analysing, deciding on steps and exporting) and how far they get with the
pathway tutorial, and how much data goes to and from each account. It counts each login in each browser, so it can
tell how many people work under a shared account, but it does not record names, addresses, files or anything you
write, and it deletes the record after 14 days unless the administrators set another time. Stepthrough on your own computer records none of this.

## 12. Credits and references

Stepthrough is created and maintained by H. "Kevin" Jin at the University of Amsterdam. The source code is at
[github.com/j-nivekk/Stepthrough](https://github.com/j-nivekk/Stepthrough) under the MIT licence.

Background reading:

- Light, B., Burgess, J., & Duguay, S. (2018). The walkthrough method: An approach to the study of apps.
  *New Media & Society, 20*(3), 881–900.
- Rogers, R. (2019). *Doing Digital Methods*. SAGE.
