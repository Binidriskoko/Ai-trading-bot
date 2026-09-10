import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import test from "node:test";

const port = 8801;
const databasePath = "/tmp/ai-trading-bot-security-audit.sqlite";
let server;

const request = async (path, options = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
};

const signup = async (email, password) => {
  const response = await request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ username: email.split("@")[0], email, password }),
  });
  assert.equal(response.status, 200, `signup failed for ${email}: ${JSON.stringify(response.data)}`);
  return response;
};

test.before(async () => {
  rmSync(databasePath, { force: true });
  server = spawn(process.execPath, ["server/index.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, API_PORT: String(port), TRADING_DB_PATH: databasePath },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (chunk) => { if (chunk.toString().includes("Trading API listening")) resolve(); });
    server.on("error", reject);
  });
});

test.after(() => server.kill());

test("users cannot inject ledger events and malformed auth input is rejected", async () => {
  const owner = await signup("binidriskoko@gmail.co", "OwnerPass1");
  const user = await signup("security-user@example.com", "UserPass1");

  const injection = await request("/api/financial/event", {
    method: "POST",
    headers: { cookie: user.cookie },
    body: JSON.stringify({ eventId: "evil-event", type: "TRADE_FEE", fee: 9999, grossAmount: 9999, netAmount: 9999, metadata: { allocation: { ownerRevenue: 9999, platformReserve: 0, referralEarnings: 0 } } }),
  });
  assert.equal(injection.status, 403);
  assert.equal(injection.data.error, "Owner authorization required.");

  const badLogin = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "not-an-email", password: "Short1" }),
  });
  assert.equal(badLogin.status, 400);
  assert.match(badLogin.data.error, /valid email|invalid email/i);

  const invalidOwner = await request(`/api/admin/payments/${Date.now()}`, {
    method: "POST",
    headers: { cookie: user.cookie },
    body: JSON.stringify({ status: "APPROVED" }),
  });
  assert.equal(invalidOwner.status, 403);
  assert.equal(invalidOwner.data.error, "Owner authorization required.");

  const logout = await request("/api/auth/logout", { method: "POST", headers: { cookie: owner.cookie } });
  assert.equal(logout.status, 200);
  const staleSession = await request("/api/session", { headers: { cookie: owner.cookie } });
  assert.equal(staleSession.status, 200);
  assert.equal(staleSession.data.account, null);
});
