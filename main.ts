// Pump.fun Paper Sprint — momentum with discipline.
//
// A filtered trend-following paper-trading bot for the agent-fun/replay/v2
// harness (NDJSON: hello, batch..., done on stdin; one reply per batch on
// stdout). No dependencies, no network, no randomness: the same replies
// always follow from the same input, so the two grading runs agree.
//
// Strategy, in brief:
//   - Only trade genuine early surges: price rising TOGETHER with rising buy
//     volume in a coin's first minutes after launch. One signal alone is a
//     trap; both together is a surge.
//   - Never chase a vertical spike: if the coin already ran hard before the
//     filter fires, the entry is skipped. No FOMO entries, ever.
//   - Small positions, quick exits: a small fixed slice of the bankroll per
//     trade. Bank half the gain early (scale out at +25%), let the rest ride
//     to +50% or a trailing fade. Cut every loser fast with a hard -10% stop.
//   - Cash is a position: when no coin meets the filter, hold cash and wait.
//   - Minutes, not hours: positions last minutes; a 10-minute max hold.
//   - Risk caps: a per-trade loss cap (the hard stop), a maximum position
//     size, and a drawdown cap that halts new entries for the rest of the
//     replay if the bankroll falls 10% below its start.
//
// Harness facts this implements against (kit protocol.schema.json +
// competition.yaml, harness agent-fun/replay/v2):
//   - One batch per slot that carries universe records. An order decided on
//     the batch for slot s resolves at s + latency_slots, against that mint's
//     last recorded trade in the resolution slot (or the latest earlier
//     reserves). Fills are reported in the first batch after resolution.
//   - Marks are only sent for mints the bot holds or has a pending order on,
//     so entry signals come from the batch's own TradeEvent/CreateEvent
//     records; marks + the account's positions drive exits.
//   - Buys are exact-in (quote_lamports = SOL spent, curve fees included);
//     sells sell an exact token_amount. Every sent order pays base +
//     priority tx fees; a small seeded share of orders fails (tx fees paid,
//     nothing traded), so every order is tracked by client_id and retried
//     from the fills, never assumed filled.
//   - A buy may not exceed max_order_bps_of_real_reserve of the decision-time
//     real quote reserves (100 bps here), and the guardrail needs a round
//     trip of at least 0.01 SOL on at least 20 distinct mints, so entries
//     size to 90 bps of real reserves, capped at 0.10 SOL, and are skipped
//     while the coin is too small to take a qualifying position.
//   - A CompleteEvent, and the end of data, closes open positions at the
//     last trade's post-trade reserves; the bot never needs to flatten.
//   - stdout is the protocol channel: nothing but replies is ever written
//     there. Diagnostics, if any, go to stderr.

type BuyOrder = {
  side: "buy";
  client_id: string;
  mint: string;
  quote_lamports: string;
  max_slippage_bps: number;
};

type SellOrder = {
  side: "sell";
  client_id: string;
  mint: string;
  token_amount: string;
  max_slippage_bps: number;
};

type Order = BuyOrder | SellOrder;

// ---- Tunable thresholds (tune ONLY these; never the strategy's shape) ----
const ENTRY_MAX_AGE_S = 180; // enter only in a coin's first 3 minutes
const ENTRY_MIN_GAIN = 1.08; // price up at least 8% from its first print
const ENTRY_MAX_GAIN = 1.45; // already up >45%? Never chase the vertical
const ENTRY_MIN_BUY_VOL_LAMPORTS = 1_000_000_000n; // >= 1 SOL of buys, last 60s
const ENTRY_MIN_BUYS_60S = 5; // at least 5 buy trades, last 60s
const ENTRY_MIN_REAL_SOL_LAMPORTS = 2_000_000_000n; // >= 2 SOL real reserves
const TARGET_POSITION_LAMPORTS = 100_000_000n; // 0.10 SOL per trade
const MIN_BUY_LAMPORTS = 12_000_000n; // 0.012 SOL (guardrail needs >= 0.01)
const TAKE_PROFIT_1 = 1.25; // bank half at +25%
const TAKE_PROFIT_2 = 1.5; // exit the rest at +50%
const STOP_LOSS = 0.9; // hard stop: sell all at -10%
const TRAILING_DROP = 0.88; // after a +25% peak, sell if price fades 12% off peak
const MAX_HOLD_S = 600; // 10 minutes, then out whatever the price
const DRAWDOWN_HALT = 0.9; // halt new entries below 90% of starting capital
const MAX_SLIPPAGE_BPS = 500; // 5%: pump.fun moves fast in 2 slots
const VOL_WINDOW_S = 60; // buy-volume window for the entry filter
const TX_FEE_LAMPORTS = 105_000n; // base 5,000 + priority 100,000 per order

