Common issues when starting Stepthrough or tuning detection on a recording.

## Stepthrough does not start or does not open

See **If something goes wrong** in [Installing and starting Stepthrough](Installing-and-Starting.md#with-docker).
If you installed with Docker, check that Docker Desktop is running. If you installed from the source code, check
that both parts (backend and frontend) are running.

## It missed important steps

1. Check that the recording type matches the device.
2. If the missing screen was short, lower the **minimum time on screen**.
3. If the missing change was small, lower the **smallest change**.
4. Add important moments by hand.

## It found too many steps

1. If something on screen keeps moving, draw an **ignore area** over it.
2. If a mouse pointer causes extra steps, use the **computer** recording type.
3. Raise the **minimum time on screen** to skip screens the person only passed through.
4. Raise the **smallest change**.
5. For very grainy recordings, raise the **pixel threshold** under **advanced**.

## A page that keeps loading gives two steps

When a page comes to rest and then loads more content, the loaded page is a step of its own, labelled
*update*. Reject the earlier step, or raise the minimum time on screen so that the first one is skipped.

## Typing on a computer is split up or shows unfinished text

On a computer screen, each typed character is a tiny change, far below the default smallest change for the
**computer** recording type. Set the **smallest change** to 0.05 % for recordings with typing, and keep the
mouse still while typing. The same setting helps when a scroll through a list of similar-looking rows is
missed: try 0.10 %.

## There are many scroll steps

By default, every place where the page stops is a step. Choose **scrolling: merge stops** to keep only the
first.

## Changes in text are missed

Changes in text are visual changes, so Stepthrough finds them without text recognition. If a single changed
word is missed, lower the **smallest change**. Only turn on **read text (ocr)** if you need the words
themselves.

## The run found almost no steps

The screen probably never stays still, for example because a video or an animation keeps playing. Draw an
ignore area over it, or lower the minimum time on screen.
