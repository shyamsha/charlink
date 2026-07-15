// /**
//  * chartink-removed-stock-webhook.js
//  *
//  * Chartink does NOT send a "stock removed from scan" event natively.
//  * It only POSTs the list of stocks currently matching, on every alert cycle.
//  * This server detects "removed" stocks by diffing each new payload against
//  * the previous one (per scan_name), then fires a Telegram alert for exits.
//  *
//  * SETUP:
//  *   npm install express node-telegram-bot-api dotenv
//  *
//  * .env file:
//  *   PORT=3000
//  *   TELEGRAM_BOT_TOKEN=xxxxx
//  *   TELEGRAM_CHAT_ID=xxxxx
//  *
//  * CHARTINK SETUP:
//  *   Scanner -> Create Alert -> Webhook URL -> https://your-server.com/webhook
//  *   (Chartink pings this URL every time the scan re-evaluates, e.g. every 1-5 min)
//  */

// require("dotenv").config();
// const express = require("express");
// const fs = require("fs");
// const path = require("path");
// const { TelegramBot } = require("node-telegram-bot-api"); // v1.x: TelegramBot is a named export, not default

// const app = express();
// app.use(express.json());
// app.use(express.urlencoded({ extended: true })); // Chartink sometimes posts form-encoded

// const PORT = process.env.PORT || 3000;
// const STATE_FILE = path.join(__dirname, "scan_state.json");

// // Exact scan_name text Chartink sends for the two scans you want to combine.
// // Must match exactly what appears in the "scan_name" field of the webhook payload.
// const SCAN_A_NAME = process.env.SCAN_A_NAME || "";
// const SCAN_B_NAME = process.env.SCAN_B_NAME || "";

// const bot = process.env.TELEGRAM_BOT_TOKEN
//   ? new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false })
//   : null;

// // ---------- State persistence (per scan_name) ----------
// function loadState() {
//   try {
//     return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
//   } catch (e) {
//     return {}; // first run, no file yet
//   }
// }

// function saveState(state) {
//   fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
// }

// // ---------- Alert sender ----------
// async function sendTelegramAlert(message) {
//   if (!bot || !process.env.TELEGRAM_CHAT_ID) {
//     console.log("[Telegram not configured] Would have sent:", message);
//     return;
//   }
//   try {
//     await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, message, {
//       parse_mode: "Markdown",
//     });
//   } catch (err) {
//     console.error("Telegram send failed:", err.message);
//   }
// }

// // ---------- Core diff logic ----------
// function diffStocks(previous, current) {
//   const removed = previous.filter((s) => !current.includes(s));
//   const added = current.filter((s) => !previous.includes(s));
//   return { added, removed };
// }

// // ---------- Cross-scan intersection logic ----------
// // A stock counts as a combined signal only while it matches BOTH configured scans.
// function computeIntersection(state) {
//   if (!SCAN_A_NAME || !SCAN_B_NAME) return null; // feature disabled unless both names are set
//   const listA = state.scans?.[SCAN_A_NAME] || [];
//   const listB = state.scans?.[SCAN_B_NAME] || [];
//   return listA.filter((s) => listB.includes(s));
// }

// // ---------- Webhook endpoint ----------
// app.post("/webhook", async (req, res) => {
//   try {
//     const payload = req.body;

//     if (!payload.stocks || !payload.scan_name) {
//       console.warn("Malformed payload received:", payload);
//       return res.status(400).send("Missing stocks or scan_name");
//     }

//     const scanName = payload.scan_name;
//     const currentStocks = payload.stocks
//       .split(",")
//       .map((s) => s.trim())
//       .filter(Boolean);

//     const state = loadState();
//     if (!state.scans) state.scans = {}; // per-scan stock lists, keyed by scan_name
//     if (!state.intersection) state.intersection = []; // last known A∩B list

//     const previousStocks = state.scans[scanName] || [];
//     const { added, removed } = diffStocks(previousStocks, currentStocks);

