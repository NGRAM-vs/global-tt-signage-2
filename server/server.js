require("dotenv").config();

const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const convert = require("heic-convert");

const { pool, init } = require("./db");
const { broadcast, subscribe } = require("./events");
const { hashPassword, verifyPassword } = require("./auth");

const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

const app = express();
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Needed so secure cookies work correctly when running behind a reverse
// proxy (Caddy) that terminates HTTPS and forwards plain HTTP internally.
if (IS_PRODUCTION) app.set("trust proxy", 1);

app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
      secure: IS_PRODUCTION, // only sent over HTTPS once deployed
    },
  })
);

app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/uploads", express.static(UPLOADS_DIR));

// Signed-in check for every role. Users stored in the database are
// re-checked on each request, so removing or demoting someone takes effect
// immediately. The .env admin (fromEnv) has no database row to check.
async function requireAuth(req, res, next) {
  const s = req.session;
  if (!s || !s.authenticated)
    return res.status(401).json({ error: "Not signed in" });
  if (s.fromEnv) {
    req.user = { email: s.email, role: "admin", fromEnv: true };
    return next();
  }
  try {
    const { rows } = await pool.query(
      "SELECT id, email, role FROM users WHERE id = $1",
      [s.userId]
    );
    if (!rows[0]) {
      return req.session.destroy(() =>
        res.status(401).json({ error: "Not signed in" })
      );
    }
    s.role = rows[0].role;
    s.email = rows[0].email;
    req.user = { id: rows[0].id, email: rows[0].email, role: rows[0].role };
    return next();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Database error" });
  }
}

// Admin-only: user management.
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role === "admin") return next();
    return res.status(403).json({ error: "Admins only" });
  });
}

function safeEqual(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// Applied to the login and pairing endpoints — both are guessable-secret
// checks (a password, a 6-character code) that shouldn't be hammerable from
// the public internet.
const guessLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many attempts — please wait a few minutes and try again.",
  },
});

// Wraps an async route handler so a rejected promise (e.g. a database error)
// becomes a normal 500 response instead of crashing the process.
function asyncRoute(handler) {
  return (req, res) => {
    handler(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: "Database error" });
    });
  };
}

/* ================= AUTH ================= */

app.post(
  "/api/login",
  guessLimiter,
  asyncRoute(async (req, res) => {
    const { email, password } = req.body || {};
    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(401).json({ error: "Incorrect email or password" });
    }
    const normalized = email.trim().toLowerCase();

    let identity = null;
    const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [
      normalized,
    ]);
    if (rows[0] && (await verifyPassword(password, rows[0].password_hash))) {
      identity = {
        userId: rows[0].id,
        email: rows[0].email,
        role: rows[0].role,
        fromEnv: false,
      };
    } else if (
      safeEqual(email.trim(), ADMIN_EMAIL) &&
      safeEqual(password, ADMIN_PASSWORD)
    ) {
      // .env account: permanent admin, so you can never lock yourself out
      identity = {
        userId: null,
        email: ADMIN_EMAIL,
        role: "admin",
        fromEnv: true,
      };
    }
    if (!identity)
      return res.status(401).json({ error: "Incorrect email or password" });

    req.session.regenerate((err) => {
      if (err)
        return res.status(500).json({ error: "Could not start session" });
      Object.assign(req.session, identity, { authenticated: true });
      res.json({ ok: true, email: identity.email, role: identity.role });
    });
  })
);

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get(
  "/api/session",
  asyncRoute(async (req, res) => {
    const s = req.session;
    if (!s || !s.authenticated) return res.json({ authenticated: false });
    if (!s.fromEnv) {
      const { rows } = await pool.query(
        "SELECT email, role FROM users WHERE id = $1",
        [s.userId]
      );
      if (!rows[0])
        return req.session.destroy(() => res.json({ authenticated: false }));
      s.email = rows[0].email;
      s.role = rows[0].role;
    }
    res.json({ authenticated: true, email: s.email, role: s.role });
  })
);

/* ================= USERS (admin only) ================= */

const ROLES = ["admin", "editor"];
const MIN_PASSWORD = 8;

app.get(
  "/api/users",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      "SELECT id, email, role, created_at FROM users ORDER BY created_at ASC"
    );
    res.json(rows);
  })
);

