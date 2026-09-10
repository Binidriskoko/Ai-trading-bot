import assert from "node:assert/strict";
import test from "node:test";
import {
  attachReferral,
  calculateFee,
  getLedger,
  getReferralEarnings,
  getReferralProfile,
  getReferralRewardHistory,
  getRevenueSummary,
  recordLedger,
  recordReferralReward,
  recordTradingFee,
  saveFeeSettings,
  validateAllocationPercentages,
} from "../src/services/feeRevenueService.js";
import { getAccountData, saveAccountData } from "../src/services/demoDataService.js";

const accounts = {
  referrer: { email: "referrer@example.com" },
  referred: { email: "referred@example.com" },
};

const resetStorage = () => {
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  getReferralProfile(accounts.referrer);
  getReferralProfile(accounts.referred);
  saveFeeSettings({ tradingFeePercent: 1, depositFeePercent: 2, withdrawalFeePercent: 3, referralCommissionPercent: 10 });
};

const linkReferral = () => {
  const code = getReferralProfile(accounts.referrer).code;
  assert.equal(attachReferral(accounts.referred.email, code).ok, true);
};

test.beforeEach(resetStorage);

test("allocation settings must total 100 percent", () => {
  assert.equal(validateAllocationPercentages({ ownerRevenuePercent: 70, referralCommissionPercent: 20, platformReservePercent: 10 }), true);
  assert.equal(validateAllocationPercentages({ ownerRevenuePercent: 70, referralCommissionPercent: 20, platformReservePercent: 11 }), false);
  assert.throws(() => saveFeeSettings({ tradingFeePercent: 1, depositFeePercent: 2, withdrawalFeePercent: 3, ownerRevenuePercent: 70, referralCommissionPercent: 20, platformReservePercent: 11 }), /total 100/);
});

test("one referred user earns rewards for multiple eligible trades", () => {
  linkReferral();
  recordLedger({ user: accounts.referred.email, type: "TRADE_FEE", grossAmount: 100, fee: 1, netAmount: 99, eventId: "trade-1" });
  recordReferralReward(accounts.referrer.email, accounts.referred.email, 0.1, "trade-1");
  recordLedger({ user: accounts.referred.email, type: "TRADE_FEE", grossAmount: 200, fee: 2, netAmount: 198, eventId: "trade-2" });
  recordReferralReward(accounts.referrer.email, accounts.referred.email, 0.2, "trade-2");
  assert.equal(getReferralProfile(accounts.referrer).rewards.length, 2);
  assert.equal(getReferralEarnings(accounts.referrer.email), 0.3);
  assert.equal(getRevenueSummary().referralRewardEventCount, 2);
});

test("referred trading fees distribute 70/20/10 and accumulate", () => {
  linkReferral();
  const firstFee = calculateFee(500, 1);
  const secondFee = calculateFee(250, 2);
  recordTradingFee({ user: accounts.referred.email, ...firstFee, eventId: "trade-distribution-1" });
  recordTradingFee({ user: accounts.referred.email, ...secondFee, eventId: "trade-distribution-2" });

  const summary = getRevenueSummary();
  const feeEvents = getLedger().filter((entry) => entry.type === "TRADE_FEE");
  assert.equal(feeEvents.every((entry) => entry.amount > 0 && entry.fee > 0), true);
  assert.equal(summary.tradingFees, 10);
  assert.equal(summary.adminRevenue, 7);
  assert.equal(summary.ownerRevenue, 7);
  assert.equal(getReferralEarnings(accounts.referrer.email), 2);
  assert.equal(summary.platformReserve, 1);
});

test("trading fees without a referrer distribute 80/0/20", () => {
  const tradeFee = calculateFee(500, 1);
  recordTradingFee({ user: accounts.referred.email, ...tradeFee, eventId: "trade-no-referrer" });

  const summary = getRevenueSummary();
  const feeEvent = getLedger().find((entry) => entry.eventId === "trade-no-referrer");
  assert.equal(feeEvent.amount, 5);
  assert.deepEqual(feeEvent.metadata.allocation, { ownerRevenue: 4, referralEarnings: 0, platformReserve: 1 });
  assert.equal(summary.adminRevenue, 4);
  assert.equal(getReferralEarnings(accounts.referred.email), 0);
  assert.equal(summary.platformReserve, 1);
});

test("referred trade credits Account A's ledger and profile, not Account B", () => {
  linkReferral();
  const trade = calculateFee(250, 1);
  recordLedger({ user: accounts.referred.email, type: "TRADE_FEE", ...trade, eventId: "trade-account-b" });
  recordReferralReward(accounts.referrer.email, accounts.referred.email, trade.fee * 0.1, "trade-account-b");
  assert.equal(getReferralEarnings(accounts.referrer.email), 0.25);
  assert.equal(getReferralEarnings(accounts.referred.email), 0);
  assert.equal(getReferralRewardHistory(accounts.referrer.email)[0].referredEmail, accounts.referred.email);
  assert.equal(getLedger().find((entry) => entry.type === "REFERRAL_REWARD").user, accounts.referrer.email);
  assert.equal(getReferralProfile(accounts.referrer).rewards[0].referredEmail, accounts.referred.email);
});

