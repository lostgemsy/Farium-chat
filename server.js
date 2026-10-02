"use strict";

/* ═══════════════════════════════════════════════════════════════════════
   Farius Chat — Vercel Serverless Edition
   Express + Socket.IO + Upstash Redis + Vercel Blob
   ═══════════════════════════════════════════════════════════════════════ */

const express     = require("express");
const http        = require("http");
const path        = require("path");
const fs          = require("fs");
const crypto      = require("crypto");
const bcrypt      = require("bcryptjs");
const jwt         = require("jsonwebtoken");
const multer      = require("multer");
const helmet      = require("helmet");
const compression = require("compression");
const rateLimit   = require("express-rate-limit");
const { execFile } = require("child_process");
const ffmpegPath  = require("ffmpeg-static");
const { Server }  = require("socket.io");
const { Redis }   = require("@upstash/redis");
const { put }     = require("@vercel/blob");

/* ───────────────────────────── Config ───────────────────────────── */
const PORT            = Number(process.env.PORT || 3000);
const JWT_SECRET      = process.env.JWT_SECRET     || "farius-chat-change-this-secret";
const ADMIN_USERNAME  = process.env.ADMIN_USERNAME || "hogohames";
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD || "28426713fg";
const TOKEN_TTL       = "7d";

const MAX_MESSAGE_LEN = 2000;
const MAX_HISTORY     = 200;
const MAX_DB_MESSAGES = 8000;
const TRIM_TO         = 5000;
const MAX_UPLOAD_B    = 100 * 1024 * 1024;

/* ───────────────────────────── Storage ───────────────────────────── */
const redis = Redis.fromEnv();

/* ───────────────────────────── App ──────────────────────────────── */
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(compression());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

/* Serve static files (HTML, CSS, JS, wallpaper) from public/ */
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/", rateLimit({
  windowMs: 60_000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, slow down." }
}));

const authLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auth attempts. Try again later." }
});

/* ─────────────────────────── Uploads (Vercel Blob) ───────────────── */
const ALLOWED_MIME = /^(image\/(png|jpe?g|gif|webp|avif)|video\/(mp4|webm|quicktime|ogg)|audio\/(mpeg|wav|ogg|webm|mp4))/;

const upload = multer({
  storage: multer.memoryStorage(), // Vercel Blob needs the buffer, not a disk path
  limits: { fileSize: MAX_UPLOAD_B, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.test(file.mimetype)) {
      return cb(new Error("Unsupported file type."));
    }
    cb(null, true);
  }
});

/* ─────────────────────────── Redis Helpers ──────────────────────── */
const rid = (prefix = "") => prefix + crypto.randomBytes(9).toString("hex");
const now = () => Date.now();
const safeText = (v, max = MAX_MESSAGE_LEN) => String(v ?? "").trim().slice(0, max);

async function getUsers() {
  return await redis.get("farius:users") || [];
}
async function saveUsers(users) {
  await redis.set("farius:users", JSON.stringify(users));
}
async function getMessages() {
  const data = await redis.get("farius:messages");
  return data || [];
}
async function saveMessages(messages) {
  if (messages.length > MAX_DB_MESSAGES) messages = messages.slice(-TRIM_TO);
  await redis.set("farius:messages", JSON.stringify(messages));
}
async function getGroups() {
  return await redis.get("farius:groups") || [];
}
async function saveGroups(groups) {
  await redis.set("farius:groups", JSON.stringify(groups));
}
async function getBans() {
  return await redis.get("farius:bans") || [];
}
async function saveBans(bans) {
  await redis.set("farius:bans", JSON.stringify(bans));
}
async function getMutes() {
  return await redis.get("farius:mutes") || [];
}
async function saveMutes(mutes) {
  await redis.set("farius:mutes", JSON.stringify(mutes));
}
async function getAnnouncements() {
  return await redis.get("farius:announcements") || [];
}
async function saveAnnouncements(announcements) {
  await redis.set("farius:announcements", JSON.stringify(announcements));
}
async function getAuditLog() {
  return await redis.get("farius:auditLog") || [];
}
async function saveAuditLog(log) {
  if (log.length > 2000) log = log.slice(-2000);
  await redis.set("farius:auditLog", JSON.stringify(log));
}

