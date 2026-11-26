Administrators look after accounts in the admin panel: open the menu with your name at the bottom right, then
**admin panel**. Nobody can sign up on their own.

## People and passwords

- **Adding people.** Type the name they will log in with, optionally with tags and a deletion date, and give them
  the link that appears. With the link they choose their own password; it works once, for 14 days.
  Common passwords, and passwords containing their name, are refused.
- **Importing a list.** A CSV file in the layout of 4CAT's bulk user import works as it is: a `name` column, and
  optionally `expires` (a date as `2027-02-01`), `tags`, `password` and `notes`. Everyone without a password gets
  a link, and the page offers all of them as a CSV, ready for a mail merge. Passwords in the list are kept as
  given, even weak ones (the result lists who has one); people's own new passwords follow the rules.
- **Forgotten passwords.** Give the person a new link (**reset link** on their row). It works for 3 days, and
  earlier links stop working.
- **Deletion dates.** From an account's deletion date, the account and the projects only it owns are deleted.
  People see a notice in the month before. Accounts without a date are kept until an administrator deletes them.
- **Shared and visitor accounts.** The `shared` tag makes an account for a group that works under one login. The
  `visitor` tag makes a shared account for people from elsewhere, with limits: each of its projects is deleted a
  set time after it was made (72 hours by default), its uploads and what it keeps are capped, and every page of
  its projects says when they go and offers the project file to keep the work. An account has one of the two
  tags, never both, and administrators have neither: the panel, a list and the command line all refuse it. Under
  **add people**, administrators set for everyone at once how long visitors' projects are kept, in hours from when
  each was made (a shorter time asks first; projects older than it go within a few minutes), the largest video a
  visitor may upload (empty: the server's own limit, `STEPTHROUGH_MAX_UPLOAD_MB`), how much each visitor
  account may keep at once (empty: no limit), and for how many days an account given the visitor tag without a
  deletion date is deleted (14 by default; empty: no date). Below them, the visitors' projects are listed with
  when each is deleted, and **+1 day** keeps one a day longer, for a workshop that runs over. See
  [Shared and visitor accounts](Shared-and-Visitor-Accounts.md) for how they behave for users.
- **Switching off** an account logs it out at once and keeps its projects.
- **Guessing.** After too many wrong passwords, further attempts wait 15 minutes; see the log for who and from
  where: `docker compose logs stepthrough | grep -E "Wrong|Refused"`.

## Command-line account management

The same can be done from the command line, which also lists accounts with when they were last seen:

```bash
docker compose exec stepthrough python -m app.users list
docker compose exec stepthrough python -m app.users link yourname          # a new password link
docker compose exec -T stepthrough python -m app.users import /dev/stdin --tag group-a < people.csv > links.csv
docker compose exec stepthrough python -m app.users --help                 # everything else
```

*(Without Docker, run `uv run python -m app.users ...` from `backend/`.)*

## Server settings

Under **server** in the admin panel, administrators change, while Stepthrough runs and for everyone at once:

- how many analyses run at a time (it starts as `STEPTHROUGH_MAX_CONCURRENT_RUNS` has it),
- how many text readers run and how many threads each uses (0 turns text recognition off),
- whether answers are compressed (a switch in case something goes wrong with it),
- over how many seconds the browsers of a shared account spread reloading a task after a change, and
- how long usage and traffic are kept: 2, 3, 4 or 8 weeks, a number of days, for ever (until a shorter time is chosen),
  or off (nothing recorded). A shorter time asks first, then deletes what is older at once.

The changes are kept in the database and outlast restarts; each says when it differs from the server's configuration.

## Progress, usage, and traffic reports

- **Progress.** Under **progress** in the admin panel, administrators see how far each account has got with its
  projects: videos, analysed, reviewed (no undecided steps), described (every accepted step has a title or notes),
  pathway figure and exported, with the date each was reached, the share done where it is not, and the accounts that
  need a look (not started, no change for a week, or a failed analysis not run again). Whether the pathway figure
  counts toward done is a switch, for courses that do not ask for one. It is read from the projects themselves, so it
  covers a whole course whatever the keeping time, and can be downloaded as CSV.
- **Usage.** Under **usage** in the admin panel, administrators see how Stepthrough is used, for today, the last 7 or
  14 days, 4 or 8 weeks, everything kept, or any dates, in their own time zone: how many people are in the app at each
  hour of the day and on each day, logins, analyses (how long they took and waited), decisions, pathway corrections,
  exports, time on each page, how far people get with the pathway tutorial, a grid of the minutes each account made
  changes each day, and the same per account; each can be downloaded as CSV for a report, also as one long table of
  every account, day and measure. People are counted by their login in each browser, so the several people working
  under one shared account count separately. It records accounts that are not administrators, never names,
  addresses, files or what anyone writes, and deletes everything after 14 days unless set otherwise under **server**.
  Stepthrough without logins records nothing.
- **One class at a time.** Progress, usage and traffic can each be narrowed to the accounts with one tag, such as the
  tag given to a class when its accounts were imported.
- **Traffic.** Under **traffic** in the admin panel, administrators see how much goes in and out of the server, as it
  goes over the network: per hour of the day and per day, by kind (video uploads, videos and screenshots, exports,
  live updates, other data and the app's own files), and per account, administrators included, with what came before
  a login apart. It is kept as totals per hour, account and kind for as long as usage is kept, and can be downloaded as
  CSV.

## Upgrading from a version without accounts

Projects made before then belong to a built-in account that nobody logs in with, so they appear in nobody's list.
Take them over with **take over its projects** on the built-in account's row, or
`docker compose exec stepthrough python -m app.users transfer local yourname`.
