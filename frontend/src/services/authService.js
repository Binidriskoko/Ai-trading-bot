import { apiRequest } from "./apiClient.js";

export const OWNER_EMAIL = "binidriskoko@gmail.co";
const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
const browser = typeof window !== "undefined"; let session = null; let users = []; let authGeneration = 0;
const request = async (path, options = {}) => apiRequest(path, options);
const enrich = async (account) => { const data = await request("/api/account"); return { ...account, referrals: data.referrals }; };
const parseStorage = (key) => { try { const value = window.localStorage.getItem(key); return value ? JSON.parse(value) : null; } catch { return null; } };
const legacyOwnerAccount = () => {
	if (!browser) return null;
	const candidates = ["users", "accounts", "registeredUsers", "tradingAccounts", "authUsers"].flatMap((key) => {
		const value = parseStorage(key);
		if (Array.isArray(value)) return value;
		if (value && typeof value === "object") return Object.values(value);
		return [];
	});
	for (const key of ["owner", `user:${OWNER_EMAIL}`, `account:${OWNER_EMAIL}`, `user_${OWNER_EMAIL}`, `account_${OWNER_EMAIL}`]) {
		const value = parseStorage(key);
		if (value && typeof value === "object") candidates.push(value);
	}
	const account = candidates.find((value) => normalizeEmail(value?.email) === OWNER_EMAIL);
	if (!account) return null;
	const { password: _password, ...safeAccount } = account;
	return { ...safeAccount, email: OWNER_EMAIL };
};
const migrateLegacyOwner = async (password) => {
	const account = legacyOwnerAccount();
	if (!account) return null;
	const data = await request("/api/auth/migrate-owner", { method: "POST", body: JSON.stringify({ account, password }) });
	session = await enrich(data.account);
	return session;
};
export const isOwnerAccount = (value) => normalizeEmail(typeof value === "string" ? value : value?.email) === OWNER_EMAIL;
export const signUp = async (input) => { authGeneration += 1; if (!browser) { session = { username: input.username, email: normalizeEmail(input.email), role: isOwnerAccount(input.email) ? "owner" : "user" }; return session; } const data = await request("/api/auth/signup", { method: "POST", body: JSON.stringify(input) }); session = await enrich(data.account); return session; };
export const login = async (input) => { authGeneration += 1; try { const data = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email: normalizeEmail(input.email), password: input.password }) }); session = await enrich(data.account); return session; } catch (error) { if (normalizeEmail(input.email) !== OWNER_EMAIL) throw error; const migrated = await migrateLegacyOwner(input.password); if (migrated) return migrated; throw error; } };
export const getAuthStatus = (email) => ({ accountExists: Boolean(session && normalizeEmail(session.email) === normalizeEmail(email)), sessionActive: Boolean(session && normalizeEmail(session.email) === normalizeEmail(email)) });
export const getSession = () => session; export const getRegisteredUsers = () => users;
export const logout = async () => { authGeneration += 1; if (browser) await request("/api/auth/logout", { method: "POST" }).catch(() => {}); session = null; };
export const updateAccount = (email, updates) => { if (!session || normalizeEmail(session.email) !== normalizeEmail(email)) return null; session = { ...session, ...updates }; request("/api/account/data", { method: "POST", body: JSON.stringify({ ...updates, username: updates.username || session.username }) }).catch(() => {}); return session; };
export const setAccountReferrer = () => null;
export const hydrateSession = async () => { if (!browser) return null; const generation = authGeneration; const data = await request("/api/session"); if (generation !== authGeneration) return session; session = data.account ? await enrich(data.account) : null; return session; };
export const hydrateUsers = (next) => { users = next || []; }; export { normalizeEmail };
