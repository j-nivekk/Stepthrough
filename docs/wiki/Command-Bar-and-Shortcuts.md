Stepthrough can be driven quickly from the keyboard using single-key shortcuts and the `/` command bar.

## Command bar

Press **/** outside a text field to open the bar at the bottom of the window. Type a command, use **Tab** to
complete it or **↑** and **↓** to choose a suggestion, then press **Enter**. **Esc** closes the bar. Type
`/help` to see the commands available in the current view, or `/keys` to see the keyboard shortcuts.

`/top` and `/end` scroll the page. In a finished run, `/30` goes to step 30 and `/accept 3-7` accepts a range.
With no numbers, `/accept`, `/reject` and `/reset` act on the selected steps that are visible, or the active
step if nothing is selected. Use `candidate 5` when you mean the screenshot labelled **candidate 5**.
`/pathway` opens the pathway, where `/zoom fit` fits the figure and `/steps` returns to the review.

`/analysis` returns to the project's analysis page. Use `/goto parameters`, `/goto tasks` or `/goto timeline`
to jump between sections, and `/fold` or `/unfold` to toggle between **review** and **workspace** layouts.
`/preview` opens the selected video, and `/closepreview` closes it. In step review, `/nextstep`, `/prevstep`,
`/firststep` and `/laststep` follow the current filters.

`/export accepted` and `/export all` download the open run from Steps or Pathway. Use `/exportproject` to
download the selected project with its videos and runs, or give it a project name. `/exportruns selected`
downloads the completed runs selected in the tasks list. Use `video` for the selected video's completed runs
or `completed` for all completed runs in the project. In Pathway, `/exportfigure svg` or `/exportfigure png`
downloads the figure.

The Vim-style aliases appear below their command names:

| alias | command | what it does |
| --- | --- | --- |
| `/gg` | `/top` | scroll to the top of the page |
| `/G` | `/end` | scroll to the bottom of the page |
| `/a` | `/accept` | accept the selected steps, the active step, or given numbers |
| `/r` | `/reject` | reject the selected steps, the active step, or given numbers |
| `/u` | `/reset` | reset steps back to pending |
| `/x` | `/select` | select steps (`all`, `none`, `invert`, `pending`, or numbers) |
| `/p` | `/playfrom` | play the video from the active step |
| `/w` | `/export` | download the open run (`accepted` or `all`) |
| `/q` | `/closepreview` | close an open video preview |
| `/?` | `/help` | list commands available in the current view |
| `/map` | `/keys` | list keyboard shortcuts |

## Keyboard shortcuts

| key | what it does |
| --- | --- |
| `/` | open the command bar |
| `a`, `r`, `u` | accept, reject, or reset the active step |
| `x`, `Shift+x` | select the active step, or select a range |
| `←`, `→` | move to the previous or next step |
| `p` | play the video from the active step |
| `Shift+F10` | open the context menu of all actions for the active step |
| `Space` | play or pause the video preview |
| `,`, `.` | step one frame back or forward in the video preview |
| `k` | add a manual step at the current moment of the video preview |
| `⌘Z` / `Ctrl+Z` | undo the last change in the pathway |
| `Esc` | close the command bar, clear step selection, or close a menu |
