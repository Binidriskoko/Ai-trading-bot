import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import test from "node:test";

const port = 8802;
const databasePath = "/tmp/ai-trading-bot-password-reset.sqlite";
let server;

const request = async (path, options = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
};

const signup = async (email, password, username = email.split("@")[0]) => {
  const response = await request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ username, email, password }),
  });
  assert.equal(response.status, 200, `signup failed for ${email}: ${JSON.stringify(response.data)}`);
  return response;
};

const tokenHash = (value) => createHash("sha256").update(value).digest("hex");

test.before(async () => {
  rmSync(databasePath, { force: true });
  server = spawn(process.execPath, ["server/index.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, API_PORT: String(port), TRADING_DB_PATH: databasePath },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("Trading API listening")) resolve();
    });
    server.on("error", reject);
  });
});

test.after(() => server.kill());

test("password reset requests are safe and valid reset tokens can set a new password", async () => {
  const unknownEmail = "missing-user@example.com";
  const resetRequestUnknown = await request("/api/auth/password-reset/request", {
    method: "POST",
    body: JSON.stringify({ email: unknownEmail }),
  });
  assert.equal(resetRequestUnknown.status, 200);
  assert.match(resetRequestUnknown.data.message, /If an account exists|account exists|reset/i);

  await signup("reset-user@example.com", "ResetPass1");

  const resetRequestKnown = await request("/api/auth/password-reset/request", {
    method: "POST",
    body: JSON.stringify({ email: "reset-user@example.com" }),
  });
  assert.equal(resetRequestKnown.status, 200);
  assert.match(resetRequestKnown.data.message, /If an account exists|account exists|reset/i);

  const db = new DatabaseSync(databasePath);
  const row = db.prepare("SELECT * FROM password_reset_tokens WHERE user_email = ?").get("reset-user@example.com");
  assert.ok(row, "expected a password reset token to be created for the known account");

  const rawToken = `reset-demo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  db.prepare("INSERT INTO password_reset_tokens(id, user_email, token_hash, created_at, expires_at, used_at) VALUES(?,?,?,?,?,?)").run(`reset-test-${Date.now()}`, "reset-user@example.com", tokenHash(rawToken), new Date().toISOString(), new Date(Date.now() + 3600000).toISOString(), null);

  const confirm = await request("/api/auth/password-reset/confirm", {
    method: "POST",
    body: JSON.stringify({ token: rawToken, password: "NewResetPass2" }),
  });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.data));
  assert.equal(confirm.data.ok, true);

  const login = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "reset-user@example.com", password: "NewResetPass2" }),
  });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.equal(login.data.account.email, "reset-user@example.com");
});

test("normal users cannot access the admin transaction center", async () => {
  const user = await signup("tx-user@example.com", "UserPass1");
  const forbidden = await request("/api/admin/transactions", {
    method: "GET",
    headers: { cookie: user.cookie },
  });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.data.error, "Owner authorization required.");

  const owner = await signup("binidriskoko@gmail.co", "OwnerPass1");
  const allowed = await request("/api/admin/transactions?page=1&pageSize=5&sort=newest", {
    method: "GET",
    headers: { cookie: owner.cookie },
  });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
  assert.ok(Array.isArray(allowed.data.transactions));
  assert.equal(typeof allowed.data.total, "number");
  assert.ok(allowed.data.pageSize <= 100);
});
