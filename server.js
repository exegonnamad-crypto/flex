const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");
const crypto = require("crypto");
const { spawn } = require("child_process");
require("dotenv").config();

const app = express();
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));

// FIX: Raw body for NOWPayments webhook BEFORE express.json
app.use((req, res, next) => {
  if (req.path === "/api/payments/webhook") {
    express.raw({ type: "*/*" })(req, res, next);
  } else {
    express.json({ limit: "10mb" })(req, res, next);
  }
});

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "v1amp@proton.me";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY || "";
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || "";
const DEFAULT_API_ID = process.env.DEFAULT_API_ID || "2040";
const DEFAULT_API_HASH = process.env.DEFAULT_API_HASH || "b18441a1ff607e10a989891a5462e627";
const BACKEND_URL = process.env.BACKEND_URL || "https://flex-production-da21.up.railway.app";

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
  plan: { type: String, default: "trial" },
  planExpiresAt: Date,
  credits: { type: Number, default: 0 },
  totalSpent: { type: Number, default: 0 },
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  referralEarnings: { type: Number, default: 0 },
  features: {
    spintax: { type: Boolean, default: true },
    mediaMessages: { type: Boolean, default: true },
    warmupMode: { type: Boolean, default: true },
    smartRotation: { type: Boolean, default: true },
    autoBlacklist: { type: Boolean, default: true },
    abTesting: { type: Boolean, default: true },
    webhookNotifications: { type: Boolean, default: false },
    whiteLabel: { type: Boolean, default: false },
    teamMembers: { type: Boolean, default: false },
  },
  whiteLabelName: { type: String, default: "" },
  whiteLabelLogo: { type: String, default: "" },
  webhookUrl: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
}));

const TeamMember = mongoose.model("TeamMember", new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  email: String,
  role: { type: String, enum: ["viewer", "editor", "manager"], default: "editor" },
  permissions: {
    canManageAccounts: { type: Boolean, default: false },
    canManageGroups: { type: Boolean, default: true },
    canManageCampaigns: { type: Boolean, default: true },
    canViewLogs: { type: Boolean, default: true },
    canViewStats: { type: Boolean, default: true },
  },
  status: { type: String, enum: ["pending", "active"], default: "pending" },
  inviteToken: String,
  createdAt: { type: Date, default: Date.now },
}));

const TgAccount = mongoose.model("TgAccount", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  label: { type: String, default: "" },
  phone: { type: String, default: "" },
  apiId: { type: String, default: "" },
  apiHash: { type: String, default: "" },
  sessionString: { type: String, default: "" },
  proxy: { type: String, default: "" },
  deviceModel: { type: String, default: "" },
  status: { type: String, default: "active", enum: ["active", "cooldown", "banned", "needs_auth", "warming"] },
  groupsSent: { type: Number, default: 0 },
  dailySent: { type: Number, default: 0 },
  floodWaitCount: { type: Number, default: 0 },
  lastUsedAt: Date,
  cooldownUntil: Date,
  warmupEnabled: { type: Boolean, default: false },
  warmupDay: { type: Number, default: 0 },
  warmupTarget: { type: Number, default: 14 },
  warmupStartedAt: Date,
  createdAt: { type: Date, default: Date.now },
}));

const TgGroup = mongoose.model("TgGroup", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  groupId: { type: String, default: "" },
  username: { type: String, default: "" },
  title: { type: String, default: "" },
  members: { type: Number, default: 0 },
  niche: { type: String, default: "General" },
  language: { type: String, default: "" },
  isActive: { type: Boolean, default: true },
  isBlacklisted: { type: Boolean, default: false },
  blacklistReason: { type: String, default: "" },
  lastPostedAt: Date,
  lastCheckedAt: Date,
  totalPosts: { type: Number, default: 0 },
  errorCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
}));

const MessageTemplate = mongoose.model("MessageTemplate", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  name: { type: String, required: true },
  message: { type: String, required: true },
  variants: { type: [String], default: [] },
  niche: { type: String, default: "General" },
  usageCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
}));

const Campaign = mongoose.model("Campaign", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  name: { type: String, required: true },
  message: { type: String, required: true },
  variants: { type: [String], default: [] },
  mediaUrl: { type: String, default: "" },
  mediaType: { type: String, default: "", enum: ["", "photo", "video", "gif", "document"] },
  mediaCaption: { type: String, default: "" },
  groupIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "TgGroup" }],
  accountIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "TgAccount" }],
  postsPerDay: { type: Number, default: 3 },
  delayMin: { type: Number, default: 12 },
  delayMax: { type: Number, default: 45 },
  intervalMinutes: { type: Number, default: 15 },
  batchSize: { type: Number, default: 5 },
  scheduleTime: { type: String, default: "" },
  scheduleDays: { type: [Number], default: [0,1,2,3,4,5,6] },
  startAt: Date,
  endAt: Date,
  useSpintax: { type: Boolean, default: false },
  useSmartRotation: { type: Boolean, default: true },
  skipBlacklisted: { type: Boolean, default: true },
  abEnabled: { type: Boolean, default: false },
  abVariantA: { type: String, default: "" },
  abVariantB: { type: String, default: "" },
  abSentA: { type: Number, default: 0 },
  abSentB: { type: Number, default: 0 },
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
  abVariant: { type: String, default: "" },
  status: { type: String, enum: ["sent", "failed", "skipped"] },
  error: { type: String, default: "" },
  sentAt: { type: Date, default: Date.now },
}));

const AutoReply = mongoose.model("AutoReply", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "TgAccount" },
  triggers: [String],
  response: String,
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
}));

const Payment = mongoose.model("Payment", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  orderId: { type: String, unique: true },
  paymentId: String,
  type: { type: String, enum: ["subscription", "credits"] },
  plan: String,
  credits: { type: Number, default: 0 },
  amountUsd: Number,
  currency: String,
  status: { type: String, default: "pending", enum: ["pending", "confirmed", "failed", "expired"] },
  months: { type: Number, default: 1 },
  createdAt: { type: Date, default: Date.now },
  confirmedAt: Date,
}));

const Blacklist = mongoose.model("Blacklist", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  username: { type: String, required: true },
  reason: { type: String, default: "" },
  autoAdded: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
}));

// FIX: Inbox schemas defined HERE — before any routes that use them
const InboxMessage = mongoose.model("InboxMessage", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "TgAccount", index: true },
  accountPhone: String,
  fromUsername: String,
  fromFirstName: String,
  fromUserId: String,
  chatUsername: String,
  chatTitle: String,
  chatType: { type: String, enum: ["private", "group", "channel"], default: "private" },
  message: String,
  replyToMessage: String,
  isRead: { type: Boolean, default: false },
  isReplied: { type: Boolean, default: false },
  replyText: String,
  replyMode: { type: String, enum: ["none", "manual", "ai", "forward"], default: "none" },
  forwardedTo: String,
  aiReply: String,
  sentiment: { type: String, enum: ["positive", "negative", "neutral", "question"], default: "neutral" },
  tags: [String],
  receivedAt: { type: Date, default: Date.now },
}));

const AccountInboxSettings = mongoose.model("AccountInboxSettings", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  replyMode: { type: String, enum: ["off", "manual", "ai", "forward"], default: "off" },
  aiSystemPrompt: { type: String, default: "You are a helpful sales assistant. Be friendly, concise, and helpful." },
  aiTone: { type: String, enum: ["professional", "friendly", "casual", "sales"], default: "friendly" },
  forwardTo: { type: String, default: "" },
  autoMarkRead: { type: Boolean, default: false },
  notifyOnPositive: { type: Boolean, default: true },
  filterSpam: { type: Boolean, default: true },
  blacklistWords: [String],
  welcomeMessage: { type: String, default: "" },
  maxAutoRepliesPerUser: { type: Number, default: 5 },
  createdAt: { type: Date, default: Date.now },
}));

// ── PLAN CONFIG ───────────────────────────────────────────────────────────────
const PLAN_LIMITS = {
  trial:   { accounts: 1,   groups: 50,    campaigns: 1,   postsPerDay: 10,   templates: 5,   teamMembers: 0  },
  starter: { accounts: 3,   groups: 500,   campaigns: 5,   postsPerDay: 100,  templates: 20,  teamMembers: 0  },
  pro:     { accounts: 10,  groups: 2000,  campaigns: 20,  postsPerDay: 500,  templates: 100, teamMembers: 3  },
  agency:  { accounts: 999, groups: 99999, campaigns: 999, postsPerDay: 9999, templates: 999, teamMembers: 20 },
};

const PLAN_PRICES = {
  starter: { monthly: 9,  quarterly: 24, yearly: 79  },
  pro:     { monthly: 19, quarterly: 49, yearly: 149 },
  agency:  { monthly: 49, quarterly: 129,yearly: 399 },
};

const CREDIT_PACKAGES = [
  { id: "c100",  credits: 100,  price: 2  },
  { id: "c500",  credits: 500,  price: 8  },
  { id: "c2000", credits: 2000, price: 25 },
  { id: "c5000", credits: 5000, price: 55 },
];

