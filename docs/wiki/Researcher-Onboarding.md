# Researcher Onboarding

This page is designed for new researchers, especially bachelor-level students who are using **Stepthrough** for the first time.

The goal is not to teach every feature immediately. The goal is to help you become productive with one clear workflow and a small set of concepts.

## What The App Is For

Stepthrough helps you turn a screen recording into a clean, reviewable walkthrough.

In a typical research workflow, you:

1. import a screen recording
2. run automatic analysis
3. review the suggested step moments
4. accept the meaningful ones
5. export the final walkthrough

This means you do not have to manually take screenshots every time the interface changes.

## Why Record First Instead Of Taking Screenshots Live

For walkthrough-driven research, screen recordings are often a better medium than taking screenshots manually during the session.

A recording helps because:

- it captures the whole interaction, including the moments you did not expect would matter
- it preserves dynamic behavior such as scrolling, fading, flashing, expanding menus, and loading states
- it removes the need to interrupt a session to press screenshot buttons or shortcuts
- it lets you backtrack later if you missed something in real time
- it makes it easier to study fast or informal interfaces such as feeds, threads, and short-form video apps

This is important because many meaningful interface states are not stable static screens. They may appear briefly during motion, transition, or interaction.

## The Five Terms You Need First

You only need five concepts to begin:

- **Project**: the workspace for a study, class exercise, or product area
- **Recording**: the uploaded screen recording
- **Run**: one analysis attempt with a chosen setting profile
- **Candidate**: a suggested screenshot or moment produced by the analysis
- **Accepted step**: a candidate you approved for the final walkthrough

If you understand those five terms, the interface becomes much easier to follow.

## The Beginner Workflow

For your first sessions, use this workflow:

1. Create or open a project.
2. Import one recording.
3. Start with **Hybrid v2 + Balanced**.
4. Wait for the run to finish.
5. Review the candidates one by one.
6. Accept the meaningful steps.
7. Reject the noise.
8. Add a manual step if the detector missed something important.
9. Export accepted steps.

That is enough for most beginner work.

## What To Ignore At First

Do not worry about advanced settings right away.

You can safely postpone:

- detailed threshold tuning
- dwell and settle timing
- detector mode comparisons
- OCR edge cases
- cross-run comparison strategy

These matter later, but they are not needed to complete a good first walkthrough.

## A Good Teaching Sequence For Classes

If you are teaching this app in a course or lab, the sequence below works well:

1. **Concept introduction**  
   Explain what the app does and why recording-first capture is useful.

2. **Live demo**  
   Show one complete workflow from import to export without pausing for every feature.

3. **Guided tutorial**  
   Let students repeat the workflow on a small sample recording.

4. **Reflection**  
   Ask what the detector caught well, what it missed, and when a manual step was useful.

5. **Troubleshooting and tuning**  
   Only after the first exercise, introduce preset choice and basic parameter changes.

## Recommended Rules For New Users

These rules keep the first experience manageable:

- Start with **Hybrid v2 + Balanced**.
- If the run misses important states, try **Subtle UI**.
- If the run finds too much noise, try **Ignore Noise**.
- If one important moment is missing, add a manual step.
- Change one thing at a time between runs.

## Learning Outcomes For A First Session

By the end of a first onboarding session, a new user should be able to:

- explain what a project, recording, run, candidate, and accepted step are
- import a recording and run analysis
- review candidates and make accept or reject decisions
- explain why a manual step might be needed
- export a final walkthrough package

## Next Step

Continue to the [First Tutorial](./First-Tutorial.md) for a guided practice exercise.
