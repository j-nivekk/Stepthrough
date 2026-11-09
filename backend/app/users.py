"""Manage accounts from the command line: ``python -m app.users COMMAND``.

On a server that uses password logins (``STEPTHROUGH_AUTH=password``, the default for ``STEPTHROUGH_DEPLOYMENT=server``)
this is how the first administrator is made; after that, administrators can also use the users page in the app.
In Docker, run it inside the container: ``docker compose exec stepthrough python -m app.users list``.

  add NAME [--admin] [--tag TAG ...] [--display-name TEXT] [--delete-after DATE] [--password | --password-stdin]
  import FILE.csv [--tag TAG ...] [--delete-after DATE]     (prints a CSV of names and links)
  list [--tag TAG]
  link NAME                    a new link to set a password (the old one stops working)
  tag NAME [--add TAG ...] [--remove TAG ...]
  disable NAME / enable NAME   switch an account off (it is logged out at once) or on again
  delete NAME [--yes]          delete the account and the projects only it owns
  transfer FROM TO             hand FROM's projects to TO (FROM may be `local`, the built-in account)
  expire                       delete the accounts whose deletion date has come (the server does this hourly)

People without a password get a one-time link (valid for 14 days; a reset link for 3) to choose their own. Set
STEPTHROUGH_PUBLIC_URL (for example https://stepthrough.example.org) to print whole addresses.
"""

from __future__ import annotations

import argparse
import csv
import getpass
import sys
from pathlib import Path
from typing import Any

from .accounts import User, UserLink, link_url, new_user_link, password_problem
from .config import public_url
from .database import ADMIN_TAG, LOCAL_USER_ID, init_db
from .repository import find_user_by_name, list_users, projects_owned_only_by, transfer_projects, update_user
from .user_admin import (
    AccountBusy,
    AccountError,
    clean_tags,
    create_account,
    delete_account,
    delete_expired_accounts,
    import_accounts,
)


def _out(text: str = "") -> None:
    print(text)


def _say(text: str) -> None:
    print(text, file=sys.stderr)


def _link_text(link: UserLink) -> str:
    return link_url(link.token, public_url())


def _show_link(name: str, link: UserLink) -> None:
    what = "Invitation" if link.purpose == "invite" else "Password reset"
    _out(f"{what} for {name}, usable once, until {link.expires_at[:16].replace('T', ' ')} UTC:")
    _out(f"  {_link_text(link)}")
    if public_url() is None:
        _out("  (Put the server's address in front, or set STEPTHROUGH_PUBLIC_URL to print it whole.)")


def _user(name: str) -> dict[str, Any]:
    row = find_user_by_name(name)
    if row is None:
        raise AccountError(f"There is no account called {name}.")
    if row["id"] == LOCAL_USER_ID:
        raise AccountError("The built-in account cannot be changed.")
    return row


def _read_password(from_stdin: bool, name: str) -> str:
    if from_stdin:
        password = sys.stdin.readline().rstrip("\n")
    else:
        password = getpass.getpass("Password: ")
        if getpass.getpass("Again: ") != password:
            raise AccountError("The two passwords differ.")
    if not password:
        raise AccountError("The password is empty.")
    # An administrator's password is kept as given (see app.user_admin); only say when it is a weak one.
    if problem := password_problem(password, name):
        _say(f"Note: {problem} It is kept, because an administrator set it; {name} can change it in the app.")
    return password


def cmd_add(args: argparse.Namespace) -> None:
    password = _read_password(args.password_stdin, args.name) if args.password or args.password_stdin else None
    tags = [*args.tag, *([ADMIN_TAG] if args.admin else [])]
    row, link = create_account(
        args.name, display_name=args.display_name, tags=tags, delete_after=args.delete_after, password=password
    )
    user = User.from_row(row)
    _out(f"Made the account {user.name}" + (f" (tags: {', '.join(user.tags)})" if user.tags else "") + ".")
    if link:
        _show_link(user.name, link)


def cmd_import(args: argparse.Namespace) -> None:
    result = import_accounts(Path(args.file).read_bytes(), tags=args.tag, delete_after=args.delete_after)
    writer = csv.writer(sys.stdout)
    writer.writerow(["name", "link"])
    for row, link in result.created:
        writer.writerow([row["name"], _link_text(link) if link else ""])
    _say(f"Made {len(result.created)} accounts.")
    if result.existing:
        _say(f"Left {len(result.existing)} existing accounts as they were: {', '.join(result.existing)}.")
    for number, name, message in result.errors:
        _say(f"Row {number}" + (f" ({name})" if name else "") + f" skipped: {message}")
    if result.weak_passwords:
        _say(
            f"Kept the passwords from the list for {len(result.weak_passwords)} people although they would be refused "
            f"as new ones (common, short or containing the name): {', '.join(result.weak_passwords)}."
        )


