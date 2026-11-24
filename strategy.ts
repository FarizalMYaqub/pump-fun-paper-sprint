// Dip-and-Rip v4: momentum entry, tight exits, let runners run.
//
// Sweep history on the dev window (grade-local, process driver):
//   v1 dip+breakout, TP +35% / SL -25%:  -1.33 SOL, 455 coins, win 22%
//   v2 breakout-only +20%, no TP, trailing 15% armed +20%, SL -20%:
//                                        -0.87 SOL, 178 coins, win 22%
//   v3 buy-early-hold (no sells):        -0.06 SOL but only 5 coins —
//                                        fails the 20-coin breadth bar,
//                                        because no curve completes and
//                                        the 5 slots never free up.
// Lesson: holding is cheapest per coin but cannot clear the breadth bar
// without selling, and every sale is a rotation slot. v4 keeps v2's
// shape (breakout entry, no fixed take-profit, trailing stop) and
// tightens everything: earlier breakout (+10%, first 20 trades), a
// tighter stop (-8%), an 8% trailing stop armed at +10%, and a 150-batch
// age cap, so losers are cut faster and slots rotate sooner.
//
// Determinism: every decision comes from the harness state only — no
// clock, no environment, no randomness. Two runs on the same data produce
// the same action log byte for byte.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// --- tuning constants (all in one place, easy to sweep) -------------------
const STAKE_LAMPORTS = 50_000_000n; // 0.05 SOL per buy
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: the guardrail's round-trip bar
const MAX_TRADES_TO_ENTER = 20; // only very young coins
const MIN_TRADES_TO_ENTER = 3; // need a little tape before judging
const BREAKOUT_BPS = 1000; // entry: 10% above first-seen price
const STOP_LOSS_BPS = 800; // -8% vs entry cost per token
const TRAILING_BPS = 800; // sell 8% below the best price since entry
const TRAILING_ARM_BPS = 1000; // trailing stop arms only once +10% in profit
const MAX_HOLD_BATCHES = 150; // age cap: free the slot
const SLIPPAGE_BPS = 500; // 5% slippage tolerance on every order
const CASH_BUFFER_LAMPORTS = 20_000_000n; // keep 0.02 SOL spare for fees

interface CoinTrack {
  firstPrice: number; // SOL per token at first sight
  peak: number; // highest price since first sight
  trades: number; // TradeEvents seen on this curve
  bought: boolean; // already entered once (one shot per coin)
  entryPrice: number; // cost per token of the open position (0 = not held)
  entryPeak: number; // best price since entry
  entryBatch: number; // batch seq when the position first appeared
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n || vq <= 0n) return 0;
  return Number(vq) / Number(vt);
}

export function createStrategy() {
  const tracks = new Map<string, CoinTrack>();

  function trackFor(mint: string, price: number): CoinTrack {
    let t = tracks.get(mint);
    if (t === undefined) {
      t = {
        firstPrice: price,
        peak: price,
        trades: 0,
        bought: false,
        entryPrice: 0,
        entryPeak: 0,
        entryBatch: 0,
      };
      tracks.set(mint, t);
    }
    if (price > 0) {
      if (price > t.peak) t.peak = price;
      if (t.entryPrice > 0 && price > t.entryPeak) t.entryPeak = price;
    }
    return t;
  }

  return {
    onHello(_state: BotState): void {
      // Nothing to precompute: the hello carries the caps and the seed,
      // and this strategy reads both fresh from state on every batch.
    },

    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const { caps } = state.hello;
      const tx = state.txFeeLamports();
      const orders: OrderInput[] = [];
      let free = state.freeCashLamports();
      let slots = caps.max_open_positions - state.committedPositionCount();

      // 1. Fold this batch's tape into the per-coin tracks.
      for (const e of batch.events) {
        if (e.event !== 'TradeEvent') continue;
        const curve = state.curves.get(e.mint);
        if (curve === undefined) continue;
        const t = trackFor(e.mint, priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves));
        t.trades += 1;
      }

      // 2. Sync entry prices for positions that just filled.
      for (const [mint, holding] of state.positions) {
        const curve = state.curves.get(mint);
        if (curve === undefined) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const t = trackFor(mint, price);
        if (t.entryPrice === 0 && holding.token_amount > 0n) {
          t.entryPrice = Number(holding.cost_lamports) / Number(holding.token_amount);
          t.entryPeak = price > 0 ? price : t.entryPrice;
          t.entryBatch = batch.seq;
        }
      }

      // 3. Exits first: free slots before deciding new entries.
      for (const [mint, holding] of state.positions) {
        const curve = state.curves.get(mint);
        const t = tracks.get(mint);
        if (curve === undefined || curve.complete || t === undefined || t.entryPrice === 0) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;
        const age = batch.seq - t.entryBatch;
        const stoppedOut = price <= (t.entryPrice * (10_000 - STOP_LOSS_BPS)) / 10_000;
        const armed = price >= (t.entryPrice * (10_000 + TRAILING_ARM_BPS)) / 10_000;
        const trailedOff =
          armed && t.entryPeak > 0 && price <= (t.entryPeak * (10_000 - TRAILING_BPS)) / 10_000;
        const tooOld = age > MAX_HOLD_BATCHES;
        if (stoppedOut || trailedOff || tooOld) {
          orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SLIPPAGE_BPS });
          slots += 1; // the slot frees once this sell fills
        }
      }

      // 4. Entries: walk the curves in first-seen order (deterministic)
      //    and buy breakouts on very young coins only.
      for (const [mint, curve] of state.curves) {
        if (orders.length >= caps.max_orders_per_batch) break;
        if (slots <= 0) break;
        if (curve.complete) continue;
        if (state.positions.has(mint)) continue;
        let pendingBuy = false;
        for (const p of state.pending.values()) {
          if (p.order.side === 'buy' && p.order.mint === mint) {
            pendingBuy = true;
            break;
          }
        }
        if (pendingBuy) continue;
        const t = tracks.get(mint);
        if (t === undefined || t.bought) continue;
        if (t.trades < MIN_TRADES_TO_ENTER || t.trades > MAX_TRADES_TO_ENTER) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0 || t.peak <= 0 || t.firstPrice <= 0) continue;
        const brokeOut = price >= (t.firstPrice * (10_000 + BREAKOUT_BPS)) / 10_000;
        if (!brokeOut) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_BUY_LAMPORTS) continue;
        let amount = STAKE_LAMPORTS < cap ? STAKE_LAMPORTS : cap;
        const affordable = free - tx - CASH_BUFFER_LAMPORTS;
        if (affordable < MIN_BUY_LAMPORTS) continue;
        if (amount > affordable) amount = affordable;
        if (amount < MIN_BUY_LAMPORTS) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
        t.bought = true;
        free -= amount + tx;
        slots -= 1;
      }

      return orders;
    },

    onDone(_state: BotState): void {
      // The harness flattens whatever is left; nothing to do here.
    },
  };
}
