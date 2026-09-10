import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const port = 8800;
const databasePath = "/tmp/ai-trading-bot-withdrawal-fee.sqlite";
const adminWallet = "0x1111111111111111111111111111111111111111";
let server;

const db = () => new DatabaseSync(databasePath);

const request = async (path, options = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
};

const signup = async (email, password) => {
  const response = await request("/api/auth/signup", { method: "POST", body: JSON.stringify({ username: email.split("@")[0], email, password }) });
  assert.equal(response.status, 200, `signup failed for ${email}: ${JSON.stringify(response.data)}`);
  return response;
};

const setBalance = (email, amount) => {
  const database = db();
  try {
    database.prepare("UPDATE users SET balance = ? WHERE email = ?").run(Number(amount), email);
  } finally {
    database.close();
  }
};

const getBalance = (email) => {
  const database = db();
  try {
    return database.prepare("SELECT balance, reserved FROM users WHERE email = ?").get(email);
  } finally {
    database.close();
  }
};

const getLedger = (email) => {
  const database = db();
  try {
    return database.prepare("SELECT * FROM ledger WHERE user_email = ? ORDER BY timestamp DESC").all(email);
  } finally {
    database.close();
  }
};

const getAllLedger = () => {
  const database = db();
  try {
    return database.prepare("SELECT * FROM ledger ORDER BY timestamp DESC").all();
  } finally {
    database.close();
  }
};

const ensureServer = async () => {
  if (server && !server.killed) return;
  if (!server) rmSync(databasePath, { force: true });
  server = spawn(process.execPath, ["server/index.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, API_PORT: String(port), TRADING_DB_PATH: databasePath, ADMIN_WALLET_ADDRESS: adminWallet, OWNER_WALLET_ADDRESS: adminWallet },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (chunk) => { if (chunk.toString().includes("Trading API listening")) resolve(); });
    server.on("error", reject);
  });
};

test.before(async () => {
  await ensureServer();
});

test.after(() => server.kill());

test("$100 withdrawal charges $1 fixed fee and records admin wallet fee", async () => {
  const user = await signup("withdrawal-success@example.com", "UserPass1");
  const email = user.data.account.email;
  setBalance(email, 1000);

  const response = await request("/api/withdraw", {
    method: "POST",
    headers: { cookie: user.cookie },
    body: JSON.stringify({ amount: 100, idempotencyKey: "withdraw-success-1" }),
  });

  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.withdrawal.grossAmount, 100);
  assert.equal(response.data.withdrawal.fee, 1);
  assert.equal(response.data.withdrawal.netAmount, 99);
  assert.equal(response.data.withdrawal.adminWalletAddress, adminWallet);
  assert.equal(response.data.withdrawal.status, "completed");

  const after = getBalance(email);
  assert.equal(after.balance, 899);
  assert.equal(after.reserved, 0);

  const ledger = getLedger(email);
  const allLedger = getAllLedger();
  assert.equal(ledger.filter((entry) => entry.type === "WITHDRAWAL").length, 1);
  assert.equal(ledger.find((entry) => entry.type === "WITHDRAWAL")?.fee, 1);
  assert.equal(ledger.find((entry) => entry.type === "WITHDRAWAL")?.net_amount, 99);
  assert.equal(allLedger.filter((entry) => entry.type === "WITHDRAWAL_FEE").length, 1);
  assert.equal(allLedger.find((entry) => entry.type === "WITHDRAWAL_FEE")?.amount, 1);
  assert.equal(allLedger.find((entry) => entry.type === "WITHDRAWAL_FEE")?.user_email, "binidriskoko@gmail.co");
  assert.match(allLedger.find((entry) => entry.type === "WITHDRAWAL_FEE")?.metadata_json || "", /0x1111111111111111111111111111111111111111/);
});

test("insufficient funds rejects withdrawal and does not collect a fee", async () => {
  const user = await signup("withdrawal-insufficient@example.com", "UserPass1");
  const email = user.data.account.email;
  setBalance(email, 50);

  const response = await request("/api/withdraw", {
    method: "POST",
    headers: { cookie: user.cookie },
    body: JSON.stringify({ amount: 50, idempotencyKey: "withdraw-insufficient-1" }),
  });

  assert.equal(response.status, 409);
  assert.match(response.data.error, /insufficient funds|available balance/i);
  assert.equal(getBalance(email).balance, 50);
  assert.equal(getLedger(email).filter((entry) => entry.type === "WITHDRAWAL").length, 0);
  assert.equal(getLedger(email).filter((entry) => entry.type === "WITHDRAWAL_FEE").length, 0);
});