app.post(
  "/api/users",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    const email = String(body.email || "")
      .trim()
      .toLowerCase();
    const password = String(body.password || "");
    const role = body.role;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: "Enter a valid email address" });
    if (!ROLES.includes(role))
      return res.status(400).json({ error: "Role must be admin or editor" });
    if (password.length < MIN_PASSWORD)
      return res.status(400).json({
        error: "Password must be at least " + MIN_PASSWORD + " characters",
      });
    if (email === ADMIN_EMAIL.toLowerCase())
      return res
        .status(409)
        .json({ error: "That email is the main admin account from .env" });

    const exists = await pool.query("SELECT 1 FROM users WHERE email = $1", [
      email,
    ]);
    if (exists.rows.length)
      return res
        .status(409)
        .json({ error: "A user with that email already exists" });

    const id = crypto.randomUUID();
    const createdAt = Date.now();
    await pool.query(
      "INSERT INTO users (id, email, password_hash, role, created_at) VALUES ($1,$2,$3,$4,$5)",
      [id, email, await hashPassword(password), role, createdAt]
    );
    res.json({ id, email, role, created_at: createdAt });
  })
);

// Counts admins that could still sign in, other than `exceptId`. The .env
// account always counts, so there is always at least one admin.
async function otherAdminsExist(exceptId) {
  if (ADMIN_EMAIL) return true;
  const { rows } = await pool.query(
    "SELECT 1 FROM users WHERE role = 'admin' AND id <> $1",
    [exceptId]
  );
  return rows.length > 0;
}

app.patch(
  "/api/users/:id",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [
      req.params.id,
    ]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "User not found" });
    const body = req.body || {};

    let role = row.role;
    let hash = row.password_hash;
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role))
        return res.status(400).json({ error: "Role must be admin or editor" });
      if (
        row.role === "admin" &&
        body.role !== "admin" &&
        !(await otherAdminsExist(row.id))
      ) {
        return res
          .status(400)
          .json({ error: "You can't demote the last admin" });
      }
      role = body.role;
    }
    if (body.password !== undefined) {
      if (String(body.password).length < MIN_PASSWORD)
        return res.status(400).json({
          error: "Password must be at least " + MIN_PASSWORD + " characters",
        });
      hash = await hashPassword(String(body.password));
    }
    await pool.query(
      "UPDATE users SET role = $1, password_hash = $2 WHERE id = $3",
      [role, hash, row.id]
    );
    res.json({ ok: true });
  })
);

app.delete(
  "/api/users/:id",
  requireAdmin,
  asyncRoute(async (req, res) => {
    if (req.user.id === req.params.id)
      return res
        .status(400)
        .json({ error: "You can't delete your own account" });
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [
      req.params.id,
    ]);
    if (!rows[0]) return res.status(404).json({ error: "User not found" });
    if (rows[0].role === "admin" && !(await otherAdminsExist(rows[0].id))) {
      return res.status(400).json({ error: "You can't delete the last admin" });
    }
    await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  })
);

/* ================= CONTENT ================= */

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => {
      cb(
        null,
        "upload-" + Date.now() + "-" + crypto.randomBytes(6).toString("hex")
      );
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB per file, generous for signage video
});

app.get(
  "/api/content",
  asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      "SELECT * FROM content ORDER BY created_at DESC"
    );
    res.json(rows);
  })
);

