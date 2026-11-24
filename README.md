# Dip-and-Rip

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/FarizalMYaqub/pump-fun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/FarizalMYaqub/pump-fun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for make.fun's Pump.fun Paper Sprint. It trades 10 SOL of paper money on a 6-hour replay of pump.fun bonding-curve activity, ranked by net PnL. No real money, no wallet, no DEX — pure simulation.

## Strategy

Fresh bonding curves are noisy: either a launch catches a bid and runs, or it bleeds out slowly. Dip-and-Rip buys small (0.05 SOL) on very young coins only, on a breakout trigger — price 20% above first sight within the first 30 trades. No dip buying: most curves bleed, so catching falling knives pays the bleed. Exits are mechanical and let winners run: no fixed take-profit, just a 15% trailing stop armed once the trade is +20%, a −20% stop-loss, and a 300-batch age cap that frees the slot for the next launch. At most 5 open positions, one shot per coin, so the bot rotates through many coins and clears the 20-coin breadth bar without any single coin sinking the run.

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
