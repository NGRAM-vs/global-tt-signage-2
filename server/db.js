// PostgreSQL storage layer. Uses `pg` with a connection pool — every query
// in server.js is async (`await pool.query(...)`).

const { Pool } = require("pg");

// Managed Postgres providers (Railway, Neon, Supabase, Render, etc.) hand
// you one DATABASE_URL connection string rather than separate host/port/
// user/password fields. Prefer that when it's set; fall back to the
// discrete DB_* vars for local Docker use, where there's no single URL.
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // most managed providers require SSL with a non-strict cert chain
      max: 10
    })
  : new Pool({
      host: process.env.DB_HOST || "127.0.0.1",
      port: process.env.DB_PORT || 5432,
      user: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "",
      database: process.env.DB_NAME || "signal_signage",
      max: 10
    });

// Creates the tables if they don't exist yet. Called once at server startup.
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content (
      id VARCHAR(36) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      type VARCHAR(16) NOT NULL,
      url VARCHAR(512) NOT NULL,
      filename VARCHAR(255) NOT NULL,
      size BIGINT,
      duration_seconds REAL,
      created_at BIGINT NOT NULL
    )
  `);

  // Covers databases created before duration_seconds existed — harmless
  // no-op on a fresh install where the column is already there above.
  const existingCols = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'content' AND column_name = 'duration_seconds'`
  );
  if (existingCols.rows.length === 0) {
    await pool.query(`ALTER TABLE content ADD COLUMN duration_seconds REAL`);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS playlists (
      id VARCHAR(36) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      items TEXT NOT NULL,
      ticker TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS screens (
      id VARCHAR(36) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      pairing_code VARCHAR(16) NOT NULL UNIQUE,
      playlist_id VARCHAR(36),
      last_seen_at BIGINT,
      status VARCHAR(16),
      created_at BIGINT NOT NULL
    )
  `);
}

module.exports = { pool, init };
