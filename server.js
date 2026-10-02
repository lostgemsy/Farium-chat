"use strict";

/* ═══════════════════════════════════════════════════════════════════════
   Farius Chat — server
   Express + Socket.IO + JSON store + WebRTC signaling + roles + moderation
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

/* ───────────────────────────── Paths ────────────────────────────── */
const ROOT       = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR   = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads");
const DB_FILE    = path.join(DATA_DIR, "db.json");

fs.mkdirSync(DATA_DIR,   { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ───────────────────────── Persistent store ─────────────────────── */
const SCHEMA = {
  users: [],
  messages: [],
  groups: [],
  announcements: [],
  bans: [],
  mutes: [],
  auditLog: []
};

let db;
try {
  db = fs.existsSync(DB_FILE)
    ? JSON.parse(fs.readFileSync(DB_FILE, "utf8"))
    : structuredClone(SCHEMA);
} catch (err) {
  console.warn("[db] could not read db.json, starting fresh:", err.message);
  db = structuredClone(SCHEMA);
}
for (const k of Object.keys(SCHEMA)) {
  if (!Array.isArray(db[k])) db[k] = [];
}

/* Migrate legacy isAdmin → role */
for (const u of db.users) {
  if (!u.role) u.role = u.isAdmin ? "admin" : "user";
  delete u.isAdmin;
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flushSave(); }, 250);
}
function flushSave() {
  const tmp = DB_FILE + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    console.error("[db] write failed:", err.message);
  }
}
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  flushSave();
}

/* ───────────────────────────── Helpers ──────────────────────────── */
const rid      = (prefix = "") => prefix + crypto.randomBytes(9).toString("hex");
const now      = () => Date.now();
const safeText = (v, max = MAX_MESSAGE_LEN) => String(v ?? "").trim().slice(0, max);

const findUser     = (username) =>
  db.users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
const findUserById = (id) => db.users.find(u => u.id === id);

const publicUser = (u) => u && {
  id: u.id,
  username: u.username,
  avatar: u.avatar || "",
  background: u.background || "",
  role: u.role || "user",
  createdAt: u.createdAt
};

const tokenFor = (user) =>
  jwt.sign({ sub: user.id, username: user.username, role: user.role },
           JWT_SECRET, { expiresIn: TOKEN_TTL });

const roleOf  = (u) => (u && u.role) || "user";
const isAdmin = (u) => roleOf(u) === "admin";
const isMod   = (u) => roleOf(u) === "mod" || isAdmin(u);

const activeBan  = (userId) => db.bans.find(b =>
  b.userId === userId && (b.permanent || (b.until && b.until > now())));
const activeMute = (userId) => db.mutes.find(m =>
  m.userId === userId && m.until > now());

function audit(entry) {
  db.auditLog.push({ id: rid("log_"), at: now(), ...entry });
  if (db.auditLog.length > 2000) db.auditLog = db.auditLog.slice(-2000);
  save();
}

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

/* ───────────────────────────── Express ─────────────────────────── */
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
app.use(express.static(PUBLIC_DIR, { maxAge: "1h", index: false }));

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

/* ─────────────────────────── Uploads ───────────────────────────── */
const ALLOWED_MIME = /^(image\/(png|jpe?g|gif|webp|avif)|video\/(mp4|webm|quicktime|ogg)|audio\/(mpeg|wav|ogg|webm|mp4))/;

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || "").toLowerCase().slice(0, 10);
      cb(null, `${Date.now()}-${crypto.randomBytes(5).toString("hex")}${ext}`);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_B, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.test(file.mimetype)) {
      return cb(new Error("Unsupported file type."));
    }
    cb(null, true);
  }
});

