import { mkdirSync, mkdtempSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // Environment variables may be supplied by the process manager or tests.
}

const isProduction = (process.env.NODE_ENV || "development").toLowerCase() === "production";
const configuredDatabasePath = String(process.env.TRADING_DB_PATH || "").trim();
if (isProduction && (!configuredDatabasePath || !isAbsolute(configuredDatabasePath))) {
  throw new Error("TRADING_DB_PATH must be an absolute persistent path in production.");
}
const isTestProcess = process.env.NODE_ENV === "test" || process.execArgv.includes("--test") || process.argv.includes("--test") || process.argv.some((argument) => /(?:^|[\\/])test(?:[\\/].*)?\.test\.js$/.test(argument));
const databasePath = resolve(configuredDatabasePath || (isTestProcess ? join(mkdtempSync(join(tmpdir(), "ai-trading-test-")), "trading.sqlite") : "./data/trading.sqlite"));
mkdirSync(dirname(databasePath), { recursive: true });
export const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    profile_json TEXT NOT NULL,
    balance REAL NOT NULL DEFAULT 1000 CHECK(balance >= 0),
    reserved REAL NOT NULL DEFAULT 0 CHECK(reserved >= 0),
    referral_earnings REAL NOT NULL DEFAULT 0 CHECK(referral_earnings >= 0)
  );
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES users(email), expires_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS referrals (email TEXT PRIMARY KEY REFERENCES users(email), code TEXT NOT NULL UNIQUE, referred_by TEXT REFERENCES users(email));
  CREATE TABLE IF NOT EXISTS ledger (
    id TEXT PRIMARY KEY,
    event_id TEXT UNIQUE,
    user_email TEXT NOT NULL,
    type TEXT NOT NULL,
    amount REAL NOT NULL CHECK(amount >= 0),
    gross_amount REAL NOT NULL CHECK(gross_amount >= 0),
    fee REAL NOT NULL CHECK(fee >= 0),
    net_amount REAL NOT NULL CHECK(net_amount >= 0),
    timestamp TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    status TEXT NOT NULL,
    metadata_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, action TEXT NOT NULL, actor TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL, timestamp TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bot_payments (
    id TEXT PRIMARY KEY,
    user_email TEXT NOT NULL REFERENCES users(email),
    amount REAL NOT NULL CHECK(amount >= 0),
    reference TEXT NOT NULL,
    proof TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    reviewed_by TEXT,
    reviewed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY,
    user_email TEXT NOT NULL REFERENCES users(email),
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
`);
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ledger_reference_unique ON ledger(reference_id, type) WHERE type IN ('WITHDRAWAL', 'WITHDRAWAL_FEE')");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS bot_payment_reference_unique ON bot_payments(reference)");
db.exec("CREATE INDEX IF NOT EXISTS bot_payments_status_idx ON bot_payments(user_email, status)");
db.exec("CREATE INDEX IF NOT EXISTS referrals_referred_by_idx ON referrals(referred_by)");
db.exec("CREATE INDEX IF NOT EXISTS bot_payments_review_idx ON bot_payments(status, created_at DESC)");
db.exec("CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at)");
db.exec("CREATE INDEX IF NOT EXISTS sessions_email_idx ON sessions(email)");
db.exec("CREATE INDEX IF NOT EXISTS ledger_user_timestamp_idx ON ledger(user_email, timestamp DESC)");
db.exec("CREATE INDEX IF NOT EXISTS ledger_type_timestamp_idx ON ledger(type, timestamp DESC)");
db.exec("CREATE INDEX IF NOT EXISTS ledger_user_type_timestamp_idx ON ledger(user_email, type, timestamp DESC)");
db.exec("CREATE INDEX IF NOT EXISTS password_reset_user_idx ON password_reset_tokens(user_email, created_at DESC)");
db.exec("CREATE INDEX IF NOT EXISTS password_reset_expires_idx ON password_reset_tokens(expires_at)");
if (!db.prepare("PRAGMA table_info(users)").all().some((column) => column.name === "bot_status")) {
  db.exec("ALTER TABLE users ADD COLUMN bot_status TEXT NOT NULL DEFAULT 'inactive'");
}

db.exec(`
  CREATE TRIGGER IF NOT EXISTS users_balance_non_negative
  BEFORE UPDATE ON users
  FOR EACH ROW
  BEGIN
    SELECT CASE
      WHEN NEW.balance < 0 THEN RAISE(ABORT, 'balance must be non-negative')
      WHEN NEW.reserved < 0 THEN RAISE(ABORT, 'reserved must be non-negative')
      WHEN NEW.referral_earnings < 0 THEN RAISE(ABORT, 'referral_earnings must be non-negative')
    END;
  END;

  CREATE TRIGGER IF NOT EXISTS users_balance_insert_non_negative
  BEFORE INSERT ON users
  FOR EACH ROW
  BEGIN
    SELECT CASE
      WHEN NEW.balance < 0 THEN RAISE(ABORT, 'balance must be non-negative')
      WHEN NEW.reserved < 0 THEN RAISE(ABORT, 'reserved must be non-negative')
      WHEN NEW.referral_earnings < 0 THEN RAISE(ABORT, 'referral_earnings must be non-negative')
    END;
  END;
`);

export const OWNER_EMAIL = "binidriskoko@gmail.co";
export const defaults = { tradingFeePercent: 0.25, depositFeePercent: 1, withdrawalFeePercent: 1, referralCommissionPercent: 20, ownerRevenuePercent: 70, platformReservePercent: 10 };
export const now = () => new Date().toISOString();
export const json = (value) => JSON.stringify(value ?? {});
export const parse = (value, fallback = {}) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
export const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
export const getUser = (email) => db.prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email));
export const publicUser = (user) => user && ({ username: user.username, email: user.email, createdAt: user.created_at, status: user.status, botStatus: user.bot_status || "inactive", profile: parse(user.profile_json), wallet: { balance: user.balance, reserved: user.reserved, referralEarnings: user.referral_earnings }, role: user.email === OWNER_EMAIL ? "owner" : "user" });
export const settings = () => ({ ...defaults, ...parse(db.prepare("SELECT value_json FROM settings WHERE key = 'fees'").get()?.value_json, {}) });
export const setSettings = (value) => db.prepare("INSERT INTO settings(key,value_json) VALUES('fees',?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json").run(json(value));
export const closeDatabase = () => {
  try {
    db.close();
  } catch (error) {
    console.warn("[db] close failed", error.message);
  }
};