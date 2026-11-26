This page covers why Stepthrough works from screen recordings, the key terms used across the interface, and how
to install and start Stepthrough on your own computer.

## Why work from screen recordings

Taking screenshots by hand during a session interrupts what you are doing, and you miss anything you did not
think to capture. A screen recording keeps everything:

- **the whole interaction**, including moments you did not expect to matter;
- **screens that only last a moment**, such as menus, loading screens, pop-ups and notifications;
- **no interruptions**: nobody has to stop to take a screenshot;
- **a second look**: you can go back to the recording when you notice that a step is missing.

The downside is that a recording is one long video, while an analysis needs separate screens. Stepthrough
does that for you: it finds the screens the person actually stopped on and gives you one screenshot of each.

To see this as an animation, open Stepthrough and choose **about → how it works** at the bottom right.

## Key terms

| term | meaning |
| --- | --- |
| **project** | a folder for one study, app or topic; it holds the recordings and their runs |
| **recording** | a screen recording you imported |
| **run** (or task) | one analysis of a recording with one set of settings; you can analyse a recording as often as you like |
| **step** | a screen that stayed still long enough to count, with one screenshot; until you accept it, it is called a candidate |
| **start** | the opening screen, which the recording starts on. Nothing was done to get there, so it is where the steps start and not one of them; it has a screenshot like the steps, and the number 0 in the files |
| **accepted step** | a step you decided belongs in the walkthrough |
| **label** | the kind of change that led to a step, such as navigation, scroll or typing |
| **screen** | one or more steps that show the same screen of the app, such as a page before and after scrolling |
| **pathway** | the accepted steps drawn as a chart: the screens, and the moves between them |
| **export** | a zip file with the screenshots and files that describe the steps: `steps.csv`, `steps.json` and `pathway.json` |

## Installing and starting Stepthrough

If someone has set up a Stepthrough server for your group, you do not need to install anything. They send you a
link with which you choose a password; after that, open the server's address, log in with your name and that
password, and go on to the [First walkthrough tutorial](First-Walkthrough-Tutorial.md). Your name at the bottom
right opens your account: change your password or log out there. If you forget your password, ask them for a new
link. A password needs at least 8 characters; very common ones, and ones containing your name, are refused. You
stay logged in for up to 30 days, or until you have not used Stepthrough for a week.

Otherwise, there are two ways to run Stepthrough on your own computer:

- **With Docker (recommended).** You install one program, Docker Desktop, and type three commands. It works
  the same way on Windows and on a Mac.
- **From the source code.** This is for people who want to change Stepthrough. It needs more programs.

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
  screenshots somewhere else, export them in the app (see [Exports and project files](Exports-and-Project-Files.md)).
  If you delete the `stepthrough_data` volume in Docker Desktop, all your Stepthrough data is deleted with it.

Commands that start with `docker compose` only work inside your Stepthrough folder. In every new terminal
window, type `cd Stepthrough` first.

**Settings.** You can change a few things by adding lines to a settings file called `.env` in your Stepthrough
folder. Each command below adds one line; afterwards, type `docker compose up -d` to apply it. To undo your
settings, delete the file (`del .env` on Windows, `rm .env` on a Mac), add the line from step 2 again
(`echo STEPTHROUGH_AUTH=none>>.env`) and type `docker compose up -d`.

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

**Text recognition** downloads its models (23 MB) the first time you use it, so you need to be online then. It does not
work on Macs with an Intel processor or with macOS before version 14; on those, use Docker instead.

**Where your data is.** Everything is stored in the `data` folder inside the Stepthrough folder.

**To update,** type `git pull` in the Stepthrough folder, then run the set-up commands again: `uv sync` in
`backend` and `npm install` in `frontend` (on a Mac, `./setup.sh` does both).

*(For hosting Stepthrough on a server for a class or research group, see [Server deployment (Docker)](Server-Deployment-Docker.md) or [Server deployment (without Docker)](Server-Deployment-Without-Docker.md).)*