def cmd_list(args: argparse.Namespace) -> None:
    rows = [row for row in list_users() if not args.tag or args.tag in User.from_row(row).tags]
    for row in rows:
        user = User.from_row(row)
        state = (
            "switched off" if row["is_disabled"]
            else "built in" if user.is_builtin
            else "password set" if row["has_password"]
            else f"{row['open_link'] or 'no'} link open"
        )
        details = [
            ", ".join(user.tags) or "no tags",
            state,
            f"{row['project_count']} projects",
            f"deleted on {user.delete_after}" if user.delete_after else "",
            f"last seen {row['last_seen_at'][:10]}" if row.get("last_seen_at") else "never logged in",
        ]
        _out(f"{user.name:<24} " + " · ".join(part for part in details if part))
    _say(f"{len(rows)} accounts.")


def cmd_link(args: argparse.Namespace) -> None:
    row = _user(args.name)
    _show_link(row["name"], new_user_link(row["id"]))


def cmd_tag(args: argparse.Namespace) -> None:
    row = _user(args.name)
    tags = (set(User.from_row(row).tags) | set(clean_tags(args.add))) - set(args.remove)
    user = User.from_row(update_user(row["id"], tags=sorted(tags)))
    _out(f"{user.name}: {', '.join(user.tags) or 'no tags'}")


def cmd_switch(args: argparse.Namespace, *, disabled: bool) -> None:
    row = _user(args.name)
    update_user(row["id"], is_disabled=disabled)
    _out(f"{row['name']} is switched {'off' if disabled else 'on'}.")


def cmd_delete(args: argparse.Namespace) -> None:
    row = _user(args.name)
    projects = [project["name"] for project in projects_owned_only_by(row["id"])]
    if not args.yes:
        listed = f" and {len(projects)} projects only it owns ({', '.join(projects)})" if projects else ""
        answer = input(f"Delete the account {row['name']}{listed}? This cannot be undone. Type the name to confirm: ")
        if answer.strip().lower() != row["name"].lower():
            _say("Nothing deleted.")
            return
    deleted = delete_account(row["id"])
    _out(f"Deleted {row['name']}" + (f" and {len(deleted)} projects." if deleted else "."))


def cmd_transfer(args: argparse.Namespace) -> None:
    source = find_user_by_name(args.source)
    if source is None:
        raise AccountError(f"There is no account called {args.source}.")
    target = _user(args.target)
    if target["id"] == source["id"]:
        raise AccountError("Choose two different accounts.")
    moved = transfer_projects(source["id"], target["id"])
    _out(f"Handed {moved} projects from {source['name']} to {target['name']}.")


def cmd_expire(_args: argparse.Namespace) -> None:
    deleted = delete_expired_accounts()
    _out(f"Deleted {len(deleted)} accounts" + (f": {', '.join(deleted)}." if deleted else "."))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.users", description="Manage Stepthrough accounts.")
    commands = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")

    add = commands.add_parser("add", help="make an account (prints its invitation link)")
    add.add_argument("name")
    add.add_argument("--admin", action="store_true", help="make it an administrator")
    add.add_argument("--tag", action="append", default=[], help="a tag; repeat for more")
    add.add_argument("--display-name")
    add.add_argument("--delete-after", help="the date (YYYY-MM-DD) from which the account is deleted")
    choose = add.add_mutually_exclusive_group()
    choose.add_argument("--password", action="store_true", help="type a password now instead of making a link")
    choose.add_argument("--password-stdin", action="store_true", help="read the password from standard input")
    add.set_defaults(run=cmd_add)

    bulk = commands.add_parser("import", help="make accounts from a CSV list (4CAT's layout)")
    bulk.add_argument("file")
    bulk.add_argument("--tag", action="append", default=[], help="a tag for everyone in the list; repeat for more")
    bulk.add_argument("--delete-after", help="the deletion date for rows without their own `expires`")
    bulk.set_defaults(run=cmd_import)

    listing = commands.add_parser("list", help="list the accounts")
    listing.add_argument("--tag", help="only the accounts with this tag")
    listing.set_defaults(run=cmd_list)

    link = commands.add_parser("link", help="a new link to set a password")
    link.add_argument("name")
    link.set_defaults(run=cmd_link)

    tag = commands.add_parser("tag", help="add or remove tags")
    tag.add_argument("name")
    tag.add_argument("--add", action="append", default=[])
    tag.add_argument("--remove", action="append", default=[])
    tag.set_defaults(run=cmd_tag)

    for command, disabled in (("disable", True), ("enable", False)):
        switch = commands.add_parser(command, help=f"switch an account {'off' if disabled else 'on'}")
        switch.add_argument("name")
        switch.set_defaults(run=lambda args, disabled=disabled: cmd_switch(args, disabled=disabled))

    delete = commands.add_parser("delete", help="delete an account and the projects only it owns")
    delete.add_argument("name")
    delete.add_argument("--yes", action="store_true", help="do not ask")
    delete.set_defaults(run=cmd_delete)

    transfer = commands.add_parser("transfer", help="hand one account's projects to another")
    transfer.add_argument("source", metavar="FROM")
    transfer.add_argument("target", metavar="TO")
    transfer.set_defaults(run=cmd_transfer)

    expire = commands.add_parser("expire", help="delete the accounts whose deletion date has come")
    expire.set_defaults(run=cmd_expire)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    init_db()
    try:
        args.run(args)
    except AccountError as error:
        _say(str(error))
        return 1
    except AccountBusy as busy:
        _say(f"Analyses are still running in {busy}. End them first, then delete the account.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
