# First Tutorial

This tutorial is meant for a first guided session with new researchers. It assumes the app is already available and ready to use.

## Goal

By the end of this exercise, you will:

- import a recording
- run automatic detection
- review candidate steps
- add one manual step
- export a clean walkthrough

## What You Need

- one short sample screen recording
- about 10 to 15 minutes

Choose a recording with a simple task flow, such as:

- signing into an app
- searching for an item
- opening a settings panel
- moving through a short prototype

## Before You Begin

Remember the basic workflow:

**recording -> run -> candidates -> accepted steps -> export**

Also remember why we work from recordings:

- the recording captures the full session
- it preserves movement and transitions
- it lets us revisit missed moments later

## Exercise

### 1. Open Or Create A Project

Create a project for the exercise or open the one your instructor prepared.

A project is simply the container for your recordings and analysis runs.

### 2. Import One Recording

Go to the **Import** stage and add one screen recording.

After import, confirm that the recording appears in the project.

### 3. Run A First Analysis

Go to the **Analysis** stage.

For your first run:

- use **Hybrid v2**
- choose the **Balanced** preset
- keep the other settings at their default values

Then run the analysis.

### 4. Check The Result

When the run is completed, open the candidate review area.

Look through the proposed steps and ask:

- Does this moment show a meaningful change in the task?
- Would this help another person understand the walkthrough later?
- Is this a duplicate or just motion noise?

### 5. Accept And Reject Candidates

As you review:

- accept candidates that represent meaningful task steps
- reject candidates that are duplicates, noise, or unhelpful transitions

Try to think like a future reader of the walkthrough. The goal is not to keep everything. The goal is to keep the moments that explain the flow clearly.

### 6. Add One Manual Step

Find one place where the automatic detection missed something important or where you want to guarantee a certain frame is included.

Add one manual step.

This teaches an important lesson: automatic detection is helpful, but researcher judgment still matters.

### 7. Export Accepted Steps

Export the accepted walkthrough.

Notice that the export package contains:

- screenshots
- a CSV file
- a JSON file

These can then be used for reporting, comparison, or further analysis.

## Reflection Questions

After the exercise, answer these briefly:

1. Which candidates were clearly useful?
2. Which ones felt noisy or unnecessary?
3. Did the detector miss any important state?
4. When was a manual step helpful?
5. Would a live screenshot workflow have been easier or harder for this recording?

## If The Results Look Wrong

Use these simple fixes:

- If important states are missing, try **Subtle UI**.
- If there is too much noise, try **Ignore Noise**.
- If only one key moment is missing, add a manual step instead of rerunning immediately.

## What You Learned

You have now completed the main beginner workflow:

1. import a recording
2. run analysis
3. review candidates
4. curate accepted steps
5. export a walkthrough

That is the core skill new Stepthrough users need first.