app.post(
  "/api/content",
  requireAuth,
  upload.array("files", 20),
  asyncRoute(async (req, res) => {
    const files = req.files || [];
    // Parallel array of detected durations (seconds), sent by the browser
    // since it already has to load each file locally before uploading it.
    let durations = [];
    try {
      durations = JSON.parse(req.body.durations || "[]");
    } catch (e) {
      durations = [];
    }

    const created = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const id = crypto.randomUUID();

      // Browsers often send HEIC with an empty or odd mimetype, so check the extension too.
      const isHeic =
        /\.(heic|heif)$/i.test(file.originalname) ||
        /image\/hei[cf]/i.test(file.mimetype);

      let displayName = file.originalname;
      let mimetype = file.mimetype;
      let size = file.size;
      let sourcePath = file.path;

      if (isHeic) {
        try {
          const input = await fs.promises.readFile(file.path);
          const output = await convert({
            buffer: input,
            format: "JPEG",
            quality: 0.9,
          });
          sourcePath = file.path + ".jpg";
          await fs.promises.writeFile(sourcePath, output);
          displayName =
            file.originalname.replace(/\.(heic|heif)$/i, "") + ".jpg";
          mimetype = "image/jpeg";
          size = output.length;
        } catch (err) {
          fs.unlink(file.path, () => {});
          return res.status(400).json({ error: "Couldn't convert HEIC image" });
        }
      }

      const type = mimetype.startsWith("video")
        ? "video"
        : mimetype.startsWith("audio")
        ? "audio"
        : "image";
      const safeName = displayName.replace(/[^a-zA-Z0-9.\-_]/g, "_");
      const key =
        Date.now() +
        "-" +
        crypto.randomBytes(4).toString("hex") +
        "-" +
        safeName;
      const url = "/uploads/" + key;

      try {
        await fs.promises.copyFile(sourcePath, path.join(UPLOADS_DIR, key));
      } finally {
        fs.unlink(file.path, () => {});
        if (sourcePath !== file.path) fs.unlink(sourcePath, () => {});
      }

      const createdAt = Date.now();
      const durationSeconds =
        typeof durations[i] === "number" && durations[i] > 0
          ? durations[i]
          : null;
      await pool.query(
        "INSERT INTO content (id, name, type, url, filename, size, duration_seconds, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [id, displayName, type, url, key, size, durationSeconds, createdAt]
      );
      created.push({
        id,
        name: displayName,
        type,
        url,
        filename: key,
        size,
        duration_seconds: durationSeconds,
        created_at: createdAt,
      });
    }
    broadcast("content", "create", null);
    res.json(created);
  })
);

app.delete(
  "/api/content/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    const { rows } = await pool.query("SELECT * FROM content WHERE id = $1", [
      req.params.id,
    ]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Not found" });
    await pool.query("DELETE FROM content WHERE id = $1", [req.params.id]);
    fs.unlink(path.join(UPLOADS_DIR, path.basename(row.filename)), () => {}); // ignore if already gone
    broadcast("content", "delete", req.params.id);
    res.json({ ok: true });
  })
);

/* ================= PLAYLISTS ================= */

function serializePlaylist(row) {
  return {
    id: row.id,
    name: row.name,
    items: JSON.parse(row.items),
    ticker: JSON.parse(row.ticker),
    tickerLogo: row.ticker_logo || null,
    created_at: row.created_at,
  };
}

app.get(
  "/api/playlists",
  asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      "SELECT * FROM playlists ORDER BY created_at DESC"
    );
    res.json(rows.map(serializePlaylist));
  })
);

app.get(
  "/api/playlists/:id",
  asyncRoute(async (req, res) => {
    const { rows } = await pool.query("SELECT * FROM playlists WHERE id = $1", [
      req.params.id,
    ]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(serializePlaylist(row));
  })
);

app.post(
  "/api/playlists",
  requireAuth,
  asyncRoute(async (req, res) => {
    const id = crypto.randomUUID();
    const name = (req.body && req.body.name) || "Untitled playlist";
    const createdAt = Date.now();
    await pool.query(
      "INSERT INTO playlists (id, name, items, ticker, created_at) VALUES ($1,$2,$3,$4,$5)",
      [id, name, "[]", "[]", createdAt]
    );
    broadcast("playlists", "create", id);
    res.json(
      serializePlaylist({
        id,
        name,
        items: "[]",
        ticker: "[]",
        created_at: createdAt,
      })
    );
  })
);

app.patch(
  "/api/playlists/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    const { rows } = await pool.query("SELECT * FROM playlists WHERE id = $1", [
      req.params.id,
    ]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Not found" });
    const patch = req.body || {};
    const name = patch.name !== undefined ? patch.name : row.name;
    const items =
      patch.items !== undefined ? JSON.stringify(patch.items) : row.items;
    const ticker =
      patch.ticker !== undefined ? JSON.stringify(patch.ticker) : row.ticker;
    await pool.query(
      "UPDATE playlists SET name = $1, items = $2, ticker = $3 WHERE id = $4",
      [name, items, ticker, req.params.id]
    );
    const tickerLogo =
      patch.tickerLogo !== undefined ? patch.tickerLogo : row.ticker_logo;
    await pool.query(
      "UPDATE playlists SET name = $1, items = $2, ticker = $3, ticker_logo = $4 WHERE id = $5",
      [name, items, ticker, tickerLogo, req.params.id]
    );
    broadcast("playlists", "update", req.params.id);
    res.json(
      serializePlaylist({
        id: row.id,
        name,
        items,
        ticker,
        tickerLogo,
        created_at: row.created_at,
      })
    );
  })
);

