import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { stat, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, db, OWNER_EMAIL, defaults, getUser, json, normalizeEmail, now, parse, publicUser, setSettings, settings } from "./db.mjs";
import { adminWalletAddress, botPaymentConfig, corsOrigin, host, port, secureCookies, tradingMode, withdrawalFeeAmount } from "./config.mjs";

const safeOrigin = String(corsOrigin || "").trim();
const isProduction = (process.env.NODE_ENV || "development").toLowerCase() === "production";
const staticRoot = resolve(fileURLToPath(new URL("../dist", import.meta.url)));
const fallbackHtml = async () => readFile(join(staticRoot, "index.html"), "utf8");
const passwordHash = (value) => scryptSync(value, "ai-trading-bot-password-salt", 32).toString("hex");
const tokenHash = (value) => createHash("sha256").update(value).digest("hex");
const readBody = async (request) => { let value = ""; for await (const chunk of request) value += chunk; return value ? JSON.parse(value) : {}; };
const send = (response, status, value, headers = {}) => { response.writeHead(status, { "content-type": "application/json", ...headers }); response.end(JSON.stringify(value)); };
const sessionToken = (request) => request.headers.cookie?.match(/(?:^|; )session=([^;]+)/)?.[1];
const validEmail = (value) => typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) && value.trim().length <= 254;
const validUsername = (value) => typeof value === "string" && value.trim().length >= 3 && value.trim().length <= 80 && !/[\r\n]/.test(value);
const validPassword = (value) => typeof value === "string" && value.length >= 8 && /[A-Z]/.test(value) && /[0-9]/.test(value) && !/\s/.test(value);
const validIdempotencyKey = (value) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 160 && !/[\r\n]/.test(value);
const validReference = (value) => typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value.trim());
const setCorsHeaders = (response, request) => {
  const requestOrigin = request.headers.origin ? String(request.headers.origin) : "";
  const allowedOrigin = safeOrigin && requestOrigin && (safeOrigin === requestOrigin || safeOrigin === "*") ? requestOrigin : safeOrigin || "*";
  response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  response.setHeader("Vary", "Origin");
};
const rateLimitBuckets = new Map();
const normalizeClientIp = (request) => {
  const forwarded = request.headers["x-forwarded-for"] || request.headers["x-real-ip"] || "";
  const first = String(forwarded).split(",")[0].trim();
  return first || request.socket?.remoteAddress || "unknown";
};
const checkRateLimit = (request, key, limit = 10, windowMs = 60000) => {
  const bucketKey = `${key}:${normalizeClientIp(request)}`;
  const nowMs = Date.now();
  const current = rateLimitBuckets.get(bucketKey) || [];
  const recent = current.filter((entry) => entry > nowMs - windowMs);
  if (recent.length >= limit) {
    rateLimitBuckets.set(bucketKey, recent);
    return false;
  }
  recent.push(nowMs);
  rateLimitBuckets.set(bucketKey, recent);
  return true;
};
const currentUser = (request) => { const token = sessionToken(request); if (!token || !/^[a-f0-9]+$/i.test(token)) return null; const session = db.prepare("SELECT email FROM sessions WHERE token_hash = ? AND expires_at > ?").get(tokenHash(token), now()); return session ? getUser(session.email) : null; };
const requireUser = (request, response) => { const user = currentUser(request); if (!user) { send(response, 401, { error: "Authentication required." }); return null; } return user; };
const isOwner = (user) => Boolean(user && normalizeEmail(user.email) === OWNER_EMAIL);
const ownerOnly = (request, response) => { const user = requireUser(request, response); if (!user) return null; if (!isOwner(user)) { send(response, 403, { error: "Owner authorization required." }); return null; } return user; };
const validAllocation = (value) => [value.ownerRevenuePercent, value.referralCommissionPercent, value.platformReservePercent].map(Number).every((item) => Number.isFinite(item) && item >= 0) && Math.abs(Number(value.ownerRevenuePercent) + Number(value.referralCommissionPercent) + Number(value.platformReservePercent) - 100) < 0.000001;
const codeFor = (email) => `AI-${normalizeEmail(email).replace(/[^a-z0-9]/gi, "").slice(0, 5).toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`;
const allReferrals = () => { const result = {}; for (const row of db.prepare("SELECT r.email, r.code, r.referred_by, GROUP_CONCAT(child.email) AS children FROM referrals r LEFT JOIN referrals child ON child.referred_by = r.email GROUP BY r.email").all()) result[row.email] = { code: row.code, referredBy: row.referred_by, referredUsers: row.children ? row.children.split(",") : [], rewards: db.prepare("SELECT id, amount, timestamp, metadata_json FROM ledger WHERE user_email = ? AND type = 'REFERRAL_REWARD' ORDER BY timestamp DESC").all(row.email).map((item) => ({ id: item.id, amount: item.amount, timestamp: item.timestamp, ...parse(item.metadata_json) })) }; return result; };
const allLedger = () => db.prepare("SELECT id, event_id AS eventId, user_email AS user, type, amount, gross_amount AS grossAmount, fee, net_amount AS netAmount, timestamp, reference_id AS referenceId, status, metadata_json AS metadata FROM ledger ORDER BY timestamp DESC").all().map((item) => ({ ...item, metadata: parse(item.metadata) }));
const summary = () => { const rows = allLedger(); const sum = (type) => rows.filter((item) => item.type === type && item.fee > 0).reduce((total, item) => total + item.fee, 0); const allocations = rows.filter((item) => item.type === "TRADE_FEE").map((item) => item.metadata.allocation).filter(Boolean); const ownerRevenue = allocations.reduce((total, item) => total + item.ownerRevenue, 0); return { tradingFees: sum("TRADE_FEE"), depositFees: sum("DEPOSIT"), withdrawalFees: sum("WITHDRAWAL"), referralRewards: rows.filter((item) => item.type === "REFERRAL_REWARD").reduce((total, item) => total + item.netAmount, 0), adminRevenue: ownerRevenue, ownerRevenue, platformReserve: allocations.reduce((total, item) => total + item.platformReserve, 0), referralRewardEventCount: rows.filter((item) => item.type === "REFERRAL_REWARD").length, feeEventCount: rows.filter((item) => ["TRADE_FEE", "DEPOSIT", "WITHDRAWAL"].includes(item.type) && item.fee > 0).length }; };
const paymentView = (payment) => ({ id: payment.id, userEmail: payment.user_email, amount: payment.amount, token: botPaymentConfig.token, network: botPaymentConfig.network, reference: payment.reference, proof: payment.proof, createdAt: payment.created_at, status: payment.status, reviewedBy: payment.reviewed_by, reviewedAt: payment.reviewed_at });
const paymentResponse = (payment) => ({ payment: payment ? paymentView(payment) : null, paymentConfig: botPaymentConfig });
const withdrawalReference = (key) => String(key || "").trim();
const withdrawalResponse = (userEmail, eventId, grossAmount, feeAmount, netAmount, idempotencyKey, status = "completed") => ({
  id: eventId,
  eventId,
  userEmail,
  grossAmount: Number(grossAmount),
  fee: Number(feeAmount),
  netAmount: Number(netAmount),
  adminWalletAddress,
  idempotencyKey,
  timestamp: now(),
  status,
});
const paymentFor = (email) => db.prepare("SELECT * FROM bot_payments WHERE user_email = ? ORDER BY created_at DESC LIMIT 1").get(normalizeEmail(email));
const allPayments = () => db.prepare("SELECT * FROM bot_payments ORDER BY CASE status WHEN 'PENDING' THEN 0 ELSE 1 END, created_at DESC").all().map(paymentView);
const loginResponse = (response, user) => { const token = randomBytes(32).toString("hex"); db.prepare("DELETE FROM sessions WHERE email = ?").run(user.email); db.prepare("INSERT INTO sessions(token_hash,email,expires_at) VALUES(?,?,?)").run(tokenHash(token), user.email, new Date(Date.now() + 604800000).toISOString()); const cookieAttributes = `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${secureCookies ? "; Secure" : ""}`; send(response, 200, { account: publicUser(user) }, { "set-cookie": cookieAttributes }); };
const audit = (actor, action, target = "") => db.prepare("INSERT INTO audit_logs(id,action,actor,target,status,timestamp) VALUES(?,?,?,?,?,?)").run(`audit-${Date.now()}-${randomBytes(3).toString("hex")}`, action, normalizeEmail(actor), normalizeEmail(target), "completed", now());
const legacyValue = (value, fallback) => value === undefined || value === null ? fallback : value;
const importLegacyOwner = (input) => {
  const account = input.account || {};
  const email = normalizeEmail(account.email);
  if (email !== OWNER_EMAIL) return { imported: false, error: "Only the canonical owner account can be migrated." };
  if (getUser(email)) return { imported: false, alreadyExists: true };
  const credential = typeof account.passwordHash === "string" && /^[a-f0-9]{64}$/i.test(account.passwordHash)
    ? account.passwordHash
    : typeof input.password === "string" && input.password.length > 0 ? passwordHash(input.password) : "";
  if (!credential) return { imported: false, needsPassword: true };
  const wallet = account.wallet || {};
  const profile = { ...(account.profile || {}), history: legacyValue(account.history, account.profile?.history || []) };
  const createdAt = typeof account.createdAt === "string" ? account.createdAt : now();
  const username = String(account.username || "owner").trim().slice(0, 80) || "owner";
  const referral = account.referrals || {};
  const code = String(referral.code || `AI-OWNER-${randomBytes(3).toString("hex").toUpperCase()}`).trim().toUpperCase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO users(email,username,password_hash,created_at,status,profile_json,balance,reserved,referral_earnings) VALUES(?,?,?,?,?,?,?,?,?)").run(email, username, credential, createdAt, account.status === "suspended" ? "suspended" : "active", json(profile), Number(wallet.balance ?? account.balance ?? 1000), Number(wallet.reserved ?? account.reserved ?? 0), Number(wallet.referralEarnings ?? account.referralEarnings ?? 0));
    db.prepare("INSERT INTO referrals(email,code,referred_by) VALUES(?,?,?)").run(email, code, referral.referredBy ? normalizeEmail(referral.referredBy) : null);
    db.prepare("INSERT INTO audit_logs(id,action,actor,target,status,timestamp) VALUES(?,?,?,?,?,?)").run(`audit-${Date.now()}-${randomBytes(3).toString("hex")}`, "OWNER_ACCOUNT_MIGRATED", email, email, "completed", now());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    if (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY") return { imported: false, alreadyExists: true };
    throw error;
  }
  return { imported: true, account: getUser(email) };
};