// ---- Per-mint market state, built from the batch events ----
interface MintState {
  firstTs: number;
  firstPrice: number;
  lastPrice: number;
  lastTs: number;
  realSol: bigint;
  buys: { ts: number; sol: bigint }[];
  complete: boolean;
}

// ---- Per-position state, derived from the authoritative account ----
interface PositionState {
  entryPrice: number; // SOL per token, from cost / tokens
  peak: number;
  tp1Done: boolean;
  enteredTs: number;
}

interface PendingOrder {
  mint: string;
  kind: "buy" | "tp1" | "sell";
}

const mints = new Map<string, MintState>();
const positions = new Map<string, PositionState>();
const traded = new Set<string>(); // one shot per mint: never re-enter after exit
const pending = new Map<string, PendingOrder>(); // client_id -> order

let nowTs = 0;
let initialCapital = 10_000_000_000n;
let maxOpenPositions = 5;
let maxOrdersPerBatch = 16;
let maxOrderBps = 100;
let cash = 0n;
let halted = false;
let orderCounter = 0;

function priceOf(virtualSol: string, virtualTokens: string): number {
  const vt = Number(virtualTokens);
  if (vt <= 0) return 0;
  return Number(virtualSol) / vt;
}

function nextClientId(): string {
  orderCounter += 1;
  return "o" + orderCounter.toString(36);
}

function buyVolume(m: MintState, fromTs: number, toTs: number): { sol: bigint; n: number } {
  let sol = 0n;
  let n = 0;
  for (const b of m.buys) {
    if (b.ts >= fromTs && b.ts <= toTs) {
      sol += b.sol;
      n += 1;
    }
  }
  return { sol, n };
}

function pruneBuys(m: MintState): void {
  const cutoff = nowTs - VOL_WINDOW_S - 30;
  while (m.buys.length > 0 && m.buys[0]!.ts < cutoff) m.buys.shift();
}

function handleHello(msg: any): void {
  if (msg.capital && typeof msg.capital.lamports === "string") {
    initialCapital = BigInt(msg.capital.lamports);
  }
  if (msg.caps) {
    if (typeof msg.caps.max_open_positions === "number") maxOpenPositions = msg.caps.max_open_positions;
    if (typeof msg.caps.max_orders_per_batch === "number") maxOrdersPerBatch = msg.caps.max_orders_per_batch;
    if (typeof msg.caps.max_order_bps_of_real_reserve === "number") maxOrderBps = msg.caps.max_order_bps_of_real_reserve;
  }
  cash = initialCapital;
}