const findUser = async (username) => {
  const users = await getUsers();
  return users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
};
const findUserById = async (id) => {
  const users = await getUsers();
  return users.find(u => u.id === id);
};

const publicUser = (u) => u && {
  id: u.id,
  username: u.username,
  avatar: u.avatar || "",
  background: u.background || "",
  role: u.role || "user",
  createdAt: u.createdAt
};

const tokenFor = (user) =>
  jwt.sign({ sub: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });

const roleOf = (u) => (u && u.role) || "user";
const isAdmin = (u) => roleOf(u) === "admin";
const isMod = (u) => roleOf(u) === "mod" || isAdmin(u);

const activeBan = async (userId) => {
  const bans = await getBans();
  return bans.find(b => b.userId === userId && (b.permanent || (b.until && b.until > now())));
};
const activeMute = async (userId) => {
  const mutes = await getMutes();
  return mutes.find(m => m.userId === userId && m.until > now());
};

/* ─────────────────────── Moderation normalizer ──────────────────── */
const BLOCKED = new Set([
  "nigger","niggers","nigga","niggah","niggas",
  "faggot","faggots","retard","retarded",
  "kike","spic","chink","coon"
]);

function normalizeForModeration(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[@4]/g, "a")
    .replace(/3/g, "e")
    .replace(/[1!|]/g, "i")
    .replace(/0/g, "o")
    .replace(/[5$]/g, "s")
    .replace(/7/g, "t")
    .replace(/[^a-z0-9]/g, "")
    .replace(/(.)\1{2,}/g, "$1$1");
}
function containsBlocked(text) {
  const n = normalizeForModeration(text);
  for (const word of BLOCKED) if (n.includes(word)) return true;
  return false;
}

/* ───────────────────────── Auth Middleware ─────────────────────── */
async function auth(req, res, next) {
  try {
    const raw = req.headers.authorization || "";
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Sign in required." });

    const payload = jwt.verify(token, JWT_SECRET);
    const user = await findUserById(payload.sub);
    if (!user) return res.status(401).json({ error: "Account not found." });

    const ban = await activeBan(user.id);
    if (ban) {
      return res.status(403).json({
        error: `You are banned ${
          ban.permanent ? "permanently" : `until ${new Date(ban.until).toLocaleString()}`
        }.`
      });
    }

    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Invalid session." });
  }
}

async function adminOnly(req, res, next) {
  auth(req, res, async () => {
    if (!isAdmin(req.user)) return res.status(403).json({ error: "Admin only." });
    next();
  });
}

async function staffOnly(req, res, next) {
  auth(req, res, async () => {
    if (!isMod(req.user)) return res.status(403).json({ error: "Staff only." });
    next();
  });
}