const server = createServer(async (request, response) => {
  try {
    setCorsHeaders(response, request);
    const url = new URL(request.url, `http://${request.headers.host}`); const path = url.pathname; const method = request.method;
    if (method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (method === "GET" && path === "/api/health") {
      return send(response, 200, {
        ok: true,
        status: "healthy",
        environment: process.env.NODE_ENV || "development",
        mode: tradingMode,
        ready: true,
        timestamp: now(),
      });
    }
    if (method === "POST" && path === "/api/auth/signup") { const input = await readBody(request); const email = normalizeEmail(input.email); const username = typeof input.username === "string" ? input.username.trim() : ""; if (!validUsername(username) || !validEmail(email) || !validPassword(String(input.password || ""))) return send(response, 400, { error: "Invalid signup details." }); if (getUser(email)) return send(response, 409, { error: "An account with this email already exists." }); db.prepare("INSERT INTO users(email,username,password_hash,created_at,profile_json) VALUES(?,?,?,?,?)").run(email, username, passwordHash(String(input.password)), now(), json({ risk: "Conservative", notifications: true })); db.prepare("INSERT INTO referrals(email,code) VALUES(?,?)").run(email, codeFor(email)); return loginResponse(response, getUser(email)); }
    if (method === "POST" && path === "/api/auth/migrate-owner") { const input = await readBody(request); const result = importLegacyOwner(input); if (result.error) return send(response, 403, { error: result.error }); if (result.needsPassword) return send(response, 428, { error: "A password is required to migrate this account." }); if (result.alreadyExists) return send(response, 409, { error: "The account is already available in SQLite." }); return loginResponse(response, result.account); }
    if (method === "POST" && path === "/api/auth/login") { const input = await readBody(request); const email = normalizeEmail(input.email); if (!validEmail(email) || !validPassword(String(input.password || ""))) return send(response, 400, { error: "A valid email and password are required." }); const user = getUser(email); const valid = user && timingSafeEqual(Buffer.from(user.password_hash), Buffer.from(passwordHash(input.password || ""))); if (!valid) return send(response, 401, { error: "Email or password is incorrect." }); if (user.status === "suspended") return send(response, 403, { error: "This account is suspended." }); return loginResponse(response, user); }
    if (method === "POST" && path === "/api/auth/logout") { const token = sessionToken(request); if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token)); return send(response, 200, { ok: true }, { "set-cookie": "session=; HttpOnly; Path=/; Max-Age=0" }); }
    if (method === "POST" && path === "/api/auth/password-reset/request") {
      if (!checkRateLimit(request, "password-reset-request", 5, 900000)) return send(response, 429, { error: "Too many password reset requests. Please wait and try again later." });
      const input = await readBody(request);
      const email = normalizeEmail(input.email);
      if (!validEmail(email)) return send(response, 400, { error: "A valid email is required." });
      const user = getUser(email);
      if (user) {
        const token = randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        db.prepare("DELETE FROM password_reset_tokens WHERE user_email = ?").run(user.email);
        db.prepare("INSERT INTO password_reset_tokens(id,user_email,token_hash,created_at,expires_at,used_at) VALUES(?,?,?,?,?,?)").run(`reset-${Date.now()}-${randomBytes(4).toString("hex")}`, user.email, tokenHash(token), now(), expiresAt, null);
      }
      return send(response, 200, { ok: true, message: "If an account exists for this email, a password reset link has been sent." });
    }
    if (method === "POST" && path === "/api/auth/password-reset/confirm") {
      if (!checkRateLimit(request, "password-reset-confirm", 10, 900000)) return send(response, 429, { error: "Too many reset attempts. Please wait and try again later." });
      const input = await readBody(request);
      const token = String(input.token || "").trim();
      const password = String(input.password || "");
      if (!token || !validPassword(password)) return send(response, 400, { error: "A valid reset token and a strong new password are required." });
      const tokenRow = db.prepare("SELECT * FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1").get(tokenHash(token), now());
      if (!tokenRow) return send(response, 400, { error: "The reset token is invalid or has expired." });
      db.exec("BEGIN IMMEDIATE");
      try {
        const user = getUser(tokenRow.user_email);
        if (!user) throw new Error("Password reset user not found.");
        db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(passwordHash(password), user.email);
        db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE user_email = ? AND used_at IS NULL").run(now(), user.email);
        db.prepare("DELETE FROM sessions WHERE email = ?").run(user.email);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return send(response, 200, { ok: true, message: "Password reset was successful." });
    }
    if (method === "GET" && path === "/api/session") return send(response, 200, { account: publicUser(currentUser(request)) });
    if (method === "GET" && path === "/api/account") { const user = requireUser(request, response); if (!user) return; return send(response, 200, { account: publicUser(user), referrals: allReferrals()[user.email] }); }
    if (method === "GET" && path === "/api/account/data") { const user = requireUser(request, response); if (!user) return; return send(response, 200, { account: publicUser(user), history: parse(user.profile_json).history || [] }); }
    if (method === "GET" && path === "/api/ledger") {
      const user = requireUser(request, response);
      if (!user) return;
      const page = Math.max(1, Number(new URL(request.url, `http://${request.headers.host}`).searchParams.get("page") || 1));
      const pageSize = Math.min(100, Math.max(1, Number(new URL(request.url, `http://${request.headers.host}`).searchParams.get("pageSize") || 25)));
      const ledger = allLedger().filter((entry) => entry.user === user.email || entry.type === "WITHDRAWAL_FEE");
      const start = (page - 1) * pageSize;
      const slice = ledger.slice(start, start + pageSize);
      return send(response, 200, { ledger: slice, total: ledger.length, page, pageSize, totalPages: Math.max(1, Math.ceil(ledger.length / pageSize)) });
    }
    if (method === "POST" && path === "/api/withdraw") {
      const user = requireUser(request, response);
      if (!user) return;
      if (!checkRateLimit(request, "withdrawal-request", 20, 600000)) return send(response, 429, { error: "Too many withdrawal requests. Please wait and try again later." });
      const input = await readBody(request);

      if (!adminWalletAddress) return send(response, 500, { error: "Withdrawal admin wallet is not configured on the server." });
      if (Object.prototype.hasOwnProperty.call(input, "userEmail") && normalizeEmail(String(input.userEmail || "")) !== user.email) return send(response, 403, { error: "You can only withdraw your own funds." });
      if (Object.prototype.hasOwnProperty.call(input, "adminWalletAddress") && String(input.adminWalletAddress || "").trim() && String(input.adminWalletAddress).trim() !== adminWalletAddress) return send(response, 403, { error: "The admin wallet address cannot be overridden by the client." });
      if (Object.prototype.hasOwnProperty.call(input, "withdrawalFee") && Number(input.withdrawalFee) !== withdrawalFeeAmount) return send(response, 403, { error: "The withdrawal fee cannot be modified by the client." });

      const amountText = String(input.amount ?? "").trim();
      const amount = Number(amountText);
      const idempotencyKey = withdrawalReference(input.idempotencyKey);
      if (!/^\d+(?:\.\d{1,2})?$/.test(amountText)) return send(response, 400, { error: "A positive withdrawal amount with at most two decimals is required." });
      if (!Number.isFinite(amount) || amount <= 0) return send(response, 400, { error: "A positive withdrawal amount is required." });
      if (!validIdempotencyKey(idempotencyKey)) return send(response, 400, { error: "A unique idempotency key is required." });
      if (amount < withdrawalFeeAmount) return send(response, 400, { error: "Withdrawal minimum is $1.00 including the fixed fee." });

      const grossAmount = Number(amount.toFixed(2));
      const fee = Number(withdrawalFeeAmount.toFixed(2));
      const netAmount = Number((grossAmount - fee).toFixed(2));
      const totalDebit = Number((grossAmount + fee).toFixed(2));
      const eventId = `withdrawal-${Date.now()}-${randomBytes(3).toString("hex")}`;
      const withdrawalId = `${eventId}:withdrawal`;
      const feeId = `${eventId}:fee`;
      const timestamp = now();

      db.exec("BEGIN IMMEDIATE");
      try {
        const duplicate = db.prepare("SELECT user_email AS user, event_id AS eventId, amount, fee, net_amount AS netAmount FROM ledger WHERE reference_id = ? AND type = 'WITHDRAWAL' LIMIT 1").get(idempotencyKey);
        if (duplicate) {
          if (duplicate.user !== user.email) {
            db.exec("ROLLBACK");
            return send(response, 409, { error: "The idempotency key has already been used." });
          }
          db.exec("ROLLBACK");
          const data = withdrawalResponse(duplicate.user, duplicate.eventId, duplicate.amount, duplicate.fee, duplicate.netAmount, idempotencyKey, "completed");
          return send(response, 200, { withdrawal: data, fee: { ...data, userEmail: OWNER_EMAIL, adminWalletAddress, status: "completed" }, ok: true });
        }

        const account = getUser(user.email);
        const availableBalance = Number(account.balance) - Number(account.reserved || 0);
        if (totalDebit > availableBalance) {
          db.exec("ROLLBACK");
          return send(response, 409, { error: "Insufficient available balance for withdrawal." });
        }

        const debited = db.prepare("UPDATE users SET balance = balance - ? WHERE email = ? AND (balance - reserved) >= ?").run(totalDebit, user.email, totalDebit);
        if (debited.changes !== 1) {
          db.exec("ROLLBACK");
          return send(response, 409, { error: "Insufficient available balance for withdrawal." });
        }

        const insertLedger = db.prepare("INSERT INTO ledger(id,event_id,user_email,type,amount,gross_amount,fee,net_amount,timestamp,reference_id,status,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
        insertLedger.run(withdrawalId, eventId, user.email, "WITHDRAWAL", grossAmount, grossAmount, fee, netAmount, timestamp, idempotencyKey, "completed", json({ amount: grossAmount, fee, netAmount, adminWalletAddress, idempotencyKey, requestedUserEmail: user.email, sourceEventId: eventId, feeDestination: adminWalletAddress, status: "completed" }));
        insertLedger.run(feeId, feeId, OWNER_EMAIL, "WITHDRAWAL_FEE", fee, fee, 0, fee, timestamp, idempotencyKey, "completed", json({ amount: fee, fee: 0, netAmount: fee, adminWalletAddress, idempotencyKey, withdrawalEventId: eventId, feeDestination: adminWalletAddress, status: "completed" }));
        db.exec("COMMIT");

        const record = withdrawalResponse(user.email, eventId, grossAmount, fee, netAmount, idempotencyKey, "completed");
        return send(response, 200, { withdrawal: record, fee: { ...record, userEmail: OWNER_EMAIL, adminWalletAddress, status: "completed" }, ok: true });
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    if (method === "GET" && path === "/api/payments") { const user = requireUser(request, response); if (!user) return; return send(response, 200, paymentResponse(paymentFor(user.email))); }
    if (method === "POST" && path === "/api/payments") { const user = requireUser(request, response); if (!user) return; if (!checkRateLimit(request, "bot-payment-submit", 10, 600000)) return send(response, 429, { error: "Too many payment submissions. Please wait before submitting another payment." }); const input = await readBody(request); const reference = String(input.reference || "").trim(); const proof = String(input.proof || "").trim(); if (!validReference(reference)) return send(response, 400, { error: "A valid Ethereum transaction hash is required." }); if (proof.length > 2000) return send(response, 400, { error: "Payment proof is too long." }); if (paymentFor(user.email)?.status === "APPROVED") return send(response, 409, { error: "Your bot activation payment is already approved." }); const existingHash = db.prepare("SELECT id FROM bot_payments WHERE reference = ? LIMIT 1").get(reference); if (existingHash) return send(response, 409, { error: "A payment with this transaction hash already exists." }); const existingPending = db.prepare("SELECT id FROM bot_payments WHERE user_email = ? AND status = 'PENDING'").get(user.email); if (existingPending) return send(response, 409, { error: "A payment is already pending review." }); const payment = { id: `payment-${Date.now()}-${randomBytes(3).toString("hex")}`, userEmail: user.email, amount: botPaymentConfig.amount, reference, proof, createdAt: now(), status: "PENDING", reviewedBy: null, reviewedAt: null }; db.prepare("INSERT INTO bot_payments(id,user_email,amount,reference,proof,created_at,status) VALUES(?,?,?,?,?,?,?)").run(payment.id, payment.userEmail, payment.amount, payment.reference, payment.proof, payment.createdAt, payment.status); return send(response, 201, paymentResponse(payment)); }
    if (method === "GET" && path === "/api/trading/status") { const user = requireUser(request, response); if (!user) return; const payment = paymentFor(user.email); const account = getUser(user.email); return send(response, 200, { allowed: payment?.status === "APPROVED", botStatus: account.bot_status, payment: payment ? paymentView(payment) : null }); }
    if (method === "POST" && path === "/api/trading/activate") { const user = requireUser(request, response); if (!user) return; const payment = paymentFor(user.email); if (payment?.status !== "APPROVED") return send(response, 403, { error: payment?.status === "PENDING" ? "Bot activation payment is pending owner approval." : "A $2 bot activation payment must be approved before trading." }); db.prepare("UPDATE users SET bot_status = 'active' WHERE email = ?").run(user.email); return send(response, 200, { allowed: true, botStatus: "active", payment: paymentView(payment) }); }
    if (method === "POST" && path === "/api/trading/deactivate") { const user = requireUser(request, response); if (!user) return; db.prepare("UPDATE users SET bot_status = 'inactive' WHERE email = ?").run(user.email); return send(response, 200, { allowed: false, botStatus: "inactive" }); }
    if (method === "POST" && path === "/api/account/data") { const user = requireUser(request, response); if (!user) return; const input = await readBody(request); if (Object.prototype.hasOwnProperty.call(input, "username") && !validUsername(String(input.username || ""))) return send(response, 400, { error: "Username must be 3-80 characters without line breaks." }); if (Object.prototype.hasOwnProperty.call(input, "profile") && (input.profile === null || typeof input.profile !== "object" || Array.isArray(input.profile))) return send(response, 400, { error: "Profile data must be an object." }); const profile = { ...parse(user.profile_json), ...(input.profile || {}), history: Array.isArray(input.history) ? input.history : parse(user.profile_json).history || [] }; const username = Object.prototype.hasOwnProperty.call(input, "username") ? input.username.trim() : undefined; if (Object.prototype.hasOwnProperty.call(input, "wallet")) { const wallet = input.wallet || {}; if (Object.prototype.hasOwnProperty.call(wallet, "balance") || Object.prototype.hasOwnProperty.call(wallet, "reserved") || Object.prototype.hasOwnProperty.call(wallet, "referralEarnings")) return send(response, 403, { error: "Client-controlled wallet values are not allowed on the server." }); } db.prepare("UPDATE users SET username = COALESCE(?, username), profile_json = ? WHERE email = ?").run(username ? username : null, json(profile), user.email); return send(response, 200, { account: publicUser(getUser(user.email)), history: profile.history }); }
    if (method === "POST" && path === "/api/referrals/attach") { const user = requireUser(request, response); if (!user) return; const input = await readBody(request); const referrer = db.prepare("SELECT email FROM referrals WHERE code = ?").get(String(input.code || "").trim().toUpperCase()); if (!referrer || referrer.email === user.email) return send(response, 400, { error: "Invalid or self-referral code." }); const existing = db.prepare("SELECT referred_by FROM referrals WHERE email = ?").get(user.email); if (existing?.referred_by) return send(response, 400, { error: "Referral already assigned." }); db.prepare("UPDATE referrals SET referred_by = ? WHERE email = ?").run(referrer.email, user.email); return send(response, 200, { ok: true, referrals: allReferrals()[user.email] }); }
    if (method === "POST" && path === "/api/financial/event") { const user = ownerOnly(request, response); if (!user) return; const input = await readBody(request); const safeType = String(input.type || "TRADE_FEE"); if (!["TRADE_FEE", "DEPOSIT", "WITHDRAWAL", "WITHDRAWAL_FEE", "REFERRAL_REWARD", "OWNER_REVENUE", "PLATFORM_RESERVE", "TRADE_SETTLEMENT"].includes(safeType)) return send(response, 400, { error: "Unsupported ledger event type." }); const eventId = String(input.eventId || input.id || `event-${Date.now()}-${randomBytes(3).toString("hex")}`).trim(); const referenceId = String(input.referenceId || eventId).trim(); const eventUser = normalizeEmail(input.user || input.userEmail || user.email); const amount = Number(input.amount ?? input.netAmount ?? 0); const grossAmount = Number(input.grossAmount ?? amount ?? 0); const fee = Number(input.fee ?? 0); const netAmount = Number(input.netAmount ?? amount ?? 0); if (!eventUser || !validEmail(eventUser)) return send(response, 400, { error: "A valid user email is required for ledger records." }); if (!Number.isFinite(amount) || !Number.isFinite(grossAmount) || !Number.isFinite(fee) || !Number.isFinite(netAmount)) return send(response, 400, { error: "Ledger financial fields must be numeric." }); if (referenceId.length > 200 || eventId.length > 200) return send(response, 400, { error: "Ledger identifiers are too long." }); if (typeof input.metadata !== "undefined" && (input.metadata === null || typeof input.metadata !== "object" || Array.isArray(input.metadata))) return send(response, 400, { error: "Ledger metadata must be an object." }); const existing = db.prepare("SELECT id FROM ledger WHERE event_id = ? OR reference_id = ?").get(eventId, referenceId); if (existing) return send(response, 200, { ledger: allLedger() });
      const allocation = safeType === "TRADE_FEE" && input.metadata?.allocation ? { ...input.metadata.allocation } : null;
      const event = { id: eventId, eventId, user: eventUser, type: safeType, amount: Math.max(0, amount), grossAmount: Math.max(0, grossAmount), fee: Math.max(0, fee), netAmount: Math.max(0, netAmount), timestamp: now(), referenceId, status: "completed", metadata: { ...(input.metadata || {}), ...(allocation ? { allocation } : {}) } };
      db.prepare("INSERT INTO ledger(id,event_id,user_email,type,amount,gross_amount,fee,net_amount,timestamp,reference_id,status,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(event.id, event.eventId, event.user, event.type, event.amount, event.grossAmount, event.fee, event.netAmount, event.timestamp, event.referenceId, event.status, json(event.metadata));
      if (allocation?.referralEarnings) { const referrer = db.prepare("SELECT referred_by FROM referrals WHERE email = ?").get(eventUser)?.referred_by; if (referrer) { const rewardId = `${event.eventId}:reward`; db.prepare("INSERT INTO ledger(id,event_id,user_email,type,amount,gross_amount,fee,net_amount,timestamp,reference_id,status,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(rewardId, rewardId, referrer, "REFERRAL_REWARD", allocation.referralEarnings, allocation.referralEarnings, 0, allocation.referralEarnings, now(), rewardId, "completed", json({ referredEmail: eventUser, sourceEventId: event.eventId })); db.prepare("UPDATE users SET referral_earnings = referral_earnings + ? WHERE email = ?").run(allocation.referralEarnings, referrer); } }
      return send(response, 200, { ledger: allLedger() }); }
    if (method === "GET" && path === "/api/admin/bootstrap") { const user = ownerOnly(request, response); if (!user) return; return send(response, 200, { users: db.prepare("SELECT * FROM users ORDER BY created_at").all().map(publicUser), payments: allPayments(), ledger: allLedger(), referrals: allReferrals(), revenue: summary(), settings: settings(), engineStatus: parse(db.prepare("SELECT value_json FROM settings WHERE key='engine'").get()?.value_json, "running"), auditLog: db.prepare("SELECT id, action, actor, target, status, timestamp FROM audit_logs ORDER BY timestamp DESC").all() }); }
    if (method === "GET" && path === "/api/admin/transactions") {
      const owner = ownerOnly(request, response);
      if (!owner) return;
      const url = new URL(request.url, `http://${request.headers.host}`);
      const page = Math.max(1, Number(url.searchParams.get("page") || 1));
      const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") || 25)));
      const sort = ["newest", "oldest", "highest", "lowest"].includes(url.searchParams.get("sort") || "") ? url.searchParams.get("sort") : "newest";
      const search = (url.searchParams.get("search") || "").trim();
      const userFilter = normalizeEmail(url.searchParams.get("user") || "");
      const type = String(url.searchParams.get("type") || "").toUpperCase();
      const status = String(url.searchParams.get("status") || "").toUpperCase();
      const fromDate = url.searchParams.get("fromDate") || "";
      const toDate = url.searchParams.get("toDate") || "";
      const minAmount = Number(url.searchParams.get("minAmount") || "");
      const maxAmount = Number(url.searchParams.get("maxAmount") || "");
      const conditions = [];
      const params = [];
      if (userFilter) { conditions.push("user_email = ?"); params.push(userFilter); }
      if (type) { conditions.push("type = ?"); params.push(type); }
      if (status) { conditions.push("status = ?"); params.push(status); }
      if (fromDate) { conditions.push("timestamp >= ?"); params.push(new Date(fromDate).toISOString()); }
      if (toDate) { conditions.push("timestamp <= ?"); params.push(new Date(toDate).toISOString()); }
      if (Number.isFinite(minAmount)) { conditions.push("net_amount >= ?"); params.push(minAmount); }
      if (Number.isFinite(maxAmount)) { conditions.push("net_amount <= ?"); params.push(maxAmount); }
      if (search) {
        conditions.push("(LOWER(user_email) LIKE ? OR LOWER(event_id) LIKE ? OR LOWER(reference_id) LIKE ? OR LOWER(metadata_json) LIKE ?)");
        const value = `%${search.toLowerCase()}%`;
        params.push(value, value, value, value);
      }
      const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const orderClause = sort === "oldest" ? "ORDER BY timestamp ASC" : sort === "highest" ? "ORDER BY net_amount DESC" : sort === "lowest" ? "ORDER BY net_amount ASC" : "ORDER BY timestamp DESC";
      const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM ledger ${whereClause}`).get(...params);
      const total = Number(totalRow?.total || 0);
      const offset = (page - 1) * pageSize;
      const rows = db.prepare(`SELECT * FROM ledger ${whereClause} ${orderClause} LIMIT ? OFFSET ?`).all(...params, pageSize, offset).map((entry) => ({
        id: entry.id,
        userEmail: entry.user_email,
        eventId: entry.event_id,
        type: entry.type,
        amount: Number(entry.amount),
        grossAmount: Number(entry.gross_amount),
        fee: Number(entry.fee),
        netAmount: Number(entry.net_amount),
        status: entry.status,
        timestamp: entry.timestamp,
        referenceId: entry.reference_id,
        metadata: parse(entry.metadata_json),
      }));
      const summary = {
        totalDeposits: Number(db.prepare("SELECT COALESCE(SUM(net_amount), 0) AS total FROM ledger WHERE type = 'DEPOSIT'").get()?.total || 0),
        totalWithdrawals: Number(db.prepare("SELECT COALESCE(SUM(net_amount), 0) AS total FROM ledger WHERE type = 'WITHDRAWAL'").get()?.total || 0),
        totalWithdrawalFees: Number(db.prepare("SELECT COALESCE(SUM(fee), 0) AS total FROM ledger WHERE type = 'WITHDRAWAL_FEE'").get()?.total || 0),
        approvedPayments: Number(db.prepare("SELECT COUNT(*) AS total FROM bot_payments WHERE status = 'APPROVED'").get()?.total || 0),
        pendingPayments: Number(db.prepare("SELECT COUNT(*) AS total FROM bot_payments WHERE status = 'PENDING'").get()?.total || 0),
        rejectedPayments: Number(db.prepare("SELECT COUNT(*) AS total FROM bot_payments WHERE status = 'REJECTED'").get()?.total || 0),
        tradingVolume: Number(db.prepare("SELECT COALESCE(SUM(net_amount), 0) AS total FROM ledger WHERE type = 'TRADE_EXECUTION'").get()?.total || 0),
      };
      return send(response, 200, { transactions: rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), summary });
    }
    if (path.startsWith("/api/admin/payments/") && method === "POST") { const user = ownerOnly(request, response); if (!user) return; const paymentId = path.split("/").pop(); if (!paymentId || paymentId.length > 180) return send(response, 400, { error: "Invalid payment id." }); const input = await readBody(request); const status = String(input.status || "").toUpperCase(); if (!["APPROVED", "REJECTED"].includes(status)) return send(response, 400, { error: "Payment status must be APPROVED or REJECTED." }); const payment = db.prepare("SELECT * FROM bot_payments WHERE id = ?").get(paymentId); if (!payment) return send(response, 404, { error: "Payment not found." }); if (payment.status !== "PENDING") return send(response, 409, { error: "Only pending payments can be reviewed." }); const reviewedAt = now(); db.prepare("UPDATE bot_payments SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'PENDING'").run(status, user.email, reviewedAt, paymentId); audit(user.email, `BOT_PAYMENT_${status}`, payment.user_email); return send(response, 200, { payment: paymentView(db.prepare("SELECT * FROM bot_payments WHERE id = ?").get(paymentId)) }); }
    if (path === "/api/admin/engine" && method === "POST") { const user = ownerOnly(request, response); if (!user) return; const input = await readBody(request); const value = ["running", "paused", "stopped"].includes(input.status) ? input.status : "stopped"; db.prepare("INSERT INTO settings(key,value_json) VALUES('engine',?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json").run(json(value)); audit(user.email, `ENGINE_${value.toUpperCase()}`); return send(response, 200, { engineStatus: value }); }
    if (path === "/api/admin/settings" && method === "POST") { const user = ownerOnly(request, response); if (!user) return; const input = await readBody(request); if (!validAllocation(input)) return send(response, 400, { error: "Owner, referral, and reserve allocations must total 100%." }); const next = { ...defaults, ...Object.fromEntries(Object.entries(input).map(([key, value]) => [key, Math.max(0, Number(value) || 0)])) }; setSettings(next); audit(user.email, "SETTINGS_UPDATED"); return send(response, 200, { settings: next }); }
    if (path.startsWith("/api/admin/users/") && method === "POST") { const user = ownerOnly(request, response); if (!user) return; const target = normalizeEmail(path.split("/").pop()); const input = await readBody(request); if (!validEmail(target)) return send(response, 400, { error: "A valid target email is required." }); if (target === OWNER_EMAIL) return send(response, 400, { error: "The owner cannot be suspended." }); if (!["active", "suspended"].includes(input.status)) return send(response, 400, { error: "User status must be active or suspended." }); db.prepare("UPDATE users SET status = ? WHERE email = ?").run(input.status === "suspended" ? "suspended" : "active", target); audit(user.email, `USER_${input.status === "suspended" ? "SUSPENDED" : "ACTIVE"}`, target); return send(response, 200, { ok: true }); }
    if (!path.startsWith("/api") && isProduction) {
      try {
        const candidatePath = path === "/" ? "/index.html" : path;
        const assetPath = resolve(join(staticRoot, candidatePath.replace(/^\/+/, "")));
        const requested = await stat(assetPath);
        if (requested.isFile()) {
          const extension = extname(assetPath).toLowerCase();
          const contentType = extension === ".html" ? "text/html; charset=utf-8" : extension === ".js" ? "application/javascript; charset=utf-8" : extension === ".css" ? "text/css; charset=utf-8" : "application/octet-stream";
          const file = await readFile(assetPath);
          response.writeHead(200, { "content-type": contentType });
          response.end(file);
          return;
        }
      } catch {
        // Fall back to the SPA index for client-side routing.
      }
      const html = await fallbackHtml();
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    return send(response, 404, { error: "Not found." });
  } catch (error) {
    console.error("[server] request failed", { message: error.message });
    return send(response, 500, { error: "Internal server error." });
  }
});

const shutdown = (signal) => {
  console.log(`[server] shutting down on ${signal}`);
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
  setTimeout(() => {
    closeDatabase();
    process.exit(1);
  }, 5000).unref();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
server.on("error", (error) => {
  console.error("[server] startup error", { code: error.code, message: error.message });
  process.exit(1);
});
server.listen(port, host, () => console.log(`[server] Trading API listening on ${host}:${port} in ${process.env.NODE_ENV || "development"} mode`));