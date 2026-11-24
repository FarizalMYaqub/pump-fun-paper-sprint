// Dip-and-Rip v6: two-tier sizing — cheap breadth, big conviction.
//
// Sweep history on the dev window (grade-local, process driver):
//   v1 dip+breakout, TP +35% / SL -25%:  -1.33 SOL, 455 coins, win 22%
//   v2 breakout-only +20%, trailing:     -0.87 SOL, 178 coins, win 22%
//   v3 buy-early-hold (no sells):        -0.06 SOL but only 5 coins —
//                                        fails the 20-coin breadth bar.
//   v4 breakout +10%, SL -12%, trail 10%: -0.81 SOL, 236 coins
//   v5 breakout +10%, SL -8%, trail 8%, age 150:
//                                        -0.73 SOL, 236 coins, win 22%
//   v5 stress (4/20 copies before stop): -0.58, -0.56, -0.82, -0.30 SOL
//                                        — consistently negative.
//   v6 breadth-only, age 100:            -0.03 SOL, 33 coins — cheapest,
//                                        but ~8 coins on a 6h window
//                                        risks missing the 20-coin bar.
//   v6 breadth, age 40:                  -0.27 SOL, 97 coins
//   v6 breadth, age 25, 1 slot reserved: -0.24 SOL, 97 coins, win 29%
//   v6 + conviction at +50%:             -2.26 SOL, drawdown 24% — the
//                                        trigger fires on mid-spike tops
//                                        that retrace; rejected.
//   v6 + conviction at +100%:            never fires on the dev window
//                                        (99 coins double within 30
//                                        trades in the raw data, but none
//                                        as seen at batch boundaries with
//                                        a first-seen price), so it costs
//                                        nothing there and stays as a free
//                                        option for a genuine runner on
//                                        the final window.
// Lesson: every price-triggered rule tested so far has the same ~22%
// win rate and negative expectancy, because most fresh curves bleed and
// the exits cap the winners. The remaining lever is sizing, not timing:
// pay as little as possible for the breadth the guardrail demands, and
// put real size only behind the rare coin that proves itself with a 2x
// move while very fresh.
//
// v6 therefore splits the stake:
//   - Breadth tier: buy 0.01 SOL (the guardrail's minimum round trip)
//     on fresh coins as soon as the size cap allows, at most 120 coins,
//     exited by a -30% stop, a 15% trailing stop armed at +50%, or a
//     25-batch age cap. This clears the 20-coin bar for ~0.04 SOL of
//     expected bleed instead of ~0.7 SOL, and the short age cap keeps
//     the 5 slots rotating fast enough to clear the bar even on a 6-hour
//     final window (the 24h dev window only yielded 33 breadth coins
//     with a 100-batch cap — too close to the bar to risk).
//   - Conviction tier: when a coin doubles vs its first-seen price
//     within its first 30 trades, buy 0.20 SOL on it — an add if it is
//     already held, a fresh position if not (one slot is always kept in
//     reserve for this). The whole position then rides with a 400-batch
//     age cap, so a real runner gets room to run 3-10x while the
//     trailing stop banks it.
// The bet: one 3x runner on 0.21 SOL pays for the whole breadth tier
// several times over; without a runner the run loses little.
//
// Determinism: every decision comes from the harness state only — no
// clock, no environment, no randomness. Two runs on the same data produce
// the same action log byte for byte.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// --- tuning constants (all in one place, easy to sweep) -------------------
const BREADTH_STAKE_LAMPORTS = 10_000_000n; // 0.01 SOL: the guardrail minimum
const BREADTH_MAX_COINS = 120; // stop paying for breadth after 120 coins
const CONVICTION_STAKE_LAMPORTS = 200_000_000n; // 0.20 SOL behind a proven runner
const CONVICTION_BPS = 10_000; // entry: +100% vs first-seen price
const CONVICTION_MAX_TRADES = 30; // ...while very fresh
const STOP_LOSS_BPS = 3000; // -30% vs average entry cost per token
const TRAILING_BPS = 1500; // sell 15% below the best price since entry
const TRAILING_ARM_BPS = 5000; // trailing stop arms only once +50% in profit
const BREADTH_MAX_HOLD_BATCHES = 25; // age cap for breadth-only positions
const CONVICTION_MAX_HOLD_BATCHES = 400; // age cap once conviction size is in
const SLIPPAGE_BPS = 500; // 5% slippage tolerance on every order
const CASH_BUFFER_LAMPORTS = 20_000_000n; // keep 0.02 SOL spare for fees

interface CoinTrack {
  firstPrice: number; // SOL per token at first sight
  trades: number; // TradeEvents seen on this curve
  boughtBreadth: boolean; // breadth buy already sent (one shot per coin)
  boughtConviction: boolean; // conviction add already sent (one shot per coin)
  entryPrice: number; // average cost per token of the open position
  entryPeak: number; // best price since entry
  entryBatch: number; // batch seq when the position first appeared
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n || vq <= 0n) return 0;
  return Number(vq) / Number(vt);
}

