const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");
const crypto = require("crypto");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cors({
  origin: [
    "https://campaignx.pages.dev",
    "http://localhost:5173",
    "http://localhost:3000",
    process.env.FRONTEND_URL,
  ].filter(Boolean),
  credentials: true,
}));

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "v1amp@proton.me";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";

// ── DATABASE ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
}).then(() => console.log("✅ MongoDB connected"))
  .catch(e => console.error("❌ DB Error:", e.message));

// ── SCHEMAS ───────────────────────────────────────────────────────────────────
const User = mongoose.model("User", new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, unique: true, lowercase: true, trim: true },
  password: String,
  isAdmin: { type: Boolean, default: false },
  plan: { type: String, default: "trial" }, // trial, pro, agency
  planExpiresAt: Date,
  createdAt: { type: Date, default: Date.now },
}));

const TgAccount = mongoose.model("TgAccount", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  label: { type: String, default: "" },           // friendly name
  phone: { type: String, required: true },
  apiId: { type: String, default: "" },
  apiHash: { type: String, default: "" },
  sessionString: { type: String, default: "" },   // Telethon session
  proxy: { type: String, default: "" },           // host:port:user:pass
  deviceModel: { type: String, default: "" },
  status: { type: String, default: "active", enum: ["active", "cooldown", "banned", "needs_auth"] },
  groupsSent: { type: Number, default: 0 },
  dailySent: { type: Number, default: 0 },
  lastUsedAt: Date,
  cooldownUntil: Date,
  createdAt: { type: Date, default: Date.now },
}));

const TgGroup = mongoose.model("TgGroup", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  groupId: { type: String, default: "" },
  username: { type: String, default: "" },
  title: { type: String, default: "" },
  members: { type: Number, default: 0 },
  niche: { type: String, default: "General" },
  isActive: { type: Boolean, default: true },
  lastPostedAt: Date,
  totalPosts: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
}));

const Campaign = mongoose.model("Campaign", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  name: { type: String, required: true },
  message: { type: String, required: true },     // original message
  variants: { type: [String], default: [] },     // AI-generated variants
  groupIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "TgGroup" }],
  accountIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "TgAccount" }],
  postsPerDay: { type: Number, default: 3 },
  intervalMinutes: { type: Number, default: 15 }, // gap between batches
  batchSize: { type: Number, default: 5 },        // groups per batch
  startAt: Date,
  endAt: Date,
  status: { type: String, default: "draft", enum: ["draft", "active", "paused", "completed"] },
  totalSent: { type: Number, default: 0 },
  totalFailed: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
}));

const CampaignLog = mongoose.model("CampaignLog", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, index: true },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "TgAccount" },
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: "TgGroup" },
  groupTitle: String,
  accountPhone: String,
  message: String,
  status: { type: String, enum: ["sent", "failed", "skipped"] },
  error: { type: String, default: "" },
  sentAt: { type: Date, default: Date.now },
}));

const AutoReply = mongoose.model("AutoReply", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "TgAccount" },
  triggers: [String],   // ["link?", "how join?", "price?"]
  response: String,
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
}));

// ── HELPERS ───────────────────────────────────────────────────────────────────
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "Invalid token" }); }
};

const adminAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user?.isAdmin) return res.status(403).json({ error: "Admin only" });
    req.user = decoded; next();
  } catch { res.status(401).json({ error: "Invalid token" }); }
};

function runPython(script, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const py = spawn("python3", ["-c", script]);
    let out = "", err = "";
    py.stdout.on("data", d => out += d.toString());
    py.stderr.on("data", d => err += d.toString());
    py.on("close", () => {
      try {
        const lines = out.trim().split("\n").reverse();
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line.trim());
            if (parsed && "success" in parsed) return resolve(parsed);
          } catch {}
        }
        resolve({ success: false, error: err || out || "No response" });
      } catch { resolve({ success: false, error: err || "Python error" }); }
    });
    setTimeout(() => { py.kill(); resolve({ success: false, error: "Timeout" }); }, timeoutMs);
  });
}

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────
app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "All fields required" });
    if (await User.findOne({ email: email.toLowerCase() })) return res.status(400).json({ error: "Email already exists" });
    const hash = await bcrypt.hash(password, 12);
    const isAdmin = email.toLowerCase() === ADMIN_EMAIL;
    const user = await User.create({ name: name.trim(), email: email.toLowerCase(), password: hash, isAdmin, plan: isAdmin ? "agency" : "trial" });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, plan: user.plan, isAdmin: user.isAdmin } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !await bcrypt.compare(password, user.password))
      return res.status(400).json({ error: "Invalid email or password" });
    if (email.toLowerCase() === ADMIN_EMAIL && !user.isAdmin)
      await User.findByIdAndUpdate(user._id, { isAdmin: true, plan: "agency" });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, plan: user.plan, isAdmin: user.isAdmin } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TELEGRAM ACCOUNTS ─────────────────────────────────────────────────────────
