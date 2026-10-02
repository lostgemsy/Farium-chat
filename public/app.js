"use strict";

/* ══════════════════════════════════════════════════════════════════
   Farius Chat — client
   ══════════════════════════════════════════════════════════════════ */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const ROLE_LABEL = { admin: "Admin", mod: "Mod", user: "" };

const state = {
  token: localStorage.getItem("farius_token") || "",
  user: null,
  socket: null,
  currentPanel: "global",
  selectedFriend: null,
  selectedGroup: null,
  incoming: null,
  peer: null,
  localStream: null,
  remoteStream: null,
  callId: null,
  callTarget: null,
  micOn: true,
  cameraOn: false,
  audioCtx: null,
  gainNode: null,
  typingTimers: {}
};

/* ───────────────────────────── Helpers ─────────────────────────── */
const esc = (s) => {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
};
const fmtTime = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const uid = () =>
  crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);

const emptyAvatar =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 80'>
       <rect width='80' height='80' fill='#111'/>
       <text x='40' y='52' fill='#666' text-anchor='middle'
             font-family='Inter,Arial' font-size='30' font-weight='700'>F</text>
     </svg>`
  );
const avatarUrl = (u) => (u && u.avatar) || emptyAvatar;

function api(url, opts = {}) {
  opts.headers = { ...(opts.headers || {}) };
  if (state.token) opts.headers.Authorization = `Bearer ${state.token}`;
  return fetch(url, opts).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Request failed");
    return data;
  });
}

function formData(obj) {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj))
    if (v !== undefined && v !== null && v !== "") f.append(k, v);
  return f;
}

const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");

/* ───────────────────────────── Toasts ──────────────────────────── */
function toast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast glass ${type}`;
  el.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
         stroke-linecap="round" stroke-linejoin="round">
      ${type === "error"
        ? `<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>`
        : `<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>`}
    </svg>
    <span>${esc(message)}</span>`;
  $("#toastRoot").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 400);
  }, 3400);
}

/* ──────────────────── Announcements (right stack) ──────────────── */
function showAnnouncement(a) {
  const stack = $("#announceStack");
  const el = document.createElement("div");
  el.className = "announce glass-strong";
  el.innerHTML = `
    <button class="announce-close" type="button" aria-label="Dismiss">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 6 6 18M6 6l12 12"/>
      </svg>
    </button>
    <div class="announce-head">
      <div class="announce-icon">!</div>
      <div><div class="announce-title">Farius Announcement</div></div>
    </div>
    <div class="announce-text">${esc(a.message)}</div>
    <div class="announce-meta">
      <span>${new Date(a.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      <span>Broadcast</span>
    </div>`;
  const close = () => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 400);
  };
  el.querySelector(".announce-close").addEventListener("click", close);
  stack.appendChild(el);
  setTimeout(close, 12000);
}

/* ───────────────────── Message rendering ───────────────────────── */
function addMessage(container, m) {
  const mine = state.user && m.fromId === state.user.id;
  const role = m.role && ROLE_LABEL[m.role] ? m.role : "";
  const el = document.createElement("div");
  el.className = `msg ${mine ? "me" : ""}`;

  let body = esc(m.text || "");
  if (m.fileUrl) {
    const t = m.fileType || "";
    if (t.startsWith("image/")) body += `<img class="media" src="${esc(m.fileUrl)}" alt="">`;
    else if (t.startsWith("video/")) body += `<video class="media" src="${esc(m.fileUrl)}" controls></video>`;
    else if (t.startsWith("audio/")) body += `<audio controls src="${esc(m.fileUrl)}"></audio>`;
    else body += `<a class="muted" href="${esc(m.fileUrl)}" target="_blank" rel="noopener">Open file</a>`;
  }

  el.innerHTML = `
    <img class="avatar" src="${esc(avatarUrl({ avatar: m.avatar }))}" alt="">
    <div class="body">
      <div class="head">
        <span class="who">${esc(m.username || "user")}</span>
        ${role ? `<span class="role ${role}">${ROLE_LABEL[role]}</span>` : ""}
        <span class="time">${fmtTime(m.createdAt)}</span>
      </div>
      <div class="text">${body}</div>
    </div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}
function renderMessages(container, messages) {
  container.innerHTML = "";
  for (const m of messages) addMessage(container, m);
}

/* ───────────────────── Typing indicator ────────────────────────── */
function showTyping(el, name) {
  if (!el) return;
  el.textContent = `${name} is typing…`;
  el.style.opacity = "1";
  clearTimeout(state.typingTimers[el.id]);
  state.typingTimers[el.id] = setTimeout(() => {
    el.textContent = "";
    el.style.opacity = "0";
  }, 1600);
}

/* ─────────────────────────── Router ────────────────────────────── */
const TITLES = {
  global:   ["Public room", "Global"],
  friends:  ["People", "Friends"],
  groups:   ["Communities", "Groups"],
  calls:    ["Real-time", "Calls"],
  settings: ["Preferences", "Settings"],
  staff:    ["Control room", "Staff panel"]
};

function showPanel(name) {
  if (name === "staff") {
    const role = state.user?.role;
    if (role !== "admin" && role !== "mod") return;
  }
  state.currentPanel = name;
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.panel === name));
  const [eyebrow, title] = TITLES[name] || TITLES.global;
  $("#panelEyebrow").textContent = eyebrow;
  $("#panelTitle").textContent = title;

  if (name === "friends") loadFriends();
  if (name === "groups") { loadMyGroups(); loadPublicGroups(); }
  if (name === "staff") loadStaff();
}

