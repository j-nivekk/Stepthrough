# Choosing Settings

This page gives new researchers a simple way to choose settings without getting lost in technical details.

## Start Here

Stepthrough finds every screen that stays still for a moment and takes one screenshot of it. For most first-time use:

- pick the **recording type**: **phone or tablet**, or **computer** (a desktop or browser recording with a mouse)
- keep every other setting at its default

## Simple Decision Guide

Use this rule set:

- If a brief screen is missing (a menu, a popover), lower the **minimum time on screen**.
- If a small change is missing (a toggle, a badge), lower the **smallest change**.
- If something that keeps moving creates extra steps (a clock, a banner, a playing video), draw an **ignore area** over it.
- If a moving mouse pointer creates extra steps, use the **computer** recording type.
- If one important moment is missing, add a manual step before changing many settings.

## What The Main Settings Mean

### Minimum Time On Screen

How long a screen must stay still to count as a step: 450 ms for phones, 600 ms for computers.

- lower: catches brief screens, but also screens the user only passed through
- higher: calmer output, but very short states are skipped

### Smallest Change

The smallest connected change, as a share of the screen, that counts: 0.10 % for phones, 0.25 % for computers.

- lower: catches tiny changes, but small animations may add steps
- higher: ignores small movement, but tiny real changes may be missed

### Group Typing

On by default: a burst of typing with short pauses becomes one step showing the finished text. Turn it off if every pause matters for your analysis.

## Beginner Advice

For new users:

- change one thing at a time
- keep notes about which run worked better
- compare two runs if you are unsure
- leave the settings under **advanced** alone

## When To Ask For Help

Ask an instructor or advanced user when:

- the defaults perform poorly on several recordings of the same kind
- OCR-related behaviour is unclear
- the exported steps look consistently late or early
- the recording contains unusual motion-heavy content