// Send OTP to phone
app.post("/api/accounts/send-otp", auth, async (req, res) => {
  const { phone, apiId, apiHash, proxy } = req.body;
  if (!phone || !apiId || !apiHash) return res.status(400).json({ error: "phone, apiId, apiHash required" });
  const proxyLine = proxy ? `proxy=("socks5", "${proxy.split(":")[0]}", int("${proxy.split(":")[1] || 1080}"))` : "";
  const script = `
import asyncio, json, sys
from telethon import TelegramClient
from telethon.sessions import StringSession
async def main():
    try:
        client = TelegramClient(StringSession(), int("${apiId}"), "${apiHash}"${proxyLine ? ", " + proxyLine : ""})
        await client.connect()
        result = await client.send_code_request("${phone}")
        session = client.session.save()
        await client.disconnect()
        print(json.dumps({"success": True, "phoneCodeHash": result.phone_code_hash, "session": session}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
asyncio.run(main())
`;
  const result = await runPython(script, 30000);
  res.json(result);
});

// Verify OTP and save account
app.post("/api/accounts/verify-otp", auth, async (req, res) => {
  const { phone, apiId, apiHash, phoneCodeHash, code, session, label, proxy } = req.body;
  const script = `
import asyncio, json
from telethon import TelegramClient
from telethon.sessions import StringSession
async def main():
    try:
        client = TelegramClient(StringSession("${session}"), int("${apiId}"), "${apiHash}")
        await client.connect()
        await client.sign_in("${phone}", "${code}", phone_code_hash="${phoneCodeHash}")
        new_session = client.session.save()
        me = await client.get_me()
        await client.disconnect()
        print(json.dumps({"success": True, "session": new_session, "username": me.username or "", "firstName": me.first_name or ""}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
asyncio.run(main())
`;
  const result = await runPython(script, 30000);
  if (!result.success) return res.status(400).json(result);
  const acc = await TgAccount.create({
    userId: req.user.id,
    phone, apiId, apiHash,
    sessionString: result.session,
    label: label || result.firstName || phone,
    proxy: proxy || "",
    deviceModel: `CampaignX-${Math.random().toString(36).slice(2, 7)}`,
    status: "active",
  });
  res.json({ ...acc.toObject(), sessionString: undefined });
});

