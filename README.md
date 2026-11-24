# Dip-and-Rip

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/FarizalMYaqub/pump-fun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/FarizalMYaqub/pump-fun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for make.fun's Pump.fun Paper Sprint. It trades 10 SOL of paper money on a 6-hour replay of pump.fun bonding-curve activity, ranked by net PnL. No real money, no wallet, no DEX — pure simulation.

## Strategy

Fresh bonding curves are noisy: either a launch catches a bid and runs, or it bleeds out slowly. Every price-triggered rule swept on the dev window (dip-buying, breakout momentum, tight stops) landed at −0.7 to −1.3 SOL with a ~22% win rate, while buy-and-hold of the first coins came out near breakeven — so Dip-and-Rip sizes instead of timing. Breadth tier: 0.01 SOL (the guardrail's minimum round trip) on fresh launches, at most 120 coins, exited by a −30% stop, a 15% trailing stop armed at +50%, or a 25-batch age cap — the 20-coin breadth bar for ~0.04 SOL of expected bleed, with slots rotating fast enough to clear the bar even on a 6-hour final window. Conviction tier: when a coin doubles vs its first-seen price within its first 30 trades, buy 0.20 SOL on it (an add if held, a fresh position if not — one slot is always kept in reserve for this); the whole position then rides with a 400-batch age cap, so a real runner gets room to run 3–10x while the trailing stop banks it. At most 5 open positions, one breadth shot per coin. One 3x runner on 0.21 SOL pays for the whole breadth tier several times over; without a runner the run loses little. Dev grade: −0.24 SOL, 97 coins, max drawdown 3.7%, deterministic (L1 regrade byte-for-byte).

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout: the harness sends `hello`, then one `batch` per slot (events, marks, fills, account), and the bot answers each batch with one reply of buy/sell orders. Deterministic by construction — no clock, no environment, no randomness — so two runs on the same data produce the same action log.

## Layout

- `main.ts` — entrypoint, wires the strategy to the SDK shim.
- `strategy.ts` — the Dip-and-Rip strategy (triggers, exits, sizing).
- `vendor/makefun-bot.ts` — the kit's bot shim, copied unchanged.

---

<sub>Entered on [make.fun](https://make.fun/?ref=byte&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
