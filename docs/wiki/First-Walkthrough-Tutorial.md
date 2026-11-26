This tutorial takes 15 to 20 minutes. You need one short screen recording (one to three minutes) of a simple
task, such as signing in, searching for something or changing a setting. [Making good recordings](Making-Good-Recordings.md)
explains how to record.

## Step 1: create a project

On the start screen, type a name under **create a project** and press **enter**. Use one project per study or
app: a project keeps its recordings, runs and preferred settings together.

To come back to a project later, pick it from the list: a project with videos opens on the analysis page, and an
empty one on the import page. When you point at a project, you see **import**, **analysis**, **download** (the
whole project as one file, see [The project file](Exports-and-Project-Files.md#the-project-file)) and **delete**.

## Step 2: import the recording

Drag the video onto the drop area, or click the area to choose a file. Stepthrough accepts `.mp4`, `.mov`,
`.m4v`, `.webm` and `.mkv` files. Videos upload straight away, one after the other: each shows how far it is,
then **uploaded**. **cancel** stops a video that is still on its way, and **retry** sends one again if its upload
failed. Press **done** to go to the analysis; videos still uploading carry on and appear in the videos column when
they are in. Keep the page open until then.

To delete a video, point at it here or in the videos column of the analysis and press **delete**. Every run,
screenshot and export made from it goes with it, so Stepthrough asks first.

In the background, Stepthrough now makes a *working copy* of each recording (see
[How detection works and settings](How-Detection-Works-and-Settings.md)). If the first run starts before the copy
is ready, it waits for it.

## Step 3: choose settings and run

The analysis screen has three columns: **videos**, **parameters** and **tasks**.

1. In **videos**, click your recording to select it.
2. In **parameters**, set **recording type** to **phone or tablet** or to **computer**, to match the device
   you recorded. Leave everything else as it is for your first run. **show hints** explains each setting.
3. Press **run analysis**.

The run appears under **tasks** and shows its progress. A recording of a few minutes usually takes seconds. The
first run on a new recording can take longer, because it also waits for the working copy.

## Step 4: review the steps

When the run is done, click its name under **tasks**. The page switches to **review** mode so the steps have the
full page (switch back to **workspace** in the top bar whenever you need the videos, parameters or tasks). Below
the timeline, each step is shown as a card with its screenshot, time, label and status.

For each step, ask yourself:

- Does it show something meaningful in the task?
- Would someone else need it to follow the walkthrough?
- Is it a duplicate, or a moment the person only passed through?

Then:

- **accept** (✓, or press `a`) the steps that belong in the walkthrough;
- **reject** (✕, or press `r`) duplicates and noise;
- press **annotate** to give a step a title and notes, such as the action that led to it.

Rest the pointer on a screenshot for a moment to see the clip that led to that step, or choose **play from
here** to watch it in the video preview. [Reviewing steps](Reviewing-Steps.md) lists everything you can do while
reviewing.

## Step 5: add a step by hand

If an important moment is missing, switch to **workspace** (or press `/` and type `/preview`), open the video with
**preview** next to the recording's name, pause at that moment and press **mark** (or `k`). The moment is added
to the run as a manual step.

The automatic steps are a starting point. Your own judgement decides what the walkthrough contains.

## Step 6: export

Press **export** above the steps and choose **export accepted**. You get a zip file with the screenshots,
`steps.csv` to open in a spreadsheet, and `steps.json` with everything about the run (see
[Exports and project files](Exports-and-Project-Files.md)).

## Questions to reflect on

1. Which steps were clearly useful, and which were noise?
2. Did Stepthrough miss a screen that matters for your question?
3. When did you need to add a step by hand, and why was it missed?
4. What would have been harder or easier with screenshots taken during the session?
