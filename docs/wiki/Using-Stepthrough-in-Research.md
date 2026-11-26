Guidance on reporting Stepthrough in methods sections, structuring studies, handling privacy and consent, and
citing the software.

## Reporting what you did

Every run stores the exact settings it used and what it measured, and every export includes them. A methods
section could say, for example:

> Screen recordings were segmented with Stepthrough. A step was defined as a screen that remained unchanged
> for at least 450 ms, ignoring changes smaller than 0.10 % of the screen and the phone status bar; bursts of
> typing were grouped into single steps. Detected steps were reviewed by the researcher; N of M were
> accepted and K added manually.

The numbers for such a sentence are in the export: count the rows of `steps.csv` from **export all** by
`status`, and the rows whose `origin` is `manual` for the steps you added (the opening screen, `step_index` 0, is a
row too, but not a step). Copy the **preset text** of your settings into an appendix, so that others can repeat the
analysis. Use the same settings for all recordings you compare, and report the steps you added and rejected by hand.
Name the version of Stepthrough as well: **about**, at the bottom right, shows it with the commit it was built from,
and the DOI to cite.

## Typical uses

- **Walkthrough studies:** record signing up for an app, using it day to day and leaving it, and use the
  accepted steps and their notes as the basis for describing the walkthrough.
- **Usability tests:** one project per study and one recording per participant. Compare where participants
  paused or went back (revisits show returns to earlier screens, and the pathway draws them).
- **Comparing platforms:** one project per app or version, with the same task recorded in each and the same
  settings. Compare the `steps.csv` files side by side.
- **Changes over time:** record the same task at different dates and compare the exported steps.

## Privacy and consent

Screen recordings often show names, messages, notifications and account details. Ask for consent before you
record someone's device, turn on Do Not Disturb, use test accounts where you can, and store recordings and
exports as research data under your institution's rules.

When you run Stepthrough yourself, everything stays in its own data storage: the `data` folder, or the
`stepthrough_data` volume with Docker. Deleting a project in the app deletes its recordings, screenshots and
exports from there (but not copies you downloaded).

On a shared Stepthrough server, your recordings are stored on that server. Your projects are visible only to you
and to the server's administrators. Your account may have a deletion date: from then on, the account and your
projects are deleted from the server, and you see a notice in the month before, so download your exports in
time. On a visitor account, each project is deleted a few days after it was made (see
[Shared and visitor accounts](Shared-and-Visitor-Accounts.md#visitor-accounts)). Ask the people who run the server
how long recordings are kept, and do not upload recordings that show other people without their consent.

A server also keeps a record of how Stepthrough is used, for the people who teach with it: when people are in the
app and on which page, what they do (such as uploading, analysing, deciding on steps, correcting the pathway and
exporting) and how far they get with the pathway tutorial, and how much data goes to and from each account. It counts
each login in each browser, so it can tell how many people work under a shared account, but it does not record
names, addresses, files or anything you write. It deletes the record after 14 days unless the administrators set
another time, which can be longer, such as a whole course, or until they delete it.

The administrators also see how far each account has got with its projects: videos uploaded and analysed, steps
decided, steps with a title or notes, pathway figures downloaded and exports, with the dates they were done. This is
read from the projects themselves, as counts and dates, not from what anyone wrote. Stepthrough on your own computer
records none of this.

## Credits and references

Stepthrough is created and maintained by H. "Kevin" Jin at the University of Amsterdam. The source code is at
[github.com/j-nivekk/Stepthrough](https://github.com/j-nivekk/Stepthrough) under the MIT licence, and archived on
Zenodo at [doi:10.5281/zenodo.24159849](https://doi.org/10.5281/zenodo.24159849) (see
[`CITATION.cff`](https://github.com/j-nivekk/Stepthrough/blob/main/CITATION.cff)).

Background reading:

- Light, B., Burgess, J., & Duguay, S. (2018). The walkthrough method: An approach to the study of apps.
  *New Media & Society, 20*(3), 881–900.
- Rogers, R. (2019). *Doing Digital Methods*. SAGE.