/* ═══════════════════════════ Auth Routes ═════════════════════════ */
app.post("/api/auth/signup", authLimiter, upload.single("avatar"), async (req, res) => {
  try {
    const username = safeText(req.body.username, 24);
    const password = String(req.body.password || "");

    if (!/^[A-Za-z0-9_]{3,24}$/.test(username))
      return res.status(400).json({ error: "Username must be 3-24 letters, numbers, or underscores." });
    if (password.length < 8)
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    if (await findUser(username))
      return res.status(409).json({ error: "Username is already taken." });

    const users = await getUsers();
    const isFounder = username.toLowerCase() === ADMIN_USERNAME.toLowerCase()
                   && password === ADMIN_PASSWORD;

    let avatarUrl = "";
    if (req.file) {
      const blob = await put(`avatars/${Date.now()}-${crypto.randomBytes(5).toString("hex")}${path.extname(req.file.originalname)}`, req.file.buffer, {
        access: "public",
        addRandomSuffix: true,
      });
      avatarUrl = blob.url;
    }

    const user = {
      id: rid("u_"),
      username,
      passwordHash: await bcrypt.hash(password, 12),
      avatar: avatarUrl,
      background: "",
      createdAt: now(),
      role: isFounder ? "admin" : "user",
      friends: [],
      friendRequests: []
    };

    users.push(user);
    await saveUsers(users);

    res.json({ token: tokenFor(user), user: publicUser(user) });
  } catch (err) {
    console.error("[signup]", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/signin", authLimiter, async (req, res) => {
  try {
    const username = safeText(req.body.username, 24);
    const password = String(req.body.password || "");
    let user = await findUser(username);

    /* Auto-create the founder account on first sign-in if it doesn't exist */
    if (!user
        && username.toLowerCase() === ADMIN_USERNAME.toLowerCase()
        && password === ADMIN_PASSWORD) {
      const users = await getUsers();
      user = {
        id: rid("u_"),
        username,
        passwordHash: await bcrypt.hash(password, 12),
        avatar: "",
        background: "",
        createdAt: now(),
        role: "admin",
        friends: [],
        friendRequests: []
      };
      users.push(user);
      await saveUsers(users);
      // Audit log
      const log = await getAuditLog();
      log.push({ id: rid("log_"), at: now(), type: "founder-bootstrap", target: user.id });
      await saveAuditLog(log);
    }

    const ok = user && await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Invalid username or password." });

    /* Promote to admin if founder credentials match an existing account */
    if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase()
        && password === ADMIN_PASSWORD
        && user.role !== "admin") {
      const users = await getUsers();
      const idx = users.findIndex(u => u.id === user.id);
      users[idx].role = "admin";
      user = users[idx];
      await saveUsers(users);
    }

    const ban = await activeBan(user.id);
    if (ban) {
      return res.status(403).json({
        error: `You are banned ${
          ban.permanent ? "permanently" : `until ${new Date(ban.until).toLocaleString()}`
        }.`
      });
    }

    res.json({ token: tokenFor(user), user: publicUser(user) });
  } catch (err) {
    console.error("[signin]", err);
    res.status(500).json({ error: "Sign-in failed." });
  }
});

app.get("/api/me", auth, async (req, res) => {
  const mute = await activeMute(req.user.id);
  res.json({
    user: publicUser(req.user),
    mute: mute || null
  });
});

/* ═══════════════════════════ Profile ═════════════════════════════ */
app.post("/api/profile", auth, upload.single("avatar"), async (req, res) => {
  const users = await getUsers();
  const idx = users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error: "User not found." });

  const username = safeText(req.body.username, 24);
  if (username && username !== req.user.username) {
    if (!/^[A-Za-z0-9_]{3,24}$/.test(username))
      return res.status(400).json({ error: "Invalid username." });

    const taken = users.find(u => u.username.toLowerCase() === username.toLowerCase() && u.id !== req.user.id);
    if (taken) return res.status(409).json({ error: "Username is taken." });

    users[idx].username = username;
  }

  if (req.file) {
    const blob = await put(`avatars/${Date.now()}-${crypto.randomBytes(5).toString("hex")}${path.extname(req.file.originalname)}`, req.file.buffer, {
      access: "public",
      addRandomSuffix: true,
    });
    users[idx].avatar = blob.url;
  }

  if (typeof req.body.background === "string")
    users[idx].background = safeText(req.body.background, 500);

  await saveUsers(users);
  res.json({ user: publicUser(users[idx]), token: tokenFor(users[idx]) });
});

