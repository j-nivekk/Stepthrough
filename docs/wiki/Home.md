Stepthrough turns a screen recording of an app or website into a series of screenshots: one for each screen
the person stopped on, in order. You go through these steps, keep the ones that matter, add notes, chart them as
an interface pathway, and export them as images with structured data.

It is made for research on apps and interfaces, such as the walkthrough method, usability tests and comparisons
between platforms. When you run Stepthrough on your own computer, your recordings, screenshots and exports stay
on that computer. Nothing is uploaded anywhere.

---

### Getting started

- [Installing and starting Stepthrough](Installing-and-Starting.md) — Docker quick start, running from source, key terms, and why work from screen recordings
- [Tutorial: your first walkthrough](First-Walkthrough-Tutorial.md) — a 15–20 minute walkthrough from project creation to export
- [Making good recordings](Making-Good-Recordings.md) — how to record on iPhone, Android, Mac and Windows, plus practical tips

### Using Stepthrough

- [How detection works and settings](How-Detection-Works-and-Settings.md) — stable-screen rules, labels, limits, parameters and presets
- [Reviewing steps](Reviewing-Steps.md) — workspace/review modes, video preview, step decisions, tasks and comparing runs
- [Command bar and shortcuts](Command-Bar-and-Shortcuts.md) — the `/` command bar, Vim-style aliases and keyboard shortcuts
- [Text recognition (OCR)](Text-Recognition.md) — reading, inspecting, searching and exporting screen text (including PAGE XML)
- [Pathways](Pathways.md) — reading, correcting, dragging, phases, optional detours, manual returns and SVG/PNG figures
- [Exports and project files](Exports-and-Project-Files.md) — ZIP export layout (`steps.csv`, `steps.json`, `pathway.json`, `images/page`) and portable `.stepthrough.zip` project files
- [Troubleshooting](Troubleshooting.md) — common symptoms and how to fix them

### Research & teaching

- [Using Stepthrough in research](Using-Stepthrough-in-Research.md) — reporting methods and settings, typical study designs, privacy, consent and citation
- [Shared and visitor accounts](Shared-and-Visitor-Accounts.md) — live collaboration under a shared login and temporary visitor accounts for workshops

### Server & administration

- [Server deployment (Docker)](Server-Deployment-Docker.md) — Docker Compose, nginx/HTTPS, upgrades, backups and server-side OCR
- [Server deployment (without Docker)](Server-Deployment-Without-Docker.md) — running from source with `systemd`, upgrading and how it compares to Docker
- [Managing accounts](Managing-Accounts.md) — admin panel, CSV bulk import, password links, server settings, progress, usage and traffic reports

### Reference & evaluation

- [Evaluation and benchmarks](Evaluation-and-Benchmarks.md) — detection, label, screen-return and OCR evaluation results, limits and reproduction commands
- [Architecture and internals](Architecture-and-Internals.md) — backend working copies, detection engine, export schema, OCR queue and server configuration

---

- **Repository:** [j-nivekk/Stepthrough](https://github.com/j-nivekk/Stepthrough)
- **Latest release:** [GitHub Releases](https://github.com/j-nivekk/Stepthrough/releases/latest)
- **Citation (all versions):** [doi:10.5281/zenodo.24159849](https://doi.org/10.5281/zenodo.24159849)