export function createStrategy() {
  const tracks = new Map<string, CoinTrack>();
  // Coins created and not yet decided, in first-seen order. A fresh
  // curve holds no real SOL, so the size cap only grows after trades —
  // the candidate waits here until the cap allows a meaningful buy.
  const candidates = new Set<string>();
  let breadthBuys = 0;

  function trackFor(mint: string, price: number): CoinTrack {
    let t = tracks.get(mint);
    if (t === undefined) {
      t = {
        firstPrice: price,
        trades: 0,
        boughtBreadth: false,
        boughtConviction: false,
        entryPrice: 0,
        entryPeak: 0,
        entryBatch: 0,
      };
      tracks.set(mint, t);
    }
    if (price > 0) {
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

      // 1. Fold this batch's tape into the per-coin tracks, and note new
      //    launches (candidates for the breadth tier).
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') candidates.add(e.mint);
        if (e.event === 'CompleteEvent') candidates.delete(e.mint);
        if (e.event !== 'TradeEvent') continue;
        const curve = state.curves.get(e.mint);
        if (curve === undefined) continue;
        const t = trackFor(e.mint, priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves));
        t.trades += 1;
      }

      // 2. Sync average entry cost for open positions (it moves when a
      //    conviction add fills) and record first-appearance batches.
      for (const [mint, holding] of state.positions) {
        const curve = state.curves.get(mint);
        if (curve === undefined) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const t = trackFor(mint, price);
        if (holding.token_amount > 0n) {
          const avgCost = Number(holding.cost_lamports) / Number(holding.token_amount);
          if (t.entryPrice === 0) {
            t.entryPrice = avgCost;
            t.entryPeak = price > 0 ? price : avgCost;
            t.entryBatch = batch.seq;
          } else {
            t.entryPrice = avgCost;
          }
        }
      }

      // 3. Exits first: free slots before deciding new entries. The whole
      //    position exits together; conviction positions get a longer age cap.
      for (const [mint, holding] of state.positions) {
        const curve = state.curves.get(mint);
        const t = tracks.get(mint);
        if (curve === undefined || curve.complete || t === undefined || t.entryPrice === 0) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;
        const age = batch.seq - t.entryBatch;
        const ageCap = t.boughtConviction ? CONVICTION_MAX_HOLD_BATCHES : BREADTH_MAX_HOLD_BATCHES;
        const stoppedOut = price <= (t.entryPrice * (10_000 - STOP_LOSS_BPS)) / 10_000;
        const armed = price >= (t.entryPrice * (10_000 + TRAILING_ARM_BPS)) / 10_000;
        const trailedOff =
          armed && t.entryPeak > 0 && price <= (t.entryPeak * (10_000 - TRAILING_BPS)) / 10_000;
        const tooOld = age > ageCap;
        if (stoppedOut || trailedOff || tooOld) {
          orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SLIPPAGE_BPS });
          slots += 1; // the slot frees once this sell fills
        }
      }

      // 4. Conviction buys: a coin that doubled while very fresh gets real
      //    size — whether it is already held (an add on the same mint, no
      //    new slot) or not (a fresh 0.20 SOL position, which also counts
      //    toward the breadth bar). A doubling that happens before the
      //    breadth buy fills must not be missed, so this scans every
      //    tracked curve, not just the open positions.
      for (const [mint, curve] of state.curves) {
        if (orders.length >= caps.max_orders_per_batch) break;
        if (curve.complete) continue;
        const t = tracks.get(mint);
        if (t === undefined) continue;
        if (t.boughtConviction || t.trades > CONVICTION_MAX_TRADES) continue;
        if (t.firstPrice <= 0) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;
        const doubled = price >= (t.firstPrice * (10_000 + CONVICTION_BPS)) / 10_000;
        if (!doubled) continue;
        // Skip if a sell for this mint is already queued this batch.
        let exiting = false;
        for (const o of orders) if (o.side === 'sell' && o.mint === mint) exiting = true;
        if (exiting) continue;
        const held = state.positions.has(mint);
        if (!held) {
          if (slots <= 0) continue;
          let pendingBuy = false;
          for (const p of state.pending.values()) {
            if (p.order.side === 'buy' && p.order.mint === mint) {
              pendingBuy = true;
              break;
            }
          }
          if (pendingBuy) continue;
        }
        const cap = state.maxBuyLamports(mint);
        if (cap < BREADTH_STAKE_LAMPORTS) continue;
        let amount = CONVICTION_STAKE_LAMPORTS < cap ? CONVICTION_STAKE_LAMPORTS : cap;
        const affordable = free - tx - CASH_BUFFER_LAMPORTS;
        if (affordable < BREADTH_STAKE_LAMPORTS) continue;
        if (amount > affordable) amount = affordable;
        if (amount < BREADTH_STAKE_LAMPORTS) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
        t.boughtConviction = true;
        if (!held) {
          // A conviction-first buy is also the coin's breadth ticket.
          t.boughtBreadth = true;
          candidates.delete(mint);
          breadthBuys += 1;
          slots -= 1;
        }
        free -= amount + tx;
      }

      // 5. Breadth buys: the cheapest possible ticket to the 20-coin bar.
      //    Walk the candidates in first-seen order (deterministic) and buy
      //    each one once, as soon as the size cap allows a meaningful amount.
      //    One slot is always kept in reserve for a conviction-first buy
      //    (step 4), so a doubler is never locked out by five slow coins.
      for (const mint of candidates) {
        if (orders.length >= caps.max_orders_per_batch) break;
        if (slots <= 1) break;
        if (breadthBuys >= BREADTH_MAX_COINS) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) {
          candidates.delete(mint);
          continue;
        }
        if (state.positions.has(mint)) continue;
        const t = tracks.get(mint);
        if (t === undefined || t.boughtBreadth) {
          candidates.delete(mint);
          continue;
        }
        const cap = state.maxBuyLamports(mint);
        if (cap < BREADTH_STAKE_LAMPORTS) continue;
        let amount = BREADTH_STAKE_LAMPORTS < cap ? BREADTH_STAKE_LAMPORTS : cap;
        const affordable = free - tx - CASH_BUFFER_LAMPORTS;
        if (affordable < BREADTH_STAKE_LAMPORTS) continue;
        if (amount > affordable) amount = affordable;
        if (amount < BREADTH_STAKE_LAMPORTS) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
        t.boughtBreadth = true;
        candidates.delete(mint);
        breadthBuys += 1;
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