function handleBatch(msg: any): Order[] {
  const orders: Order[] = [];

  // ---- 1. Fold the batch's events into per-mint state. ----
  const events: any[] = Array.isArray(msg.events) ? msg.events : [];
  const activeMints = new Set<string>();
  for (const e of events) {
    if (!e || typeof e.mint !== "string") continue;
    const tsRaw = e.timestamp !== undefined ? Number(e.timestamp) : e.block_time;
    const ts = Number.isFinite(tsRaw) ? tsRaw : nowTs;
    if (ts > nowTs) nowTs = ts;
    const mint: string = e.mint;
    if (e.event === "CreateEvent") {
      if (!mints.has(mint)) {
        const p = priceOf(e.virtual_sol_reserves, e.virtual_token_reserves);
        mints.set(mint, {
          firstTs: ts,
          firstPrice: p,
          lastPrice: p,
          lastTs: ts,
          realSol: 0n,
          buys: [],
          complete: false,
        });
      }
      activeMints.add(mint);
    } else if (e.event === "TradeEvent") {
      let m = mints.get(mint);
      const p = priceOf(e.virtual_sol_reserves, e.virtual_token_reserves);
      if (!m) {
        m = {
          firstTs: ts,
          firstPrice: p,
          lastPrice: p,
          lastTs: ts,
          realSol: 0n,
          buys: [],
          complete: false,
        };
        mints.set(mint, m);
      }
      m.lastPrice = p;
      m.lastTs = ts;
      if (typeof e.real_sol_reserves === "string") m.realSol = BigInt(e.real_sol_reserves);
      if (e.is_buy === true) {
        m.buys.push({ ts, sol: BigInt(e.sol_amount) });
        pruneBuys(m);
      }
      activeMints.add(mint);
    } else if (e.event === "CompleteEvent") {
      const m = mints.get(mint);
      if (m) m.complete = true;
      activeMints.add(mint);
    }
  }

  // ---- 2. Settle fills: clear pending orders, record filled scale-outs. ----
  const fills: any[] = Array.isArray(msg.fills) ? msg.fills : [];
  for (const f of fills) {
    if (!f || typeof f.client_id !== "string") continue;
    const p = pending.get(f.client_id);
    if (!p) continue;
    pending.delete(f.client_id);
    if (f.status === "filled" && p.kind === "tp1") {
      const pos = positions.get(p.mint);
      if (pos) pos.tp1Done = true;
    }
  }

  // ---- 3. Authoritative account: cash + positions; sync position state. ----
  const account = msg.account || {};
  if (typeof account.cash_lamports === "string") cash = BigInt(account.cash_lamports);
  const marks = new Map<string, number>();
  const markList: any[] = Array.isArray(msg.marks) ? msg.marks : [];
  for (const mk of markList) {
    if (mk && typeof mk.mint === "string") {
      marks.set(mk.mint, priceOf(mk.virtual_quote_reserves, mk.virtual_token_reserves));
    }
  }
  const livePositions: any[] = Array.isArray(account.positions) ? account.positions : [];
  const liveSet = new Set<string>();
  for (const pos of livePositions) {
    if (!pos || typeof pos.mint !== "string") continue;
    const mint: string = pos.mint;
    liveSet.add(mint);
    const tokens = BigInt(pos.token_amount);
    const cost = BigInt(pos.cost_lamports);
    const entryPrice = tokens > 0n ? Number(cost) / Number(tokens) : 0;
    const cur = marks.get(mint) ?? mints.get(mint)?.lastPrice ?? entryPrice;
    let st = positions.get(mint);
    if (!st) {
      st = { entryPrice, peak: cur, tp1Done: false, enteredTs: nowTs };
      positions.set(mint, st);
    } else {
      if (cur > st.peak) st.peak = cur;
      if (st.entryPrice === 0) st.entryPrice = entryPrice;
    }
  }
  // Positions that vanished (sold, completed, flattened) leave tracking.
  for (const mint of [...positions.keys()]) {
    if (!liveSet.has(mint)) {
      positions.delete(mint);
      traded.add(mint);
    }
  }

  // ---- 4. Drawdown cap: equity below 90% of start halts new entries. ----
  let equity = cash;
  for (const pos of livePositions) {
    const mint: string = pos.mint;
    const cur = marks.get(mint) ?? mints.get(mint)?.lastPrice ?? 0;
    equity += BigInt(Math.floor(Number(BigInt(pos.token_amount)) * cur));
  }
  if (!halted && equity < (initialCapital * BigInt(Math.floor(DRAWDOWN_HALT * 1000))) / 1000n) {
    halted = true;
  }

  // ---- 5. Exits first: stops, scale-outs, trailing fades, max hold. ----
  const openCount = livePositions.length;
  void openCount;
  for (const pos of livePositions) {
    if (orders.length >= maxOrdersPerBatch) break;
    const mint: string = pos.mint;
    const st = positions.get(mint);
    if (!st || st.entryPrice <= 0) continue;
    if (pendingHasMint(mint, "sell") || pendingHasMint(mint, "tp1")) continue;
    const tokens = BigInt(pos.token_amount);
    if (tokens <= 0n) continue;
    const cur = marks.get(mint) ?? mints.get(mint)?.lastPrice ?? st.entryPrice;
    const entry = st.entryPrice;
    let sellTokens: bigint | null = null;
    if (cur <= entry * STOP_LOSS) {
      sellTokens = tokens; // hard stop: cut the loser fast
    } else if (!st.tp1Done && cur >= entry * TAKE_PROFIT_1) {
      sellTokens = tokens / 2n; // scale out: bank half the gain early
      if (sellTokens <= 0n) sellTokens = null;
    } else if (st.tp1Done && cur >= entry * TAKE_PROFIT_2) {
      sellTokens = tokens; // let the rest ride only while the trend holds
    } else if (st.peak >= entry * TAKE_PROFIT_1 && cur <= st.peak * TRAILING_DROP) {
      sellTokens = tokens; // momentum faded off its peak: out
    } else if (nowTs - st.enteredTs >= MAX_HOLD_S) {
      sellTokens = tokens; // minutes, not hours: max hold reached
    }
    if (sellTokens !== null && sellTokens > 0n) {
      const id = nextClientId();
      const isPartial = sellTokens < tokens;
      pending.set(id, { mint, kind: isPartial ? "tp1" : "sell" });
      orders.push({
        side: "sell",
        client_id: id,
        mint,
        token_amount: sellTokens.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }
  }

  // ---- 6. Entries: genuine early surges only, one shot per mint. ----
  if (!halted && positions.size < maxOpenPositions && orders.length < maxOrdersPerBatch) {
    const candidates: { mint: string; vol: bigint }[] = [];
    for (const mint of activeMints) {
      const m = mints.get(mint);
      if (!m || m.complete) continue;
      if (positions.has(mint) || traded.has(mint)) continue;
      if (pendingHasMint(mint, "buy")) continue;
      const age = nowTs - m.firstTs;
      if (age < 0 || age > ENTRY_MAX_AGE_S) continue;
      if (m.firstPrice <= 0 || m.lastPrice <= 0) continue;
      const gain = m.lastPrice / m.firstPrice;
      if (gain < ENTRY_MIN_GAIN || gain > ENTRY_MAX_GAIN) continue;
      if (m.realSol < ENTRY_MIN_REAL_SOL_LAMPORTS) continue;
      const v60 = buyVolume(m, nowTs - VOL_WINDOW_S, nowTs);
      if (v60.sol < ENTRY_MIN_BUY_VOL_LAMPORTS || v60.n < ENTRY_MIN_BUYS_60S) continue;
      // Volume must be RISING, not just present: the last 30s beat the prior 30s.
      const recent = buyVolume(m, nowTs - 30, nowTs);
      const prior = buyVolume(m, nowTs - VOL_WINDOW_S, nowTs - 30);
      if (recent.sol <= prior.sol) continue;
      candidates.push({ mint, vol: v60.sol });
    }
    // Strongest surge first; mint breaks ties so the order is deterministic.
    candidates.sort((a, b) => {
      if (a.vol !== b.vol) return a.vol > b.vol ? -1 : 1;
      return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
    });
    for (const c of candidates) {
      if (orders.length >= maxOrdersPerBatch) break;
      if (positions.size + orders.filter((o) => o.side === "buy").length >= maxOpenPositions) break;
      const m = mints.get(c.mint)!;
      // Size cap: 100 bps of real reserves per reply; take 90 bps, capped.
      const capByReserve = (m.realSol * BigInt(maxOrderBps - 10)) / 10000n;
      let size = TARGET_POSITION_LAMPORTS < capByReserve ? TARGET_POSITION_LAMPORTS : capByReserve;
      if (size < MIN_BUY_LAMPORTS) continue;
      if (size + TX_FEE_LAMPORTS > cash) continue;
      const id = nextClientId();
      pending.set(id, { mint: c.mint, kind: "buy" });
      orders.push({
        side: "buy",
        client_id: id,
        mint: c.mint,
        quote_lamports: size.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      cash -= size + TX_FEE_LAMPORTS; // reserve cash for this reply's buys
      traded.add(c.mint);
    }
  }

  return orders;
}

function pendingHasMint(mint: string, kind: "buy" | "tp1" | "sell"): boolean {
  for (const p of pending.values()) {
    if (p.mint === mint && p.kind === kind) return true;
  }
  return false;
}

// ---- NDJSON loop: one reply per batch, nothing else on stdout. ----
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let idx: number;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim() === "") continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "hello") {
      handleHello(msg);
    } else if (msg.type === "batch") {
      const orders = handleBatch(msg);
      process.stdout.write(JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n");
    } else if (msg.type === "done") {
      process.exit(0);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