//     // Per-scan added/removed alerts (unchanged behavior)
//     if (removed.length > 0) {
//       const msg = `🔴 *Exited: ${scanName}*\n${removed.join(", ")}\n${payload.triggered_at || ""}`;
//       console.log(msg);
//       await sendTelegramAlert(msg);
//     }
//     if (added.length > 0) {
//       const msg = `🟢 *Entered: ${scanName}*\n${added.join(", ")}\n${payload.triggered_at || ""}`;
//       console.log(msg);
//       await sendTelegramAlert(msg);
//     }

//     // Update this scan's stored list
//     state.scans[scanName] = currentStocks;

//     // ---- Cross-scan intersection check (only runs if SCAN_A_NAME + SCAN_B_NAME are set) ----
//     const newIntersection = computeIntersection(state);
//     if (newIntersection !== null) {
//       const prevIntersection = state.intersection;
//       const enteredBoth = newIntersection.filter(
//         (s) => !prevIntersection.includes(s),
//       );
//       const exitedBoth = prevIntersection.filter(
//         (s) => !newIntersection.includes(s),
//       );

//       if (enteredBoth.length > 0) {
//         const msg = `🟢 *ENTER (matched both filters)*\n${enteredBoth.join(", ")}\n${payload.triggered_at || ""}`;
//         console.log(msg);
//         await sendTelegramAlert(msg);
//       }
//       if (exitedBoth.length > 0) {
//         const msg = `🔴 *EXIT (no longer matching both)*\n${exitedBoth.join(", ")}\n${payload.triggered_at || ""}`;
//         console.log(msg);
//         await sendTelegramAlert(msg);
//       }

//       state.intersection = newIntersection;
//     }

//     saveState(state);

//     res.status(200).send("OK");
//   } catch (err) {
//     console.error("Webhook processing error:", err);
//     res.status(500).send("Internal error");
//   }
// });

// // Health check
// app.get("/", (req, res) =>
//   res.send("Chartink removed-stock webhook is running"),
// );

// app.listen(PORT, () => {
//   console.log(`Webhook listening on port ${PORT}`);
// });
/**
 * chartink-removed-stock-webhook.js
 *
 * Single-scan version: tracks ONE Chartink scan (default "Top Gainers").
 * - Stock newly appears in the scan  -> PAPER BUY (simulated, no real broker)
 * - Stock drops out of the scan      -> PAPER SELL, with full cost model applied
 *
 * Chartink does NOT send a "removed" event natively — it only POSTs the list of
 * stocks currently matching, on every alert cycle. Removal is detected by diffing
 * each new payload's stock list against the previous one.
 *
 * SETUP:
 *   npm install express node-telegram-bot-api dotenv
 *
 * .env / Render environment variables:
 *   PORT=3000
 *   TELEGRAM_BOT_TOKEN=xxxxx
 *   TELEGRAM_CHAT_ID=xxxxx
 *   TARGET_SCAN_NAME=Top Gainers        // exact scan_name Chartink sends; other scans are ignored
 *   PAPER_TRADE_QTY=1                    // virtual shares per trade
 *
 *   Optional cost-model overrides (approximate Indian intraday equity charges —
 *   actual rates vary by broker/plan, adjust to match your real broker if needed):
 *   BROKERAGE_FLAT=20            // ₹ flat per executed order (buy or sell leg), whichever is lower vs %
 *   BROKERAGE_PCT=0.0003         // 0.03% of turnover per leg
 *   STT_SELL_PCT=0.00025         // 0.025% on sell turnover (intraday STT is sell-side only)
 *   EXCHANGE_TXN_PCT=0.0000297   // NSE exchange transaction charge, both legs
 *   SEBI_PCT=0.000001            // SEBI turnover fee (₹10/crore), both legs
 *   STAMP_DUTY_BUY_PCT=0.00003   // 0.003% on buy turnover only (intraday)
 *   GST_PCT=0.18                 // 18% GST on (brokerage + exchange txn + SEBI charges)
 *
 * CHARTINK SETUP:
 *   Scanner ("Top Gainers") -> Create Alert -> Webhook URL -> https://your-server.com/webhook
 */

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const { TelegramBot } = require("node-telegram-bot-api"); // v1.x: TelegramBot is a named export, not default

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Chartink sometimes posts form-encoded

const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, "scan_state.json");