/* ══════════════════════ Users / Friends ═════════════════════════ */
app.get("/api/users/search", auth, async (req, res) => {
  const q = safeText(req.query.q, 24).toLowerCase();
  if (!q) return res.json({ users: [] });

  const users = await getUsers();
  const results = users
    .filter(u => u.id !== req.user.id && u.username.toLowerCase().includes(q))
    .slice(0, 20);

  res.json({ users: results.map(publicUser) });
});

app.post("/api/friends/request", auth, async (req, res) => {
  const users = await getUsers();
  const target = users.find(u => u.id === req.body.userId);
  if (!target || target.id === req.user.id)
    return res.status(404).json({ error: "User not found." });

  target.friendRequests = target.friendRequests || [];
  if (!target.friendRequests.includes(req.user.id) &&
      !req.user.friends?.includes(target.id)) {
    target.friendRequests.push(req.user.id);
  }
  await saveUsers(users);
  res.json({ ok: true });
});

app.post("/api/friends/accept", auth, async (req, res) => {
  const users = await getUsers();
  const idx = users.findIndex(u => u.id === req.user.id);
  const requesterIdx = users.findIndex(u => u.id === req.body.userId);
  if (requesterIdx === -1) return res.status(404).json({ error: "User not found." });

  users[idx].friendRequests = (users[idx].friendRequests || []).filter(x => x !== req.body.userId);
  users[idx].friends = users[idx].friends || [];
  users[requesterIdx].friends = users[requesterIdx].friends || [];

  if (!users[idx].friends.includes(req.body.userId)) users[idx].friends.push(req.body.userId);
  if (!users[requesterIdx].friends.includes(req.user.id)) users[requesterIdx].friends.push(req.user.id);

  await saveUsers(users);
  res.json({ ok: true });
});

app.post("/api/friends/remove", auth, async (req, res) => {
  const users = await getUsers();
  const idx = users.findIndex(u => u.id === req.user.id);
  const targetIdx = users.findIndex(u => u.id === req.body.userId);
  if (targetIdx === -1) return res.status(404).json({ error: "User not found." });

  users[idx].friends = (users[idx].friends || []).filter(x => x !== req.body.userId);
  users[targetIdx].friends = (users[targetIdx].friends || []).filter(x => x !== req.user.id);

  await saveUsers(users);
  res.json({ ok: true });
});

app.get("/api/friends", auth, async (req, res) => {
  const users = await getUsers();
  const friends = (req.user.friends || [])
    .map(id => users.find(u => u.id === id)).filter(Boolean).map(publicUser);
  const requests = (req.user.friendRequests || [])
    .map(id => users.find(u => u.id === id)).filter(Boolean).map(publicUser);

  res.json({ friends, requests });
});

/* ═════════════════════════ Messages ═════════════════════════════ */
app.get("/api/messages/global", auth, async (_req, res) => {
  const messages = await getMessages();
  res.json({
    messages: messages.filter(m => m.scope === "global").slice(-MAX_HISTORY)
  });
});

app.get("/api/messages/:peerId", auth, async (req, res) => {
  const me = req.user.id;
  const peer = req.params.peerId;
  const messages = await getMessages();

  const filtered = messages
    .filter(m => m.scope === "dm" && (
      (m.fromId === me && m.toId === peer) ||
      (m.fromId === peer && m.toId === me)
    ))
    .slice(-MAX_HISTORY);

  res.json({ messages: filtered });
});

/* ══════════════════════════ Groups ══════════════════════════════ */
const groupPublic = (g) => ({
  id: g.id,
  name: g.name,
  description: g.description,
  type: g.type,
  private: !!g.private,
  ownerId: g.ownerId,
  memberCount: g.members.length,
  persistentCall: !!g.persistentCall,
  createdAt: g.createdAt
});