/* ───────────────────────── Auth middleware ─────────────────────── */
function auth(req, res, next) {
  try {
    const raw = req.headers.authorization || "";
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Sign in required." });

    const payload = jwt.verify(token, JWT_SECRET);
    const user = findUserById(payload.sub);
    if (!user) return res.status(401).json({ error: "Account not found." });

    const ban = activeBan(user.id);
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

function adminOnly(req, res, next) {
  auth(req, res, () => {
    if (!isAdmin(req.user)) return res.status(403).json({ error: "Admin only." });
    next();
  });
}

function staffOnly(req, res, next) {
  auth(req, res, () => {
    if (!isMod(req.user)) return res.status(403).json({ error: "Staff only." });
    next();
  });
}

/* ═══════════════════════════ Auth routes ═════════════════════════ */
app.post("/api/auth/signup", authLimiter, upload.single("avatar"), async (req, res) => {
  try {
    const username = safeText(req.body.username, 24);
    const password = String(req.body.password || "");

    if (!/^[A-Za-z0-9_]{3,24}$/.test(username))
      return res.status(400).json({ error: "Username must be 3-24 letters, numbers, or underscores." });
    if (password.length < 8)
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    if (findUser(username))
      return res.status(409).json({ error: "Username is already taken." });

    const isFounder = username.toLowerCase() === ADMIN_USERNAME.toLowerCase()
                   && password === ADMIN_PASSWORD;

    const user = {
      id: rid("u_"),
      username,
      passwordHash: await bcrypt.hash(password, 12),
      avatar: req.file ? `/uploads/${req.file.filename}` : "",
      background: "",
      createdAt: now(),
      role: isFounder ? "admin" : "user",
      friends: [],
      friendRequests: []
    };

    db.users.push(user);
    saveNow();

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
    let user = findUser(username);

    /* Auto-create the founder account on first sign-in if it doesn't exist */
    if (!user
        && username.toLowerCase() === ADMIN_USERNAME.toLowerCase()
        && password === ADMIN_PASSWORD) {
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
      db.users.push(user);
      saveNow();
      audit({ type: "founder-bootstrap", target: user.id });
    }

    const ok = user && await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Invalid username or password." });

    /* Promote to admin if founder credentials match an existing account */
    if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase()
        && password === ADMIN_PASSWORD
        && user.role !== "admin") {
      user.role = "admin";
      save();
    }

    const ban = activeBan(user.id);
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

app.get("/api/me", auth, (req, res) => {
  res.json({
    user: publicUser(req.user),
    mute: activeMute(req.user.id) || null
  });
});

/* ═══════════════════════════ Profile ═════════════════════════════ */
app.post("/api/profile", auth, upload.single("avatar"), (req, res) => {
  const username = safeText(req.body.username, 24);

  if (username && username !== req.user.username) {
    if (!/^[A-Za-z0-9_]{3,24}$/.test(username))
      return res.status(400).json({ error: "Invalid username." });

    const taken = findUser(username);
    if (taken && taken.id !== req.user.id)
      return res.status(409).json({ error: "Username is taken." });

    req.user.username = username;
  }

  if (req.file) req.user.avatar = `/uploads/${req.file.filename}`;
  if (typeof req.body.background === "string")
    req.user.background = safeText(req.body.background, 500);

  save();
  res.json({ user: publicUser(req.user), token: tokenFor(req.user) });
});

/* ══════════════════════ Users / Friends ═════════════════════════ */
app.get("/api/users/search", auth, (req, res) => {
  const q = safeText(req.query.q, 24).toLowerCase();
  if (!q) return res.json({ users: [] });

  const users = db.users
    .filter(u => u.id !== req.user.id && u.username.toLowerCase().includes(q))
    .slice(0, 20);

  res.json({ users: users.map(publicUser) });
});

app.post("/api/friends/request", auth, (req, res) => {
  const target = findUserById(req.body.userId);
  if (!target || target.id === req.user.id)
    return res.status(404).json({ error: "User not found." });

  target.friendRequests ||= [];
  if (!target.friendRequests.includes(req.user.id) &&
      !req.user.friends?.includes(target.id)) {
    target.friendRequests.push(req.user.id);
  }
  save();
  res.json({ ok: true });
});

app.post("/api/friends/accept", auth, (req, res) => {
  const requester = findUserById(req.body.userId);
  if (!requester) return res.status(404).json({ error: "User not found." });

  req.user.friendRequests = (req.user.friendRequests || []).filter(x => x !== requester.id);
  req.user.friends   ||= [];
  requester.friends  ||= [];

  if (!req.user.friends.includes(requester.id))   req.user.friends.push(requester.id);
  if (!requester.friends.includes(req.user.id))   requester.friends.push(req.user.id);

  save();
  res.json({ ok: true });
});

app.post("/api/friends/remove", auth, (req, res) => {
  const target = findUserById(req.body.userId);
  if (!target) return res.status(404).json({ error: "User not found." });

  req.user.friends = (req.user.friends || []).filter(x => x !== target.id);
  target.friends   = (target.friends   || []).filter(x => x !== req.user.id);

  save();
  res.json({ ok: true });
});

app.get("/api/friends", auth, (req, res) => {
  const friends  = (req.user.friends || [])
    .map(findUserById).filter(Boolean).map(publicUser);
  const requests = (req.user.friendRequests || [])
    .map(findUserById).filter(Boolean).map(publicUser);

  res.json({ friends, requests });
});

/* ═════════════════════════ Messages ═════════════════════════════ */
app.get("/api/messages/global", auth, (_req, res) => {
  res.json({
    messages: db.messages.filter(m => m.scope === "global").slice(-MAX_HISTORY)
  });
});

app.get("/api/messages/:peerId", auth, (req, res) => {
  const me = req.user.id;
  const peer = req.params.peerId;

  const messages = db.messages
    .filter(m => m.scope === "dm" && (
      (m.fromId === me && m.toId === peer) ||
      (m.fromId === peer && m.toId === me)
    ))
    .slice(-MAX_HISTORY);

  res.json({ messages });
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

app.post("/api/groups", auth, (req, res) => {
  const name        = safeText(req.body.name, 40);
  const description = safeText(req.body.description, 180);
  const type        = req.body.type === "call" ? "call" : "chat";
  const isPrivate   = !!req.body.private;
  const password    = isPrivate ? String(req.body.password || "") : "";

  if (name.length < 2)
    return res.status(400).json({ error: "Group name is too short." });
  if (isPrivate && password.length < 4)
    return res.status(400).json({ error: "Private groups need a password of 4+ characters." });

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

  db.groups.push(group);
  save();
  res.json({ group: groupPublic(group) });
});

app.get("/api/groups", auth, (_req, res) => {
  res.json({ groups: db.groups.filter(g => !g.private).map(groupPublic) });
});

app.get("/api/groups/mine", auth, (req, res) => {
  res.json({
    groups: db.groups.filter(g => g.members.includes(req.user.id)).map(groupPublic)
  });
});

app.post("/api/groups/:groupId/join", auth, async (req, res) => {
  const g = db.groups.find(x => x.id === req.params.groupId);
  if (!g) return res.status(404).json({ error: "Group not found." });

  if (g.private) {
    const pass = String(req.body.password || "");
    const ok = g.passwordHash && await bcrypt.compare(pass, g.passwordHash);
    if (!ok) return res.status(403).json({ error: "Incorrect group password." });
  }

  if (!g.members.includes(req.user.id)) g.members.push(req.user.id);
  save();
  res.json({ group: groupPublic(g) });
});

app.post("/api/groups/:groupId/leave", auth, (req, res) => {
  const g = db.groups.find(x => x.id === req.params.groupId);
  if (!g) return res.status(404).json({ error: "Group not found." });

  g.members = g.members.filter(id => id !== req.user.id);
  save();
  res.json({ ok: true });
});

app.get("/api/groups/:groupId/messages", auth, (req, res) => {
  const g = db.groups.find(x => x.id === req.params.groupId);
  if (!g || !g.members.includes(req.user.id))
    return res.status(403).json({ error: "Join the group first." });

  const messages = db.messages
    .filter(m => m.scope === "group" && m.groupId === g.id)
    .slice(-MAX_HISTORY);

  res.json({ messages });
});

/* ═══════════════════════ Uploads + GIF ══════════════════════════ */
app.post("/api/upload", auth, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  res.json({
    url:  `/uploads/${req.file.filename}`,
    name: req.file.originalname,
    type: req.file.mimetype,
    size: req.file.size
  });
});

app.post("/api/gif", auth, upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Upload a video." });
  if (!req.file.mimetype.startsWith("video/")) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: "Only videos can be converted." });
  }

  const out = path.join(
    UPLOAD_DIR,
    `${Date.now()}-${crypto.randomBytes(5).toString("hex")}.gif`
  );

  execFile(
    ffmpegPath,
    ["-y", "-i", req.file.path, "-t", "20",
     "-vf", "fps=12,scale=640:-1:flags=lanczos", "-loop", "0", out],
    { timeout: 60_000 },
    (err) => {
      fs.unlink(req.file.path, () => {});
      if (err) return res.status(400).json({ error: "GIF conversion failed." });
      res.json({
        url:  `/uploads/${path.basename(out)}`,
        name: "farius.gif",
        type: "image/gif"
      });
    }
  );
});

/* ═════════════════════════ Moderation ═══════════════════════════ */
app.get("/api/moderation", staffOnly, (_req, res) => {
  const users = db.users.map(u => ({
    ...publicUser(u),
    banned: !!activeBan(u.id),
    muted:  !!activeMute(u.id)
  }));
  res.json({
    users,
    bans: db.bans,
    mutes: db.mutes,
    announcements: db.announcements.slice(-50)
  });
});

app.post("/api/moderation/mute", staffOnly, (req, res) => {
  const target = findUserById(req.body.userId);
  if (!target) return res.status(404).json({ error: "User not found." });
  if (isAdmin(target) && !isAdmin(req.user))
    return res.status(403).json({ error: "Only admins can mute other admins." });

  const minutes = Math.max(1, Math.min(Number(req.body.minutes || 10), 60 * 24 * 30));
  db.mutes.push({
    id: rid("m_"),
    userId: target.id,
    until: now() + minutes * 60_000,
    by: req.user.id,
    reason: safeText(req.body.reason, 200)
  });
  audit({ type: "mute", target: target.id, by: req.user.id, minutes });
  save();

  emitToUser(target.id, "toast", {
    type: "info",
    message: `You were muted for ${minutes} minute(s).`
  });

  res.json({ ok: true });
});

app.post("/api/moderation/ban", staffOnly, (req, res) => {
  const target = findUserById(req.body.userId);
  if (!target || target.id === req.user.id)
    return res.status(404).json({ error: "User not found." });
  if (isAdmin(target) && !isAdmin(req.user))
    return res.status(403).json({ error: "Only admins can ban other admins." });

  const permanent = !!req.body.permanent;
  const days = Math.max(1, Math.min(Number(req.body.days || 1), 3650));

  db.bans.push({
    id: rid("b_"),
    userId: target.id,
    until: permanent ? null : now() + days * 86_400_000,
    permanent,
    by: req.user.id,
    reason: safeText(req.body.reason, 200),
    createdAt: now()
  });
  audit({ type: "ban", target: target.id, by: req.user.id, permanent, days });
  save();

  for (const sid of getSockets(target.id)) {
    io.to(sid).emit("forced-logout", {
      reason: permanent ? "Permanently banned." : `Banned for ${days} day(s).`
    });
  }
  res.json({ ok: true });
});

app.post("/api/moderation/unban", staffOnly, (req, res) => {
  db.bans = db.bans.filter(b => b.userId !== req.body.userId);
  save();
  res.json({ ok: true });
});

app.post("/api/moderation/announcement", adminOnly, (req, res) => {
  const message = safeText(req.body.message, 1000);
  if (!message)
    return res.status(400).json({ error: "Announcement cannot be empty." });
  if (containsBlocked(message))
    return res.status(400).json({ error: "Announcement contains blocked language." });

  const announcement = { id: rid("a_"), message, createdAt: now(), by: req.user.id };
  db.announcements.push(announcement);
  save();
  io.emit("announcement", announcement);
  res.json({ announcement });
});

/* ═══════════════════ Role management (admin only) ═══════════════ */
app.post("/api/admin/role", adminOnly, (req, res) => {
  const target = findUserById(req.body.userId);
  if (!target) return res.status(404).json({ error: "User not found." });
  if (target.id === req.user.id)
    return res.status(400).json({ error: "You cannot change your own role." });

  const role = String(req.body.role || "");
  if (!["user", "mod", "admin"].includes(role))
    return res.status(400).json({ error: "Invalid role." });

  const before = target.role || "user";
  target.role = role;
  audit({ type: "role", target: target.id, by: req.user.id, before, after: role });
  save();

  emitToUser(target.id, "role-changed", { role });
  emitToUser(target.id, "toast", {
    type: "info",
    message: `Your role was updated to ${role}.`
  });

  res.json({ user: publicUser(target) });
});

/* ═══════════════════════ SPA fallback ═══════════════════════════ */
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
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

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const payload = jwt.verify(token, JWT_SECRET);
    const user = findUserById(payload.sub);
    if (!user || activeBan(user.id)) return next(new Error("Unauthorized"));
    socket.userId = user.id;
    next();
  } catch {
    next(new Error("Unauthorized"));
  }
});