/* ─────────────────────────── Auth flow ─────────────────────────── */
function enterAuth() {
  $("#splash").classList.add("splash--out");
  setTimeout(() => hide($("#splash")), 620);
  show($("#authView"));
  hide($("#app"));
}
function enterApp() {
  hide($("#splash"));
  hide($("#authView"));
  show($("#app"));
  buildParticles();
  paintProfile();
  showPanel("global");
  loadGlobal();
  wireTyping();
}
function logout() {
  if (state.socket) state.socket.disconnect();
  state.socket = null;
  state.token = "";
  state.user = null;
  localStorage.removeItem("farius_token");
  endCall(true);
  hide($("#app"));
  show($("#authView"));
}
async function loginSuccess(payload) {
  state.token = payload.token;
  state.user = payload.user;
  localStorage.setItem("farius_token", state.token);
  enterApp();
  await connectSocket();
}

/* ─────────────────────────── Profile ───────────────────────────── */
function paintProfile() {
  const u = state.user;
  if (!u) return;
  $("#railProfile").innerHTML = `<img src="${esc(avatarUrl(u))}" alt="">`;
  $("#profileName").value = u.username;
  $("#backgroundUrl").value = u.background || "";

  const role = u.role || "user";
  const staffVisible = role === "admin" || role === "mod";
  $("#staffNav").classList.toggle("hidden", !staffVisible);
  $("#panel-staff").classList.toggle("hidden", !staffVisible);

  if (role === "admin") {
    $("#announceHint").textContent =
      "Broadcast a site-wide announcement. It appears on the right side of every online user's screen.";
    $("#announcementText").disabled = false;
    $("#sendAnnouncement").disabled = false;
    $("#sendAnnouncement").style.opacity = "";
    $("#sendAnnouncement").style.cursor = "";
  } else if (role === "mod") {
    $("#announceHint").textContent =
      "Moderators can mute, ban and unban users. Announcements are admin-only.";
    $("#announcementText").disabled = true;
    $("#sendAnnouncement").disabled = true;
    $("#sendAnnouncement").style.opacity = ".45";
    $("#sendAnnouncement").style.cursor = "not-allowed";
  }
}

/* ─────────────────────────── Particles ─────────────────────────── */
let particlesEnabled = localStorage.getItem("farius_particles") !== "off";
function buildParticles() {
  const el = $("#particles");
  if (!el) return;
  el.innerHTML = "";
  if (!particlesEnabled) return;
  for (let i = 0; i < 70; i++) {
    const s = document.createElement("span");
    s.style.cssText = `
      position:absolute;width:2px;height:2px;border-radius:50%;background:#fff;
      left:${Math.random() * 100}%;top:${Math.random() * 100}%;
      opacity:${(0.08 + Math.random() * 0.32).toFixed(2)};
      animation:particleFloat ${12 + Math.random() * 18}s linear infinite;
      animation-delay:-${Math.random() * 20}s;`;
    el.appendChild(s);
  }
  if (!document.getElementById("particleKeyframes")) {
    const style = document.createElement("style");
    style.id = "particleKeyframes";
    style.textContent = `@keyframes particleFloat{
      0%{transform:translate3d(0,0,0)}
      100%{transform:translate3d(${Math.random() * 40 - 20}px,${-120 - Math.random() * 80}px,0)}
    }`;
    document.head.appendChild(style);
  }
}

/* ────────────────────────── Global chat ────────────────────────── */
async function loadGlobal() {
  try {
    const d = await api("/api/messages/global");
    renderMessages($("#globalMessages"), d.messages);
  } catch (e) { toast(e.message, "error"); }
}
function sendGlobal() {
  const v = $("#globalInput").value.trim();
  if (!v) return;
  state.socket?.emit("global-message", { text: v });
  $("#globalInput").value = "";
}

