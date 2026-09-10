import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const password = "LegacyOwner1";
let directory;
let server;
let origin;

const request = async (path, options) => {
  const response = await fetch(`${origin}${path}`, options);
  return { response, data: await response.json() };
};

test.before(async () => {
  directory = await mkdtemp(join(tmpdir(), "trading-migration-"));
  const port = 19000 + Math.floor(Math.random() * 500);
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server/index.mjs"], { env: { ...process.env, API_PORT: String(port), TRADING_DB_PATH: join(directory, "trading.sqlite") }, stdio: ["ignore", "ignore", "pipe"] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("migration server did not start")), 5000);
    server.stderr.on("data", (value) => { if (String(value).includes("Error")) reject(new Error(String(value))); });
    const poll = async () => { try { if ((await fetch(`${origin}/api/session`)).ok) { clearTimeout(timeout); resolve(); return; } } catch {} setTimeout(poll, 25); };
    poll();
  });
});

test.after(async () => { server.kill(); await rm(directory, { recursive: true, force: true }); });

test("imports the canonical owner once and preserves legacy data", async () => {
  const legacy = {
    account: {
      email: "BINIDRISKOKO@GMAIL.CO",
      username: "legacy-owner",
      passwordHash: "not-a-server-hash",
      createdAt: "2024-01-02T03:04:05.000Z",
      wallet: { balance: 731.25, reserved: 12, referralEarnings: 4.5 },
      history: [{ id: "old-trade", symbol: "SIM-USD", pnl: 8.25 }],
      referrals: { code: "AI-LEGACY-1", referredBy: null },
      profile: { risk: "Balanced", notifications: false },
    },
    password,
  };
  const first = await request("/api/auth/migrate-owner", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(legacy) });
  assert.equal(first.response.status, 200);
  assert.equal(first.data.account.email, "binidriskoko@gmail.co");
  const cookie = first.response.headers.get("set-cookie");
  const data = await request("/api/account/data", { headers: { cookie } });
  assert.equal(data.data.account.wallet.balance, 731.25);
  assert.deepEqual(data.data.history, legacy.account.history);
  assert.equal(data.data.account.profile.risk, "Balanced");

  const second = await request("/api/auth/migrate-owner", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...legacy, account: { ...legacy.account, username: "changed" } }) });
  assert.equal(second.response.status, 409);
  const login = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: legacy.account.email, password }) });
  assert.equal(login.response.status, 200);
  assert.equal(login.data.account.username, "legacy-owner");
});

test("rejects migration for a non-canonical email", async () => {
  const result = await request("/api/auth/migrate-owner", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: { email: "owner@example.com" }, password }) });
  assert.equal(result.response.status, 403);
});