test("duplicate retries are idempotent and do not charge twice", async () => {
  const user = await signup("withdrawal-duplicate@example.com", "UserPass1");
  const email = user.data.account.email;
  setBalance(email, 200);

  const first = await request("/api/withdraw", { method: "POST", headers: { cookie: user.cookie }, body: JSON.stringify({ amount: 100, idempotencyKey: "duplicate-1" }) });
  const second = await request("/api/withdraw", { method: "POST", headers: { cookie: user.cookie }, body: JSON.stringify({ amount: 100, idempotencyKey: "duplicate-1" }) });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(getBalance(email).balance, 99);
  assert.equal(getLedger(email).filter((entry) => entry.type === "WITHDRAWAL").length, 1);
  assert.equal(getAllLedger().filter((entry) => entry.type === "WITHDRAWAL_FEE" && entry.reference_id === "duplicate-1").length, 1);
});

test("unauthorized user cannot withdraw another account or override the admin fee wallet", async () => {
  const owner = await signup("owner-unauthorized@example.com", "OwnerPass1");
  const victim = await signup("victim-unauthorized@example.com", "UserPass1");
  const email = victim.data.account.email;
  setBalance(email, 500);

  const response = await request("/api/withdraw", {
    method: "POST",
    headers: { cookie: owner.cookie },
    body: JSON.stringify({ amount: 20, userEmail: email, adminWalletAddress: "0x9999999999999999999999999999999999999999", withdrawalFee: 9, idempotencyKey: "unauthorized-1" }),
  });

  assert.equal(response.status, 403);
  assert.equal(getBalance(email).balance, 500);
  assert.equal(getLedger(email).filter((entry) => entry.type === "WITHDRAWAL").length, 0);
});

test("concurrent withdrawals cannot overspend the same balance", async () => {
  const user = await signup("withdrawal-concurrent@example.com", "UserPass1");
  const email = user.data.account.email;
  setBalance(email, 100);

  const first = request("/api/withdraw", { method: "POST", headers: { cookie: user.cookie }, body: JSON.stringify({ amount: 50, idempotencyKey: "concurrent-1" }) });
  const second = request("/api/withdraw", { method: "POST", headers: { cookie: user.cookie }, body: JSON.stringify({ amount: 50, idempotencyKey: "concurrent-2" }) });

  const [a, b] = await Promise.all([first, second]);
  const successful = [a, b].filter((result) => result.status === 200).length;
  const failed = [a, b].filter((result) => result.status === 409 || result.status === 400).length;

  assert.equal(successful, 1);
  assert.equal(failed, 1);
  assert.ok(getBalance(email).balance >= 49 && getBalance(email).balance <= 50);
  assert.equal(getLedger(email).filter((entry) => entry.type === "WITHDRAWAL").length, 1);
});

test("successful withdrawal remains correct after logout/login and restart", async () => {
  const user = await signup("withdrawal-persist@example.com", "UserPass1");
  const email = user.data.account.email;
  setBalance(email, 250);

  const first = await request("/api/withdraw", { method: "POST", headers: { cookie: user.cookie }, body: JSON.stringify({ amount: 50, idempotencyKey: "persist-1" }) });
  assert.equal(first.status, 200);

  const logout = await request("/api/auth/logout", { method: "POST", headers: { cookie: user.cookie } });
  assert.equal(logout.status, 200);

  const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: "UserPass1" }) });
  const session = { cookie: login.cookie };
  const account = await request("/api/account", { headers: session });
  assert.equal(account.status, 200);
  assert.equal(account.data.account.wallet.balance, 199);

  server.kill();
  await ensureServer();

  const reloaded = await request("/api/account", { headers: { cookie: login.cookie } });
  assert.equal(reloaded.status, 200);

  const reLogin = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: "UserPass1" }) });
  const persisted = await request("/api/account", { headers: { cookie: reLogin.cookie } });
  assert.equal(persisted.status, 200);
  assert.equal(persisted.data.account.wallet.balance, 199);
  const ledger = getLedger(email);
  assert.equal(ledger.filter((entry) => entry.type === "WITHDRAWAL").length, 1);
  assert.equal(getAllLedger().find((entry) => entry.type === "WITHDRAWAL_FEE")?.amount, 1);
});
