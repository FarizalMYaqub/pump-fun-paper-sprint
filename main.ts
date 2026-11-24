// Dip-and-Rip — entrypoint for the Pump.fun Paper Sprint.
//
// The bot speaks agent-fun/replay/v2 on stdin/stdout: the harness sends
// `hello`, then one `batch` per slot (events, marks, fills, account), and
// the bot answers each batch with one reply of buy/sell orders. All
// strategy logic lives in strategy.ts; this file only wires it to the
// vendored SDK shim (vendor/makefun-bot.ts).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

const strategy = createStrategy();

await runBot({
  onHello(state) {
    strategy.onHello(state);
  },
  onBatch(state, batch) {
    return strategy.onBatch(state, batch);
  },
  onDone(state, done) {
    strategy.onDone(state);
  },
});