app.get("/api/accounts", auth, async (req, res) => {
  try {
    const accounts = await TgAccount.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json(accounts.map(a => ({ ...a.toObject(), sessionString: undefined })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/accounts/:id", auth, async (req, res) => {
  try {
    await TgAccount.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/accounts/:id", auth, async (req, res) => {
  try {
    const { label, proxy, status } = req.body;
    const acc = await TgAccount.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { label, proxy, status },
      { new: true }
    );
    res.json({ ...acc.toObject(), sessionString: undefined });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TELEGRAM GROUPS ───────────────────────────────────────────────────────────
app.get("/api/groups", auth, async (req, res) => {
  try {
    const groups = await TgGroup.find({ userId: req.user.id }).sort({ members: -1 });
    res.json(groups);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/groups", auth, async (req, res) => {
  try {
    const { username, title, members, niche } = req.body;
    if (!username) return res.status(400).json({ error: "username required" });
    const group = await TgGroup.create({
      userId: req.user.id,
      username: username.replace("@", "").replace("https://t.me/", "").trim(),
      title: title || username,
      members: members || 0,
      niche: niche || "General",
    });
    res.json(group);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk import groups
app.post("/api/groups/bulk", auth, async (req, res) => {
  try {
    const { groups } = req.body; // [{ username, title, members, niche }]
    if (!groups?.length) return res.status(400).json({ error: "No groups provided" });
    const existing = (await TgGroup.find({ userId: req.user.id })).map(g => g.username);
    const newGroups = groups
      .map((g: any) => ({ ...g, username: g.username.replace("@", "").replace("https://t.me/", "").trim() }))
      .filter((g: any) => !existing.includes(g.username))
      .map((g: any) => ({ userId: req.user.id, ...g }));
    if (!newGroups.length) return res.json({ added: 0, message: "All groups already exist" });
    await TgGroup.insertMany(newGroups);
    res.json({ added: newGroups.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Scrape group info via Telethon
app.post("/api/groups/scrape", auth, async (req, res) => {
  try {
    const { username, accountId } = req.body;
    const account = await TgAccount.findOne({ _id: accountId, userId: req.user.id });
    if (!account?.sessionString) return res.status(400).json({ error: "Account not found or not authenticated" });
    const script = `
import asyncio, json
from telethon import TelegramClient
from telethon.sessions import StringSession
async def main():
    try:
        client = TelegramClient(StringSession("${account.sessionString}"), int("${account.apiId}"), "${account.apiHash}")
        await client.connect()
        entity = await client.get_entity("${username.replace("@", "")}")
        full = await client(GetFullChannelRequest(entity))
        print(json.dumps({"success": True, "title": entity.title, "username": entity.username or "", "members": getattr(entity, 'participants_count', 0) or full.full_chat.participants_count}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
asyncio.run(main())
`;
    const result = await runPython(script, 20000);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/groups/:id", auth, async (req, res) => {
  try {
    await TgGroup.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI CONTENT REWRITER ───────────────────────────────────────────────────────
app.post("/api/ai/rewrite", auth, async (req, res) => {
  try {
    const { message, count = 5 } = req.body;
    if (!message) return res.status(400).json({ error: "message required" });
    const response = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: "llama3-8b-8192",
      messages: [{
        role: "user",
        content: `Rewrite this Telegram marketing message into ${count} different versions. Keep the same meaning but vary the wording, tone, and structure. Return ONLY a JSON array of strings, no other text.\n\nOriginal: ${message}`,
      }],
      max_tokens: 1000,
      temperature: 0.9,
    }, {
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
    });
    const text = response.data.choices[0].message.content.trim();
    const clean = text.replace(/```json|```/g, "").trim();
    const variants = JSON.parse(clean);
    res.json({ variants });
  } catch (e) {
    console.error("AI error:", e.response?.data || e.message);
    res.status(500).json({ error: "AI rewrite failed" });
  }
});

// ── CAMPAIGNS ─────────────────────────────────────────────────────────────────
app.get("/api/campaigns", auth, async (req, res) => {
  try {
    const campaigns = await Campaign.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json(campaigns);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/campaigns", auth, async (req, res) => {
  try {
    const { name, message, variants, groupIds, accountIds, postsPerDay, intervalMinutes, batchSize, startAt, endAt } = req.body;
    if (!name || !message) return res.status(400).json({ error: "name and message required" });
    const campaign = await Campaign.create({
      userId: req.user.id,
      name, message,
      variants: variants || [],
      groupIds: groupIds || [],
      accountIds: accountIds || [],
      postsPerDay: postsPerDay || 3,
      intervalMinutes: intervalMinutes || 15,
      batchSize: batchSize || 5,
      startAt: startAt ? new Date(startAt) : new Date(),
      endAt: endAt ? new Date(endAt) : null,
    });
    res.json(campaign);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/campaigns/:id", auth, async (req, res) => {
  try {
    const campaign = await Campaign.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      req.body,
      { new: true }
    );
    res.json(campaign);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/campaigns/:id", auth, async (req, res) => {
  try {
    await Campaign.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/campaigns/:id/start", auth, async (req, res) => {
  try {
    await Campaign.findOneAndUpdate({ _id: req.params.id, userId: req.user.id }, { status: "active" });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/campaigns/:id/pause", auth, async (req, res) => {
  try {
    await Campaign.findOneAndUpdate({ _id: req.params.id, userId: req.user.id }, { status: "paused" });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DISTRIBUTION ENGINE ───────────────────────────────────────────────────────
async function sendToGroup(account, group, message) {
  const script = `
import asyncio, json, random, time
from telethon import TelegramClient
from telethon.sessions import StringSession
async def main():
    try:
        client = TelegramClient(StringSession("${account.sessionString}"), int("${account.apiId}"), "${account.apiHash}")
        await client.connect()
        # Human-like: read timeline first
        await client.get_dialogs(limit=3)
        await asyncio.sleep(random.uniform(2, 6))
        entity = await client.get_entity("${group.username}")
        await client.send_message(entity, """${message.replace(/"/g, '\\"').replace(/\n/g, "\\n")}""")
        new_session = client.session.save()
        await client.disconnect()
        print(json.dumps({"success": True, "session": new_session}))
    except Exception as e:
        err = str(e)
        print(json.dumps({"success": False, "error": err}))
asyncio.run(main())
`;
  return runPython(script, 60000);
}

async function runCampaignBatch(campaign) {
  const groups = await TgGroup.find({ _id: { $in: campaign.groupIds }, isActive: true });
  const accounts = await TgAccount.find({ _id: { $in: campaign.accountIds }, status: "active" });

  if (!accounts.length) return console.log(`⚠️ No active accounts for campaign ${campaign.name}`);
  if (!groups.length) return console.log(`⚠️ No active groups for campaign ${campaign.name}`);

  // Get groups not yet posted today
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const postedToday = (await CampaignLog.find({
    campaignId: campaign._id,
    status: "sent",
    sentAt: { $gte: todayStart },
  })).map(l => l.groupId?.toString());

  const pendingGroups = groups.filter(g => !postedToday.includes(g._id.toString()));
  if (!pendingGroups.length) return console.log(`✅ Campaign ${campaign.name} — all groups done today`);

  // Take one batch
  const batch = pendingGroups.slice(0, campaign.batchSize);
  let accIndex = 0;

  for (const group of batch) {
    const account = accounts[accIndex % accounts.length];
    accIndex++;

    // Pick a variant or original
    const allMessages = [campaign.message, ...campaign.variants].filter(Boolean);
    const message = allMessages[Math.floor(Math.random() * allMessages.length)];

    // Random delay between sends (12–95 seconds)
    const delay = Math.floor(Math.random() * 83000) + 12000;
    await new Promise(r => setTimeout(r, delay));

    console.log(`📤 Sending to @${group.username} via ${account.phone}...`);
    const result = await sendToGroup(account, group, message);

    if (result.success) {
      // Update session
      if (result.session) await TgAccount.findByIdAndUpdate(account._id, { sessionString: result.session });
      await TgAccount.findByIdAndUpdate(account._id, { $inc: { groupsSent: 1, dailySent: 1 }, lastUsedAt: new Date() });
      await TgGroup.findByIdAndUpdate(group._id, { $inc: { totalPosts: 1 }, lastPostedAt: new Date() });
      await Campaign.findByIdAndUpdate(campaign._id, { $inc: { totalSent: 1 } });
      await CampaignLog.create({
        userId: campaign.userId,
        campaignId: campaign._id,
        accountId: account._id,
        groupId: group._id,
        groupTitle: group.title,
        accountPhone: account.phone,
        message,
        status: "sent",
      });
      console.log(`✅ Sent to @${group.username}`);
    } else {
      await Campaign.findByIdAndUpdate(campaign._id, { $inc: { totalFailed: 1 } });
      await CampaignLog.create({
        userId: campaign.userId,
        campaignId: campaign._id,
        accountId: account._id,
        groupId: group._id,
        groupTitle: group.title,
        accountPhone: account.phone,
        message,
        status: "failed",
        error: result.error,
      });
      // Flood wait handling
      if (result.error?.includes("FLOOD_WAIT")) {
        const seconds = parseInt(result.error.match(/\d+/)?.[0] || "60");
        const cooldownUntil = new Date(Date.now() + seconds * 1000);
        await TgAccount.findByIdAndUpdate(account._id, { status: "cooldown", cooldownUntil });
        console.log(`⏳ Account ${account.phone} flood wait ${seconds}s`);
      } else if (result.error?.includes("banned") || result.error?.includes("deactivated")) {
        await TgAccount.findByIdAndUpdate(account._id, { status: "banned" });
        console.log(`🚫 Account ${account.phone} banned`);
      }
      console.error(`❌ Failed @${group.username}: ${result.error}`);
    }
  }
}

// ── SCHEDULER ─────────────────────────────────────────────────────────────────
cron.schedule("* * * * *", async () => {
  try {
    const now = new Date();

    // Reset daily sent counts at midnight
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    if (now.getMinutes() === 0 && now.getHours() === 0) {
      await TgAccount.updateMany({}, { dailySent: 0 });
    }

    // Re-activate cooldown accounts
    await TgAccount.updateMany(
      { status: "cooldown", cooldownUntil: { $lte: now } },
      { status: "active", cooldownUntil: null }
    );

    // Run active campaigns
    const campaigns = await Campaign.find({
      status: "active",
      startAt: { $lte: now },
      $or: [{ endAt: null }, { endAt: { $gte: now } }],
    });

    for (const campaign of campaigns) {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const sentToday = await CampaignLog.countDocuments({
        campaignId: campaign._id,
        status: "sent",
        sentAt: { $gte: todayStart },
      });
      const maxPerDay = campaign.postsPerDay * campaign.batchSize;
      if (sentToday >= maxPerDay) continue;

      // Check interval — don't send if last batch was too recent
      const lastLog = await CampaignLog.findOne({ campaignId: campaign._id }).sort({ sentAt: -1 });
      if (lastLog) {
        const msSinceLast = now - lastLog.sentAt;
        if (msSinceLast < campaign.intervalMinutes * 60 * 1000) continue;
      }

      runCampaignBatch(campaign).catch(e => console.error("Campaign error:", e.message));
    }
  } catch (e) { console.error("Scheduler error:", e.message); }
});

// ── LOGS & ANALYTICS ──────────────────────────────────────────────────────────
app.get("/api/logs", auth, async (req, res) => {
  try {
    const { campaignId, limit = 100 } = req.query;
    const filter: any = { userId: req.user.id };
    if (campaignId) filter.campaignId = campaignId;
    const logs = await CampaignLog.find(filter).sort({ sentAt: -1 }).limit(parseInt(limit as string));
    res.json(logs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/stats", auth, async (req, res) => {
  try {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const [totalCampaigns, activeCampaigns, totalGroups, accounts] = await Promise.all([
      Campaign.countDocuments({ userId: req.user.id }),
      Campaign.countDocuments({ userId: req.user.id, status: "active" }),
      TgGroup.countDocuments({ userId: req.user.id }),
      TgAccount.find({ userId: req.user.id }),
    ]);
    const sentToday = await CampaignLog.countDocuments({ userId: req.user.id, status: "sent", sentAt: { $gte: todayStart } });
    const totalSent = await CampaignLog.countDocuments({ userId: req.user.id, status: "sent" });
    const totalFailed = await CampaignLog.countDocuments({ userId: req.user.id, status: "failed" });
    res.json({
      totalCampaigns, activeCampaigns, totalGroups,
      totalAccounts: accounts.length,
      activeAccounts: accounts.filter(a => a.status === "active").length,
      cooldownAccounts: accounts.filter(a => a.status === "cooldown").length,
      bannedAccounts: accounts.filter(a => a.status === "banned").length,
      sentToday, totalSent, totalFailed,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AUTO REPLY ────────────────────────────────────────────────────────────────
app.get("/api/autoreplies", auth, async (req, res) => {
  try { res.json(await AutoReply.find({ userId: req.user.id })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/autoreplies", auth, async (req, res) => {
  try {
    const ar = await AutoReply.create({ userId: req.user.id, ...req.body });
    res.json(ar);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/autoreplies/:id", auth, async (req, res) => {
  try {
    await AutoReply.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "✅ CampaignX API v1.0", uptime: process.uptime() }));
app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 3001, () => console.log(`🚀 CampaignX v1.0 on port ${process.env.PORT || 3001}`));