const PLAN_FEATURES = {
  trial:   { spintax: true,  mediaMessages: false, warmupMode: false, smartRotation: false, autoBlacklist: true,  abTesting: false, webhookNotifications: false, whiteLabel: false, teamMembers: false, csvExport: false, referral: true },
  starter: { spintax: true,  mediaMessages: true,  warmupMode: true,  smartRotation: true,  autoBlacklist: true,  abTesting: false, webhookNotifications: false, whiteLabel: false, teamMembers: false, csvExport: true,  referral: true },
  pro:     { spintax: true,  mediaMessages: true,  warmupMode: true,  smartRotation: true,  autoBlacklist: true,  abTesting: true,  webhookNotifications: true,  whiteLabel: false, teamMembers: true,  csvExport: true,  referral: true },
  agency:  { spintax: true,  mediaMessages: true,  warmupMode: true,  smartRotation: true,  autoBlacklist: true,  abTesting: true,  webhookNotifications: true,  whiteLabel: true,  teamMembers: true,  csvExport: true,  referral: true },
};

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

const checkLimit = async (userId, resource) => {
  const user = await User.findById(userId);
  const limits = PLAN_LIMITS[user?.plan] || PLAN_LIMITS.trial;
  const counts = {
    accounts: () => TgAccount.countDocuments({ userId }),
    groups: () => TgGroup.countDocuments({ userId }),
    campaigns: () => Campaign.countDocuments({ userId }),
    templates: () => MessageTemplate.countDocuments({ userId }),
  };
  const count = await counts[resource]();
  if (count >= limits[resource]) throw new Error(`${resource} limit reached (${limits[resource]} on ${user.plan} plan). Upgrade to add more.`);
};

const checkFeature = async (userId, feature) => {
  const user = await User.findById(userId);
  const planFeatures = PLAN_FEATURES[user?.plan] || PLAN_FEATURES.trial;
  if (!planFeatures[feature]) throw new Error(`${feature} not available on ${user.plan} plan. Upgrade to unlock.`);
};

function parseSpintax(text) {
  let result = text;
  const regex = /\{([^{}]+)\}/g;
  let match;
  let safety = 0;
  while ((match = regex.exec(result)) !== null && safety++ < 100) {
    const options = match[1].split("|");
    const chosen = options[Math.floor(Math.random() * options.length)];
    result = result.slice(0, match.index) + chosen + result.slice(match.index + match[0].length);
    regex.lastIndex = 0;
  }
  return result;
}

function genReferralCode(userId) {
  return "CX" + userId.toString().slice(-6).toUpperCase();
}

function runPython(script, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const py = spawn("python3", ["-c", script]);
    let out = "", err = "";
    py.stdout.on("data", d => out += d.toString());
    py.stderr.on("data", d => err += d.toString());
    py.on("close", () => {
      const lines = out.trim().split("\n").reverse();
      for (const line of lines) {
        try { const p = JSON.parse(line.trim()); if (p && "success" in p) return resolve(p); } catch {}
      }
      resolve({ success: false, error: err || out || "No response" });
    });
    setTimeout(() => { py.kill(); resolve({ success: false, error: "Timeout" }); }, timeoutMs);
  });
}

