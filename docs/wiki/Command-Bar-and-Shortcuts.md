Stepthrough can be driven quickly from the keyboard using single-key shortcuts and the `/` command bar.

## Using the command bar

Press **/** outside a text field to open the bar at the bottom of the window.

- **Complete and pick:** press **Tab** to complete the best match (or insert the current value for an argument), or
  use **↑** and **↓** to move through suggestions, then press **Enter** to run.
- **History:** press **↑** in an empty bar (`/`) to step back through earlier commands (up to 50; annotation text and
  OCR search queries are not saved).
- **Close:** press **Esc**, click outside the bar, or delete the leading `/`.
- **Context-aware:** the bar offers only the commands that work in the current view. Typing `/help` lists everything
  usable where you are; `/keys` lists the keyboard shortcuts.
- **Step references:** commands that take steps accept a single number (`12`), a range (`3-7`), a comma- or
  space-separated list (`3,5,9`), `start` (for the opening screen), or `candidate 5` / `candidates 3-7` when referring
  to unaccepted candidate numbers. Typing a number on its own (`/30`) jumps straight to that step.
- **Optional arguments** are shown in square brackets (`[…]`): leaving them out toggles an `on`/`off` setting, acts
  on the selected (or active) step, or uses the default target.

## All commands

### Everywhere

| command | aliases | takes | what it does |
| --- | --- | --- | --- |
| `/top` | `/gg` | — | scroll to the top of the page |
| `/end` | `/G` | — | scroll to the bottom of the page |
| `/projects` | — | — | open the list of projects |
| `/project` | — | `‹name›` | open a project by name |
| `/import` | — | — | open the import page to add videos to this project |
| `/analysis` | — | — | open the analysis page for this project |
| `/exportproject` | — | `[‹project name›]` | download a project file (`.stepthrough.zip`) with its videos and runs |
| `/settings` | — | — | open the app settings panel |
| `/about` | — | — | open the about panel |
| `/help` | `/?` | — | list every command available in the current view |
| `/keys` | `/map` | — | list the keyboard shortcuts |

### Videos and tasks

Available on the analysis page of a project.

| command | aliases | takes | what it does |
| --- | --- | --- | --- |
| `/video` | — | `‹name›` | select a video in the project |
| `/preview` | — | `[‹video name›]` | open the video preview (defaults to the selected video) |
| `/goto` | — | `‹section›` | jump to a section (`videos`, `parameters`, `tasks`, and when shown: `preview`, `comparison`, `run`, `timeline`, `steps`, `pathway`) |
| `/run` | — | `‹number or name›` | open a run of the selected video (run number, name, `next`, or `previous`) |
| `/tasks` | — | `‹filter›` | filter the tasks list: `all`, `active`, `completed`, or `failed` |
| `/compare` | — | — | compare two finished runs of the selected video |
| `/exportruns` | — | `‹scope›` | download ZIP exports for multiple completed runs: `selected`, `video`, or `completed` |
| `/export` | `/exportrun`, `/w` | `‹scope›` | download the open run as a ZIP: `accepted` or `all` |
| `/fold` | — | — | switch to **review** mode (tuck videos, parameters and tasks away) |
| `/unfold` | — | — | switch to **workspace** mode (show videos, parameters and tasks) |
| `/analyse` | `/analyze` | — | start a new analysis run for the selected video |

### Parameters

Available on the analysis page of a project.

| command | aliases | takes | what it does |
| --- | --- | --- | --- |
| `/type` | — | `‹type›` | set recording type: `phone` or `computer` |
| `/min` | — | `‹milliseconds›` | set minimum time on screen (`100` to `10,000 ms`) |
| `/change` | — | `‹percent›` | set smallest change (`0.01` to `25 %`) |
| `/statusbar` | — | `‹mode›` | set phone status bar handling: `include` or `ignore` |
| `/scrolling` | — | `‹mode›` | set scroll handling: `each` (each stop) or `merge` (merge stops) |
| `/typing` | — | `[on \| off]` | toggle or set group typing |
| `/opening` | — | `[on \| off]` | toggle or set including the opening screen as step 0 |
| `/text` | — | `[on \| off]` | toggle or set reading text after analysis (asks before turning on) |
| `/threshold` | — | `‹× noise›` | set pixel threshold under advanced (`1` to `20 × noise`) |
| `/rate` | — | `‹fps›` | set analysis rate under advanced (`2` to `30 fps`) |
| `/preset` | — | `‹preset›` | load a saved preset: `project` or `universal` |
| `/defaults` | — | `[project \| universal]` | reset parameters to defaults (defaults to project defaults) |
| `/hints` | — | `[on \| off]` | show or hide parameter hints |

### The video

Available while a video preview is open.

| command | aliases | takes | what it does |
| --- | --- | --- | --- |
| `/play` | — | — | play the video preview |
| `/pause` | — | — | pause the video preview |
| `/seek` | — | `‹time›` | jump to a moment, as `1:23`, `1:02:03` or `83.5` (seconds) |
| `/frame` | — | `[+n \| -n]` | step frames forward or back (defaults to `+1`) |
| `/speed` | — | `‹speed›` | set playback speed: `0.5`, `1`, `1.5`, or `2` |
| `/mark` | — | — | add a manual step at the current moment |
| `/player` | — | `‹size›` | set video preview size: `small`, `medium`, or `large` |
| `/closepreview` | `/q` | — | close the video preview |

### The steps

Available in the steps view of a finished run.

| command | aliases | takes | what it does |
| --- | --- | --- | --- |
| `/step` | `/‹number›` | `‹number›` | jump to a step (or type its number alone, e.g. `/30`) |
| `/nextstep` | `/next` | — | go to the next visible step |
| `/prevstep` | `/prev` | — | go to the previous visible step |
| `/firststep` | — | — | go to the first visible step |
| `/laststep` | — | — | go to the last visible step |
| `/pending` | — | — | jump to the next undecided step |
| `/accept` | `/a` | `[‹steps›]` | accept the selected steps, the active step, or the given step numbers |
| `/reject` | `/r` | `[‹steps›]` | reject the selected steps, the active step, or the given step numbers |
| `/reset` | `/u` | `[‹steps›]` | reset back to pending: the selected steps, the active step, or the given numbers |
| `/select` | `/x` | `[‹steps or mode›]` | select steps: step numbers, `all`, `none`, `invert`, `pending`, or omit to toggle the active step |
| `/filter` | — | `‹filter›` | filter which steps show: `all`, `pending`, `accepted`, or `rejected` |
| `/view` | — | `‹layout›` | switch step layout: `grid`, `list`, or `gallery` |
| `/size` | — | `‹pixels or fit›` | set step image size (`120` to `420 px`, or `fit`) |
| `/find` | — | `[‹text›]` | show only steps with this text on the screen (omit to clear the search) |
| `/title` | — | `‹text›` | set the title of the active step |
| `/note` | — | `‹text›` | set the annotation note of the active step |
| `/popup` | — | `[on \| off]` | mark or unmark the active step as a pop-up |
| `/same` | — | `‹step›` | stack the active step as the same screen as another step |
| `/newscreen` | — | — | mark the active step as a new screen of its own |
| `/playfrom` | `/p` | — | play the video preview from the active step |
| `/readtext` | — | — | read the text of the open run (asks first) |
| `/pathway` | — | — | switch from steps to the pathway view |

### The pathway

Available in the pathway view of a finished run.

| command | aliases | takes | what it does |
| --- | --- | --- | --- |
| `/steps` | — | — | switch back to the steps view |
| `/boxes` | — | `‹mode›` | set what a box stands for: `screens` or `steps` |
| `/notes` | — | `‹place›` | set where notes appear: `under`, `key`, or `off` |
| `/detours` | — | `‹mode›` | set optional detours: `counted` or `out` |
| `/times` | — | `[on \| off]` | toggle or set visit timestamps next to step numbers |
| `/legend` | — | `[on \| off]` | toggle or set the title above the chart and legend below it |
| `/phases` | — | — | open the list of phases |
| `/zoom` | — | `‹percent or fit›` | set figure zoom (`25` to `150 %`, or `fit`) |
| `/download` | `/exportfigure` | `‹format›` | download the pathway figure: `png` or `svg` |
| `/tutorial` | — | — | open the hands-on pathway tutorial |

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