app.post("/api/groups", auth, async (req, res) => {
  const name        = safeText(req.body.name, 40);
  const description = safeText(req.body.description, 180);
  const type        = req.body.type === "call" ? "call" : "chat";
  const isPrivate   = !!req.body.private;
  const password    = isPrivate ? String(req.body.password || "") : "";

  if (name.length < 2)
    return res.status(400).json({ error: "Group name is too short." });
  if (isPrivate && password.length < 4)
    return res.status(400).json({ error: "Private groups need a password of 4+ characters." });

  const groups = await getGroups();
  const group = {
    id: rid("g_"),
    name,
    description,
    type,
    private: isPrivate,
    passwordHash: isPrivate ? bcrypt.hashSync(password, 10) : "",
    ownerId: req.user.id,
    members: [req.user.id],
    persistentCall: !!req.body.persistentCall,
    createdAt: now()
  };

  groups.push(group);
  await saveGroups(groups);
  res.json({ group: groupPublic(group) });
});

app.get("/api/groups", auth, async (_req, res) => {
  const groups = await getGroups();
  res.json({ groups: groups.filter(g => !g.private).map(groupPublic) });
});

app.get("/api/groups/mine", auth, async (req, res) => {
  const groups = await getGroups();
  res.json({
    groups: groups.filter(g => g.members.includes(req.user.id)).map(groupPublic)
  });
});

app.post("/api/groups/:groupId/join", auth, async (req, res) => {
  const groups = await getGroups();
  const idx = groups.findIndex(x => x.id === req.params.groupId);
  if (idx === -1) return res.status(404).json({ error: "Group not found." });

  const g = groups[idx];
  if (g.private) {
    const pass = String(req.body.password || "");
    const ok = g.passwordHash && await bcrypt.compare(pass, g.passwordHash);
    if (!ok) return res.status(403).json({ error: "Incorrect group password." });
  }

  if (!g.members.includes(req.user.id)) g.members.push(req.user.id);
  await saveGroups(groups);
  res.json({ group: groupPublic(g) });
});

app.post("/api/groups/:groupId/leave", auth, async (req, res) => {
  const groups = await getGroups();
  const idx = groups.findIndex(x => x.id === req.params.groupId);
  if (idx === -1) return res.status(404).json({ error: "Group not found." });

  groups[idx].members = groups[idx].members.filter(id => id !== req.user.id);
  await saveGroups(groups);
  res.json({ ok: true });
});

app.get("/api/groups/:groupId/messages", auth, async (req, res) => {
  const groups = await getGroups();
  const g = groups.find(x => x.id === req.params.groupId);
  if (!g || !g.members.includes(req.user.id))
    return res.status(403).json({ error: "Join the group first." });

  const messages = await getMessages();
  const filtered = messages
    .filter(m => m.scope === "group" && m.groupId === g.id)
    .slice(-MAX_HISTORY);

  res.json({ messages: filtered });
});

/* ═══════════════════════ Uploads + GIF ══════════════════════════ */
app.post("/api/upload", auth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  try {
    const blob = await put(`uploads/${Date.now()}-${crypto.randomBytes(5).toString("hex")}${path.extname(req.file.originalname)}`, req.file.buffer, {
      access: "public",
      addRandomSuffix: true,
    });

    res.json({
      url: blob.url,
      name: req.file.originalname,
      type: req.file.mimetype,
      size: req.file.size
    });
  } catch (err) {
    console.error("[upload]", err);
    res.status(500).json({ error: "Upload failed." });
  }
});

app.post("/api/gif", auth, upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Upload a video." });
  if (!req.file.mimetype.startsWith("video/")) {
    return res.status(400).json({ error: "Only videos can be converted." });
  }

  // For Vercel, we'll skip local ffmpeg and just return the video URL as a fallback
  // In production, you'd use a serverless video processing service
  try {
    const blob = await put(`gifs/${Date.now()}-${crypto.randomBytes(5).toString("hex")}.mp4`, req.file.buffer, {
      access: "public",
      addRandomSuffix: true,
    });

    res.json({
      url: blob.url,
      name: "farius.mp4",
      type: "video/mp4"
    });
  } catch (err) {
    console.error("[gif]", err);
    res.status(500).json({ error: "GIF conversion failed." });
  }
});

