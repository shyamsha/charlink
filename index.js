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

// Daily stop-loss: once today's NET P&L (after charges) drops to this much in the
// red, close all open paper positions and stop opening new ones for the day.
const DAILY_STOP_LOSS_RS = Number(process.env.DAILY_STOP_LOSS_RS) || 2000;

// Per-trade take-profit: exit the moment price rises this many rupees above entry,
// regardless of whether the stock is still in the scan.
const TAKE_PROFIT_RS = Number(process.env.TAKE_PROFIT_RS) || 3;

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

function closePaperPosition(state, symbol, exitPrice, time, exitReason) {
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
    exitReason: exitReason || "unspecified",
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

    // ---- Take-profit check: any OPEN position with a fresh price this cycle that has
    // gained >= TAKE_PROFIT_RS above entry gets exited immediately, scan status aside ----
    for (const symbol of Object.keys(state.paperPositions || {})) {
      const currentPrice = priceMap[symbol]; // only symbols present in THIS payload have a fresh price
      if (currentPrice === undefined) continue;
      const pos = state.paperPositions[symbol];
      if (currentPrice - pos.entryPrice >= TAKE_PROFIT_RS) {
        const trade = closePaperPosition(
          state,
          symbol,
          currentPrice,
          payload.triggered_at,
          "take_profit",
        );
        if (trade) {
          const msg =
            `🎯 *TAKE-PROFIT EXIT (+₹${TAKE_PROFIT_RS} hit)*\n${symbol}: entry ₹${trade.entryPrice} → exit ₹${trade.exitPrice} x${trade.qty}\n` +
            `Net P&L: ₹${trade.netPnl} (${trade.netPnlPct}%)\n` +
            `Today's Net P&L: ₹${state.dailyNetPnl} | All-time: ₹${state.totalNetPnl}`;
          console.log(msg);
          await sendTelegramAlert(msg);
        }
      }
    }

    // ---- Dropped out of scan -> exit ONLY if still above entry price; otherwise hold ----
    for (const symbol of removed) {
      const pos = state.paperPositions && state.paperPositions[symbol];
      if (!pos) continue; // already closed via take-profit above, nothing left to do

      const lastKnownPrice = state.lastPrice[symbol]; // last price seen before it disappeared from the scan
      if (lastKnownPrice !== undefined && lastKnownPrice > pos.entryPrice) {
        const trade = closePaperPosition(
          state,
          symbol,
          lastKnownPrice,
          payload.triggered_at,
          "scan_removal_in_profit",
        );
        if (trade) {
          const msg =
            `🟢 *EXIT — removed from scan (still in profit)*\n${symbol}: entry ₹${trade.entryPrice} → exit ₹${trade.exitPrice} x${trade.qty}\n` +
            `Gross P&L: ₹${trade.grossPnl}\n` +
            `Charges: ₹${trade.charges.totalCharges} (brokerage ₹${trade.charges.brokerage}, STT ₹${trade.charges.stt}, exch ₹${trade.charges.exchangeTxn}, SEBI ₹${trade.charges.sebi}, stamp ₹${trade.charges.stampDuty}, GST ₹${trade.charges.gst})\n` +
            `*Net P&L: ₹${trade.netPnl} (${trade.netPnlPct}%)*\n` +
            `Today's Net P&L: ₹${state.dailyNetPnl} | All-time: ₹${state.totalNetPnl}\n` +
            `${payload.triggered_at || ""}`;
          console.log(msg);
          await sendTelegramAlert(msg);
        }
      } else {
        const msg = `⚠️ *HOLD*\n${symbol} left the scan but price ₹${lastKnownPrice ?? "N/A"} is not above entry ₹${pos.entryPrice} — keeping position open (no stop-loss set).`;
        console.log(msg);
        await sendTelegramAlert(msg);
      }
    }

    // ---- Daily limit check: force-close everything and halt for the day, in either direction ----
    let dailyLimitHit = null;
    if (!state.tradingHalted && state.dailyNetPnl >= PROFIT_TARGET) {
      dailyLimitHit = "profit_target";
    } else if (
      !state.tradingHalted &&
      state.dailyNetPnl <= -DAILY_STOP_LOSS_RS
    ) {
      dailyLimitHit = "stop_loss";
    }

    if (dailyLimitHit) {
      const openSymbols = Object.keys(state.paperPositions || {});
      for (const symbol of openSymbols) {
        const price = state.lastPrice[symbol];
        const reason =
          dailyLimitHit === "profit_target"
            ? "daily_target_hit"
            : "daily_stop_loss_hit";
        const trade = closePaperPosition(
          state,
          symbol,
          price,
          payload.triggered_at,
          reason,
        );
        if (trade) {
          const emoji = dailyLimitHit === "profit_target" ? "🎯" : "🛑";
          const msg =
            `${emoji} *${dailyLimitHit === "profit_target" ? "Target-hit" : "Stop-loss-hit"} auto exit*\n${symbol}: entry ₹${trade.entryPrice} → exit ₹${trade.exitPrice} x${trade.qty}\n` +
            `Net P&L: ₹${trade.netPnl}`;
          console.log(msg);
          await sendTelegramAlert(msg);
        }
      }
      state.tradingHalted = true;

      const summaryMsg =
        dailyLimitHit === "profit_target"
          ? `🎯 *Daily profit target ₹${PROFIT_TARGET} reached!*\n` +
            `All open positions closed. No new trades until tomorrow.\n` +
            `*Today's Net P&L: ₹${state.dailyNetPnl}*`
          : `🛑 *Daily stop-loss ₹${DAILY_STOP_LOSS_RS} hit!*\n` +
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
    dailyStopLoss: DAILY_STOP_LOSS_RS,
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