/* ─────────────────────────── Friends ───────────────────────────── */
async function loadFriends() {
  try {
    const d = await api("/api/friends");
    $("#friendBadge").classList.toggle("hidden", d.requests.length === 0);

    $("#friendsList").innerHTML = d.friends.length
      ? d.friends.map((u) => `
        <div class="list-item">
          <img class="avatar" src="${esc(avatarUrl(u))}" alt="">
          <div class="grow"><strong>${esc(u.username)}</strong><small>Friend</small></div>
          <div class="row-actions">
            <button class="btn btn--icon btn--ghost" data-dm="${u.id}" title="Message">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"/>
              </svg>
            </button>
            <button class="btn btn--icon btn--ghost" data-call="${u.id}" title="Call">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 16.92V21a1 1 0 0 1-1.11 1A19 19 0 0 1 2 3.11 1 1 0 0 1 3 2h4.09a1 1 0 0 1 1 .75c.13.96.36 1.9.7 2.81a1 1 0 0 1-.23 1.05L7.09 8a16 16 0 0 0 8.91 8.91l1.38-1.38a1 1 0 0 1 1.05-.23c.91.34 1.85.57 2.81.7a1 1 0 0 1 .76 1.02Z"/>
              </svg>
            </button>
          </div>
        </div>`).join("")
      : `<div class="muted tiny">No friends yet.</div>`;

    $("#requestsList").innerHTML = d.requests.length
      ? d.requests.map((u) => `
        <div class="list-item">
          <img class="avatar" src="${esc(avatarUrl(u))}" alt="">
          <div class="grow"><strong>${esc(u.username)}</strong><small>Wants to be friends</small></div>
          <button class="btn btn--sm btn--primary" data-accept="${u.id}">Accept</button>
        </div>`).join("")
      : `<div class="muted tiny">No pending requests.</div>`;

    $$("[data-accept]").forEach((b) => b.onclick = async () => {
      try {
        await api("/api/friends/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: b.dataset.accept })
        });
        toast("Friend added.");
        loadFriends();
      } catch (e) { toast(e.message, "error"); }
    });
    $$("[data-dm]").forEach((b) => b.onclick = () => openDM(b.dataset.dm));
    $$("[data-call]").forEach((b) => b.onclick = () => startCall(b.dataset.call, true));
  } catch (e) { toast(e.message, "error"); }
}

async function searchUsers() {
  const q = $("#userSearch").value.trim();
  if (!q) return;
  try {
    const d = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
    $("#userResults").innerHTML = d.users.length
      ? d.users.map((u) => `
        <div class="list-item">
          <img class="avatar" src="${esc(avatarUrl(u))}" alt="">
          <div class="grow"><strong>${esc(u.username)}</strong></div>
          <button class="btn btn--sm btn--ghost" data-add="${u.id}">Add</button>
        </div>`).join("")
      : `<div class="muted tiny">No one found.</div>`;

    $$("[data-add]").forEach((b) => b.onclick = async () => {
      try {
        await api("/api/friends/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: b.dataset.add })
        });
        toast("Request sent.");
      } catch (e) { toast(e.message, "error"); }
    });
  } catch (e) { toast(e.message, "error"); }
}

async function openDM(id) {
  state.selectedFriend = id;
  try {
    const friends = (await api("/api/friends")).friends;
    const f = friends.find((x) => x.id === id);
    $("#dmTitle").textContent = f ? `Chat with ${f.username}` : "Direct message";
    const d = await api(`/api/messages/${id}`);
    renderMessages($("#dmMessages"), d.messages);
    show($("#dmCard"));
    showPanel("friends");
  } catch (e) { toast(e.message, "error"); }
}
function sendDM() {
  if (!state.selectedFriend) return toast("Pick a friend first.", "error");
  const v = $("#dmInput").value.trim();
  if (!v) return;
  state.socket?.emit("dm-message", { toId: state.selectedFriend, text: v });
  $("#dmInput").value = "";
}