app.delete(
  "/api/playlists/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    await pool.query("DELETE FROM playlists WHERE id = $1", [req.params.id]);
    // unassign any screen pointed at this playlist
    await pool.query(
      "UPDATE screens SET playlist_id = NULL WHERE playlist_id = $1",
      [req.params.id]
    );
    broadcast("playlists", "delete", req.params.id);
    broadcast("screens", "update", null);
    res.json({ ok: true });
  })
);

/* ================= SCREENS ================= */

async function generatePairingCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0/I/1
  let code;
  let exists = true;
  while (exists) {
    code = Array.from(
      { length: 6 },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");
    const { rows } = await pool.query(
      "SELECT 1 FROM screens WHERE pairing_code = $1",
      [code]
    );
    exists = rows.length > 0;
  }
  return code;
}

app.get(
  "/api/screens",
  requireAuth,
  asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      "SELECT * FROM screens ORDER BY created_at DESC"
    );
    res.json(rows);
  })
);

app.get(
  "/api/screens/:id",
  asyncRoute(async (req, res) => {
    const { rows } = await pool.query("SELECT * FROM screens WHERE id = $1", [
      req.params.id,
    ]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  })
);

app.post(
  "/api/screens",
  requireAuth,
  asyncRoute(async (req, res) => {
    const id = crypto.randomUUID();
    const name = (req.body && req.body.name) || "New screen";
    const pairingCode = await generatePairingCode();
    const createdAt = Date.now();
    await pool.query(
      "INSERT INTO screens (id, name, pairing_code, playlist_id, last_seen_at, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id, name, pairingCode, null, null, null, createdAt]
    );
    broadcast("screens", "create", id);
    res.json({
      id,
      name,
      pairing_code: pairingCode,
      playlist_id: null,
      last_seen_at: null,
      status: null,
      created_at: createdAt,
    });
  })
);

app.patch(
  "/api/screens/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    const { rows } = await pool.query("SELECT * FROM screens WHERE id = $1", [
      req.params.id,
    ]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Not found" });
    const patch = req.body || {};
    const name = patch.name !== undefined ? patch.name : row.name;
    const playlistId =
      patch.playlistId !== undefined ? patch.playlistId : row.playlist_id;
    await pool.query(
      "UPDATE screens SET name = $1, playlist_id = $2 WHERE id = $3",
      [name, playlistId, req.params.id]
    );
    broadcast("screens", "update", req.params.id);
    res.json({ ok: true });
  })
);

app.delete(
  "/api/screens/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    await pool.query("DELETE FROM screens WHERE id = $1", [req.params.id]);
    broadcast("screens", "delete", req.params.id);
    res.json({ ok: true });
  })
);

// Public: a screen looks itself up by the code typed in on the pairing form
app.post(
  "/api/screens/pair",
  guessLimiter,
  asyncRoute(async (req, res) => {
    const code = ((req.body && req.body.code) || "").trim().toUpperCase();
    const { rows } = await pool.query(
      "SELECT * FROM screens WHERE pairing_code = $1",
      [code]
    );
    const row = rows[0];
    if (!row)
      return res.status(404).json({ error: "No screen matches that code" });
    res.json(row);
  })
);

// Public: a screen calls this periodically to report itself online
app.post(
  "/api/screens/:id/heartbeat",
  asyncRoute(async (req, res) => {
    const result = await pool.query(
      "UPDATE screens SET last_seen_at = $1, status = 'online' WHERE id = $2",
      [Date.now(), req.params.id]
    );
    if (result.rowCount === 0)
      return res.status(404).json({ error: "Not found" });
    broadcast("screens", "heartbeat", req.params.id);
    res.json({ ok: true });
  })
);

/* ================= LIVE UPDATES (SSE) ================= */

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");

  const unsubscribe = subscribe((payload) => {
    res.write("data: " + JSON.stringify(payload) + "\n\n");
  });

  const keepAlive = setInterval(() => res.write(":\n\n"), 20000);

  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

/* ================= STARTUP ================= */

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        "Global T & T Digital Signage is running at http://localhost:" + PORT
      );
    });
  })
  .catch((err) => {
    console.error(
      "Could not connect to PostgreSQL — check your .env DB_* settings and that the server is reachable."
    );
    console.error(err.message);
    process.exit(1);
  });