// Only this scan drives paper trades — any other scan_name hitting the webhook is ignored.
const TARGET_SCAN_NAME = process.env.TARGET_SCAN_NAME || "Top Gainers";

// Paper trading config — SIMULATION ONLY, no real broker, no real money.
const PAPER_TRADE_QTY = Number(process.env.PAPER_TRADE_QTY) || 1;

// Daily profit target: once today's NET P&L (after charges) hits this, close all
// open paper positions and stop opening new ones until the next trading day.
const PROFIT_TARGET = Number(process.env.PROFIT_TARGET) || 3000;

// ---------- IST date helper (for daily reset of profit target / halt flag) ----------
function getISTDateString() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // 'YYYY-MM-DD'
}

function ensureDailyReset(state) {
  const today = getISTDateString();
  if (state.today !== today) {
    state.today = today;
    state.dailyNetPnl = 0;
    state.tradingHalted = false;
  }
}

// ---------- Cost model (SIMULATION) ----------
// Approximate Indian intraday equity charges. Rates vary by broker/plan — treat as
// directional, not exact; adjust env vars to match your real broker if precision matters.
const BROKERAGE_FLAT = Number(process.env.BROKERAGE_FLAT) || 20;
const BROKERAGE_PCT = Number(process.env.BROKERAGE_PCT) || 0.0003;
const STT_SELL_PCT = Number(process.env.STT_SELL_PCT) || 0.00025;
const EXCHANGE_TXN_PCT = Number(process.env.EXCHANGE_TXN_PCT) || 0.0000297;
const SEBI_PCT = Number(process.env.SEBI_PCT) || 0.000001;
const STAMP_DUTY_BUY_PCT = Number(process.env.STAMP_DUTY_BUY_PCT) || 0.00003;
const GST_PCT = Number(process.env.GST_PCT) || 0.18;

const bot = process.env.TELEGRAM_BOT_TOKEN
  ? new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false })
  : null;