/* ─────────────────────────── Groups ────────────────────────────── */
async function loadMyGroups() {
  try {
    const d = await api("/api/groups/mine");
    $("#myGroups").innerHTML = d.groups.length
      ? d.groups.map((g) => groupRow(g, true)).join("")
      : `<div class="muted tiny">You haven't joined any groups.</div>`;
    bindGroupRows();
  } catch (e) { toast(e.message, "error"); }
}
async function loadPublicGroups() {
  try {
    const d = await api("/api/groups");
    $("#publicGroups").innerHTML = d.groups.length
      ? d.groups.map((g) => groupRow(g, false)).join("")
      : `<div class="muted tiny">No public groups yet.</div>`;
    bindGroupRows();
  } catch (e) { toast(e.message, "error"); }
}
function groupRow(g, mine) {
  const label = g.type === "call" ? "Call group" : "Chat group";
  return `
    <div class="list-item">
      <div class="grow">
        <strong>${esc(g.name)}</strong>
        <small>${esc(g.description || "No description")} · ${label} · ${g.memberCount} member${g.memberCount === 1 ? "" : "s"}</small>
      </div>
      <div class="row-actions">
        ${mine
          ? `<button class="btn btn--sm btn--primary" data-open-group="${g.id}">Open</button>`
          : `<button class="btn btn--sm btn--ghost" data-join-group="${g.id}">Join</button>`}
      </div>
    </div>`;
}
function bindGroupRows() {
  $$("[data-open-group]").forEach((b) => b.onclick = () => openGroup(b.dataset.openGroup));
  $$("[data-join-group]").forEach((b) => b.onclick = async () => {
    const pass = prompt("Group password (blank if public):") || "";
    try {
      await api(`/api/groups/${b.dataset.joinGroup}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pass })
      });
      toast("Joined.");
      loadMyGroups();
    } catch (e) { toast(e.message, "error"); }
  });
}
async function openGroup(id) {
  try {
    const mine = (await api("/api/groups/mine")).groups;
    const g = mine.find((x) => x.id === id);
    if (!g) return;
    state.selectedGroup = g;
    $("#groupChatTitle").textContent = g.name;
    $("#groupType").textContent = g.type === "call" ? "Call group" : "Chat group";
    const d = await api(`/api/groups/${id}/messages`);
    renderMessages($("#groupMessages"), d.messages);
    show($("#groupChatCard"));
    showPanel("groups");
  } catch (e) { toast(e.message, "error"); }
}
function sendGroup() {
  if (!state.selectedGroup) return;
  const v = $("#groupInput").value.trim();
  if (!v) return;
  state.socket?.emit("group-message", { groupId: state.selectedGroup.id, text: v });
  $("#groupInput").value = "";
}

/* ─────────────────────────── Upload ────────────────────────────── */
async function uploadAndSend(file, scope) {
  if (!file) return;
  try {
    const d = await api("/api/upload", { method: "POST", body: formData({ file }) });
    const payload = { fileUrl: d.url, fileType: d.type, name: d.name };
    const text = `📎 ${d.name}`;
    if (scope === "global") state.socket.emit("global-message", { text, ...payload });
    else if (scope === "group" && state.selectedGroup)
      state.socket.emit("group-message", {
        groupId: state.selectedGroup.id, text, ...payload
      });
    toast("Uploaded.");
  } catch (e) { toast(e.message, "error"); }
}

/* ─────────────────────────── WebRTC ────────────────────────────── */
const rtcConfig = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
  ]
};

async function ensureMedia(video) {
  if (state.localStream) {
    if (video && state.localStream.getVideoTracks().length === 0) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true });
        s.getVideoTracks().forEach((t) => {
          state.localStream.addTrack(t);
          state.peer?.addTrack(t, state.localStream);
        });
      } catch {}
    }
    return state.localStream;
  }
  state.localStream = await navigator.mediaDevices.getUserMedia({
    audio: true, video: !!video
  });
  $("#localVideo").srcObject = state.localStream;
  hide($("#callEmpty"));
  setupGain();
  return state.localStream;
}
function setupGain() {
  if (!state.localStream || !window.AudioContext) return;
  try {
    state.audioCtx ||= new AudioContext();
    if (state.gainNode) state.gainNode.disconnect();
    const src = state.audioCtx.createMediaStreamSource(state.localStream);
    state.gainNode = state.audioCtx.createGain();
    state.gainNode.gain.value = Number($("#micGain").value) / 100;
    src.connect(state.gainNode);
  } catch {}
}
async function createPeer(targetId, initiator) {
  if (state.peer) state.peer.close();
  state.peer = new RTCPeerConnection(rtcConfig);
  state.callTarget = targetId;

  state.peer.onicecandidate = (e) => {
    if (e.candidate) state.socket.emit("ice-candidate", {
      toId: targetId, candidate: e.candidate, callId: state.callId
    });
  };
  state.peer.ontrack = (e) => {
    e.streams[0]?.getTracks().forEach((t) => state.remoteStream.addTrack(t));
  };
  state.peer.onconnectionstatechange = () => {
    const s = state.peer?.connectionState;
    if (s === "connected") {
      $("#callStatus").textContent = "Live";
      $("#callStatusDot").classList.remove("off");
    }
    if (s === "failed" || s === "disconnected") {
      toast("Call disconnected.", "error");
      endCall();
    }
  };

  state.remoteStream = new MediaStream();
  $("#remoteVideo").srcObject = state.remoteStream;

  state.localStream.getTracks().forEach((t) => state.peer.addTrack(t, state.localStream));

  if (initiator) {
    const offer = await state.peer.createOffer();
    await state.peer.setLocalDescription(offer);
    state.socket.emit("call-offer", { toId: targetId, offer, callId: state.callId });
  }
}
async function startCall(targetId, video = false) {
  try {
    state.callId = uid();
    state.cameraOn = video;
    await ensureMedia(video);
    await createPeer(targetId, true);
    state.socket.emit("call-invite", { toId: targetId, callId: state.callId, video });
    $("#callStatus").textContent = "Calling…";
    showPanel("calls");
  } catch (e) { toast("Media error: " + e.message, "error"); }
}
async function acceptCall() {
  const c = state.incoming;
  if (!c) return;
  hide($("#incomingCall"));
  try {
    state.callId = c.callId;
    state.cameraOn = !!c.video;
    await ensureMedia(!!c.video);
    await createPeer(c.fromId, false);
    $("#callStatus").textContent = `Connected to ${c.fromUsername}`;
    showPanel("calls");
  } catch (e) { toast(e.message, "error"); }
}
function endCall(silent = false) {
  if (state.callTarget && state.socket)
    state.socket.emit("call-end", { toId: state.callTarget, callId: state.callId });
  if (state.peer) { state.peer.close(); state.peer = null; }
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }
  $("#localVideo").srcObject = null;
  $("#remoteVideo").srcObject = null;
  show($("#callEmpty"));
  $("#callStatus").textContent = "Ready to call";
  $("#callStatusDot").classList.add("off");
  state.callTarget = null;
  state.callId = null;
  if (!silent) toast("Call ended.");
}

/* ─────────────────────────── Socket ────────────────────────────── */
async function connectSocket() {
  if (!state.token) return;
  state.socket = io({ auth: { token: state.token } });

  state.socket.on("connect", () => $("#connectionDot").classList.remove("off"));
  state.socket.on("disconnect", () => $("#connectionDot").classList.add("off"));
  state.socket.on("connect_error", (e) => toast("Connection failed: " + e.message, "error"));

  state.socket.on("global-message", (m) => addMessage($("#globalMessages"), m));

  state.socket.on("dm-message", (m) => {
    if (state.selectedFriend && (m.fromId === state.selectedFriend || m.toId === state.selectedFriend))
      addMessage($("#dmMessages"), m);
    else if (m.fromId !== state.user.id)
      toast(`${m.username}: ${m.text.slice(0, 40)}`);
  });

  state.socket.on("group-message", (m) => {
    if (state.selectedGroup?.id === m.groupId) addMessage($("#groupMessages"), m);
  });

  state.socket.on("typing", (d) => {
    if (d.fromId === state.user.id) return;
    if (d.scope === "global") showTyping($("#globalTyping"), d.username);
    else if (d.scope === "dm" && d.fromId === state.selectedFriend)
      showTyping($("#dmTyping"), d.username);
    else if (d.scope === "group" && d.groupId === state.selectedGroup?.id)
      showTyping($("#groupTyping"), d.username);
  });

  state.socket.on("toast", (d) => toast(d.message, d.type || "info"));
  state.socket.on("announcement", showAnnouncement);
  state.socket.on("role-changed", ({ role }) => {
    if (state.user) { state.user.role = role; paintProfile(); }
  });
  state.socket.on("forced-logout", (d) => { toast(d.reason, "error"); logout(); });

  state.socket.on("incoming-call", (c) => {
    state.incoming = c;
    $("#incomingAvatar").src = avatarUrl({ avatar: c.fromAvatar });
    $("#incomingName").textContent = c.fromUsername;
    $("#incomingKind").textContent = c.video ? "Video call" : "Audio call";
    show($("#incomingCall"));
  });

  state.socket.on("call-offer", async (d) => {
    if (!state.peer) return;
    try {
      await state.peer.setRemoteDescription(d.offer);
      const answer = await state.peer.createAnswer();
      await state.peer.setLocalDescription(answer);
      state.socket.emit("call-answer", { toId: d.fromId, answer, callId: d.callId });
      $("#callStatus").textContent = "Live";
    } catch (e) { toast(e.message, "error"); }
  });
  state.socket.on("call-answer", async (d) => {
    if (state.peer) {
      try { await state.peer.setRemoteDescription(d.answer); $("#callStatus").textContent = "Live"; }
      catch {}
    }
  });
  state.socket.on("ice-candidate", async (d) => {
    try { if (state.peer) await state.peer.addIceCandidate(d.candidate); } catch {}
  });
  state.socket.on("call-ended", () => endCall());
  state.socket.on("presence", () => {});
}

/* ─────────────────────────── Typing emit ───────────────────────── */
function wireTyping() {
  const fire = (scope, input, extra = {}) => {
    let last = 0;
    input.addEventListener("input", () => {
      const t = Date.now();
      if (t - last < 1200) return;
      last = t;
      state.socket?.emit("typing", { scope, ...extra });
    });
  };
  fire("global", $("#globalInput"));
  fire("dm", $("#dmInput"), { get toId() { return state.selectedFriend; } });

  $("#groupInput").addEventListener("input", () => {
    if (!state.selectedGroup) return;
    const t = Date.now();
    if (t - (state._grpTyping || 0) < 1200) return;
    state._grpTyping = t;
    state.socket?.emit("typing", { scope: "group", groupId: state.selectedGroup.id });
  });
}

/* ─────────────────────────── Staff panel ───────────────────────── */
async function loadStaff() {
  if (!state.user) return;
  const role = state.user.role;
  if (role !== "admin" && role !== "mod") return;
  try {
    const d = await api("/api/moderation");
    const me = state.user.id;

    $("#modUsers").innerHTML = d.users.map((u) => {
      const tags = [];
      if (u.role === "admin") tags.push(`<span class="role-pill admin">Admin</span>`);
      else if (u.role === "mod") tags.push(`<span class="role-pill mod">Mod</span>`);
      if (u.banned) tags.push(`<span class="role-pill banned">Banned</span>`);
      if (u.muted) tags.push(`<span class="role-pill muted">Muted</span>`);

      const actions = [];
      if (role === "admin" && u.id !== me) {
        actions.push(`
          <select data-role-select="${u.id}" title="Change role"
                  style="background:rgba(0,0,0,.35);border:1px solid var(--line);
                         color:var(--ink);padding:6px 8px;border-radius:9px;outline:none">
            <option value="user"  ${u.role === "user" ? "selected" : ""}>User</option>
            <option value="mod"   ${u.role === "mod" ? "selected" : ""}>Mod</option>
            <option value="admin" ${u.role === "admin" ? "selected" : ""}>Admin</option>
          </select>`);
      }
      if (u.id !== me) {
        if (!u.muted) actions.push(`
          <button class="btn btn--sm btn--ghost" data-mute="${u.id}" title="Mute">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="m22 9-6 6M16 9l6 6"/>
            </svg>
          </button>`);
        if (!u.banned) actions.push(`
          <button class="btn btn--sm btn--ghost" data-ban="${u.id}" title="Ban">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                 stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 14.14 14.14"/>
            </svg>
          </button>`);
        else actions.push(`
          <button class="btn btn--sm btn--ghost" data-unban="${u.id}" title="Unban">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 6 9 17l-5-5"/>
            </svg>
          </button>`);
      }

      return `
        <div class="list-item">
          <img class="avatar" src="${esc(avatarUrl(u))}" alt="">
          <div class="grow">
            <strong>${esc(u.username)}</strong>
            <small>${tags.join(" ") || "Active"}</small>
          </div>
          <div class="row-actions">${actions.join("")}</div>
        </div>`;
    }).join("");

    $("#announcementList").innerHTML =
      d.announcements.slice().reverse().map((a) => `
        <div class="list-item">
          <div class="grow">
            <strong style="font-weight:500;font-size:13px">${esc(a.message)}</strong>
            <small>${new Date(a.createdAt).toLocaleString()}</small>
          </div>
        </div>`).join("") || `<div class="muted tiny">No announcements yet.</div>`;

    $$("[data-mute]").forEach((b) => b.onclick = async () => {
      const minutes = Number(prompt("Mute duration (minutes):", "10") || 10);
      if (!minutes) return;
      try {
        await api("/api/moderation/mute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: b.dataset.mute, minutes })
        });
        toast("User muted.");
        loadStaff();
      } catch (e) { toast(e.message, "error"); }
    });
    $$("[data-ban]").forEach((b) => b.onclick = async () => {
      const days = Number(prompt("Ban duration (days, 0 = permanent):", "1"));
      if (Number.isNaN(days)) return;
      const permanent = days === 0;
      try {
        await api("/api/moderation/ban", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: b.dataset.ban,
            days: permanent ? 3650 : days,
            permanent
          })
        });
        toast("User banned.");
        loadStaff();
      } catch (e) { toast(e.message, "error"); }
    });
    $$("[data-unban]").forEach((b) => b.onclick = async () => {
      try {
        await api("/api/moderation/unban", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: b.dataset.unban })
        });
        toast("User unbanned.");
        loadStaff();
      } catch (e) { toast(e.message, "error"); }
    });
    $$("[data-role-select]").forEach((sel) => sel.onchange = async () => {
      try {
        await api("/api/admin/role", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: sel.dataset.roleSelect, role: sel.value })
        });
        toast("Role updated.");
        loadStaff();
      } catch (e) { toast(e.message, "error"); loadStaff(); }
    });
  } catch (e) { toast(e.message, "error"); }
}
async function sendAnnouncement() {
  const message = $("#announcementText").value.trim();
  if (!message) return;
  try {
    await api("/api/moderation/announcement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });
    $("#announcementText").value = "";
    toast("Announcement sent.");
    loadStaff();
  } catch (e) { toast(e.message, "error"); }
}

/* ────────────────────── File picker previews ───────────────────── */
function previewFile(input, targetEl) {
  const f = input.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  targetEl.outerHTML = `<img id="${targetEl.id}" src="${url}" alt="">`;
}

/* ─────────────────────────── Wire up ───────────────────────────── */
function wireUI() {
  $("#enterBtn").addEventListener("click", () => {
    if (state.token) bootWithToken();
    else enterAuth();
  });

  $$(".tabs button").forEach((b) => b.addEventListener("click", () => {
    $$(".tabs button").forEach((x) => {
      x.classList.remove("active");
      x.setAttribute("aria-selected", "false");
    });
    b.classList.add("active");
    b.setAttribute("aria-selected", "true");
    $("#signinForm").classList.toggle("hidden", b.dataset.tab !== "signin");
    $("#signupForm").classList.toggle("hidden", b.dataset.tab !== "signup");
    $("#authError").textContent = "";
  }));

  $("#signinForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#authError").textContent = "";
    try {
      const d = await api("/api/auth/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: $("#signinUser").value,
          password: $("#signinPass").value
        })
      });
      await loginSuccess(d);
    } catch (err) { $("#authError").textContent = err.message; }
  });

  $("#signupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#authError").textContent = "";
    try {
      const d = await api("/api/auth/signup", {
        method: "POST",
        body: formData({
          username: $("#signupUser").value,
          password: $("#signupPass").value,
          avatar: $("#signupAvatar").files[0]
        })
      });
      await loginSuccess(d);
    } catch (err) { $("#authError").textContent = err.message; }
  });

  $("#signupAvatar").addEventListener("change", (e) => previewFile(e.target, $("#signupAvatarPreview")));
  $("#profileAvatar").addEventListener("change", (e) => previewFile(e.target, $("#profileAvatarPreview")));

  $("#railNav").addEventListener("click", (e) => {
    const b = e.target.closest(".nav-btn");
    if (b && b.dataset.panel) showPanel(b.dataset.panel);
  });
  $("#railProfile").addEventListener("click", () => showPanel("settings"));
  $("#logoutBtn").addEventListener("click", logout);

  $("#globalSend").addEventListener("click", sendGlobal);
  $("#globalInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendGlobal(); }
  });
  $("#uploadGlobal").addEventListener("click", () => $("#globalFile").click());
  $("#globalFile").addEventListener("change", (e) => uploadAndSend(e.target.files[0], "global"));

  $("#refreshFriends").addEventListener("click", loadFriends);
  $("#userSearchBtn").addEventListener("click", searchUsers);
  $("#userSearch").addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchUsers();
  });
  $("#dmSend").addEventListener("click", sendDM);
  $("#dmInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); sendDM(); }
  });
  $("#dmCallAudio").addEventListener("click", () => state.selectedFriend && startCall(state.selectedFriend, false));
  $("#dmCallVideo").addEventListener("click", () => state.selectedFriend && startCall(state.selectedFriend, true));

  $("#newGroup").addEventListener("click", () => show($("#groupModal")));
  $("#groupPrivate").addEventListener("change", (e) => {
    $("#groupPassword").disabled = !e.target.checked;
  });
  $("#groupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: $("#groupName").value,
          description: $("#groupDescription").value,
          type: $("#groupTypeSelect").value,
          private: $("#groupPrivate").checked,
          password: $("#groupPassword").value,
          persistentCall: $("#groupPersistent").checked
        })
      });
      hide($("#groupModal"));
      e.target.reset();
      $("#groupPassword").disabled = true;
      toast("Group created.");
      loadMyGroups();
      loadPublicGroups();
    } catch (err) { toast(err.message, "error"); }
  });
  $("#refreshGroups").addEventListener("click", () => {
    loadMyGroups();
    loadPublicGroups();
  });
  $("#groupSend").addEventListener("click", sendGroup);
  $("#groupInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); sendGroup(); }
  });
  $("#groupUpload").addEventListener("click", () => $("#groupFile").click());
  $("#groupFile").addEventListener("change", (e) => uploadAndSend(e.target.files[0], "group"));

  $$("[data-close]").forEach((b) => b.addEventListener("click", () => hide($("#" + b.dataset.close))));

  $("#acceptCall").addEventListener("click", acceptCall);
  $("#declineCall").addEventListener("click", () => {
    if (state.incoming)
      state.socket.emit("call-end", {
        toId: state.incoming.fromId,
        callId: state.incoming.callId
      });
    state.incoming = null;
    hide($("#incomingCall"));
  });
  $("#endCall").addEventListener("click", () => endCall());
  $("#toggleMic").addEventListener("click", () => {
    if (!state.localStream) return;
    state.micOn = !state.micOn;
    state.localStream.getAudioTracks().forEach((t) => (t.enabled = state.micOn));
    $("#toggleMic").classList.toggle("off", !state.micOn);
  });
  $("#toggleCamera").addEventListener("click", async () => {
    if (!state.localStream) return;
    const enable = !state.cameraOn;
    if (enable && state.localStream.getVideoTracks().length === 0) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true });
        s.getVideoTracks().forEach((t) => {
          state.localStream.addTrack(t);
          state.peer?.addTrack(t, state.localStream);
        });
        $("#localVideo").srcObject = state.localStream;
      } catch (e) { return toast(e.message, "error"); }
    }
    state.cameraOn = enable;
    state.localStream.getVideoTracks().forEach((t) => (t.enabled = enable));
    $("#toggleCamera").classList.toggle("off", !enable);
  });
  $("#micGain").addEventListener("input", (e) => {
    $("#micValue").textContent = e.target.value + "%";
    if (state.gainNode) state.gainNode.gain.value = Number(e.target.value) / 100;
  });

  $("#particlesToggle").checked = particlesEnabled;
  $("#particlesToggle").addEventListener("change", (e) => {
    particlesEnabled = e.target.checked;
    localStorage.setItem("farius_particles", particlesEnabled ? "on" : "off");
    buildParticles();
  });
  $("#motionToggle").addEventListener("change", (e) => {
    document.body.style.setProperty("--dur", e.target.checked ? "0s" : ".45s");
    document.querySelectorAll("*").forEach((el) => {
      el.style.animationPlayState = e.target.checked ? "paused" : "running";
    });
  });
  $("#saveAppearance").addEventListener("click", async () => {
    try {
      const d = await api("/api/profile", {
        method: "POST",
        body: formData({
          username: state.user.username,
          background: $("#backgroundUrl").value
        })
      });
      state.user = d.user;
      state.token = d.token;
      localStorage.setItem("farius_token", d.token);
      toast("Appearance saved.");
    } catch (e) { toast(e.message, "error"); }
  });
  $("#saveProfile").addEventListener("click", async () => {
    try {
      const d = await api("/api/profile", {
        method: "POST",
        body: formData({
          username: $("#profileName").value,
          avatar: $("#profileAvatar").files[0]
        })
      });
      state.user = d.user;
      state.token = d.token;
      localStorage.setItem("farius_token", d.token);
      paintProfile();
      toast("Profile saved.");
    } catch (e) { toast(e.message, "error"); }
  });
  $("#makeGif").addEventListener("click", async () => {
    const f = $("#gifVideo").files[0];
    if (!f) return toast("Choose a video first.", "error");
    const fd = new FormData();
    fd.append("video", f);
    try {
      const d = await api("/api/gif", { method: "POST", body: fd });
      $("#gifResult").innerHTML =
        `GIF ready: <a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url)}</a>`;
      toast("GIF created.");
    } catch (e) { toast(e.message, "error"); }
  });

  $("#refreshMod").addEventListener("click", loadStaff);
  $("#sendAnnouncement").addEventListener("click", sendAnnouncement);

  document.addEventListener("mousemove", (e) => {
    const btn = e.target.closest(".btn");
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    btn.style.setProperty("--mx", e.clientX - r.left + "px");
    btn.style.setProperty("--my", e.clientY - r.top + "px");
  });
}

/* ─────────────────────────── Boot ─────────────────────────────── */
async function bootWithToken() {
  try {
    const d = await api("/api/me");
    state.user = d.user;
    enterApp();
    await connectSocket();
  } catch {
    localStorage.removeItem("farius_token");
    state.token = "";
    enterAuth();
  }
}

wireUI();

if (state.token) {
  $("#splash").classList.add("splash--out");
  setTimeout(() => hide($("#splash")), 620);
  bootWithToken();
}