const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Раздаём index.html из этой же папки
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ===== Простая "база" в памяти (работает пока сервер запущен) =====
const users = []; // {id, username, password, avatarDataUrl, theme}
const sessions = new Map(); // token -> userId
const chats = new Map(); // chatId -> messages[{fromId,toId,text,time}]
const online = new Map(); // userId -> socketId

function nowTime() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function makeToken() {
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}
function normalizePair(a, b) {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}
function publicUser(u) {
  return { id: u.id, username: u.username, avatar: u.avatarDataUrl || "", theme: u.theme || "blue", online: online.has(u.id) };
}
function auth(req, res, next) {
  const token = req.headers["x-token"];
  if (!token || !sessions.has(token)) return res.status(401).json({ error: "NO_AUTH" });
  req.userId = sessions.get(token);
  next();
}

// ===== API =====

// REGISTER
app.post("/api/register", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const avatar = String(req.body?.avatar || ""); // dataURL (можно пусто)

  if (username.length < 2 || username.length > 24) return res.status(400).json({ error: "USERNAME_2_24" });
  if (!/^[a-zA-Z0-9_а-яА-ЯёЁ]+$/.test(username)) return res.status(400).json({ error: "BAD_USERNAME_CHARS" });
  if (password.length < 4) return res.status(400).json({ error: "PASS_MIN_4" });

  if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ error: "USERNAME_TAKEN" });
  }

  const user = {
    id: String(Date.now()) + "_" + Math.random().toString(16).slice(2),
    username,
    password,
    avatarDataUrl: avatar,
    theme: "blue"
  };
  users.push(user);

  const token = makeToken();
  sessions.set(token, user.id);

  res.json({ ok: true, token, user: publicUser(user) });
});

// LOGIN
app.post("/api/login", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user || user.password !== password) return res.status(400).json({ error: "BAD_LOGIN" });

  const token = makeToken();
  sessions.set(token, user.id);

  res.json({ ok: true, token, user: publicUser(user) });
});

// ME
app.get("/api/me", auth, (req, res) => {
  const me = users.find(u => u.id === req.userId);
  if (!me) return res.status(401).json({ error: "NO_USER" });
  res.json({ ok: true, user: publicUser(me) });
});

// SEARCH USERS
app.get("/api/users", auth, (req, res) => {
  const q = String(req.query.q || "").toLowerCase();
  const meId = req.userId;

  const list = users
    .filter(u => u.id !== meId)
    .filter(u => !q || u.username.toLowerCase().includes(q))
    .map(publicUser)
    .slice(0, 50);

  res.json({ ok: true, users: list });
});

// UPDATE PROFILE (nick/theme/avatar)
app.post("/api/profile", auth, (req, res) => {
  const me = users.find(u => u.id === req.userId);
  if (!me) return res.status(401).json({ error: "NO_USER" });

  const newName = req.body?.username !== undefined ? String(req.body.username).trim() : null;
  const newTheme = req.body?.theme !== undefined ? String(req.body.theme) : null;
  const newAvatar = req.body?.avatar !== undefined ? String(req.body.avatar) : null;

  if (newName !== null) {
    if (newName.length < 2 || newName.length > 24) return res.status(400).json({ error: "USERNAME_2_24" });
    if (!/^[a-zA-Z0-9_а-яА-ЯёЁ]+$/.test(newName)) return res.status(400).json({ error: "BAD_USERNAME_CHARS" });
    const conflict = users.some(u => u.id !== me.id && u.username.toLowerCase() === newName.toLowerCase());
    if (conflict) return res.status(400).json({ error: "USERNAME_TAKEN" });
    me.username = newName;
  }
  if (newTheme !== null) me.theme = newTheme;
  if (newAvatar !== null) me.avatarDataUrl = newAvatar;

  // уведомим всех о смене профиля (чтобы обновлялись авы/ники)
  io.emit("user:update", publicUser(me));

  res.json({ ok: true, user: publicUser(me) });
});

// CHAT HISTORY with user
app.get("/api/chat/:otherId", auth, (req, res) => {
  const meId = req.userId;
  const otherId = String(req.params.otherId);
  const other = users.find(u => u.id === otherId);
  if (!other) return res.status(404).json({ error: "NO_SUCH_USER" });

  const id = normalizePair(meId, otherId);
  const msgs = chats.get(id) || [];
  res.json({ ok: true, chatId: id, other: publicUser(other), messages: msgs.slice(-200) });
});

// ===== SOCKETS =====
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token || !sessions.has(token)) return next(new Error("NO_AUTH"));
  socket.userId = sessions.get(token);
  next();
});

io.on("connection", (socket) => {
  const meId = socket.userId;
  online.set(meId, socket.id);

  // online update
  io.emit("presence:update", { userId: meId, online: true });

  socket.on("chat:send", (payload) => {
    const toId = String(payload?.toId || "");
    const text = String(payload?.text || "").trim();
    if (!toId || !text) return;

    const other = users.find(u => u.id === toId);
    if (!other) return;

    const chatId = normalizePair(meId, toId);
    const msg = { fromId: meId, toId, text, time: nowTime() };

    const arr = chats.get(chatId) || [];
    arr.push(msg);
    chats.set(chatId, arr);

    // отправим обоим
    const toSock = online.get(toId);
    socket.emit("chat:msg", { chatId, msg });
    if (toSock) io.to(toSock).emit("chat:msg", { chatId, msg });
  });

  socket.on("disconnect", () => {
    if (online.get(meId) === socket.id) online.delete(meId);
    io.emit("presence:update", { userId: meId, online: false });
  });
});

server.listen(3000, () => {
  console.log("✅ Open: http://localhost:3000");
});