/* ═════════════════════════ Moderation ═══════════════════════════ */
app.get("/api/moderation", staffOnly, async (_req, res) => {
  const users = await getUsers();
  const bans = await getBans();
  const mutes = await getMutes();
  const announcements = await getAnnouncements();

  const mapped = users.map(u => ({
    ...publicUser(u),
    banned: !!bans.find(b => b.userId === u.id && (b.permanent || (b.until && b.until > now()))),
    muted: !!mutes.find(m => m.userId === u.id && m.until > now())
  }));

  res.json({
    users: mapped,
    bans,
    mutes,
    announcements: announcements.slice(-50)
  });
});

app.post("/api/moderation/mute", staffOnly, async (req, res) => {
  const users = await getUsers();
  const target = users.find(u => u.id === req.body.userId);
  if (!target) return res.status(404).json({ error: "User not found." });
  if (isAdmin(target) && !isAdmin(req.user))
    return res.status(403).json({ error: "Only admins can mute other admins." });

  const minutes = Math.max(1, Math.min(Number(req.body.minutes || 10), 60 * 24 * 30));
  const mutes = await getMutes();
  mutes.push({
    id: rid("m_"),
    userId: target.id,
    until: now() + minutes * 60_000,
    by: req.user.id,
    reason: safeText(req.body.reason, 200)
  });
  await saveMutes(mutes);

  // Audit
  const log = await getAuditLog();
  log.push({ id: rid("log_"), at: now(), type: "mute", target: target.id, by: req.user.id, minutes });
  await saveAuditLog(log);

  emitToUser(target.id, "toast", {
    type: "info",
    message: `You were muted for ${minutes} minute(s).`
  });

  res.json({ ok: true });
});

app.post("/api/moderation/ban", staffOnly, async (req, res) => {
  const users = await getUsers();
  const target = users.find(u => u.id === req.body.userId);
  if (!target || target.id === req.user.id)
    return res.status(404).json({ error: "User not found." });
  if (isAdmin(target) && !isAdmin(req.user))
    return res.status(403).json({ error: "Only admins can ban other admins." });

  const permanent = !!req.body.permanent;
  const days = Math.max(1, Math.min(Number(req.body.days || 1), 3650));

  const bans = await getBans();
  bans.push({
    id: rid("b_"),
    userId: target.id,
    until: permanent ? null : now() + days * 86_400_000,
    permanent,
    by: req.user.id,
    reason: safeText(req.body.reason, 200),
    createdAt: now()
  });
  await saveBans(bans);

  // Audit
  const log = await getAuditLog();
  log.push({ id: rid("log_"), at: now(), type: "ban", target: target.id, by: req.user.id, permanent, days });
  await saveAuditLog(log);

  for (const sid of getSockets(target.id)) {
    io.to(sid).emit("forced-logout", {
      reason: permanent ? "Permanently banned." : `Banned for ${days} day(s).`
    });
  }
  res.json({ ok: true });
});

app.post("/api/moderation/unban", staffOnly, async (req, res) => {
  let bans = await getBans();
  bans = bans.filter(b => b.userId !== req.body.userId);
  await saveBans(bans);
  res.json({ ok: true });
});

app.post("/api/moderation/announcement", adminOnly, async (req, res) => {
  const message = safeText(req.body.message, 1000);
  if (!message)
    return res.status(400).json({ error: "Announcement cannot be empty." });
  if (containsBlocked(message))
    return res.status(400).json({ error: "Announcement contains blocked language." });

  const announcements = await getAnnouncements();
  const announcement = { id: rid("a_"), message, createdAt: now(), by: req.user.id };
  announcements.push(announcement);
  await saveAnnouncements(announcements);

  io.emit("announcement", announcement);
  res.json({ announcement });
});