test("replaying the same event creates one fee and one reward", () => {
  linkReferral();
  const fee = { user: accounts.referred.email, type: "TRADE_FEE", grossAmount: 100, fee: 1, netAmount: 99, eventId: "trade-replayed" };
  recordLedger(fee);
  recordLedger(fee);
  recordReferralReward(accounts.referrer.email, accounts.referred.email, 0.1, "trade-replayed");
  assert.equal(recordReferralReward(accounts.referrer.email, accounts.referred.email, 0.1, "trade-replayed"), null);
  assert.equal(getLedger().length, 2);
});

test("self-referral creates no relationship or reward", () => {
  const code = getReferralProfile(accounts.referrer).code;
  assert.equal(attachReferral(accounts.referrer.email, code).ok, false);
  assert.equal(recordReferralReward(accounts.referrer.email, accounts.referrer.email, 1, "self-event"), null);
  assert.equal(getReferralProfile(accounts.referrer).rewards.length, 0);
});

test("deposit and withdrawal fees increase gross revenue once", () => {
  const deposit = calculateFee(100, 2);
  const withdrawal = calculateFee(50, 3);
  recordLedger({ user: accounts.referred.email, type: "DEPOSIT", ...deposit, eventId: "deposit-1" });
  recordLedger({ user: accounts.referred.email, type: "WITHDRAWAL", ...withdrawal, eventId: "withdrawal-1" });
  const summary = getRevenueSummary();
  assert.equal(summary.depositFees, 2);
  assert.equal(summary.withdrawalFees, 1.5);
  assert.equal(summary.grossRevenue, 3.5);
  assert.equal(summary.feeEventCount, 2);
});

test("trading fee and referral reward produce correct net revenue", () => {
  linkReferral();
  recordLedger({ user: accounts.referred.email, type: "TRADE_FEE", grossAmount: 100, fee: 1, netAmount: 99, eventId: "trade-net" });
  recordReferralReward(accounts.referrer.email, accounts.referred.email, 0.1, "trade-net");
  const summary = getRevenueSummary();
  assert.equal(summary.grossRevenue, 1);
  assert.equal(summary.referralRewards, 0.1);
  assert.equal(summary.netRevenue, 0.9);
  assert.equal(getLedger().filter((entry) => entry.eventId === "trade-net").length, 1);
  assert.equal(getLedger().filter((entry) => entry.type === "REFERRAL_REWARD").length, 1);
});

test("referral rewards stay separate from both trading balances", () => {
  linkReferral();
  saveAccountData(accounts.referrer.email, { wallet: { balance: 750, reserved: 0 }, history: [] });
  saveAccountData(accounts.referred.email, { wallet: { balance: 500, reserved: 0 }, history: [] });

  const trade = calculateFee(200, 1);
  const rewardAmount = trade.fee * 0.1;
  const referredBefore = getAccountData(accounts.referred.email).wallet.balance;
  saveAccountData(accounts.referred.email, {
    ...getAccountData(accounts.referred.email),
    wallet: { ...getAccountData(accounts.referred.email).wallet, balance: referredBefore - trade.grossAmount - trade.fee },
  });
  recordLedger({ user: accounts.referred.email, type: "TRADE_FEE", ...trade, eventId: "trade-separate-balances" });
  recordReferralReward(accounts.referrer.email, accounts.referred.email, rewardAmount, "trade-separate-balances");

  const referrerWallet = getAccountData(accounts.referrer.email).wallet;
  const referredWallet = getAccountData(accounts.referred.email).wallet;
  assert.equal(referrerWallet.balance, 750);
  assert.equal(referrerWallet.referralEarnings, rewardAmount);
  assert.equal(referredWallet.balance, 298);
  assert.equal(getRevenueSummary().netRevenue, 1.8);
});

test("default fee trade persists a visible nonzero Account A reward", () => {
  linkReferral();
  const trade = calculateFee(10, 0.25);
  recordLedger({ user: accounts.referred.email, type: "TRADE_FEE", ...trade, eventId: "trade-default-visible" });
  recordReferralReward(accounts.referrer.email, accounts.referred.email, trade.fee * 0.1, "trade-default-visible");

  assert.equal(getReferralEarnings(accounts.referrer.email), 0.003);
  assert.equal(getAccountData(accounts.referrer.email).wallet.referralEarnings, 0.003);
  assert.deepEqual(getReferralRewardHistory(accounts.referrer.email)[0], {
    id: "trade-default-visible-reward",
    sourceEventId: "trade-default-visible",
    referredEmail: accounts.referred.email,
    eventType: "TRADE_FEE",
    feeGenerated: 0.03,
    commissionPercent: 10,
    amount: 0.003,
    timestamp: getReferralRewardHistory(accounts.referrer.email)[0].timestamp,
    status: "completed",
  });
});