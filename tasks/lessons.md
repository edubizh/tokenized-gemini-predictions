# Lessons

Rules learned along the way. Newest first.

## 2026-11-14: Run the failure case on the real network, not only against fixtures

The fixtures mode drew every offline screen correctly, and the bug was still there: with the relayer stopped the app counted an order's expiry on the local clock, and Reclaim was offered a few seconds before the program allowed it. In fixtures the simulated cluster clock is the local clock, so the difference cannot show. Anything that depends on a clock, a rate limit or a real signature gets one run against devnet with the real failure injected (here: the relayer actually stopped) before it is called done.

## 2026-11-14: Finish the whole thing, and do not let a job sit stuck

Long-running jobs get cut off (a sleeping laptop, a usage limit) or stall. Check on them. When one stops, look at what it left behind first: the work is often nearly done and only needs verifying and committing, which is faster than starting it again. Keep the next piece moving in the meantime, and report back when the whole plan is finished, not at each step.

## 2026-11-14: Keep the build moving

A build step that runs for more than an hour with nothing to show is too slow for a personal project. Run the independent tracks (program, relayer, web) side by side. Give each task one implementer and at most one light review, time-box it, and commit as soon as it passes so progress is visible. Keep the deep review for the whole program at the end.

## 2026-11-13: No outreach

This is a personal project. Do not draft or send emails or other messages to anyone on its behalf, including Gemini. Constraints from the exchange's rules are handled by keeping the project on devnet and the sandbox, not by asking for permission. Plans and docs must not contain "contact X" steps.