// ---------- State persistence ----------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- Alert sender ----------
async function sendTelegramAlert(message) {
  if (!bot || !process.env.TELEGRAM_CHAT_ID) {
    console.log("[Telegram not configured] Would have sent:", message);
    return;
  }
  try {
    await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, message, {
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.error("Telegram send failed:", err.message);
  }
}

// ---------- Core diff logic ----------
function diffStocks(previous, current) {
  const removed = previous.filter((s) => !current.includes(s));
  const added = current.filter((s) => !previous.includes(s));
  return { added, removed };
}

// ---------- Parse "stocks" + "trigger_prices" into a symbol -> price map ----------
function parsePrices(payload, symbols) {
  const priceMap = {};
  if (!payload.trigger_prices) return priceMap;
  const prices = payload.trigger_prices
    .split(",")
    .map((p) => parseFloat(p.trim()));
  symbols.forEach((sym, i) => {
    if (!isNaN(prices[i])) priceMap[sym] = prices[i];
  });
  return priceMap;
}

// ---------- Cost model ----------
// Returns a full charges breakdown for one round-trip (buy + sell) of qty shares.
function calculateCharges(entryPrice, exitPrice, qty) {
  const buyTurnover = entryPrice * qty;
  const sellTurnover = exitPrice * qty;

  const brokerageBuy = Math.min(BROKERAGE_FLAT, BROKERAGE_PCT * buyTurnover);
  const brokerageSell = Math.min(BROKERAGE_FLAT, BROKERAGE_PCT * sellTurnover);
  const brokerage = brokerageBuy + brokerageSell;

  const stt = STT_SELL_PCT * sellTurnover; // intraday STT: sell side only
  const exchangeTxn = EXCHANGE_TXN_PCT * (buyTurnover + sellTurnover);
  const sebi = SEBI_PCT * (buyTurnover + sellTurnover);
  const stampDuty = STAMP_DUTY_BUY_PCT * buyTurnover; // buy side only
  const gst = GST_PCT * (brokerage + exchangeTxn + sebi);

  const totalCharges = brokerage + stt + exchangeTxn + sebi + stampDuty + gst;

  return {
    brokerage: Number(brokerage.toFixed(2)),
    stt: Number(stt.toFixed(2)),
    exchangeTxn: Number(exchangeTxn.toFixed(2)),
    sebi: Number(sebi.toFixed(2)),
    stampDuty: Number(stampDuty.toFixed(2)),
    gst: Number(gst.toFixed(2)),
    totalCharges: Number(totalCharges.toFixed(2)),
  };
}

// ---------- Paper trading (SIMULATION ONLY — no real broker, no real money) ----------
function openPaperPosition(state, symbol, price, time) {
  if (!state.paperPositions) state.paperPositions = {};
  if (state.paperPositions[symbol]) return null; // already open, don't double-enter
  state.paperPositions[symbol] = {
    entryPrice: price,
    entryTime: time,
    qty: PAPER_TRADE_QTY,
  };
  return state.paperPositions[symbol];
}

function closePaperPosition(state, symbol, exitPrice, time) {
  if (!state.paperPositions || !state.paperPositions[symbol]) return null;
  const pos = state.paperPositions[symbol];

  // Fallback if we never got a price for this symbol on the way out (edge case)
  if (exitPrice === undefined || exitPrice === null || isNaN(exitPrice)) {
    console.warn(
      `[paper trade] No exit price available for ${symbol}, using entry price as fallback`,
    );
    exitPrice = pos.entryPrice;
  }

  const grossPnl = (exitPrice - pos.entryPrice) * pos.qty;
  const charges = calculateCharges(pos.entryPrice, exitPrice, pos.qty);
  const netPnl = grossPnl - charges.totalCharges;
  const netPnlPct = (netPnl / (pos.entryPrice * pos.qty)) * 100;

  if (!state.tradeLog) state.tradeLog = [];
  const trade = {
    symbol,
    entryPrice: pos.entryPrice,
    entryTime: pos.entryTime,
    exitPrice,
    exitTime: time,
    qty: pos.qty,
    grossPnl: Number(grossPnl.toFixed(2)),
    charges,
    netPnl: Number(netPnl.toFixed(2)),
    netPnlPct: Number(netPnlPct.toFixed(2)),
  };
  state.tradeLog.push(trade);
  state.totalNetPnl = Number(((state.totalNetPnl || 0) + netPnl).toFixed(2));
  state.totalGrossPnl = Number(
    ((state.totalGrossPnl || 0) + grossPnl).toFixed(2),
  );
  state.totalCharges = Number(
    ((state.totalCharges || 0) + charges.totalCharges).toFixed(2),
  );
  state.dailyNetPnl = Number(((state.dailyNetPnl || 0) + netPnl).toFixed(2));

  delete state.paperPositions[symbol];
  return trade;
}

// ---------- Webhook endpoint ----------
app.post("/webhook", async (req, res) => {
  try {
    const payload = req.body;

    if (!payload.stocks || !payload.scan_name) {
      console.warn("Malformed payload received:", payload);
      return res.status(400).send("Missing stocks or scan_name");
    }

    const scanName = payload.scan_name;
    console.log(`[webhook] scan_name="${scanName}" stocks=${payload.stocks}`);

    // Ignore any scan other than the one configured (e.g. "accurate" no longer used)
    if (scanName !== TARGET_SCAN_NAME) {
      console.log(
        `[webhook] Ignoring scan "${scanName}" — not the configured TARGET_SCAN_NAME ("${TARGET_SCAN_NAME}")`,
      );
      return res.status(200).send("Ignored — not target scan");
    }

    const currentStocks = payload.stocks
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const state = loadState();
    if (!state.stocks) state.stocks = []; // last known list for the target scan
    if (!state.lastPrice) state.lastPrice = {};
    ensureDailyReset(state); // resets dailyNetPnl / tradingHalted at the start of each new IST trading day

    const priceMap = parsePrices(payload, currentStocks);
    Object.assign(state.lastPrice, priceMap);

    const { added, removed } = diffStocks(state.stocks, currentStocks);

    // Newly appeared -> paper buy (skipped once today's profit target has been hit)
    for (const symbol of added) {
      if (state.tradingHalted) {
        console.log(
          `[halted] Skipping buy for ${symbol} — daily profit target already hit`,
        );
        continue;
      }
      const price = state.lastPrice[symbol];
      openPaperPosition(state, symbol, price, payload.triggered_at);
      const msg = `🟢 *PAPER BUY*\n${symbol} @ ${price ?? "N/A"} x${PAPER_TRADE_QTY}\n${payload.triggered_at || ""}`;
      console.log(msg);
      await sendTelegramAlert(msg);
    }

    // Dropped out -> paper sell, with full cost breakdown
    for (const symbol of removed) {
      const price = state.lastPrice[symbol]; // last known price before it dropped
      const trade = closePaperPosition(
        state,
        symbol,
        price,
        payload.triggered_at,
      );
      if (trade) {
        const emoji = trade.netPnl >= 0 ? "🟢" : "🔴";
        const msg =
          `${emoji} *PAPER SELL*\n${symbol}: entry ₹${trade.entryPrice} → exit ₹${trade.exitPrice} x${trade.qty}\n` +
          `Gross P&L: ₹${trade.grossPnl}\n` +
          `Charges: ₹${trade.charges.totalCharges} (brokerage ₹${trade.charges.brokerage}, STT ₹${trade.charges.stt}, exch ₹${trade.charges.exchangeTxn}, SEBI ₹${trade.charges.sebi}, stamp ₹${trade.charges.stampDuty}, GST ₹${trade.charges.gst})\n` +
          `*Net P&L: ₹${trade.netPnl} (${trade.netPnlPct}%)*\n` +
          `Today's Net P&L: ₹${state.dailyNetPnl} | All-time: ₹${state.totalNetPnl}\n` +
          `${payload.triggered_at || ""}`;
        console.log(msg);
        await sendTelegramAlert(msg);
      }
    }

    // ---- Daily profit target check: force-close everything and halt for the day ----
    if (!state.tradingHalted && state.dailyNetPnl >= PROFIT_TARGET) {
      const openSymbols = Object.keys(state.paperPositions || {});
      for (const symbol of openSymbols) {
        const price = state.lastPrice[symbol];
        const trade = closePaperPosition(
          state,
          symbol,
          price,
          payload.triggered_at,
        );
        if (trade) {
          const msg =
            `🎯 *Target-hit auto exit*\n${symbol}: entry ₹${trade.entryPrice} → exit ₹${trade.exitPrice} x${trade.qty}\n` +
            `Net P&L: ₹${trade.netPnl}`;
          console.log(msg);
          await sendTelegramAlert(msg);
        }
      }
      state.tradingHalted = true;
      const summaryMsg =
        `🎯 *Daily profit target ₹${PROFIT_TARGET} reached!*\n` +
        `All open positions closed. No new trades until tomorrow.\n` +
        `*Today's Net P&L: ₹${state.dailyNetPnl}*`;
      console.log(summaryMsg);
      await sendTelegramAlert(summaryMsg);
    }

    state.stocks = currentStocks;
    saveState(state);

    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook processing error:", err);
    res.status(500).send("Internal error");
  }
});

// Health check
app.get("/", (req, res) => res.send("Chartink webhook is running"));

// Paper trading dashboard (JSON) — open positions, closed trades, running P&L (gross, charges, net)
app.get("/trades", (req, res) => {
  const state = loadState();
  res.json({
    targetScan: TARGET_SCAN_NAME,
    profitTarget: PROFIT_TARGET,
    today: state.today || null,
    dailyNetPnl: state.dailyNetPnl || 0,
    tradingHalted: state.tradingHalted || false,
    openPositions: state.paperPositions || {},
    closedTrades: state.tradeLog || [],
    totalGrossPnl: state.totalGrossPnl || 0,
    totalCharges: state.totalCharges || 0,
    totalNetPnl: state.totalNetPnl || 0,
  });
});

// Debug: see exactly what's stored for the target scan
app.get("/state", (req, res) => {
  const state = loadState();
  res.json({
    targetScan: TARGET_SCAN_NAME,
    currentStocks: state.stocks || [],
    lastPrice: state.lastPrice || {},
  });
});

app.listen(PORT, () => {
  console.log(`Webhook listening on port ${PORT}`);
});