/* ═══════════════════ Role management (admin only) ═══════════════ */
app.post("/api/admin/role", adminOnly, async (req, res) => {
  const users = await getUsers();
  const targetIdx = users.findIndex(u => u.id === req.body.userId);
  if (targetIdx === -1) return res.status(404).json({ error: "User not found." });
  if (users[targetIdx].id === req.user.id)
    return res.status(400).json({ error: "You cannot change your own role." });

  const role = String(req.body.role || "");
  if (!["user", "mod", "admin"].includes(role))
    return res.status(400).json({ error: "Invalid role." });

  const before = users[targetIdx].role || "user";
  users[targetIdx].role = role;
  await saveUsers(users);

  // Audit
  const log = await getAuditLog();
  log.push({ id: rid("log_"), at: now(), type: "role", target: users[targetIdx].id, by: req.user.id, before, after: role });
  await saveAuditLog(log);

  emitToUser(users[targetIdx].id, "role-changed", { role });
  emitToUser(users[targetIdx].id, "toast", {
    type: "info",
    message: `Your role was updated to ${role}.`
  });

  res.json({ user: publicUser(users[targetIdx]) });
});

/* ═══════════════════════ SPA fallback ═══════════════════════════ */
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ═════════════════════════ Socket.IO ════════════════════════════ */
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 10 * 1024 * 1024,
  pingTimeout: 25_000
});

const onlineSockets = new Map(); // userId -> Set<socketId>

const getSockets = (userId) => onlineSockets.get(userId) || new Set();
const emitToUser = (userId, event, payload) => {
  for (const sid of getSockets(userId)) io.to(sid).emit(event, payload);
};

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await findUserById(payload.sub);
    if (!user || await activeBan(user.id)) return next(new Error("Unauthorized"));
    socket.userId = user.id;
    next();
  } catch {
    next(new Error("Unauthorized"));
  }
});

async function pushMessage(m) {
  const messages = await getMessages();
  messages.push(m);
  await saveMessages(messages);
}

