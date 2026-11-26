Stepthrough exports both run-level walkthrough bundles (for analysis, spreadsheets, scripts and publications) and
complete project files (for backup and moving projects between computers or servers).

## Run exports

**export**, at the right above the steps, opens a menu: **export accepted** exports the steps you accepted;
**export all** exports every step. A name typed at the top of that menu names the zip file; left empty, the server
names it. Under **tasks**, **select** lets you export several runs at once. An export is made from the task as it
is at that moment, so Stepthrough keeps only the latest of each task: export again whenever you need it. Each
export is a zip file with:

- `images/`: one screenshot (PNG) per step, named after the recording, the step number and the time;
- `images/page/`: PAGE XML files for each screenshot whose text was read (when OCR has run);
- `steps.csv`: one row per step, to open in a spreadsheet;
- `steps.json`: the same steps, plus everything about the run, for use in your own scripts;
- `pathway.json`: the same steps as a pathway: which screen each step is on, the visits to each screen, and
  the moves between screens with the steps they lead to.

The steps are numbered as in the pathway (`step_index`): 0 for the opening screen, which is where they start, then 1,
2 and so on; without the opening screen, from 1. Screenshots and `step_id` have the same number. Before version
1.4.4, the opening screen was number 1, so every number was one higher: use exports made with the same version
when you compare steps by number. **export all** numbers the candidates in the same way.

For each step, the export has its time, the screenshot's file name, its status, title and notes, whether
Stepthrough found it or you added it by hand (`origin`: `detected` or `manual`), the phase you put it in
(`phase`), and its label (`transition_type`). It also has when the change started (`change_started_ms`), when the screen came to rest
(`settled_ms`), how long it stayed on screen (`time_on_screen_ms`), how many typing states were grouped
together (`grouped_states`), links to earlier visits of the same screen, the areas that changed and, if it was
read, the text on the screenshot (`ocr_text`). `text_state` says whether it was read; in `steps.json`,
`text_lines` has each line with its place on the screenshot, and `text_page_xml` the file in `images/page` that has
the same as PAGE XML.

`steps.json` also records the size and frame rate of the recording, the settings as you chose them and as
they were actually used, what was measured (such as the flicker level), and `field_notes` explaining every
field. That way, the export can be read and cited without the app.

`pathway.json` uses the step numbers and image names of `steps.json`. For every step it gives the screen it
is on and why it shares that screen with an earlier step (`grouped_by`: `researcher` when you chose it, a
revisit, or what was found, such as `scroll` or `same_page`), and what you chose for the step (`screen_choice`,
`kind_choice`), so your decisions and the automatic ones can be told apart. It has its own `field_notes`.
The chart itself is not in the zip; save it with **download: svg** or **png** from [Pathways](Pathways.md#saving-figures-svg-and-png).

## The project file

An export holds the results of one run, to work with elsewhere. To keep a whole project, take it to another
Stepthrough server, or bring it back after it was deleted, use **download** next to the project in the list of
projects. It saves the project as one file (`name.stepthrough.zip`) with its videos as they were uploaded, and
every run with its settings, its name and number, its steps with your decisions, titles and notes, your screen,
pop-up and row choices, and its phases. Exports of runs and the log of each analysis are not in it, and runs that
are still analysing are left out. With long videos the file is large; it downloads as it is made.

To bring the work back, choose **or import a project...** on the list of projects and drop the file there (or
click to choose it). It becomes a project again, under its own name, with every video and run in it, and opens
when it is in: you can carry on reviewing, or analyse again with other settings. The same file can be brought in
more than once. To add the videos of a project file to a project you are working in instead, drop the file on
that project's import page, as you would a video.

A server takes project files up to a size its administrators chose (4 GB unless they chose otherwise). When a
project's file would be larger, **download** says so first: you can still keep the file, but not bring it back on
that server.

A file made with an earlier version of Stepthrough always opens in a later one. A file made with a newer version
than the server is refused with a message, rather than read halfway: update the server first. A damaged or
incomplete file is noticed and refused, and nothing of it is kept.

Like the export, the project file holds screenshots of what was on screen, and the videos themselves: keep it as
you keep the recordings.
