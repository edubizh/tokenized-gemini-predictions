# Lessons

Rules learned along the way. Newest first.

## 2026-11-15: A long unattended run needs a machine that stays awake

The long verification run stalled for seventeen hours: the laptop slept with its lid closed on battery. The keep-awake command used, `caffeinate -i`, prevents idle sleep only, not sleep on lid close, and nothing noticed that the run had stopped. Before a long unattended run, say what the machine needs to stay awake (lid open, or mains power) and check the power source at the start. A run that depends on wall-clock windows stops with a clear message when it finds a gap in time, instead of failing case by case.

## 2026-11-15: A test that reads the clock passes today and fails tomorrow

Three pushes in a row failed in CI although none of them touched the code under test. A function that decides whether orders are closed took the current time as an optional argument and read the wall clock when it was missing, and its test used a fixed "last order" time that was a quarter of an hour ahead when the test was written. The tests passed until that moment came and failed from then on, everywhere. The failures were noticed by the owner, not by whoever pushed. Logic that depends on time takes the time as a required argument and reads no clock itself. CI now runs the unit tests a second time with the clock moved a year ahead (`scripts/shift-clock.mjs`), so a test that only passes today fails at once. And the result of CI is looked at after every push, not assumed.

## 2026-11-15: Bring progress back in small pieces

Two hours into the second phase, long jobs were still running and nothing had been pushed: the work sat on side branches and in jobs that reported only when they were completely finished, one of them after more than two hours. The owner asked that jobs stop disappearing into long runs. A job hands back within about 45 minutes with whatever is complete and passing. Each hand-back is checked and committed, and pushed as soon as `main` is consistent. A job whose files have not changed for 15 minutes is looked at. A change reaches `main` in the smallest piece that leaves it working, instead of waiting on a long branch.

## 2026-11-14: A stand-in wallet does not prove wallet login

Wallet login was checked with a test wallet injected into the page. It signs at once and has no window of its own, so it never met what real extensions do: a window to connect, a second window for the signature, a locked wallet, a wallet with no Solana account. With the owner's real wallets, Phantom hung on the signature step and MetaMask did not connect. Wallet login is done only after the real extensions have been driven through it (connect, sign, reject, locked, reload), and any step that waits on a wallet says what it is waiting for and offers a way to try again.

## 2026-11-14: Keep the interface plain

The first interface carried a motif (tickets, receipts, stamps) and many kinds of component. The owner asked for the opposite: very simple, clean and calm, few components, a small fixed palette. Start from the fewest parts that do the job, and add a component only when a screen cannot work without it.

## 2026-11-14: Run the failure case on the real network, not only against fixtures

The fixtures mode drew every offline screen correctly, and the bug was still there: with the relayer stopped the app counted an order's expiry on the local clock, and Reclaim was offered a few seconds before the program allowed it. In fixtures the simulated cluster clock is the local clock, so the difference cannot show. Anything that depends on a clock, a rate limit or a real signature gets one run against devnet with the real failure injected (here: the relayer actually stopped) before it is called done.

## 2026-11-14: Finish the whole thing, and do not let a job sit stuck

Long-running jobs get cut off (a sleeping laptop, a usage limit) or stall. Check on them. When one stops, look at what it left behind first: the work is often nearly done and only needs verifying and committing, which is faster than starting it again. Keep the next piece moving in the meantime, and report back when the whole plan is finished, not at each step.

## 2026-11-14: Keep the build moving

A build step that runs for more than an hour with nothing to show is too slow for a personal project. Run the independent tracks (program, relayer, web) side by side. Give each task one implementer and at most one light review, time-box it, and commit as soon as it passes so progress is visible. Keep the deep review for the whole program at the end.

## 2026-11-13: No outreach

This is a personal project. Do not draft or send emails or other messages to anyone on its behalf, including Gemini. Constraints from the exchange's rules are handled by keeping the project on devnet and the sandbox, not by asking for permission. Plans and docs must not contain "contact X" steps.
