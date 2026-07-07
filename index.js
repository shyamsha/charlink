/**
 * chartink-removed-stock-webhook.js
 *
 * Chartink does NOT send a "stock removed from scan" event natively.
 * It only POSTs the list of stocks currently matching, on every alert cycle.
 * This server detects "removed" stocks by diffing each new payload against
 * the previous one (per scan_name), then fires a Telegram alert for exits.
 *
 * SETUP:
 *   npm install express node-telegram-bot-api dotenv
 *
 * .env file:
 *   PORT=3000
 *   TELEGRAM_BOT_TOKEN=xxxxx
 *   TELEGRAM_CHAT_ID=xxxxx
 *
 * CHARTINK SETUP:
 *   Scanner -> Create Alert -> Webhook URL -> https://your-server.com/webhook
 *   (Chartink pings this URL every time the scan re-evaluates, e.g. every 1-5 min)
 */

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const { TelegramBot } = require("node-telegram-bot-api");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Chartink sometimes posts form-encoded

const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, "scan_state.json");

const bot = process.env.TELEGRAM_BOT_TOKEN
  ? new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false })
  : null;

// ---------- State persistence (per scan_name) ----------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    return {}; // first run, no file yet
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

// ---------- Webhook endpoint ----------
app.post("/webhook", async (req, res) => {
  try {
    const payload = req.body;

    if (!payload.stocks || !payload.scan_name) {
      console.warn("Malformed payload received:", payload);
      return res.status(400).send("Missing stocks or scan_name");
    }

    const scanName = payload.scan_name;
    const currentStocks = payload.stocks
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const state = loadState();
    const previousStocks = state[scanName] || [];

    const { added, removed } = diffStocks(previousStocks, currentStocks);

    if (removed.length > 0) {
      const msg = `🔴 *Exited: ${scanName}*\n${removed.join(", ")}\n${payload.triggered_at || ""}`;
      console.log(msg);
      await sendTelegramAlert(msg);
    }

    if (added.length > 0) {
      const msg = `🟢 *Entered: ${scanName}*\n${added.join(", ")}\n${payload.triggered_at || ""}`;
      console.log(msg);
      await sendTelegramAlert(msg);
    }

    // Update stored state for next comparison
    state[scanName] = currentStocks;
    saveState(state);

    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook processing error:", err);
    res.status(500).send("Internal error");
  }
});

// Health check
app.get("/", (req, res) =>
  res.send("Chartink removed-stock webhook is running"),
);

app.listen(PORT, () => {
  console.log(`Webhook listening on port ${PORT}`);
});
