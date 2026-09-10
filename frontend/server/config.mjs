try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // Environment variables may be supplied by the process manager or tests.
}

const toBoolean = (value, fallback = false) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const toNumber = (value, fallback) => {
  const numeric = Number(value ?? fallback);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const normalizeMode = (value) => {
  const mode = String(value || "PAPER").trim().toUpperCase();
  return ["BACKTEST", "PAPER", "TESTNET"].includes(mode) ? mode : "PAPER";
};

export const isProduction = (process.env.NODE_ENV || "development").toLowerCase() === "production";
export const host = process.env.HOST || "0.0.0.0";
export const port = toNumber(process.env.PORT || process.env.API_PORT || 8787, 8787);
export const publicUrl = String(process.env.PUBLIC_URL || process.env.CORS_ORIGIN || "").trim();
export const corsOrigin = String(process.env.CORS_ORIGIN || "").trim() || (isProduction ? publicUrl : "");
export const databasePath = String(process.env.TRADING_DB_PATH || "").trim();
export const secureCookies = toBoolean(process.env.SECURE_COOKIES, isProduction);
export const tradingMode = normalizeMode(process.env.TRADING_MODE);
export const allowLiveTrading = false;

export const adminWalletAddress = String(process.env.ADMIN_WALLET_ADDRESS || process.env.OWNER_WALLET_ADDRESS || "").trim();
export const withdrawalFeeAmount = toNumber(process.env.WITHDRAWAL_FEE_AMOUNT || "1", 1);
export const appName = "ai-trading-bot";

export const botPaymentConfig = Object.freeze({
  amount: toNumber(process.env.BOT_PAYMENT_AMOUNT || "2", 2),
  token: String(process.env.BOT_PAYMENT_TOKEN || "USDT").trim() || "USDT",
  network: String(process.env.BOT_PAYMENT_NETWORK || "Ethereum ERC-20").trim() || "Ethereum ERC-20",
  recipientAddress: String(process.env.BOT_PAYMENT_RECIPIENT_ADDRESS || "").trim(),
});

export const validateProductionConfig = () => {
  if (!isProduction) return;

  if (!adminWalletAddress) {
    throw new Error("ADMIN_WALLET_ADDRESS is required in production. Set it in the environment or .env file.");
  }

  if (!botPaymentConfig.recipientAddress) {
    throw new Error("BOT_PAYMENT_RECIPIENT_ADDRESS is required in production. Set it in the environment or .env file.");
  }

  if (!publicUrl && !corsOrigin) {
    throw new Error("PUBLIC_URL or CORS_ORIGIN is required in production so the app has a trusted client origin.");
  }

  if (!databasePath) {
    throw new Error("TRADING_DB_PATH is required in production so persistent storage is explicit.");
  }

};

export const runtimeConfig = Object.freeze({
  isProduction,
  host,
  port,
  publicUrl,
  corsOrigin,
  databasePath,
  secureCookies,
  tradingMode,
  allowLiveTrading,
  adminWalletAddress,
  withdrawalFeeAmount,
  appName,
  botPaymentConfig,
});

validateProductionConfig();