async function notifyWebhook(userId, event, data) {
  try {
    const user = await User.findById(userId);
    if (!user?.webhookUrl) return;
    await axios.post(user.webhookUrl, { event, data, timestamp: new Date().toISOString() }, { timeout: 5000 });
  } catch {}
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password, referralCode } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "All fields required" });
    if (await User.findOne({ email: email.toLowerCase() })) return res.status(400).json({ error: "Email already exists" });
    const hash = await bcrypt.hash(password, 12);
    const isAdmin = email.toLowerCase() === ADMIN_EMAIL;
    let referredBy = null;
    if (referralCode) {
      const referrer = await User.findOne({ referralCode: referralCode.toUpperCase() });
      if (referrer) referredBy = referrer._id;
    }
    const user = await User.create({ name: name.trim(), email: email.toLowerCase(), password: hash, isAdmin, plan: isAdmin ? "agency" : "trial", referredBy });
    await User.findByIdAndUpdate(user._id, { referralCode: genReferralCode(user._id) });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, plan: user.plan, isAdmin: user.isAdmin, credits: user.credits } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !await bcrypt.compare(password, user.password)) return res.status(400).json({ error: "Invalid credentials" });
    if (email.toLowerCase() === ADMIN_EMAIL && !user.isAdmin) await User.findByIdAndUpdate(user._id, { isAdmin: true, plan: "agency" });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, plan: user.plan, isAdmin: user.isAdmin, credits: user.credits } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    res.json({ ...user.toObject(), limits: PLAN_LIMITS[user.plan] || PLAN_LIMITS.trial, planFeatures: PLAN_FEATURES[user.plan] || PLAN_FEATURES.trial });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/me/features", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const planFeatures = PLAN_FEATURES[user.plan] || PLAN_FEATURES.trial;
    const updates = {};
    for (const [key, val] of Object.entries(req.body)) {
      if (key in planFeatures) {
        if (val && !planFeatures[key]) throw new Error(`${key} not available on ${user.plan} plan`);
        updates[`features.${key}`] = val;
      }
    }
    const updated = await User.findByIdAndUpdate(req.user.id, updates, { new: true }).select("-password");
    res.json(updated);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put("/api/me/settings", auth, async (req, res) => {
  try {
    const { webhookUrl, whiteLabelName, whiteLabelLogo } = req.body;
    const user = await User.findById(req.user.id);
    const planF = PLAN_FEATURES[user.plan] || PLAN_FEATURES.trial;
    const update = {};
    if (webhookUrl !== undefined) { if (webhookUrl && !planF.webhookNotifications) throw new Error("Webhooks not on your plan"); update.webhookUrl = webhookUrl; }
    if (whiteLabelName !== undefined) { if (whiteLabelName && !planF.whiteLabel) throw new Error("White label not on your plan"); update.whiteLabelName = whiteLabelName; }
    if (whiteLabelLogo !== undefined) update.whiteLabelLogo = whiteLabelLogo;
    res.json(await User.findByIdAndUpdate(req.user.id, update, { new: true }).select("-password"));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── ACCOUNTS ──────────────────────────────────────────────────────────────────
app.post("/api/accounts/send-otp", auth, async (req, res) => {
  try {
    await checkLimit(req.user.id, "accounts");
    const { phone, apiId, apiHash, proxy } = req.body;
    if (!phone) return res.status(400).json({ error: "phone required" });
    const useApiId = apiId || DEFAULT_API_ID;
    const useApiHash = apiHash || DEFAULT_API_HASH;
    const proxyParts = proxy ? proxy.replace("socks5://","").split(":") : null;
    const proxyLine = proxyParts ? `, proxy=("socks5", "${proxyParts[0]}", int("${proxyParts[1] || 1080}"))` : "";
    const script = `
import asyncio, json
from telethon import TelegramClient
from telethon.sessions import StringSession
async def main():
    try:
        client = TelegramClient(StringSession(), int("${useApiId}"), "${useApiHash}"${proxyLine})
        await client.connect()
        result = await client.send_code_request("${phone}")
        session = client.session.save()
        await client.disconnect()
        print(json.dumps({"success": True, "phoneCodeHash": result.phone_code_hash, "session": session}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
asyncio.run(main())
`;
    res.json(await runPython(script, 30000));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/accounts/verify-otp", auth, async (req, res) => {
  try {
    const { phone, apiId, apiHash, phoneCodeHash, code, twoFaPassword, session, label, proxy, warmupEnabled } = req.body;
    const useApiId = apiId || DEFAULT_API_ID;
    const useApiHash = apiHash || DEFAULT_API_HASH;
    const script = `
import asyncio, json
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.errors import SessionPasswordNeededError
async def main():
    try:
        client = TelegramClient(StringSession("${session}"), int("${useApiId}"), "${useApiHash}")
        await client.connect()
        try:
            await client.sign_in("${phone}", "${code}", phone_code_hash="${phoneCodeHash}")
        except SessionPasswordNeededError:
            ${twoFaPassword ? `await client.sign_in(password="${twoFaPassword}")` : `raise Exception("2FA required")`}
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
      userId: req.user.id, phone, apiId: useApiId, apiHash: useApiHash,
      sessionString: result.session,
      label: label || result.firstName || phone,
      proxy: proxy || "",
      deviceModel: `CampaignX-${Math.random().toString(36).slice(2, 7)}`,
      status: warmupEnabled ? "warming" : "active",
      warmupEnabled: warmupEnabled || false,
      warmupDay: 0, warmupTarget: 14,
      warmupStartedAt: warmupEnabled ? new Date() : undefined,
    });
    res.json({ ...acc.toObject(), sessionString: undefined });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// QR Generate
app.post("/api/accounts/qr-generate", auth, async (req, res) => {
  try {
    await checkLimit(req.user.id, "accounts");
    const { apiId, apiHash, proxy } = req.body;
    const useApiId = apiId || DEFAULT_API_ID;
    const useApiHash = apiHash || DEFAULT_API_HASH;
    const proxyParts = proxy ? proxy.replace("socks5://","").split(":") : null;
    const proxyLine = proxyParts ? `, proxy=("socks5", "${proxyParts[0]}", int("${proxyParts[1] || 1080}"))` : "";
    const devices = ["Samsung Galaxy S23","iPhone 14 Pro","Xiaomi 13","OnePlus 11","Google Pixel 7"];
    const device = devices[Math.floor(Math.random() * devices.length)];
    const script = `
import asyncio, json, base64
from telethon import TelegramClient
from telethon.sessions import StringSession
try:
    import qrcode, io
    HAS_QR = True
except ImportError:
    HAS_QR = False
async def main():
    try:
        client = TelegramClient(StringSession(), int("${useApiId}"), "${useApiHash}"${proxyLine},
            device_model="${device}", system_version="Android 13", app_version="9.6.7")
        await client.connect()
        qr_login = await client.qr_login()
        session = client.session.save()
        qr_image = ""
        if HAS_QR:
            qr = qrcode.QRCode(border=2)
            qr.add_data(qr_login.url)
            qr.make(fit=True)
            img = qr.make_image(fill_color="black", back_color="white")
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            qr_image = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
        await client.disconnect()
        print(json.dumps({"success": True, "url": qr_login.url, "session": session, "qrImage": qr_image}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
asyncio.run(main())
`;
    res.json(await runPython(script, 30000));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// QR Poll
app.post("/api/accounts/qr-poll", auth, async (req, res) => {
  try {
    const { session, apiId, apiHash, label, proxy, warmupEnabled } = req.body;
    if (!session) return res.status(400).json({ error: "session required" });
    const useApiId = apiId || DEFAULT_API_ID;
    const useApiHash = apiHash || DEFAULT_API_HASH;
    const script = `
import asyncio, json, random
from telethon import TelegramClient
from telethon.sessions import StringSession
async def main():
    try:
        client = TelegramClient(StringSession("${session}"), int("${useApiId}"), "${useApiHash}")
        await client.connect()
        me = await client.get_me()
        if me:
            await asyncio.sleep(random.uniform(1, 3))
            await client.get_dialogs(limit=5)
            new_session = client.session.save()
            await client.disconnect()
            print(json.dumps({"success": True, "scanned": True, "session": new_session, "username": me.username or "", "firstName": me.first_name or "", "phone": me.phone or ""}))
        else:
            await client.disconnect()
            print(json.dumps({"success": True, "scanned": False}))
    except Exception as e:
        print(json.dumps({"success": False, "scanned": False, "error": str(e)}))
asyncio.run(main())
`;
    const result = await runPython(script, 20000);
    if (!result.success || !result.scanned) return res.json({ scanned: false });
    const acc = await TgAccount.create({
      userId: req.user.id, phone: result.phone || "",
      apiId: useApiId, apiHash: useApiHash,
      sessionString: result.session,
      label: label || result.firstName || result.username || "QR Account",
      proxy: proxy || "",
      deviceModel: `CampaignX-${Math.random().toString(36).slice(2, 7)}`,
      status: warmupEnabled ? "warming" : "active",
      warmupEnabled: warmupEnabled || false,
      warmupDay: 0, warmupTarget: 14,
      warmupStartedAt: warmupEnabled ? new Date() : undefined,
    });
    res.json({ scanned: true, account: { ...acc.toObject(), sessionString: undefined } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/accounts", auth, async (req, res) => {
  try {
    const accs = await TgAccount.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json(accs.map(a => ({ ...a.toObject(), sessionString: undefined })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/accounts/:id", auth, async (req, res) => {
  try {
    const acc = await TgAccount.findOneAndUpdate({ _id: req.params.id, userId: req.user.id }, req.body, { new: true });
    res.json({ ...acc.toObject(), sessionString: undefined });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/accounts/:id", auth, async (req, res) => {
  try { await TgAccount.findOneAndDelete({ _id: req.params.id, userId: req.user.id }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GROUPS ────────────────────────────────────────────────────────────────────
app.get("/api/groups", auth, async (req, res) => {
  try {
    const { niche, search, blacklisted } = req.query;
    const filter = { userId: req.user.id };
    if (niche && niche !== "All") filter.niche = niche;
    if (blacklisted === "true") filter.isBlacklisted = true;
    else if (blacklisted === "false") filter.isBlacklisted = false;
    if (search) filter.$or = [{ username: { $regex: search, $options: "i" } }, { title: { $regex: search, $options: "i" } }];
    res.json(await TgGroup.find(filter).sort({ members: -1 }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/groups", auth, async (req, res) => {
  try {
    await checkLimit(req.user.id, "groups");
    const { username, title, members, niche, language } = req.body;
    if (!username) return res.status(400).json({ error: "username required" });
    const clean = username.replace("@","").replace("https://t.me/","").trim();
    const bl = await Blacklist.findOne({ userId: req.user.id, username: clean });
    if (bl) return res.status(400).json({ error: `@${clean} is blacklisted` });
    res.json(await TgGroup.create({ userId: req.user.id, username: clean, title: title || username, members: members || 0, niche: niche || "General", language: language || "" }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/groups/bulk", auth, async (req, res) => {
  try {
    const { groups } = req.body;
    if (!groups?.length) return res.status(400).json({ error: "No groups provided" });
    const user = await User.findById(req.user.id);
    const limits = PLAN_LIMITS[user.plan] || PLAN_LIMITS.trial;
    const existing = await TgGroup.countDocuments({ userId: req.user.id });
    const canAdd = limits.groups - existing;
    if (canAdd <= 0) throw new Error(`Group limit reached on ${user.plan} plan.`);
    const existingUsernames = (await TgGroup.find({ userId: req.user.id }, "username")).map(g => g.username);
    const blacklisted = (await Blacklist.find({ userId: req.user.id }, "username")).map(b => b.username);
    const newGroups = groups
      .slice(0, canAdd)
      .map(g => ({ ...g, username: g.username.replace("@","").replace("https://t.me/","").trim() }))
      .filter(g => g.username && !existingUsernames.includes(g.username) && !blacklisted.includes(g.username))
      .map(g => ({ userId: req.user.id, ...g }));
    if (!newGroups.length) return res.json({ added: 0, message: "All groups already exist or blacklisted" });
    await TgGroup.insertMany(newGroups);
    res.json({ added: newGroups.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/groups/search", auth, async (req, res) => {
  try {
    const { keyword, accountId, limit = 20 } = req.body;
    if (!keyword || !accountId) return res.status(400).json({ error: "keyword and accountId required" });
    const account = await TgAccount.findOne({ _id: accountId, userId: req.user.id });
    if (!account?.sessionString) return res.status(400).json({ error: "Account not found" });
    const safeKeyword = keyword.replace(/"/g,"").replace(/\\/g,"").slice(0, 50);
    const script = `
import asyncio, json
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.functions.contacts import SearchRequest
async def main():
    try:
        client = TelegramClient(StringSession("${account.sessionString}"), int("${account.apiId}"), "${account.apiHash}")
        await client.connect()
        result = await client(SearchRequest(q="${safeKeyword}", limit=${Math.min(parseInt(limit), 50)}))
        groups = []
        for chat in result.chats:
            try:
                uname = getattr(chat, "username", "") or ""
                title = getattr(chat, "title", "") or ""
                members = getattr(chat, "participants_count", 0) or 0
                if uname:
                    groups.append({"username": uname, "title": title, "members": members})
            except: pass
        await client.disconnect()
        print(json.dumps({"success": True, "groups": groups}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
asyncio.run(main())
`;
    res.json(await runPython(script, 30000));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/groups/scrape", auth, async (req, res) => {
  try {
    const { username, accountId } = req.body;
    const account = await TgAccount.findOne({ _id: accountId, userId: req.user.id });
    if (!account?.sessionString) return res.status(400).json({ error: "Account not found" });
    const cleanUsername = username.replace("@","");
    const script = `
import asyncio, json
from telethon import TelegramClient
from telethon.sessions import StringSession
async def main():
    try:
        client = TelegramClient(StringSession("${account.sessionString}"), int("${account.apiId}"), "${account.apiHash}")
        await client.connect()
        entity = await client.get_entity("${cleanUsername}")
        members = getattr(entity, "participants_count", 0) or 0
        await client.disconnect()
        print(json.dumps({"success": True, "title": getattr(entity,"title",""), "username": getattr(entity,"username","") or "", "members": members}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
asyncio.run(main())
`;
    res.json(await runPython(script, 20000));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/groups/health-check", auth, async (req, res) => {
  try {
    const { accountId, groupIds } = req.body;
    const account = await TgAccount.findOne({ _id: accountId, userId: req.user.id });
    if (!account?.sessionString) return res.status(400).json({ error: "Account not found" });
    const groups = await TgGroup.find({ _id: { $in: groupIds }, userId: req.user.id });
    const results = [];
    for (const group of groups) {
      const script = `
import asyncio, json
from telethon import TelegramClient
from telethon.sessions import StringSession
async def main():
    try:
        client = TelegramClient(StringSession("${account.sessionString}"), int("${account.apiId}"), "${account.apiHash}")
        await client.connect()
        entity = await client.get_entity("${group.username}")
        members = getattr(entity, "participants_count", 0) or 0
        await client.disconnect()
        print(json.dumps({"success": True, "members": members}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
asyncio.run(main())
`;
      const result = await runPython(script, 15000);
      const newErrorCount = result.success ? 0 : (group.errorCount || 0) + 1;
      await TgGroup.findByIdAndUpdate(group._id, {
        lastCheckedAt: new Date(),
        ...(result.success ? { members: result.members, isActive: true, errorCount: 0 } : { errorCount: newErrorCount }),
        ...(newErrorCount >= 3 ? { isBlacklisted: true, blacklistReason: result.error } : {}),
      });
      results.push({ id: group._id, username: group.username, ...result });
    }
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/groups/:id", auth, async (req, res) => {
  try { res.json(await TgGroup.findOneAndUpdate({ _id: req.params.id, userId: req.user.id }, req.body, { new: true })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/groups/:id", auth, async (req, res) => {
  try { await TgGroup.findOneAndDelete({ _id: req.params.id, userId: req.user.id }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/groups", auth, async (req, res) => {
  try { const r = await TgGroup.deleteMany({ userId: req.user.id }); res.json({ deleted: r.deletedCount }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Groups CSV export
app.get("/api/groups/export", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!(PLAN_FEATURES[user.plan] || PLAN_FEATURES.trial).csvExport) return res.status(403).json({ error: "CSV export not on your plan" });
    const groups = await TgGroup.find({ userId: req.user.id });
    const rows = groups.map(g => `"${g.username}","${(g.title||"").replace(/"/g,"'")}","${g.members||0}","${g.niche||""}","${g.isActive}","${g.isBlacklisted}","${g.totalPosts||0}"`);
    res.setHeader("Content-Type","text/csv");
    res.setHeader("Content-Disposition","attachment; filename=groups.csv");
    res.send(["Username,Title,Members,Niche,Active,Blacklisted,TotalPosts",...rows].join("\n"));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BLACKLIST ─────────────────────────────────────────────────────────────────
app.get("/api/blacklist", auth, async (req, res) => {
  try { res.json(await Blacklist.find({ userId: req.user.id }).sort({ createdAt: -1 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/blacklist", auth, async (req, res) => {
  try {
    const { username, reason } = req.body;
    const clean = username.replace("@","").replace("https://t.me/","").trim();
    const bl = await Blacklist.create({ userId: req.user.id, username: clean, reason: reason || "" });
    await TgGroup.updateOne({ userId: req.user.id, username: clean }, { isBlacklisted: true, blacklistReason: reason || "" });
    res.json(bl);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/blacklist/:id", auth, async (req, res) => {
  try {
    const bl = await Blacklist.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    if (bl) await TgGroup.updateOne({ userId: req.user.id, username: bl.username }, { isBlacklisted: false, blacklistReason: "" });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TEMPLATES ─────────────────────────────────────────────────────────────────
app.get("/api/templates", auth, async (req, res) => {
  try { res.json(await MessageTemplate.find({ userId: req.user.id }).sort({ usageCount: -1 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/templates", auth, async (req, res) => {
  try {
    await checkLimit(req.user.id, "templates");
    const { name, message, variants, niche } = req.body;
    if (!name || !message) return res.status(400).json({ error: "name and message required" });
    res.json(await MessageTemplate.create({ userId: req.user.id, name, message, variants: variants || [], niche: niche || "General" }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/templates/:id", auth, async (req, res) => {
  try { res.json(await MessageTemplate.findOneAndUpdate({ _id: req.params.id, userId: req.user.id }, req.body, { new: true })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/templates/:id", auth, async (req, res) => {
  try { await MessageTemplate.findOneAndDelete({ _id: req.params.id, userId: req.user.id }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI ────────────────────────────────────────────────────────────────────────
app.post("/api/ai/rewrite", auth, async (req, res) => {
  try {
    const { message, count = 5, tone = "marketing", useSpintax = false } = req.body;
    if (!message) return res.status(400).json({ error: "message required" });
    const tones = { marketing: "persuasive marketing", casual: "casual friendly", professional: "formal professional", urgent: "urgent FOMO-driven", funny: "humorous witty" };
    const spintaxNote = useSpintax ? " Use {option1|option2} spintax for words that can vary." : "";
    const r = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: "llama3-8b-8192",
      messages: [{ role: "user", content: `Rewrite this Telegram message into ${count} versions with ${tones[tone]||"marketing"} tone.${spintaxNote} Same meaning. Return ONLY a JSON array of strings, no markdown.\n\nOriginal: ${message}` }],
      max_tokens: 2000, temperature: 0.9,
    }, { headers: { Authorization: `Bearer ${GROQ_API_KEY}` } });
    const text = r.data.choices[0].message.content.trim().replace(/```json|```/g,"").trim();
    res.json({ variants: JSON.parse(text) });
  } catch (e) { res.status(500).json({ error: "AI rewrite failed" }); }
});

// ── CAMPAIGNS ─────────────────────────────────────────────────────────────────
app.get("/api/campaigns", auth, async (req, res) => {
  try { res.json(await Campaign.find({ userId: req.user.id }).sort({ createdAt: -1 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/campaigns", auth, async (req, res) => {
  try {
    await checkLimit(req.user.id, "campaigns");
    const { name, message, variants, groupIds, accountIds, postsPerDay, intervalMinutes, batchSize, delayMin, delayMax, scheduleTime, scheduleDays, startAt, endAt, useSpintax, useSmartRotation, skipBlacklisted, abEnabled, abVariantA, abVariantB, mediaUrl, mediaType, mediaCaption, templateId } = req.body;
    if (!name || !message) return res.status(400).json({ error: "name and message required" });
    if (templateId) await MessageTemplate.findByIdAndUpdate(templateId, { $inc: { usageCount: 1 } });
    const campaign = await Campaign.create({
      userId: req.user.id, name, message,
      variants: variants || [], groupIds: groupIds || [], accountIds: accountIds || [],
      postsPerDay: postsPerDay || 3, intervalMinutes: intervalMinutes || 15, batchSize: batchSize || 5,
      delayMin: delayMin || 12, delayMax: delayMax || 45,
      scheduleTime: scheduleTime || "", scheduleDays: scheduleDays || [0,1,2,3,4,5,6],
      startAt: startAt ? new Date(startAt) : new Date(), endAt: endAt ? new Date(endAt) : null,
      useSpintax: useSpintax || false, useSmartRotation: useSmartRotation !== false, skipBlacklisted: skipBlacklisted !== false,
      abEnabled: abEnabled || false, abVariantA: abVariantA || "", abVariantB: abVariantB || "",
      mediaUrl: mediaUrl || "", mediaType: mediaType || "", mediaCaption: mediaCaption || "",
    });
    res.json(campaign);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/campaigns/:id", auth, async (req, res) => {
  try { res.json(await Campaign.findOneAndUpdate({ _id: req.params.id, userId: req.user.id }, req.body, { new: true })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/campaigns/:id", auth, async (req, res) => {
  try { await Campaign.findOneAndDelete({ _id: req.params.id, userId: req.user.id }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/campaigns/:id/start", auth, async (req, res) => {
  try { await Campaign.findOneAndUpdate({ _id: req.params.id, userId: req.user.id }, { status: "active" }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/campaigns/:id/pause", auth, async (req, res) => {
  try { await Campaign.findOneAndUpdate({ _id: req.params.id, userId: req.user.id }, { status: "paused" }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/campaigns/:id/duplicate", auth, async (req, res) => {
  try {
    const orig = await Campaign.findOne({ _id: req.params.id, userId: req.user.id });
    if (!orig) return res.status(404).json({ error: "Not found" });
    const { _id, createdAt, totalSent, totalFailed, abSentA, abSentB, ...rest } = orig.toObject();
    res.json(await Campaign.create({ ...rest, name: rest.name + " (copy)", status: "draft", totalSent: 0, totalFailed: 0, abSentA: 0, abSentB: 0 }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/campaigns/:id/ab-stats", auth, async (req, res) => {
  try {
    const c = await Campaign.findOne({ _id: req.params.id, userId: req.user.id });
    if (!c) return res.status(404).json({ error: "Not found" });
    res.json({ abVariantA: c.abVariantA, abVariantB: c.abVariantB, sentA: c.abSentA, sentB: c.abSentB });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SEND ENGINE ───────────────────────────────────────────────────────────────
async function sendToGroup(account, group, message, mediaUrl, mediaType, mediaCaption) {
  const escaped = message.replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\n/g,"\\n");
  const escapedCaption = (mediaCaption||"").replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\n/g,"\\n");
  let sendCode = `await client.send_message(entity, "${escaped}")`;
  if (mediaUrl && mediaType) {
    const escapedUrl = mediaUrl.replace(/"/g,'\\"');
    if (["photo","video","document"].includes(mediaType)) {
      sendCode = `await client.send_file(entity, "${escapedUrl}", caption="${escapedCaption||escaped}")`;
    }
  }
  const script = `
import asyncio, json, random
from telethon import TelegramClient
from telethon.sessions import StringSession
async def main():
    try:
        client = TelegramClient(StringSession("${account.sessionString}"), int("${account.apiId}"), "${account.apiHash}")
        await client.connect()
        await client.get_dialogs(limit=3)
        await asyncio.sleep(random.uniform(1, 4))
        entity = await client.get_entity("${group.username}")
        ${sendCode}
        new_session = client.session.save()
        await client.disconnect()
        print(json.dumps({"success": True, "session": new_session}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
asyncio.run(main())
`;
  return runPython(script, 60000);
}

async function getBestAccount(accounts) {
  return [...accounts].sort((a, b) => (a.dailySent||0) - (b.dailySent||0))[0];
}

async function runCampaignBatch(campaign) {
  const [groups, allAccounts] = await Promise.all([
    TgGroup.find({ _id: { $in: campaign.groupIds }, isActive: true, ...(campaign.skipBlacklisted ? { isBlacklisted: false } : {}) }),
    TgAccount.find({ _id: { $in: campaign.accountIds }, status: "active" }),
  ]);
  if (!allAccounts.length || !groups.length) return;

  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const postedToday = (await CampaignLog.find({ campaignId: campaign._id, status: "sent", sentAt: { $gte: todayStart } })).map(l => l.groupId?.toString());
  const pending = groups.filter(g => !postedToday.includes(g._id.toString()));
  if (!pending.length) return;

  const batch = pending.slice(0, campaign.batchSize);
  for (const group of batch) {
    const accounts = await TgAccount.find({ _id: { $in: campaign.accountIds }, status: "active" });
    if (!accounts.length) break;
    const account = campaign.useSmartRotation ? await getBestAccount(accounts) : accounts[Math.floor(Math.random()*accounts.length)];

    let message, abVariant = "";
    if (campaign.abEnabled && campaign.abVariantA && campaign.abVariantB) {
      abVariant = campaign.abSentA <= campaign.abSentB ? "A" : "B";
      message = abVariant === "A" ? campaign.abVariantA : campaign.abVariantB;
    } else {
      const msgs = [campaign.message, ...campaign.variants].filter(Boolean);
      message = msgs[Math.floor(Math.random() * msgs.length)];
    }
    if (campaign.useSpintax) message = parseSpintax(message);

    const minMs = (campaign.delayMin||12) * 1000;
    const maxMs = (campaign.delayMax||45) * 1000;
    await new Promise(r => setTimeout(r, Math.floor(Math.random()*(maxMs-minMs))+minMs));

    const result = await sendToGroup(account, group, message, campaign.mediaUrl, campaign.mediaType, campaign.mediaCaption);

    if (result.success) {
      if (result.session) await TgAccount.findByIdAndUpdate(account._id, { sessionString: result.session });
      const abInc = abVariant === "A" ? { abSentA: 1 } : abVariant === "B" ? { abSentB: 1 } : {};
      await Promise.all([
        TgAccount.findByIdAndUpdate(account._id, { $inc: { groupsSent: 1, dailySent: 1 }, lastUsedAt: new Date() }),
        TgGroup.findByIdAndUpdate(group._id, { $inc: { totalPosts: 1 }, lastPostedAt: new Date() }),
        Campaign.findByIdAndUpdate(campaign._id, { $inc: { totalSent: 1, ...abInc } }),
        CampaignLog.create({ userId: campaign.userId, campaignId: campaign._id, accountId: account._id, groupId: group._id, groupTitle: group.title, accountPhone: account.phone, message, abVariant, status: "sent" }),
      ]);
      const user = await User.findById(campaign.userId);
      if (user?.credits > 0) await User.findByIdAndUpdate(campaign.userId, { $inc: { credits: -1 } });
    } else {
      await Promise.all([
        Campaign.findByIdAndUpdate(campaign._id, { $inc: { totalFailed: 1 } }),
        CampaignLog.create({ userId: campaign.userId, campaignId: campaign._id, accountId: account._id, groupId: group._id, groupTitle: group.title, accountPhone: account.phone, message, status: "failed", error: result.error }),
        TgGroup.findByIdAndUpdate(group._id, { $inc: { errorCount: 1 } }),
      ]);
      if (result.error?.includes("FLOOD_WAIT")) {
        const secs = parseInt(result.error.match(/\d+/)?.[0] || "60");
        await TgAccount.findByIdAndUpdate(account._id, { status: "cooldown", cooldownUntil: new Date(Date.now()+secs*1000), $inc: { floodWaitCount: 1 } });
        notifyWebhook(campaign.userId, "account_cooldown", { phone: account.phone, seconds: secs });
      } else if (result.error?.includes("banned") || result.error?.includes("deactivated")) {
        await TgAccount.findByIdAndUpdate(account._id, { status: "banned" });
        notifyWebhook(campaign.userId, "account_banned", { phone: account.phone });
      }
      const updated = await TgGroup.findById(group._id);
      if ((updated?.errorCount||0) >= 3) {
        await TgGroup.findByIdAndUpdate(group._id, { isBlacklisted: true, blacklistReason: result.error });
        await Blacklist.create({ userId: campaign.userId, username: group.username, reason: result.error, autoAdded: true }).catch(()=>{});
      }
    }
  }
}

// ── SCHEDULER ─────────────────────────────────────────────────────────────────
cron.schedule("* * * * *", async () => {
  try {
    const now = new Date();
    if (now.getHours()===0 && now.getMinutes()===0) await TgAccount.updateMany({}, { dailySent: 0 });
    await TgAccount.updateMany({ status: "cooldown", cooldownUntil: { $lte: now } }, { status: "active", cooldownUntil: null });
    await User.updateMany({ planExpiresAt: { $lte: now }, plan: { $nin: ["trial","agency"] } }, { plan: "trial" });

    // Warmup progression
    const warmingAccounts = await TgAccount.find({ status: "warming", warmupEnabled: true });
    for (const acc of warmingAccounts) {
      if (!acc.warmupStartedAt) continue;
      const daysSince = Math.floor((now - acc.warmupStartedAt) / (1000*60*60*24));
      if (daysSince > acc.warmupDay) {
        const newDay = Math.min(daysSince, acc.warmupTarget||14);
        await TgAccount.findByIdAndUpdate(acc._id, { warmupDay: newDay });
        if (newDay >= (acc.warmupTarget||14)) await TgAccount.findByIdAndUpdate(acc._id, { status: "active", warmupEnabled: false });
      }
    }

    const campaigns = await Campaign.find({ status: "active", startAt: { $lte: now }, $or: [{ endAt: null },{ endAt: { $gte: now } }] });
    for (const campaign of campaigns) {
      if (campaign.scheduleTime) {
        const [h, m] = campaign.scheduleTime.split(":").map(Number);
        if (!campaign.scheduleDays.includes(now.getDay())) continue;
        if (now.getHours()!==h || now.getMinutes()!==m) continue;
      }
      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      const sentToday = await CampaignLog.countDocuments({ campaignId: campaign._id, status: "sent", sentAt: { $gte: todayStart } });
      if (sentToday >= campaign.postsPerDay * campaign.batchSize) continue;
      const lastLog = await CampaignLog.findOne({ campaignId: campaign._id }).sort({ sentAt: -1 });
      if (lastLog && (now - lastLog.sentAt) < campaign.intervalMinutes*60*1000) continue;
      runCampaignBatch(campaign).catch(e => console.error("Batch error:", e.message));
    }
  } catch (e) { console.error("Scheduler error:", e.message); }
});

// ── LOGS & STATS ──────────────────────────────────────────────────────────────
app.get("/api/logs", auth, async (req, res) => {
  try {
    const { campaignId, status, limit = 100, page = 1 } = req.query;
    const filter = { userId: req.user.id };
    if (campaignId) filter.campaignId = campaignId;
    if (status) filter.status = status;
    const skip = (parseInt(page)-1) * parseInt(limit);
    const [logs, total] = await Promise.all([
      CampaignLog.find(filter).sort({ sentAt: -1 }).skip(skip).limit(parseInt(limit)),
      CampaignLog.countDocuments(filter),
    ]);
    res.json({ logs, total, page: parseInt(page), pages: Math.ceil(total/parseInt(limit)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/logs/export", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!(PLAN_FEATURES[user.plan]||PLAN_FEATURES.trial).csvExport) return res.status(403).json({ error: "CSV export not on your plan" });
    const { campaignId } = req.query;
    const filter = { userId: req.user.id };
    if (campaignId) filter.campaignId = campaignId;
    const logs = await CampaignLog.find(filter).sort({ sentAt: -1 }).limit(10000);
    const rows = logs.map(l => `"${(l.groupTitle||"").replace(/"/g,"'")}","${l.accountPhone||""}","${l.status}","${(l.message||"").slice(0,50).replace(/"/g,"'")}","${l.sentAt?.toISOString()||""}","${(l.error||"").replace(/"/g,"'")}"`);
    res.setHeader("Content-Type","text/csv");
    res.setHeader("Content-Disposition","attachment; filename=logs.csv");
    res.send(["Group,Account,Status,Message,SentAt,Error",...rows].join("\n"));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/stats", auth, async (req, res) => {
  try {
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const weekStart = new Date(Date.now()-7*24*60*60*1000);
    const [tc, ac, tg, accounts, user, inboxUnread] = await Promise.all([
      Campaign.countDocuments({ userId: req.user.id }),
      Campaign.countDocuments({ userId: req.user.id, status: "active" }),
      TgGroup.countDocuments({ userId: req.user.id }),
      TgAccount.find({ userId: req.user.id }),
      User.findById(req.user.id),
      InboxMessage.countDocuments({ userId: req.user.id, isRead: false }),
    ]);
    const [sentToday, sentWeek, totalSent, totalFailed] = await Promise.all([
      CampaignLog.countDocuments({ userId: req.user.id, status: "sent", sentAt: { $gte: todayStart } }),
      CampaignLog.countDocuments({ userId: req.user.id, status: "sent", sentAt: { $gte: weekStart } }),
      CampaignLog.countDocuments({ userId: req.user.id, status: "sent" }),
      CampaignLog.countDocuments({ userId: req.user.id, status: "failed" }),
    ]);
    const dailyChart = [];
    for (let i=6; i>=0; i--) {
      const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-i);
      const next = new Date(d); next.setDate(d.getDate()+1);
      const count = await CampaignLog.countDocuments({ userId: req.user.id, status: "sent", sentAt: { $gte: d, $lt: next } });
      dailyChart.push({ date: d.toLocaleDateString("en-US",{weekday:"short"}), sent: count });
    }
    res.json({
      totalCampaigns: tc, activeCampaigns: ac, totalGroups: tg,
      totalAccounts: accounts.length,
      activeAccounts: accounts.filter(a=>a.status==="active").length,
      cooldownAccounts: accounts.filter(a=>a.status==="cooldown").length,
      bannedAccounts: accounts.filter(a=>a.status==="banned").length,
      warmingAccounts: accounts.filter(a=>a.status==="warming").length,
      sentToday, sentWeek, totalSent, totalFailed,
      successRate: totalSent+totalFailed>0 ? Math.round(totalSent/(totalSent+totalFailed)*100) : 0,
      dailyChart, plan: user?.plan, credits: user?.credits||0,
      planExpiresAt: user?.planExpiresAt, inboxUnread,
      limits: PLAN_LIMITS[user?.plan]||PLAN_LIMITS.trial,
      planFeatures: PLAN_FEATURES[user?.plan]||PLAN_FEATURES.trial,
      referralCode: user?.referralCode,
      referralEarnings: user?.referralEarnings||0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AUTO REPLY ────────────────────────────────────────────────────────────────
app.get("/api/autoreplies", auth, async (req, res) => {
  try { res.json(await AutoReply.find({ userId: req.user.id })); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/autoreplies", auth, async (req, res) => {
  try { res.json(await AutoReply.create({ userId: req.user.id, ...req.body })); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/autoreplies/:id", auth, async (req, res) => {
  try { await AutoReply.findOneAndDelete({ _id: req.params.id, userId: req.user.id }); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── INBOX — FIX: static routes BEFORE dynamic /:id routes ─────────────────────
// Stats first (no :id conflict)
app.get("/api/inbox/stats", auth, async (req, res) => {
  try {
    const [total, unread, replied, positive, negative, neutral, questions] = await Promise.all([
      InboxMessage.countDocuments({ userId: req.user.id }),
      InboxMessage.countDocuments({ userId: req.user.id, isRead: false }),
      InboxMessage.countDocuments({ userId: req.user.id, isReplied: true }),
      InboxMessage.countDocuments({ userId: req.user.id, sentiment: "positive" }),
      InboxMessage.countDocuments({ userId: req.user.id, sentiment: "negative" }),
      InboxMessage.countDocuments({ userId: req.user.id, sentiment: "neutral" }),
      InboxMessage.countDocuments({ userId: req.user.id, sentiment: "question" }),
    ]);
    res.json({ total, unread, replied, replyRate: total>0?Math.round(replied/total*100):0, sentiment:{positive,negative,neutral,questions} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Read-all before /:id routes
app.put("/api/inbox/read-all", auth, async (req, res) => {
  try { await InboxMessage.updateMany({ userId: req.user.id }, { isRead: true }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Settings routes before /:id routes
app.get("/api/inbox/settings/:accountId", auth, async (req, res) => {
  try {
    let s = await AccountInboxSettings.findOne({ accountId: req.params.accountId, userId: req.user.id });
    if (!s) s = { replyMode:"off", aiSystemPrompt:"You are a helpful sales assistant.", aiTone:"friendly", forwardTo:"", filterSpam:true, notifyOnPositive:true, blacklistWords:[], welcomeMessage:"", maxAutoRepliesPerUser:5 };
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/inbox/settings/:accountId", auth, async (req, res) => {
  try {
    const s = await AccountInboxSettings.findOneAndUpdate(
      { accountId: req.params.accountId, userId: req.user.id },
      { ...req.body, userId: req.user.id, accountId: req.params.accountId },
      { upsert: true, new: true }
    );
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Main inbox list
app.get("/api/inbox", auth, async (req, res) => {
  try {
    const { accountId, isRead, sentiment, limit=50, page=1 } = req.query;
    const filter = { userId: req.user.id };
    if (accountId) filter.accountId = accountId;
    if (isRead !== undefined) filter.isRead = isRead === "true";
    if (sentiment) filter.sentiment = sentiment;
    const skip = (parseInt(page)-1)*parseInt(limit);
    const [messages, total, unread] = await Promise.all([
      InboxMessage.find(filter).sort({ receivedAt: -1 }).skip(skip).limit(parseInt(limit)),
      InboxMessage.countDocuments(filter),
      InboxMessage.countDocuments({ userId: req.user.id, isRead: false }),
    ]);
    res.json({ messages, total, unread, page: parseInt(page), pages: Math.ceil(total/parseInt(limit)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dynamic :id routes last
app.put("/api/inbox/:id/read", auth, async (req, res) => {
  try { await InboxMessage.findOneAndUpdate({ _id: req.params.id, userId: req.user.id }, { isRead: true }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/inbox/:id", auth, async (req, res) => {
  try { await InboxMessage.findOneAndDelete({ _id: req.params.id, userId: req.user.id }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/inbox/:id/reply", auth, async (req, res) => {
  try {
    const { replyText } = req.body;
    if (!replyText) return res.status(400).json({ error: "replyText required" });
    const msg = await InboxMessage.findOne({ _id: req.params.id, userId: req.user.id });
    if (!msg) return res.status(404).json({ error: "Not found" });
    const account = await TgAccount.findOne({ _id: msg.accountId, userId: req.user.id });
    if (!account?.sessionString) return res.status(400).json({ error: "Account not available" });
    const escaped = replyText.replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\n/g,"\\n");
    const target = msg.fromUserId || msg.fromUsername;
    const script = `
import asyncio, json
from telethon import TelegramClient
from telethon.sessions import StringSession
async def main():
    try:
        client = TelegramClient(StringSession("${account.sessionString}"), int("${account.apiId}"), "${account.apiHash}")
        await client.connect()
        entity = await client.get_entity(${msg.fromUserId ? `int("${msg.fromUserId}")` : `"${msg.fromUsername}"`})
        await client.send_message(entity, "${escaped}")
        await client.disconnect()
        print(json.dumps({"success": True}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
asyncio.run(main())
`;
    const result = await runPython(script, 30000);
    if (!result.success) return res.status(400).json({ error: result.error });
    await InboxMessage.findByIdAndUpdate(msg._id, { isReplied: true, replyText, isRead: true, replyMode: "manual" });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/inbox/:id/ai-reply", auth, async (req, res) => {
  try {
    const { send = false } = req.body;
    const msg = await InboxMessage.findOne({ _id: req.params.id, userId: req.user.id });
    if (!msg) return res.status(404).json({ error: "Not found" });
    const settings = await AccountInboxSettings.findOne({ accountId: msg.accountId }) || {};
    const r = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: "llama3-8b-8192",
      messages: [
        { role: "system", content: (settings.aiSystemPrompt || "You are a helpful sales assistant.") + " Reply in 1-3 sentences max. Be conversational." },
        { role: "user", content: msg.message },
      ],
      max_tokens: 200, temperature: 0.8,
    }, { headers: { Authorization: `Bearer ${GROQ_API_KEY}` } });
    const aiReply = r.data.choices[0].message.content.trim();
    await InboxMessage.findByIdAndUpdate(msg._id, { aiReply, isRead: true });

    if (send) {
      const account = await TgAccount.findOne({ _id: msg.accountId, userId: req.user.id });
      if (account?.sessionString) {
        const escaped = aiReply.replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\n/g,"\\n");
        const script = `
import asyncio, json
from telethon import TelegramClient
from telethon.sessions import StringSession
async def main():
    try:
        client = TelegramClient(StringSession("${account.sessionString}"), int("${account.apiId}"), "${account.apiHash}")
        await client.connect()
        entity = await client.get_entity(${msg.fromUserId ? `int("${msg.fromUserId}")` : `"${msg.fromUsername}"`})
        await client.send_message(entity, "${escaped}")
        await client.disconnect()
        print(json.dumps({"success": True}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
asyncio.run(main())
`;
        const result = await runPython(script, 30000);
        if (result.success) await InboxMessage.findByIdAndUpdate(msg._id, { isReplied: true, replyMode: "ai", replyText: aiReply });
      }
    }
    res.json({ success: true, aiReply });
  } catch (e) { res.status(500).json({ error: "AI reply failed: " + e.message }); }
});

app.post("/api/inbox/:id/forward", auth, async (req, res) => {
  try {
    const { forwardTo } = req.body;
    const msg = await InboxMessage.findOne({ _id: req.params.id, userId: req.user.id });
    if (!msg) return res.status(404).json({ error: "Not found" });
    const account = await TgAccount.findOne({ _id: msg.accountId, userId: req.user.id });
    if (!account?.sessionString) return res.status(400).json({ error: "Account not available" });
    const target = (forwardTo || "").replace("@","");
    if (!target) return res.status(400).json({ error: "forwardTo required" });
    const fwdText = `📨 Reply from @${msg.fromUsername||msg.fromUserId} in ${msg.chatTitle||"DM"}:\n\n${msg.message}`;
    const escaped = fwdText.replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\n/g,"\\n");
    const script = `
import asyncio, json
from telethon import TelegramClient
from telethon.sessions import StringSession
async def main():
    try:
        client = TelegramClient(StringSession("${account.sessionString}"), int("${account.apiId}"), "${account.apiHash}")
        await client.connect()
        entity = await client.get_entity("${target}")
        await client.send_message(entity, "${escaped}")
        await client.disconnect()
        print(json.dumps({"success": True}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
asyncio.run(main())
`;
    const result = await runPython(script, 30000);
    if (!result.success) return res.status(400).json({ error: result.error });
    await InboxMessage.findByIdAndUpdate(msg._id, { isReplied: true, replyMode: "forward", forwardedTo: target, isRead: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── INBOX POLLER ──────────────────────────────────────────────────────────────
async function pollInboxForAccount(account) {
  try {
    const settings = await AccountInboxSettings.findOne({ accountId: account._id });
    if (!settings || settings.replyMode === "off") return;

    const script = `
import asyncio, json
from telethon import TelegramClient
from telethon.sessions import StringSession
async def main():
    try:
        client = TelegramClient(StringSession("${account.sessionString}"), int("${account.apiId}"), "${account.apiHash}")
        await client.connect()
        messages = []
        async for msg in client.iter_messages(None, limit=30, unread=True):
            try:
                if not msg.message: continue
                sender = await msg.get_sender()
                chat = await msg.get_chat()
                chat_type = "private"
                if hasattr(chat, "broadcast"):
                    chat_type = "channel" if chat.broadcast else "group"
                messages.append({
                    "fromUserId": str(sender.id) if sender else "",
                    "fromUsername": getattr(sender, "username", "") or "",
                    "fromFirstName": getattr(sender, "first_name", "") or "",
                    "chatUsername": getattr(chat, "username", "") or "",
                    "chatTitle": getattr(chat, "title", getattr(chat, "first_name", "")) or "",
                    "chatType": chat_type,
                    "message": msg.message
                })
            except: pass
        new_session = client.session.save()
        await client.disconnect()
        print(json.dumps({"success": True, "messages": messages, "session": new_session}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
asyncio.run(main())
`;
    const result = await runPython(script, 60000);
    if (!result.success || !result.messages?.length) return;
    if (result.session) await TgAccount.findByIdAndUpdate(account._id, { sessionString: result.session });

    for (const m of result.messages) {
      if (!m.message || !m.fromUserId) continue;
      const exists = await InboxMessage.findOne({ accountId: account._id, fromUserId: m.fromUserId, message: m.message });
      if (exists) continue;
      if (settings.filterSpam && !m.fromUsername) continue;
      if (settings.blacklistWords?.length) {
        const lower = m.message.toLowerCase();
        if (settings.blacklistWords.some(w => w && lower.includes(w.toLowerCase()))) continue;
      }

      let sentiment = "neutral";
      if (GROQ_API_KEY) {
        try {
          const sr = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama3-8b-8192",
            messages: [{ role: "user", content: `Classify as exactly one word: positive, negative, neutral, or question.\nMessage: "${m.message.slice(0,150).replace(/"/g,"'")}"` }],
            max_tokens: 5, temperature: 0,
          }, { headers: { Authorization: `Bearer ${GROQ_API_KEY}` } });
          const s = sr.data.choices[0].message.content.trim().toLowerCase().split(/\s/)[0];
          if (["positive","negative","neutral","question"].includes(s)) sentiment = s;
        } catch {}
      }

      const inbox = await InboxMessage.create({ userId: account.userId, accountId: account._id, accountPhone: account.phone, ...m, sentiment });

      if (settings.replyMode === "ai" && GROQ_API_KEY) {
        try {
          const replyCount = await InboxMessage.countDocuments({ accountId: account._id, fromUserId: m.fromUserId, isReplied: true });
          if (replyCount >= (settings.maxAutoRepliesPerUser||5)) continue;
          const r = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama3-8b-8192",
            messages: [
              { role: "system", content: (settings.aiSystemPrompt||"You are a helpful assistant.") + " Reply in 1-2 sentences." },
              { role: "user", content: m.message },
            ],
            max_tokens: 150, temperature: 0.7,
          }, { headers: { Authorization: `Bearer ${GROQ_API_KEY}` } });
          const aiReply = r.data.choices[0].message.content.trim();
          const escaped = aiReply.replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\n/g,"\\n");
          const replyScript = `
import asyncio, json
from telethon import TelegramClient
from telethon.sessions import StringSession
async def main():
    try:
        client = TelegramClient(StringSession("${account.sessionString}"), int("${account.apiId}"), "${account.apiHash}")
        await client.connect()
        entity = await client.get_entity(int("${m.fromUserId}"))
        await client.send_message(entity, "${escaped}")
        await client.disconnect()
        print(json.dumps({"success": True}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
asyncio.run(main())
`;
          const sendResult = await runPython(replyScript, 30000);
          if (sendResult.success) await InboxMessage.findByIdAndUpdate(inbox._id, { isReplied: true, replyMode: "ai", aiReply, replyText: aiReply, isRead: true });
        } catch {}
      } else if (settings.replyMode === "forward" && settings.forwardTo) {
        try {
          const fwdText = `📨 @${m.fromUsername||m.fromUserId} in ${m.chatTitle}:\\n\\n${m.message}`.replace(/"/g,'\\"');
          const fwdScript = `
import asyncio, json
from telethon import TelegramClient
from telethon.sessions import StringSession
async def main():
    try:
        client = TelegramClient(StringSession("${account.sessionString}"), int("${account.apiId}"), "${account.apiHash}")
        await client.connect()
        entity = await client.get_entity("${settings.forwardTo.replace("@","")}")
        await client.send_message(entity, "${fwdText}")
        await client.disconnect()
        print(json.dumps({"success": True}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
asyncio.run(main())
`;
          await runPython(fwdScript, 20000);
          await InboxMessage.findByIdAndUpdate(inbox._id, { isReplied: true, replyMode: "forward", forwardedTo: settings.forwardTo, isRead: true });
        } catch {}
      }
    }
  } catch (e) { console.error("pollInbox error:", e.message); }
}

cron.schedule("*/2 * * * *", async () => {
  try {
    const settings = await AccountInboxSettings.find({ replyMode: { $ne: "off" } });
    const accountIds = settings.map(s => s.accountId);
    const accounts = await TgAccount.find({ _id: { $in: accountIds }, status: "active" });
    for (const account of accounts) pollInboxForAccount(account).catch(()=>{});
  } catch (e) { console.error("Inbox cron error:", e.message); }
});

// ── TEAM MEMBERS ──────────────────────────────────────────────────────────────
app.get("/api/team", auth, async (req, res) => {
  try {
    await checkFeature(req.user.id, "teamMembers");
    res.json(await TeamMember.find({ ownerId: req.user.id }).populate("userId","name email"));
  } catch (e) { res.status(403).json({ error: e.message }); }
});

app.post("/api/team/invite", auth, async (req, res) => {
  try {
    await checkFeature(req.user.id, "teamMembers");
    const user = await User.findById(req.user.id);
    const count = await TeamMember.countDocuments({ ownerId: req.user.id });
    if (count >= (PLAN_LIMITS[user.plan]||PLAN_LIMITS.trial).teamMembers) throw new Error("Team member limit reached");
    const { email, role, permissions } = req.body;
    const inviteToken = crypto.randomBytes(20).toString("hex");
    const member = await TeamMember.create({ ownerId: req.user.id, email, role: role||"editor", permissions: permissions||{}, inviteToken });
    res.json({ ...member.toObject(), inviteLink: `${process.env.FRONTEND_URL||""}/invite/${inviteToken}` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/team/accept/:token", auth, async (req, res) => {
  try {
    const member = await TeamMember.findOneAndUpdate({ inviteToken: req.params.token }, { userId: req.user.id, status: "active", inviteToken: "" }, { new: true });
    if (!member) return res.status(404).json({ error: "Invalid invite" });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/team/:id", auth, async (req, res) => {
  try { await TeamMember.findOneAndDelete({ _id: req.params.id, ownerId: req.user.id }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── REFERRAL ──────────────────────────────────────────────────────────────────
app.get("/api/referral", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const referrals = await User.find({ referredBy: req.user.id }).select("name email plan createdAt");
    res.json({
      referralCode: user.referralCode,
      referralLink: `${process.env.FRONTEND_URL||"https://campaignx.pages.dev"}/register?ref=${user.referralCode}`,
      totalReferrals: referrals.length,
      paidReferrals: referrals.filter(r=>r.plan!=="trial").length,
      earnings: user.referralEarnings||0,
      referrals,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PAYMENTS ──────────────────────────────────────────────────────────────────
app.get("/api/plans", (req, res) => res.json({ plans: PLAN_PRICES, credits: CREDIT_PACKAGES, features: PLAN_FEATURES, limits: PLAN_LIMITS }));

app.post("/api/payments/create", auth, async (req, res) => {
  try {
    if (!NOWPAYMENTS_API_KEY) return res.status(503).json({ error: "Payments not configured" });
    const { type, plan, billingPeriod="monthly", creditPackageId, currency="usdttrc20" } = req.body;
    let amountUsd, months=1, credits=0;
    if (type==="subscription") {
      if (!PLAN_PRICES[plan]) return res.status(400).json({ error: "Invalid plan" });
      amountUsd = PLAN_PRICES[plan][billingPeriod]||PLAN_PRICES[plan].monthly;
      months = billingPeriod==="quarterly"?3:billingPeriod==="yearly"?12:1;
    } else if (type==="credits") {
      const pkg = CREDIT_PACKAGES.find(p=>p.id===creditPackageId);
      if (!pkg) return res.status(400).json({ error: "Invalid package" });
      amountUsd=pkg.price; credits=pkg.credits;
    } else return res.status(400).json({ error: "Invalid type" });
    const orderId = `cx_${req.user.id}_${Date.now()}`;
    const r = await axios.post("https://api.nowpayments.io/v1/payment", {
      price_amount: amountUsd, price_currency: "usd", pay_currency: currency,
      order_id: orderId,
      order_description: type==="subscription"?`CampaignX ${plan} ${billingPeriod}`:`CampaignX ${credits} credits`,
      ipn_callback_url: `${BACKEND_URL}/api/payments/webhook`,
    }, { headers: { "x-api-key": NOWPAYMENTS_API_KEY } });
    await Payment.create({ userId: req.user.id, orderId, paymentId: r.data.payment_id, type, plan:plan||"", credits, amountUsd, months, currency: r.data.pay_currency });
    res.json({ paymentId: r.data.payment_id, payAddress: r.data.pay_address, payAmount: r.data.pay_amount, payCurrency: r.data.pay_currency, orderId });
  } catch (e) { console.error("Payment error:", e.response?.data||e.message); res.status(500).json({ error: "Payment failed" }); }
});

app.post("/api/payments/webhook", async (req, res) => {
  try {
    const body = Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);
    if (NOWPAYMENTS_IPN_SECRET) {
      const sig = req.headers["x-nowpayments-sig"];
      const expected = crypto.createHmac("sha512", NOWPAYMENTS_IPN_SECRET).update(body).digest("hex");
      if (sig !== expected) return res.status(401).json({ error: "Bad sig" });
    }
    const { payment_status, order_id, payment_id } = JSON.parse(body);
    if (payment_status==="confirmed"||payment_status==="finished") {
      const payment = await Payment.findOneAndUpdate({ orderId: order_id, status:"pending" }, { status:"confirmed", confirmedAt:new Date(), paymentId:payment_id }, { new:true });
      if (payment) {
        if (payment.type==="subscription") {
          const user = await User.findById(payment.userId);
          const base = user?.planExpiresAt>new Date()?user.planExpiresAt:new Date();
          const expiry = new Date(base); expiry.setMonth(expiry.getMonth()+payment.months);
          await User.findByIdAndUpdate(payment.userId, { plan:payment.plan, planExpiresAt:expiry, $inc:{totalSpent:payment.amountUsd} });
          if (user?.referredBy) {
            const commission = Math.floor(payment.amountUsd*0.2);
            await User.findByIdAndUpdate(user.referredBy, { $inc:{referralEarnings:commission,credits:commission*10} });
          }
        } else {
          await User.findByIdAndUpdate(payment.userId, { $inc:{credits:payment.credits,totalSpent:payment.amountUsd} });
        }
        notifyWebhook(payment.userId, "payment_confirmed", { amount:payment.amountUsd, type:payment.type });
      }
    }
    res.json({ ok: true });
  } catch (e) { console.error("Webhook error:", e.message); res.json({ ok: true }); }
});

app.get("/api/payments/status/:orderId", auth, async (req, res) => {
  try {
    const p = await Payment.findOne({ orderId:req.params.orderId, userId:req.user.id });
    if (!p) return res.status(404).json({ error: "Not found" });
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/payments", auth, async (req, res) => {
  try { res.json(await Payment.find({ userId:req.user.id }).sort({ createdAt:-1 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN ─────────────────────────────────────────────────────────────────────
app.get("/api/admin/stats", adminAuth, async (req, res) => {
  try {
    const [totalUsers, paidUsers, totalCampaigns, totalSent, revenueAgg] = await Promise.all([
      User.countDocuments(), User.countDocuments({ plan:{$ne:"trial"} }),
      Campaign.countDocuments(), CampaignLog.countDocuments({ status:"sent" }),
      Payment.aggregate([{$match:{status:"confirmed"}},{$group:{_id:null,total:{$sum:"$amountUsd"}}}]),
    ]);
    const planBreakdown = await User.aggregate([{$group:{_id:"$plan",count:{$sum:1}}}]);
    const recentPayments = await Payment.find({ status:"confirmed" }).sort({ confirmedAt:-1 }).limit(10).populate("userId","name email");
    const recentUsers = await User.find().sort({ createdAt:-1 }).limit(10).select("-password");
    const dailySignups = [];
    for (let i=6; i>=0; i--) {
      const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-i);
      const next=new Date(d); next.setDate(d.getDate()+1);
      const count=await User.countDocuments({ createdAt:{$gte:d,$lt:next} });
      dailySignups.push({ date:d.toLocaleDateString("en-US",{weekday:"short"}), signups:count });
    }
    res.json({ totalUsers, paidUsers, totalCampaigns, totalSent, totalRevenue:revenueAgg[0]?.total||0, planBreakdown, recentPayments, recentUsers, dailySignups });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/users", adminAuth, async (req, res) => {
  try {
    const { search, plan, page=1, limit=50 } = req.query;
    const filter = {};
    if (search) filter.$or = [{ name:{$regex:search,$options:"i"} },{ email:{$regex:search,$options:"i"} }];
    if (plan) filter.plan = plan;
    const skip = (parseInt(page)-1)*parseInt(limit);
    const [users, total] = await Promise.all([
      User.find(filter).select("-password").sort({ createdAt:-1 }).skip(skip).limit(parseInt(limit)),
      User.countDocuments(filter),
    ]);
    res.json({ users, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/admin/users/:id", adminAuth, async (req, res) => {
  try {
    const { plan, credits, isAdmin, planExpiresAt } = req.body;
    const update = {};
    if (plan!==undefined) update.plan=plan;
    if (credits!==undefined) update.credits=parseInt(credits);
    if (isAdmin!==undefined) update.isAdmin=isAdmin;
    if (planExpiresAt) update.planExpiresAt=new Date(planExpiresAt);
    res.json(await User.findByIdAndUpdate(req.params.id, update, { new:true }).select("-password"));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/users/:id", adminAuth, async (req, res) => {
  try {
    const uid = req.params.id;
    await Promise.all([User.findByIdAndDelete(uid),TgAccount.deleteMany({userId:uid}),TgGroup.deleteMany({userId:uid}),Campaign.deleteMany({userId:uid}),CampaignLog.deleteMany({userId:uid}),InboxMessage.deleteMany({userId:uid})]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/grant", adminAuth, async (req, res) => {
  try {
    const { email, plan, months=1, credits=0 } = req.body;
    const user = await User.findOne({ email:email.toLowerCase() });
    if (!user) return res.status(404).json({ error: "User not found" });
    const update = {};
    if (plan) { const exp=new Date(); exp.setMonth(exp.getMonth()+parseInt(months)); update.plan=plan; update.planExpiresAt=exp; }
    if (parseInt(credits)>0) update.$inc={ credits:parseInt(credits) };
    await User.findByIdAndUpdate(user._id, update);
    res.json({ success:true, message:`Granted to ${email}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/payments", adminAuth, async (req, res) => {
  try { res.json(await Payment.find().sort({ createdAt:-1 }).limit(200).populate("userId","name email")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "✅ CampaignX v3.0", uptime: process.uptime() }));
app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 3001, () => console.log(`🚀 CampaignX v3.0 on port ${process.env.PORT || 3001}`));
