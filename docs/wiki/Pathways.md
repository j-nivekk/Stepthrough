Above the steps of a finished run you can switch from **steps** to **pathway**. The pathway draws the
accepted steps as a chart: one box per screen, with a screenshot, and arrows for the moves between screens.
A recording is a straight line in time; the chart shows where that line went back to a screen, left it again
another way, or took a detour.

New to pathways? The first time you open one, an invitation above the chart offers a hands-on tutorial of about
five minutes (**start the tutorial**); after that it is under **about** at the bottom right, as **how to work with
pathways**. On a practice recording you fold steps into screens, follow the journey, find what the automatic
grouping got wrong, correct it, and prepare the figure. Nothing in it changes your own runs.

After an update, a short tour shows what changed, the first time you open the steps of a finished run: each stop lights
up one control and says what it does. **skip** ends it, and it stays under **about** as **what's new in 1.5.1**. Used
pathways before version 1.4? Correcting them works differently now (see below), and lesson 5 of the tutorial has you try
it.

## How to read a pathway

- The journey begins at **start**, the opening screen. A step is a change of the screen, and nothing led to this one,
  so it is not counted as a step: the first step is the change that leaves it. If you reject the opening screen, or
  it is turned off in the settings, there is no start, and the journey begins at step 1.
- The black numbers are step numbers, the same as on the accepted steps and in `steps.csv`. A screen shows the
  steps taken on it, each with its time. An arrow shows the number of the step it leads to, so you can
  follow the journey from 1 onwards.
