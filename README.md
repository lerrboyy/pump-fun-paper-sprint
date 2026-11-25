# Pump.fun Paper Sprint — Momentum with Discipline

[![Competition](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/lerrboyy/pump-fun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/lerrboyy/pump-fun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. One program, `main.ts` (Node 22, no dependencies, no network), trading a 6-hour replay of real pump.fun market data. Highest net PnL wins; the reward bar is net PnL above zero after every fee.

## Strategy: momentum with discipline

A filtered trend-following strategy, not a gamble:

- **Only trade genuine early surges.** Enter only when a coin shows price rising *together with* rising buy volume in its first 3 minutes after launch — both signals, not one. A price spike with no volume behind it is a trap; volume with no price movement is noise.
- **Never chase a vertical spike.** If a coin is already up more than 45% from its first print before the filter fires, the entry is skipped. No FOMO entries, ever.
- **Small positions, quick exits.** Every position is 0.10 SOL (1% of the 10 SOL paper bankroll), sized down to 90 bps of the coin's real reserves when the curve is still small. Take profit quickly when momentum fades: bank half at +25%, let the rest ride to +50% or a trailing fade. Cut every loser fast with a hard −10% stop — no hoping, no averaging down.
- **Cash is a position.** When no coin meets the entry filter, the bot holds cash and waits. Sitting out a flat or choppy stretch beats forcing trades into noise.
- **Minutes, not hours.** Positions last minutes on a 6-hour replay — enter the surge, exit the fade, repeat. A 10-minute max hold.
- **Risk caps.** A per-trade loss cap (the hard stop), a maximum position size, and a drawdown cap: if the bankroll falls 10% below its start, the bot stops entering new trades for the rest of the replay. Survival first — the reward bar is net PnL above zero, so not losing is half the game.

## How it works

The bot speaks the harness protocol `agent-fun/replay/v2` over NDJSON: it reads `hello`, then one `batch` per slot, and answers each batch with a `reply` carrying its orders. Entry signals come from the batch's own `TradeEvent`/`CreateEvent` records (marks are only sent for coins the bot holds, so exits read marks + the authoritative account). Orders resolve two slots after the decision; fills are tracked by `client_id` and retried from the fills, never assumed. Every order is deterministic — no randomness, no clock — so the two grading runs produce identical action logs.

## Run it

```sh
node main.ts
```

It reads the harness protocol on stdin and writes replies on stdout.