io.on("connection", async (socket) => {
  const user = await findUserById(socket.userId);
  if (!user) return socket.disconnect(true);

  if (!onlineSockets.has(user.id)) onlineSockets.set(user.id, new Set());
  onlineSockets.get(user.id).add(socket.id);

  const announcements = await getAnnouncements();
  socket.emit("ready", {
    user: publicUser(user),
    announcements: announcements.slice(-5)
  });
  io.emit("presence", { userId: user.id, online: true });

  /* ── Chat ── */
  socket.on("global-message", async (data) => {
    if (await activeMute(user.id))
      return socket.emit("toast", { type: "error", message: "You are muted." });

    const text = safeText(data?.text);
    if (!text) return;
    if (containsBlocked(text))
      return socket.emit("toast", { type: "error", message: "That message was blocked." });

    const message = {
      id: rid("msg_"),
      scope: "global",
      fromId: user.id,
      username: user.username,
      avatar: user.avatar || "",
      text,
      createdAt: now()
    };
    await pushMessage(message);
    io.emit("global-message", message);
  });

  socket.on("dm-message", async (data) => {
    if (await activeMute(user.id))
      return socket.emit("toast", { type: "error", message: "You are muted." });

    const toId = safeText(data?.toId, 80);
    const target = await findUserById(toId);
    const text = safeText(data?.text);
    if (!target || !text) return;
    if (containsBlocked(text))
      return socket.emit("toast", { type: "error", message: "That message was blocked." });

    const message = {
      id: rid("msg_"),
      scope: "dm",
      fromId: user.id,
      toId,
      username: user.username,
      avatar: user.avatar || "",
      text,
      createdAt: now()
    };
    await pushMessage(message);

    const recipients = new Set([socket.id, ...getSockets(toId)]);
    for (const sid of recipients) io.to(sid).emit("dm-message", message);
  });

  socket.on("group-message", async (data) => {
    if (await activeMute(user.id))
      return socket.emit("toast", { type: "error", message: "You are muted." });

    const groupId = safeText(data?.groupId, 80);
    const groups = await getGroups();
    const group = groups.find(x => x.id === groupId);
    const text = safeText(data?.text);

    if (!group || !group.members.includes(user.id) || !text) return;
    if (containsBlocked(text))
      return socket.emit("toast", { type: "error", message: "That message was blocked." });

    const message = {
      id: rid("msg_"),
      scope: "group",
      groupId,
      fromId: user.id,
      username: user.username,
      avatar: user.avatar || "",
      text,
      createdAt: now()
    };
    await pushMessage(message);

    for (const uid of group.members) {
      for (const sid of getSockets(uid)) io.to(sid).emit("group-message", message);
    }
  });

  /* ── Typing ── */
  socket.on("typing", (data) => {
    const scope = data?.scope;
    if (scope === "global") {
      socket.broadcast.emit("typing", {
        scope, fromId: user.id, username: user.username
      });
    } else if (scope === "dm") {
      emitToUser(data.toId, "typing", {
        scope, fromId: user.id, username: user.username
      });
    } else if (scope === "group") {
      getGroups().then(groups => {
        const group = groups.find(x => x.id === data.groupId);
        if (!group || !group.members.includes(user.id)) return;
        for (const uid of group.members) {
          if (uid === user.id) continue;
          emitToUser(uid, "typing", {
            scope, fromId: user.id, username: user.username, groupId: group.id
          });
        }
      });
    }
  });

  /* ── Direct call signaling ── */
  socket.on("call-invite", async (data) => {
    const toId = safeText(data?.toId, 80);
    const target = await findUserById(toId);
    if (!target) return;
    emitToUser(toId, "incoming-call", {
      callId: data.callId,
      fromId: user.id,
      fromUsername: user.username,
      fromAvatar: user.avatar || "",
      video: !!data.video,
      groupId: data.groupId || null
    });
  });

  socket.on("call-offer", (data) => {
    const toId = safeText(data?.toId, 80);
    emitToUser(toId, "call-offer", {
      fromId: user.id, offer: data.offer, callId: data.callId
    });
  });

  socket.on("call-answer", (data) => {
    const toId = safeText(data?.toId, 80);
    emitToUser(toId, "call-answer", {
      fromId: user.id, answer: data.answer, callId: data.callId
    });
  });

  socket.on("ice-candidate", (data) => {
    const toId = safeText(data?.toId, 80);
    emitToUser(toId, "ice-candidate", {
      fromId: user.id, candidate: data.candidate, callId: data.callId
    });
  });

  socket.on("call-end", (data) => {
    const toId = safeText(data?.toId, 80);
    emitToUser(toId, "call-ended", { fromId: user.id, callId: data.callId });
  });

  /* ── Group call mesh ── */
  socket.on("group-call-signal", async (data) => {
    const groups = await getGroups();
    const group = groups.find(x => x.id === data?.groupId);
    if (!group || !group.members.includes(user.id) || group.type !== "call") return;

    for (const uid of group.members) {
      if (uid === user.id) continue;
      emitToUser(uid, "group-call-signal", {
        fromId: user.id,
        groupId: group.id,
        kind: data.kind,
        payload: data.payload
      });
    }
  });

  socket.on("disconnect", () => {
    const set = onlineSockets.get(user.id);
    if (!set) return;
    set.delete(socket.id);
    if (!set.size) {
      onlineSockets.delete(user.id);
      io.emit("presence", { userId: user.id, online: false });
    }
  });
});

/* ═══════════════════════════ Export for Vercel ═════════════════ */
module.exports = server;

/* ═══════════════════════════ Local dev boot ═════════════════ */
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n  ▲  Farius Chat\n  →  http://localhost:${PORT}\n`);
  });
}