- A solid arrow goes onwards; a dashed arrow goes back to a screen that was first seen earlier. With **back** on it
  instead of a number, the return is one you added (see [Returns added by hand](#returns-added-by-hand) below), and no
  step leads to it.
- A doubled frame means several steps in a row on that screen (for example `6–7` after scrolling).
- A box shows the screenshot of its first step. Rest the pointer on a step number under the box to see that
  step instead; a number for several steps in a row, such as `6–7`, shows them in turn.
- A dashed frame is a pop-up (a menu, dialog or sheet), when the change that led to it was labelled **modal**.
- A screen takes the title of its first step that has one. Notes appear under the screen, with the step
  number in front when the screen has several steps.

## Automatic grouping: screens vs steps

Which steps count as the same screen is decided automatically, from what the screenshots show. The same picture
again (a revisit) always shares its box. A step reached by scrolling, typing, swiping to the next item of a feed or a
small change stays in the box of the step before it, and so does a step that clearly shows an earlier screen, also
scrolled or with something changed on it. When something that lay over the screen goes away (**modal closed**), the
step after it goes back into the box of the screen under it. Choose **view: steps** to give every step its own box, so
that only the same picture again shares one. A step you added by hand always has its own box. As with labels, this goes
by what the screen looks like: two screens that look alike count as one, and the same screen in a different state can
count as two. In runs made with Stepthrough 1.4.4 or earlier, a screen had to look exactly the same to be known again;
run the analysis again to have it compared.

Both kinds of boxes are screens; they differ in how readily two steps count as one. Use **screens** for the
journey as places: how many screens, in what order, and where people came back. Use **steps** to see every
action on its own, such as each scroll through a feed, or to check what **screens** put together before you
correct it.

## Correcting the pathway

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

You can make the same corrections in the pathway itself, by pointing at what you want to change. What you
select is what changes:

- **click a box** to select it, with **shift** for several boxes;
- **click the number under a box** to select that step. A number such as "4–5" stands for several steps in a
  row; the toolbox lists every step of the box, to pick another;
- **right-click** a box or a number for every action as a menu; with the keyboard, **Tab** goes from box to box,
  **Enter** selects one and the menu key opens its actions.

A small toolbox opens beside what you selected. For a box: its **title** (a box is named after its first step that
has a title, so this is that step's title, and the step list shows it too), **pop-up**, **stacking…** (to stack
onto another box, unstack all steps, unstack by visit, pop out a single step, **stack automatically** back where
steps were found, or **edit steps…**), and **phase…**. For a step: **own screen** (on stacked boxes), **put it
on…** another box, and **pop-up**. Under **⋯** (and in the right-click menu) are the rarer ones: **row**, which says whether the box goes **next to** the
screen it was reached from or **on a row below**, and **return to**. Without a say about its row, the longest way on
from a screen goes next to it and the others go below; use it to keep the main way through on one line and put detours
underneath. The screens and the moves stay the same.

The two most common corrections can also be dragged:

- **drag a box onto another box** to stack it there: all its steps move together, for two boxes that show one
  screen;
- **drag a step number onto a box** to put that step there, or **off the boxes** to give it a screen of its own,
  for one step in the wrong box. Onto a box, the steps that follow it by scrolling or typing go with it; off the
  boxes, only that step leaves.

A dotted outline shows where a drop would go, and the line above the chart says what it would do. Every change can
be taken back with **⌘Z** (Ctrl+Z on Windows) or **undo** on that line. The undo is your own: in a shared account,
each browser takes back only what it did, and a step someone else changed since stays as they left it.

Everything you change here is stored on the steps, exactly as if you had chosen it in the step list (**row** can only be
chosen here).

## Returns added by hand

**return to** is for a trip that went back where no step shows it: after looking around in **Help**, say, someone
pressed back and opened the next page at once, so the recording holds no still picture of the list in between. Choose
**return to** on the last screen of the trip and pick the screen they went back to (screens seen before it, the latest
first; for a box with several visits, it is the last one, or select the step number of another). The chart then has a
dashed arrow back with **back** on it, what follows leaves from the screen they went back to, and the trip is an
optional detour. No step is added, so the count of steps stays the same. It also works when the next step does show the
screen they went back to: there is no second arrow then, and the trip counts as a detour however long it was. **no
return** takes it away again. In the step list, the step then says where it went, such as **then back to step 41**:
click it to jump there. It can also be chosen there, by right-clicking the step.

## Phases

**Phases** name the parts of a walkthrough, such as "sign up", "verify identity" and "first payment". Select the
boxes or the step a phase starts with and choose **phase…**, or click **phases** above the chart. A small panel
opens beside it with the phases named so far: **add a phase** asks for a name and the steps it runs from and to,
and clicking a phase (in that panel, or its bracket in the chart) lets you change or remove it. Phase changes are
taken back with **⌘Z** like the others, unless someone else has changed the phases since. In the step list, every accepted step has a **phase** choice
too (under **annotate** on a card, or in the **label, screen** column of the list): one of the phases named so
far, a new one, or none. A header above the first step of each phase gives its name, its stretch of the recording and
how many accepted steps it holds; a dashed one marks where the steps go on outside every phase. A step can be in one phase at most: a phase that takes steps from another says so before
you add it. The figure draws each phase as a bracket over the screens it reaches first, with its name, how many
steps it took on how many screens, and, with **times** on, how long. A phase that goes on in another row is left
open where it breaks and says "continued" where it picks up. The export gives every step its `phase`, in
`steps.csv` and `steps.json`, and `pathway.json` lists the phases with their steps, screens and duration, so a
sentence such as "signing up took 14 steps on 9 screens" can be counted and checked. A phase runs from the moment
of its first step up to the step after its last, so a step you add by hand in between belongs to it.

## Optional detours

The main way through is the row that carries on from the first screen: on its own, the way that leads on
furthest, so a side trip that comes back goes below it; your **row** choices decide where you make them. Some
interactions are optional, so a trip off the main way that comes back to it is an optional detour: with
**detours: left out** the counts above the chart and of each phase are those of the main way, with how many steps
the detours took. The numbers follow: they count on along the main way, so the last one is the count, and the steps
of a detour have a letter after the step it leaves from. `13a`, `13b` and `13c` are the steps of a detour taken
after step 13, with the step that comes back; the next step of the main way is 14. A trip that never comes back, or
that only shows pop-ups the app put in the way, still counts. If a trip did come back and no step shows it, say so with
**return to**. The export always has both numbers: `step_index`
counts every step, `path_step` has the numbers without the detours, and `detour` marks the steps of one. Returns you
added are in it as well: `returns_to_step_id` in `steps.csv` and `steps.json`, and in `pathway.json` `returns_to` on the
step and a move with the `origin` `researcher`, which no step leads to.

## Quick reference

| to | do this |
| --- | --- |
| see another step of a box | rest the pointer on its number under the box |
| give every step its own box | **view: steps** (the default, **screens**, groups them) |
| stack two boxes that show one screen | drag one box onto the other, or **stack onto…** |
| move one step to another box | drag its number onto that box, or **put it on…** |
| take a change back | **⌘Z** (Ctrl+Z), or **undo** above the chart |
| keep the main way through on one row | **row** for a box (under **⋯**): **next to** the screen before it, or **on a row below** |
| say that a trip went back where no step shows it | **return to** for its last screen or step (under **⋯**, or right-click) |
| count only the steps an activity needs | **detours: left out**: trips off the main way that come back to it drop out of the counts and the numbers: their steps get letters, such as 13a |
| name the parts of the walkthrough | select boxes and choose **phase…**, or **phases** above the chart |
| move the notes | **notes: under screens**, **in a key** below the chart, or **off** |
| leave out the times, or the title and legend | **show: times** and **title and legend** |
| change the size on the page, and how many screens fit on a row | the slider: the smaller, the more screens on a row; **fit** goes back to the width of the window at a readable size. Beyond 100% the rows stay as they are, and the chart can be moved sideways |
| save the chart | **download: svg** or **png** |

## Saving figures (SVG and PNG)

A saved chart has the same rows as the one on the page, so set how many screens a row takes with the slider first. Its
size does not change with the slider: the file is as large as the chart on the page at 100%.

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
