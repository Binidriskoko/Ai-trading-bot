import { apiRequest } from "./apiClient.js";

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
const cache = new Map(); let testStorage;
const resetTestCache = () => { if (typeof window === "undefined" && globalThis.localStorage !== testStorage) { testStorage = globalThis.localStorage; cache.clear(); } };
const defaults = () => ({ wallet: { balance: 1000, reserved: 0, referralEarnings: 0 }, history: [] });
export const getAccountData = (email) => { resetTestCache(); return cache.get(normalizeEmail(email)) || defaults(); };
export const saveAccountData = (email, data) => { resetTestCache(); const key = normalizeEmail(email); cache.set(key, { ...defaults(), ...data, wallet: { ...defaults().wallet, ...(data?.wallet || {}) } }); if (typeof window !== "undefined") apiRequest("/api/account/data", { method: "POST", body: JSON.stringify(cache.get(key)) }).catch(() => {}); return cache.get(key); };
export const hydrateAccountData = async (email) => {
  try {
    const data = await apiRequest("/api/account/data");
    const value = { wallet: data.account.wallet, history: data.history || [] };
    cache.set(normalizeEmail(email), value);
    return value;
  } catch {
    return getAccountData(email);
  }
};
