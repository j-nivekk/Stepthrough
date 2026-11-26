On a multi-user Stepthrough server, administrators can tag accounts as `shared` (for teams or classes working
together) or `visitor` (for temporary workshop or guest access). See [Managing accounts](Managing-Accounts.md) for
how administrators configure these tags and limits.

## Working under a shared account

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

## Visitor accounts

For people from elsewhere who try Stepthrough for a short while, an administrator can give an account the
`visitor` tag instead. A visitor account is a shared account with limits: everything above applies to it, and an
account has either the `shared` or the `visitor` tag, never both (the admin panel and a list of people refuse the
combination). Administrator accounts cannot have it either.

- **Projects are kept for a while.** Each project of a visitor account is deleted 72 hours after it was made,
  with every video, run and screenshot in it, unless the administrators chose another time. The time counts from
  when the project was made, not from the last change. The list of projects says when each one goes, and every
  page of the project shows it in a notice in the bottom left corner, which can be made small but not closed.
- **Keep the work with the project file.** The notice offers **download**: the project file
  described under [The project file](Exports-and-Project-Files.md#the-project-file). Importing that file on the
  list of projects, on the same server or another one, brings the work back; on a visitor account the new project
  counts its own time.
- **Limits.** A video may be at most 500 MB, and an account may keep at most 2000 MB at once, videos and
  screenshots together, unless the administrators chose other limits. Both are checked when a video or a project
  file comes in, and the account panel shows them.

An administrator can keep a visitor's project a day longer, for example for a workshop that runs over, and a
visitor account itself gets a deletion date (14 days on, unless the administrators chose otherwise) when it is
made without one. A project that a regular account owns as well is not deleted. In the usage, traffic and progress reports, visitor
accounts are marked as such; choosing a class leaves them out, as they have no class tag.