function pushMessage(m) {
  db.messages.push(m);
  if (db.messages.length > MAX_DB_MESSAGES) {
    db.messages = db.messages.slice(-TRIM_TO);
  }
  save();
}

io.on("connection", (socket) => {
  const user = findUserById(socket.userId);
  if (!user) return socket.disconnect(true);

  if (!onlineSockets.has(user.id)) onlineSockets.set(user.id, new Set());
  onlineSockets.get(user.id).add(socket.id);

  socket.emit("ready", {
    user: publicUser(user),
    announcements: db.announcements.slice(-5)
  });
  io.emit("presence", { userId: user.id, online: true });

  /* ── Chat ── */
  socket.on("global-message", (data) => {
    if (activeMute(user.id))
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
    pushMessage(message);
    io.emit("global-message", message);
  });

  socket.on("dm-message", (data) => {
    if (activeMute(user.id))
      return socket.emit("toast", { type: "error", message: "You are muted." });

    const toId = safeText(data?.toId, 80);
    const target = findUserById(toId);
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
    pushMessage(message);

    const recipients = new Set([socket.id, ...getSockets(toId)]);
    for (const sid of recipients) io.to(sid).emit("dm-message", message);
  });

  socket.on("group-message", (data) => {
    if (activeMute(user.id))
      return socket.emit("toast", { type: "error", message: "You are muted." });

    const groupId = safeText(data?.groupId, 80);
    const group = db.groups.find(x => x.id === groupId);
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
    pushMessage(message);

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
      const group = db.groups.find(x => x.id === data.groupId);
      if (!group || !group.members.includes(user.id)) return;
      for (const uid of group.members) {
        if (uid === user.id) continue;
        emitToUser(uid, "typing", {
          scope, fromId: user.id, username: user.username, groupId: group.id
        });
      }
    }
  });

  /* ── Direct call signaling ── */
  socket.on("call-invite", (data) => {
    const toId = safeText(data?.toId, 80);
    if (!findUserById(toId)) return;
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
  socket.on("group-call-signal", (data) => {
    const group = db.groups.find(x => x.id === data?.groupId);
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

/* ═══════════════════════════ Boot ══════════════════════════════ */
server.listen(PORT, () => {
  console.log(`\n  ▲  Farius Chat\n  →  http://localhost:${PORT}\n`);
});

process.on("SIGINT",  () => { saveNow(); process.exit(0); });
process.on("SIGTERM", () => { saveNow(); process.exit(0); });
process.on("uncaughtException", (err) => console.error("[fatal]", err));
process.on("unhandledRejection", (err) => console.error("[rejection]", err));