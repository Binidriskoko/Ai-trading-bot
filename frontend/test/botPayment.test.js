import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const port = 8798;
const databasePath = "/tmp/ai-trading-bot-payment-test.sqlite";
let server;

const getBotStatus = (email) => {
  const db = new DatabaseSync(databasePath);
  try {
    return db.prepare("SELECT bot_status FROM users WHERE email = ?").get(email)?.bot_status || "inactive";
  } finally {
    db.close();
  }
};

const request = async (path, options = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
};

const signup = (email, password) => request("/api/auth/signup", { method: "POST", body: JSON.stringify({ username: email.split("@")[0], email, password }) });

test.before(async () => {
  rmSync(databasePath, { force: true });
  server = spawn(process.execPath, ["server/index.mjs"], { cwd: process.cwd(), env: { ...process.env, API_PORT: String(port), TRADING_DB_PATH: databasePath }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (chunk) => { if (chunk.toString().includes("Trading API listening")) resolve(); });
    server.on("error", reject);
  });
});

test.after(() => server.kill());

test("bot payment statuses gate activation, owner-only review, and survive login", async () => {
  const owner = await signup("binidriskoko@gmail.co", "OwnerPass1");
  const user = await signup("payment-user@example.com", "UserPass1");
  const userHeaders = { cookie: user.cookie };
  const ownerHeaders = { cookie: owner.cookie };
  const userEmail = user.data.account.email;

  const paymentDetails = await request("/api/payments", { headers: userHeaders });
  assert.deepEqual(paymentDetails.data.paymentConfig.amount, 2);
  assert.equal(paymentDetails.data.paymentConfig.token, "USDT");
  assert.equal(paymentDetails.data.paymentConfig.network, "Ethereum ERC-20");
  assert.match(paymentDetails.data.paymentConfig.recipientAddress, /^0x[a-f0-9]{40}$/i);
  assert.equal((await request("/api/trading/activate", { method: "POST", headers: userHeaders })).status, 403);
  assert.equal(getBotStatus(userEmail), "inactive");

  const invalidHash = await request("/api/payments", { method: "POST", headers: userHeaders, body: JSON.stringify({ reference: "0x1234" }) });
  assert.equal(invalidHash.status, 400);
  assert.equal(invalidHash.data.error, "A valid Ethereum transaction hash is required.");

  const submitted = await request("/api/payments", { method: "POST", headers: userHeaders, body: JSON.stringify({ reference: `0x${"1".repeat(64)}` }) });
  assert.equal(submitted.status, 201);
  assert.equal((await request("/api/trading/activate", { method: "POST", headers: userHeaders })).status, 403);
  assert.equal(getBotStatus(userEmail), "inactive");

  const nonOwnerApproval = await request(`/api/admin/payments/${submitted.data.payment.id}`, { method: "POST", headers: userHeaders, body: JSON.stringify({ status: "APPROVED" }) });
  assert.equal(nonOwnerApproval.status, 403);
  assert.equal(nonOwnerApproval.data.error, "Owner authorization required.");

  const rejected = await request(`/api/admin/payments/${submitted.data.payment.id}`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ status: "REJECTED" }) });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.data.payment.status, "REJECTED");
  assert.equal((await request("/api/trading/activate", { method: "POST", headers: userHeaders })).status, 403);
  assert.equal(getBotStatus(userEmail), "inactive");

  const replacement = await request("/api/payments", { method: "POST", headers: userHeaders, body: JSON.stringify({ reference: `0x${"2".repeat(64)}` }) });
  assert.equal(replacement.status, 201);
  const approval = await request(`/api/admin/payments/${replacement.data.payment.id}`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ status: "APPROVED" }) });
  assert.equal(approval.status, 200);
  assert.equal(approval.data.payment.status, "APPROVED");
  assert.equal((await request("/api/trading/activate", { method: "POST", headers: userHeaders })).status, 200);
  assert.equal(getBotStatus(userEmail), "active");

  const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email: user.data.account.email, password: "UserPass1" }) });
  const reloginHeaders = { cookie: login.cookie };
  const statusAfterLogin = await request("/api/trading/status", { headers: reloginHeaders });
  assert.equal(statusAfterLogin.status, 200);
  assert.equal(statusAfterLogin.data.payment.status, "APPROVED");
  assert.equal(statusAfterLogin.data.botStatus, "active");
  assert.equal((await request("/api/trading/activate", { method: "POST", headers: reloginHeaders })).status, 200);
  assert.equal(getBotStatus(userEmail), "active");
});

test("duplicate payment hashes are rejected and expired sessions are denied", async () => {
  const user = await signup("payment-duplicate@example.com", "UserPass1");
  const headers = { cookie: user.cookie };
  const reference = `0x${"7".repeat(64)}`;

  const first = await request("/api/payments", { method: "POST", headers, body: JSON.stringify({ reference }) });
  assert.equal(first.status, 201);

  const duplicate = await request("/api/payments", { method: "POST", headers, body: JSON.stringify({ reference }) });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.data.error, /already exists|duplicate/i);

  const expired = await request("/api/trading/status", { headers: { cookie: "session=expired-token; Path=/; HttpOnly" } });
  assert.equal(expired.status, 401);
  assert.equal(expired.data.error, "Authentication required.");
});
