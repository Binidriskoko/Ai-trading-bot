import { useEffect, useRef, useState } from "react";
import "./App.css";
import { getRegisteredUsers, getSession, hydrateSession, hydrateUsers, isOwnerAccount, login, logout, setAccountReferrer, signUp, updateAccount } from "./services/authService";
import { getAccountData, hydrateAccountData, saveAccountData } from "./services/demoDataService";
import { attachReferral, calculateFee, getAdminUsers, getAuditLog, getEngineStatus, getFeeSettings, getLedger, getReferralEarnings, getReferralProfile, getReferralRecords, getReferralRewardHistory, getRevenueSummary, hydrateAccountLedger, hydrateFinancialData, recordAuditLog, recordLedger, recordTradingFee, recordReferralReward, saveEngineStatus, saveFeeSettings, validateAllocationPercentages, withdrawFunds } from "./services/feeRevenueService";

import { authorizeTrading, getPayment, getPaymentConfig, hydrateAdminPayments, hydratePayment, reviewPayment, submitPayment } from "./services/paymentService";

const INITIAL_BALANCE = 1000;
const TICK_INTERVAL = 2000;
const SHORT_WINDOW = 5;
const LONG_WINDOW = 10;
const PRICE_STEPS = [0.7, 0.9, 0.4, -0.2, -0.6, -0.8, -0.4, 0.2, 0.8, 1.1, 0.6, 0.3, -0.5, -0.9, -0.3, 0.5];

const toMoney = (value) => Number((Number.isFinite(value) ? value : 0).toFixed(2));
const safePercent = (value, fallback) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : fallback;
};

function getSignal(priceHistory) {
  if (priceHistory.length < LONG_WINDOW) {
    return { signal: "HOLD", confidence: 0, shortAverage: 0, longAverage: 0, momentum: 0 };
  }

  const shortPrices = priceHistory.slice(-SHORT_WINDOW);
  const longPrices = priceHistory.slice(-LONG_WINDOW);
  const shortAverage = shortPrices.reduce((sum, value) => sum + value, 0) / SHORT_WINDOW;
  const longAverage = longPrices.reduce((sum, value) => sum + value, 0) / LONG_WINDOW;
  const momentum = ((priceHistory.at(-1) - priceHistory.at(-4)) / priceHistory.at(-4)) * 100;
  const trend = ((shortAverage - longAverage) / longAverage) * 100;
  const strength = Math.min(100, Math.round(50 + Math.abs(trend * 12 + momentum * 8)));

  if (trend > 0.08 && momentum > 0.05) {
    return { signal: "BUY", confidence: strength, shortAverage, longAverage, momentum };
  }
  if (trend < -0.08 && momentum < -0.05) {
    return { signal: "SELL", confidence: strength, shortAverage, longAverage, momentum };
  }
  return { signal: "HOLD", confidence: Math.max(0, strength - 10), shortAverage, longAverage, momentum };
}

const BACKTEST_PRICES = Array.from({ length: 96 }, (_, index) => {
  const drift = index < 32 ? 0.12 : index < 64 ? -0.1 : 0.16;
  return toMoney(100 + PRICE_STEPS.slice(0, index + 1).reduce((sum, step) => sum + step, 0) + drift * index);
});

const safeAmount = (value, fallback) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : fallback;
};

function runBacktest({ startingBalance, tradingAmount, stopLoss, takeProfit, maxDailyLoss }) {
  const initialBalance = safeAmount(startingBalance, 1000);
  const requestedAmount = safeAmount(tradingAmount, 10);
  const state = { balance: initialBalance, pnl: 0, positions: [], trades: [], equity: [initialBalance], peak: initialBalance, maxDrawdown: 0 };
  const prices = [BACKTEST_PRICES[0]];
  const dailyLossLimit = initialBalance * (safePercent(maxDailyLoss, 5) / 100);
  const closePosition = (position, exitPrice, reason, index) => {
    const change = position.side === "BUY"
      ? ((exitPrice - position.entryPrice) / position.entryPrice) * 100
      : ((position.entryPrice - exitPrice) / position.entryPrice) * 100;
    const profitLoss = toMoney(position.amount * (change / 100));
    state.balance = Math.max(0, toMoney(state.balance + position.amount + profitLoss));
    state.pnl = toMoney(state.pnl + profitLoss);
    state.trades.push({
      id: `${index}-${position.id}`,
      entryTime: `Tick ${position.entryIndex + 1}`,
      exitTime: `Tick ${index + 1}`,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: toMoney(exitPrice),
      pnl: profitLoss,
      reason,
    });
  };

  BACKTEST_PRICES.forEach((nextPrice, index) => {
    if (index > 0) prices.push(nextPrice);
    const analysis = getSignal(prices.slice(-LONG_WINDOW));
    state.positions = state.positions.filter((position) => {
      const change = position.side === "BUY"
        ? ((nextPrice - position.entryPrice) / position.entryPrice) * 100
        : ((position.entryPrice - nextPrice) / position.entryPrice) * 100;
      const stopTriggered = change <= -safePercent(stopLoss, 0.1);
      const targetTriggered = change >= safePercent(takeProfit, 0.1);
      if (!stopTriggered && !targetTriggered) return true;
      closePosition(position, nextPrice, stopTriggered ? "Stop-loss" : "Take-profit", index);
      return false;
    });

    if (state.pnl > -dailyLossLimit && analysis.signal !== "HOLD" && state.positions.length === 0) {
      const amount = Math.min(requestedAmount, Math.max(0, state.balance));
      if (amount > 0) {
        state.balance = Math.max(0, toMoney(state.balance - amount));
        state.positions.push({ id: index, side: analysis.signal, entryPrice: toMoney(nextPrice), amount, entryIndex: index });
      }
    }
    const openValue = state.positions.reduce((sum, position) => {
      const change = position.side === "BUY"
        ? (nextPrice - position.entryPrice) / position.entryPrice
        : (position.entryPrice - nextPrice) / position.entryPrice;
      return sum + position.amount + position.amount * change;
    }, 0);
    const equity = Math.max(0, toMoney(state.balance + openValue));
    state.equity.push(equity);
    state.peak = Math.max(state.peak, equity);
    state.maxDrawdown = Math.max(state.maxDrawdown, toMoney(state.peak - equity));
  });

  const finalPrice = BACKTEST_PRICES.at(-1);
  state.positions.forEach((position) => closePosition(position, finalPrice, "End of dataset", BACKTEST_PRICES.length - 1));
  state.positions = [];
  state.equity.push(Math.max(0, toMoney(state.balance)));
  const winningTrades = state.trades.filter((trade) => trade.pnl > 0).length;
  const losingTrades = state.trades.filter((trade) => trade.pnl < 0).length;
  const profits = state.trades.filter((trade) => trade.pnl > 0).map((trade) => trade.pnl);
  const losses = state.trades.filter((trade) => trade.pnl < 0).map((trade) => trade.pnl);
  return {
    startingBalance: initialBalance,
    finalBalance: state.balance,
    netProfitLoss: state.pnl,
    returnPercent: initialBalance > 0 ? (state.pnl / initialBalance) * 100 : 0,
    totalTrades: state.trades.length,
    winningTrades,
    losingTrades,
    winRate: state.trades.length > 0 ? (winningTrades / state.trades.length) * 100 : 0,
    maxDrawdown: state.maxDrawdown,
    averageProfit: profits.length > 0 ? profits.reduce((sum, value) => sum + value, 0) / profits.length : 0,
    averageLoss: losses.length > 0 ? losses.reduce((sum, value) => sum + value, 0) / losses.length : 0,
    equity: state.equity,
    trades: state.trades,
  };
}

function EquityCurve({ values }) {
  if (!values || values.length < 2) return <div className="empty">Run a backtest to see the equity curve.</div>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${100 - ((value - min) / range) * 88 - 6}`).join(" ");
  return (
    <div className="chart-wrap">
      <svg className="equity-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Backtest equity curve">
        <polyline points={points} fill="none" stroke="#38bdf8" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="chart-labels"><span>${toMoney(max).toFixed(2)}</span><span>${toMoney(min).toFixed(2)}</span></div>
    </div>
  );
}

function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ username: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [resetForm, setResetForm] = useState({ email: "", token: "", password: "" });
  const [resetMessage, setResetMessage] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const account = mode === "login" ? await login(form) : await signUp(form);
      onAuthenticated(account);
    } catch (submissionError) {
      setError(submissionError.message);
    } finally {
      setBusy(false);
    }
  };
  const handlePasswordReset = async (event) => {
    event.preventDefault();
    setResetMessage("");
    setResetBusy(true);
    try {
      const payload = { email: resetForm.email.trim(), ...(resetForm.token ? { token: resetForm.token.trim(), password: resetForm.password } : {}) };
      const endpoint = resetForm.token ? "/api/auth/password-reset/confirm" : "/api/auth/password-reset/request";
      const response = await fetch(endpoint, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Password reset failed.");
      setResetMessage(data.message || "Password reset request accepted.");
      if (resetForm.token) {
        setShowReset(false);
        setForm({ ...form, email: resetForm.email, password: "" });
      }
    } catch (submissionError) {
      setResetMessage(submissionError.message);
    } finally {
      setResetBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <span className="eyebrow">DEMO TERMINAL</span>
        <h1>AI Trading Bot</h1>
        <p className="muted">Paper funds only. No exchange connections.</p>
        <div className="auth-tabs"><button className={mode === "login" ? "selected" : ""} onClick={() => setMode("login")}>Log in</button><button className={mode === "signup" ? "selected" : ""} onClick={() => setMode("signup")}>Sign up</button></div>
        {!showReset ? (
          <form onSubmit={submit}>
            {mode === "signup" && <label>Username<input required minLength="3" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>}
            <label>Email<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label>Password<input required type="password" minLength="8" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /><small>8+ characters, one uppercase letter and one number.</small></label>
            {mode === "login" && <button type="button" className="link-button" onClick={() => { setShowReset(true); setResetForm({ ...resetForm, email: form.email }); }}>Forgot password?</button>}
            {error && <p className="form-error">{error}</p>}
            <button className="primary-button" disabled={busy}>{busy ? "PLEASE WAIT" : mode === "login" ? "LOG IN" : "CREATE DEMO ACCOUNT"}</button>
          </form>
        ) : (
          <form onSubmit={handlePasswordReset}>
            <label>Email<input required type="email" value={resetForm.email} onChange={(e) => setResetForm({ ...resetForm, email: e.target.value })} /></label>
            <label>Reset token (optional if you already received the link)<input value={resetForm.token} onChange={(e) => setResetForm({ ...resetForm, token: e.target.value })} placeholder="Paste reset token" /></label>
            {resetForm.token && <label>New password<input required type="password" minLength="8" value={resetForm.password} onChange={(e) => setResetForm({ ...resetForm, password: e.target.value })} /></label>}
            {resetMessage && <p className="muted">{resetMessage}</p>}
            <button className="primary-button" disabled={resetBusy}>{resetBusy ? "PLEASE WAIT" : resetForm.token ? "RESET PASSWORD" : "REQUEST RESET"}</button>
            <button type="button" className="secondary-button" onClick={() => setShowReset(false)}>Back to login</button>
          </form>
        )}
      </div>
    </div>
  );
}

function PaymentScreen({ payment, paymentConfig, onSubmit }) {
  const [reference, setReference] = useState("");
  const [proof, setProof] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await onSubmit({ reference, proof });
      setMessage("Payment submitted. The owner must approve it before bot trading is enabled.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };
  const status = payment?.status;
  return <section className="panel payment-panel"><span className="eyebrow">BOT ACTIVATION</span><h2>${paymentConfig?.amount || 2} {paymentConfig?.token || "USDT"} payment required</h2><p className="muted">Send exactly {paymentConfig?.amount || 2} {paymentConfig?.token || "USDT"} on {paymentConfig?.network || "Ethereum ERC-20"} to:</p><p><strong>{paymentConfig?.recipientAddress || "Payment address unavailable"}</strong></p><p className="muted">Trading stays locked until the owner manually approves your submitted transaction hash.</p>{status && <p className="status">PAYMENT {status}</p>}{status !== "APPROVED" && status !== "PENDING" && <form onSubmit={submit}><label>Ethereum transaction hash<input required pattern="0x[a-fA-F0-9]{64}" title="Enter a 0x-prefixed Ethereum transaction hash." value={reference} onChange={(event) => setReference(event.target.value)} placeholder="0x..." /></label><label>Proof / notes<textarea value={proof} onChange={(event) => setProof(event.target.value)} placeholder="Optional payment details" /></label><button className="primary-button" disabled={busy}>{busy ? "SUBMITTING" : "SUBMIT $2 PAYMENT"}</button></form>}{message && <p className="muted">{message}</p>}</section>;
}

function OwnerDashboard({ account, revenue, ledger, users, referrals, payments, settings, auditLog, engineStatus, message, onEngineStatus, onUserStatus, onReviewPayment, onSaveSettings, transactions = [], transactionSummary = {} }) {
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState(settings);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [transactionPage, setTransactionPage] = useState(1);
  const [transactionPageSize, setTransactionPageSize] = useState(10);
  const [txSearch, setTxSearch] = useState("");
  const [txType, setTxType] = useState("all");
  const [txStatus, setTxStatus] = useState("all");
  const [txSort, setTxSort] = useState("newest");
  const visibleUsers = users.filter((user) => `${user.username} ${user.email}`.toLowerCase().includes(search.toLowerCase()));
  const allocationTotal = Number(draft.ownerRevenuePercent || 0) + Number(draft.referralCommissionPercent || 0) + Number(draft.platformReservePercent || 0);
  const tradeCount = ledger.filter((entry) => entry.type === "TRADE_EXECUTION").length;
  const activeUsers = users.filter((user) => user.status !== "suspended").length;
  const referralUsers = Object.values(referrals).reduce((total, profile) => total + (profile.referredUsers?.length || 0), 0);
  const filteredTransactions = (transactions || []).filter((entry) => {
    const matchesSearch = !txSearch || [entry.userEmail, entry.eventId, entry.referenceId, entry.type, entry.status].some((value) => String(value || "").toLowerCase().includes(txSearch.toLowerCase()));
    const matchesType = txType === "all" || entry.type === txType;
    const matchesStatus = txStatus === "all" || entry.status === txStatus;
    return matchesSearch && matchesType && matchesStatus;
  });
  const sortedTransactions = [...filteredTransactions].sort((a, b) => {
    const timeDifference = new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
    if (txSort === "newest") return timeDifference;
    if (txSort === "oldest") return new Date(a.timestamp || 0) - new Date(b.timestamp || 0);
    if (txSort === "highest") return Number(b.netAmount || 0) - Number(a.netAmount || 0);
    if (txSort === "lowest") return Number(a.netAmount || 0) - Number(b.netAmount || 0);
    return timeDifference;
  });
  const totalTransactionPages = Math.max(1, Math.ceil(sortedTransactions.length / transactionPageSize));
  const pagedTransactions = sortedTransactions.slice((transactionPage - 1) * transactionPageSize, transactionPage * transactionPageSize);

    const saveSettings = () => {
    try {
      onSaveSettings(draft);
      setSettingsMessage("Platform settings saved.");
    } catch (error) {
      setSettingsMessage(error.message);
    }
  };

  const paymentPanel = <section className="panel"><h3>Bot Payment Review</h3><div className="table-scroll"><table><thead><tr><th>User email</th><th>Amount</th><th>Reference</th><th>Status</th><th>Review</th></tr></thead><tbody>{payments.map((item) => <tr key={item.id}><td>{item.userEmail}</td><td>${Number(item.amount).toFixed(2)}</td><td>{item.reference}</td><td>{item.status}</td><td>{item.status === "PENDING" ? <><button className="primary-button" onClick={() => onReviewPayment(item.id, "APPROVED")}>APPROVE</button><button className="secondary-button" onClick={() => onReviewPayment(item.id, "REJECTED")}>REJECT</button></> : item.reviewedBy || "-"}</td></tr>)}</tbody></table></div></section>;
  return <section className="owner-dashboard">
    <div className="admin-heading"><div><span className="eyebrow">OWNER CONTROL PLANE</span><h2>Admin Dashboard</h2><p className="muted">Authorized owner: {account.email}. Sensitive authentication and exchange credentials are never shown.</p></div><span className="status active">OWNER VERIFIED</span></div>
    {message && <p className="admin-message">{message}</p>}
    <section className="cards admin-summary">
      {[['Total Users', users.length], ['Active Users', activeUsers], ['Total Trading Fees', `$${revenue.tradingFees.toFixed(2)}`], ['Owner Revenue', `$${revenue.ownerRevenue.toFixed(2)}`], ['Referral Rewards', `$${revenue.referralRewards.toFixed(2)}`], ['Platform Reserve', `$${revenue.platformReserve.toFixed(2)}`], ['Total Trades', tradeCount], ['Total Referral Users', referralUsers]].map(([label, value]) => <div className="card" key={label}><p>{label}</p><h2>{value}</h2></div>)}
    </section>
    <div className="admin-grid">
      <section className="panel"><h3>Revenue Management</h3><div className="admin-metrics"><span>Total trading fees<strong>${revenue.tradingFees.toFixed(2)}</strong></span><span>Admin / owner revenue<strong>${revenue.ownerRevenue.toFixed(2)}</strong></span><span>Referral rewards paid<strong>${revenue.referralRewards.toFixed(2)}</strong></span><span>Platform reserve<strong>${revenue.platformReserve.toFixed(2)}</strong></span></div><p className="muted">Valid referrer: 70% owner / 20% referrer / 10% reserve. No valid referrer: 80% owner / 0% referrer / 20% reserve.</p></section>
      <section className="panel"><h3>Trading Engine</h3><p>Engine status: <strong className={engineStatus === "running" ? "positive" : "negative"}>{engineStatus.toUpperCase()}</strong></p><button className="primary-button" onClick={() => onEngineStatus("running")}>START</button><button className="secondary-button" onClick={() => onEngineStatus("paused")}>PAUSE</button><button className="stop" onClick={() => onEngineStatus("stopped")}>STOP</button><p className="muted">Paper trading only. Exchange API secrets are not part of this control area.</p></section>
    </div>
    {paymentPanel}
    <section className="panel"><h3>Admin Transaction Center</h3><div className="admin-metrics"><span>Total deposits<strong>${Number(transactionSummary.totalDeposits || 0).toFixed(2)}</strong></span><span>Total withdrawals<strong>${Number(transactionSummary.totalWithdrawals || 0).toFixed(2)}</strong></span><span>Withdrawal fees<strong>${Number(transactionSummary.totalWithdrawalFees || 0).toFixed(2)}</strong></span><span>Trading volume<strong>${Number(transactionSummary.tradingVolume || 0).toFixed(2)}</strong></span></div><div className="admin-settings"><label>Search<input value={txSearch} onChange={(event) => { setTxSearch(event.target.value); setTransactionPage(1); }} placeholder="User, ID, wallet, hash" /></label><label>Type<select value={txType} onChange={(event) => { setTxType(event.target.value); setTransactionPage(1); }}><option value="all">All</option><option value="DEPOSIT">Deposit</option><option value="WITHDRAWAL">Withdrawal</option><option value="WITHDRAWAL_FEE">Withdrawal fee</option><option value="TRADE_EXECUTION">Trade execution</option><option value="TRADE_SETTLEMENT">Trade settlement</option></select></label><label>Status<select value={txStatus} onChange={(event) => { setTxStatus(event.target.value); setTransactionPage(1); }}><option value="all">All</option><option value="completed">Completed</option><option value="PENDING">Pending</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option></select></label><label>Sort<select value={txSort} onChange={(event) => { setTxSort(event.target.value); setTransactionPage(1); }}><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="highest">Highest amount</option><option value="lowest">Lowest amount</option></select></label><label>Page size<select value={transactionPageSize} onChange={(event) => { setTransactionPageSize(Number(event.target.value)); setTransactionPage(1); }}><option value={5}>5</option><option value={10}>10</option><option value={25}>25</option></select></label></div><div className="table-scroll"><table><thead><tr><th>Timestamp</th><th>Type</th><th>User</th><th>Amount</th><th>Fee</th><th>Status</th></tr></thead><tbody>{pagedTransactions.map((entry) => <tr key={entry.id}><td>{new Date(entry.timestamp).toLocaleString()}</td><td>{entry.type}</td><td>{entry.userEmail}</td><td>${Number(entry.netAmount || entry.amount || 0).toFixed(2)}</td><td>${Number(entry.fee || 0).toFixed(2)}</td><td>{entry.status}</td></tr>)}</tbody></table></div><div className="admin-actions"><button className="secondary-button" disabled={transactionPage <= 1} onClick={() => setTransactionPage((current) => Math.max(1, current - 1))}>Previous</button><span>Page {transactionPage} / {totalTransactionPages}</span><button className="secondary-button" disabled={transactionPage >= totalTransactionPages} onClick={() => setTransactionPage((current) => Math.min(totalTransactionPages, current + 1))}>Next</button></div></section>
    <section className="panel"><h3>User Management</h3><input aria-label="Search users" placeholder="Search by email or username" value={search} onChange={(event) => setSearch(event.target.value)} /><div className="table-scroll"><table><thead><tr><th>Account</th><th>Created</th><th>Status</th><th>Referrer</th><th>Balance</th><th>Action</th></tr></thead><tbody>{visibleUsers.map((user) => <tr key={user.email}><td><strong>{user.username}</strong><br />{user.email}</td><td>{user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "-"}</td><td>{user.status || "active"}</td><td>{user.referredBy || referrals[user.email]?.referredBy || "None"}</td><td>${getAccountData(user.email).wallet.balance.toFixed(2)}</td><td>{isOwnerAccount(user) ? "Owner" : <button className="secondary-button" onClick={() => onUserStatus(user)}>{user.status === "suspended" ? "Reactivate" : "Suspend"}</button>}</td></tr>)}</tbody></table></div></section>
    <section className="panel"><h3>Referral Management</h3><p className="muted">{referralUsers} referred users · {revenue.referralRewardEventCount} reward events. Self-referrals and duplicate source events are rejected by the ledger service.</p><div className="table-scroll"><table><thead><tr><th>Referrer</th><th>Code</th><th>Referred users</th><th>Rewards</th><th>Reward history</th></tr></thead><tbody>{Object.entries(referrals).filter(([, profile]) => profile.referredUsers?.length).map(([email, profile]) => <tr key={email}><td>{email}</td><td>{profile.code}</td><td>{profile.referredUsers.join(", ")}</td><td>${(profile.rewards || []).reduce((sum, reward) => sum + Number(reward.amount || 0), 0).toFixed(4)}</td><td>{(profile.rewards || []).length}</td></tr>)}</tbody></table></div></section>
    <section className="panel"><h3>Platform Settings</h3><div className="admin-settings"><label>Trading fee (%)<input type="number" min="0" step="0.01" value={draft.tradingFeePercent} onChange={(event) => setDraft({ ...draft, tradingFeePercent: event.target.value })} /></label><label>Owner revenue (%)<input type="number" min="0" step="0.01" value={draft.ownerRevenuePercent} onChange={(event) => setDraft({ ...draft, ownerRevenuePercent: event.target.value })} /></label><label>Referral commission (%)<input type="number" min="0" step="0.01" value={draft.referralCommissionPercent} onChange={(event) => setDraft({ ...draft, referralCommissionPercent: event.target.value })} /></label><label>Platform reserve (%)<input type="number" min="0" step="0.01" value={draft.platformReservePercent} onChange={(event) => setDraft({ ...draft, platformReservePercent: event.target.value })} /></label></div><p className={Math.abs(allocationTotal - 100) < 0.000001 ? "positive" : "form-error"}>Allocation total: {allocationTotal.toFixed(2)}% (must equal 100%)</p><button className="primary-button" disabled={!validateAllocationPercentages(draft)} onClick={saveSettings}>SAVE PLATFORM SETTINGS</button>{settingsMessage && <p className="muted">{settingsMessage}</p>}</section>
    <section className="panel"><h3>Financial Ledger</h3><p className="muted">Persistent fee, reward, owner, and reserve history. Event IDs prevent duplicate rewards.</p><div className="table-scroll"><table><thead><tr><th>Timestamp</th><th>Type</th><th>User / relationship</th><th>Amount</th><th>Event ID</th><th>Status</th></tr></thead><tbody>{ledger.map((entry) => <tr key={entry.id}><td>{new Date(entry.timestamp).toLocaleString()}</td><td>{entry.type}</td><td>{entry.user}{entry.metadata?.referredEmail ? ` → ${entry.metadata.referredEmail}` : ""}</td><td>${Number(entry.amount || entry.netAmount || 0).toFixed(4)}</td><td>{entry.eventId || entry.id}</td><td>{entry.status}</td></tr>)}</tbody></table></div></section>
    <section className="panel"><h3>Admin Audit Log</h3><div className="table-scroll"><table><thead><tr><th>Timestamp</th><th>Action</th><th>Target</th><th>Status</th></tr></thead><tbody>{auditLog.map((entry) => <tr key={entry.id}><td>{new Date(entry.timestamp).toLocaleString()}</td><td>{entry.action}</td><td>{entry.target || "Platform"}</td><td>{entry.status}</td></tr>)}</tbody></table></div></section>
  </section>;
}

function App() {
  const [account, setAccount] = useState(() => getSession());
  const [view, setView] = useState("dashboard");
  const [accountData, setAccountData] = useState(() => {
    const session = getSession();
    return session ? getAccountData(session.email) : { wallet: { balance: 1000, reserved: 0 }, history: [] };
  });
  const [active, setActive] = useState(false);
  const [amount, setAmount] = useState(10);
  const [risk, setRisk] = useState("Conservative");

  const [price, setPrice] = useState(100);
  const [signal, setSignal] = useState("HOLD");
  const [confidence, setConfidence] = useState(0);
  const [indicators, setIndicators] = useState({ shortAverage: 0, longAverage: 0, momentum: 0 });
  const [balance, setBalance] = useState(() => getAccountData(getSession()?.email || "").wallet?.balance || INITIAL_BALANCE);
  const [pnl, setPnl] = useState(0);
  const [trades, setTrades] = useState(() => getAccountData(getSession()?.email || "").history || []);
  const [openPositions, setOpenPositions] = useState([]);

  const [stopLoss, setStopLoss] = useState(2);
  const [takeProfit, setTakeProfit] = useState(4);
  const [maxDailyLoss, setMaxDailyLoss] = useState(5);
  const [maxOpenTrades, setMaxOpenTrades] = useState(3);
  const [backtestBalance, setBacktestBalance] = useState(1000);
  const [backtestAmount, setBacktestAmount] = useState(10);
  const [backtestRisk, setBacktestRisk] = useState("Conservative");
  const [backtestStopLoss, setBacktestStopLoss] = useState(2);
  const [backtestTakeProfit, setBacktestTakeProfit] = useState(4);
  const [backtestMaxDailyLoss, setBacktestMaxDailyLoss] = useState(5);
  const [backtestResult, setBacktestResult] = useState(null);
  const [walletAmount, setWalletAmount] = useState("100");
  const [walletMessage, setWalletMessage] = useState("");
  const [feeSettings, setFeeSettings] = useState(() => getFeeSettings());
  const [ledger, setLedger] = useState(() => getLedger());
  const [adminUsers, setAdminUsers] = useState(() => getRegisteredUsers());
  const [engineStatus, setEngineStatus] = useState(() => getEngineStatus());
  const [auditLog, setAuditLog] = useState(() => getAuditLog());
  const [adminMessage, setAdminMessage] = useState("");
  const [payment, setPayment] = useState(() => getPayment());
  const [paymentConfig, setPaymentConfig] = useState(() => getPaymentConfig());
  const [adminPayments, setAdminPayments] = useState([]);
  const [adminTransactions, setAdminTransactions] = useState([]);
  const [transactionSummary, setTransactionSummary] = useState({ totalDeposits: 0, totalWithdrawals: 0, totalWithdrawalFees: 0, tradingVolume: 0 });
  const [activationMessage, setActivationMessage] = useState("");
  const [referralProfile, setReferralProfile] = useState(() => { const session = getSession(); return session ? getReferralProfile(session) : null; });
  const [referralCodeInput, setReferralCodeInput] = useState("");
  const [profileName, setProfileName] = useState(() => getSession()?.username || "");
  const engine = useRef({
    balance: getAccountData(getSession()?.email || "").wallet?.balance || INITIAL_BALANCE,
    pnl: 0,
    price: 100,
    prices: [100],
    step: 0,
    positions: [],
    trades: getAccountData(getSession()?.email || "").history || [],
  });
  const winCount = trades.filter((trade) => trade.pnl > 0).length;
  const winRate = trades.length > 0 ? Math.round((winCount / trades.length) * 100) : 0;
  const revenue = getRevenueSummary();
  const owner = isOwnerAccount(account);
  const referralRecords = getReferralRecords();
  const referralEarnings = getReferralEarnings(account?.email || "");
  const referralRewardHistory = getReferralRewardHistory(account?.email || "");
  const referralLink = `${window.location.origin}/?ref=${referralProfile?.code}`;

  useEffect(() => {
    if (account) return;
    let cancelled = false;
    hydrateSession().then((nextAccount) => {
      if (cancelled) return;
      if (!nextAccount) return;
      hydrateAccountData(nextAccount.email).then((nextData) => {
        if (cancelled) return;
        setAccount(nextAccount);
        setAccountData(nextData);
        setBalance(nextData.wallet.balance);
        setTrades(nextData.history);
        setActive(nextAccount.botStatus === "active");
        setProfileName(nextAccount.username);
        setReferralProfile(getReferralProfile(nextAccount));
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [account]);

  useEffect(() => {
    hydrateFinancialData(owner).then(() => {
      hydrateUsers(getAdminUsers());
      setFeeSettings(getFeeSettings());
      setLedger(getLedger());
      setAuditLog(getAuditLog());
      setEngineStatus(getEngineStatus());
      if (owner) hydrateAdminPayments().then(setAdminPayments).catch(() => {});
    }).catch(() => {});
  }, [owner]);

  useEffect(() => {
    if (account) hydratePayment().then((nextPayment) => { setPayment(nextPayment); setPaymentConfig(getPaymentConfig()); }).catch(() => {});
  }, [account, account?.email]);

  useEffect(() => {
    if (!owner) return;
    const loadAdminTransactions = async () => {
      try {
        const data = await fetch(`/api/admin/transactions?page=1&pageSize=25&sort=newest`, { credentials: "include", headers: { "content-type": "application/json" } }).then(async (response) => {
          const json = await response.json();
          if (!response.ok) throw new Error(json.error || "Failed to load admin transactions.");
          return json;
        });
        setAdminTransactions(data.transactions || []);
        setTransactionSummary(data.summary || {});
      } catch (error) {
        setAdminMessage(error.message);
      }
    };
    loadAdminTransactions();
  }, [owner]);

  const emergencyStop = () => {
    const state = engine.current;
    const emergencyTrades = state.positions.map((position) => {
      const change = position.side === "BUY"
        ? ((state.price - position.entryPrice) / position.entryPrice) * 100
        : ((position.entryPrice - state.price) / position.entryPrice) * 100;
      const profitLoss = toMoney(position.amount * (change / 100));
      state.balance = Math.max(0, toMoney(state.balance + position.amount + profitLoss));
      state.pnl = toMoney(state.pnl + profitLoss);
      return {
        id: `${Date.now()}-${position.id}`,
        time: new Date().toLocaleTimeString(),
        symbol: "SIM-USD",
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice: toMoney(state.price),
        amount: position.amount,
        fee: position.fee || 0,
        pnl: profitLoss,
        reason: "Emergency stop",
      };
    });
    state.positions = [];
    state.trades = [...emergencyTrades, ...state.trades].slice(0, 20);
    setBalance(state.balance);
    setPnl(state.pnl);
    setTrades(state.trades);
    saveAccountData(account.email, { ...getAccountData(account.email), history: state.trades, wallet: { ...accountData.wallet, balance: state.balance } });
    setAccountData(getAccountData(account.email));
    setOpenPositions([]);
    setActive(false);
    setSignal("HOLD");
    setConfidence(0);
  };

  const handleBacktest = () => {
    setBacktestResult(runBacktest({
      startingBalance: safeAmount(backtestBalance, 1000),
      tradingAmount: safeAmount(backtestAmount, 10),
      stopLoss: safePercent(backtestStopLoss, 0.1),
      takeProfit: safePercent(backtestTakeProfit, 0.1),
      maxDailyLoss: safePercent(backtestMaxDailyLoss, 0.1),
    }));
  };

  const updateWallet = async (direction) => {
    const safeValue = Number(walletAmount);
    if (!Number.isFinite(safeValue) || safeValue <= 0) return setWalletMessage("Enter a valid amount greater than zero.");
    if (direction === "withdraw") {
      try {
        const result = await withdrawFunds(walletAmount, `withdrawal-${account.email}-${crypto.randomUUID()}`);
        const nextData = await hydrateAccountData(account.email);
        setAccountData(nextData);
        setBalance(nextData.wallet.balance);
        setLedger(await hydrateAccountLedger());
        setWalletMessage(`Withdrawal confirmed. Fixed fee $${result.withdrawal.fee.toFixed(2)} · Net received $${result.withdrawal.netAmount.toFixed(2)}.`);
      } catch (error) {
        setWalletMessage(error.message);
      }
      return;
    }
    const currentData = getAccountData(account.email);
    const current = currentData.wallet;
    const fee = calculateFee(safeValue, direction === "deposit" ? feeSettings.depositFeePercent : feeSettings.withdrawalFeePercent);
    if (direction === "withdraw" && safeValue > current.balance - current.reserved) return setWalletMessage("Available demo funds are insufficient.");
    const nextWallet = { ...current, balance: Math.max(0, current.balance + (direction === "deposit" ? fee.netAmount : -fee.grossAmount)) };
    const nextData = { ...currentData, wallet: nextWallet };
    setAccountData(nextData);
    saveAccountData(account.email, nextData);
    engine.current.balance = nextWallet.balance;
    setBalance(nextWallet.balance);
    const eventId = `${direction}-${Date.now()}`;
    recordLedger({ user: account.email, type: direction === "deposit" ? "DEPOSIT" : "WITHDRAWAL", ...fee, referenceId: eventId, eventId, metadata: { demoOnly: true, requestedAmount: safeValue } });
    const reward = referralProfile?.referredBy
      ? recordReferralReward(referralProfile.referredBy, account.email, fee.fee * (feeSettings.referralCommissionPercent / 100), eventId)
      : null;
    setLedger(getLedger());
    if (reward) {
      setReferralProfile(getReferralProfile(account));
    }
    setWalletMessage(`${direction === "deposit" ? "Deposit" : "Withdrawal"} confirmed. Fee $${fee.fee.toFixed(2)} · Net ${direction === "deposit" ? "credited" : "amount"} $${fee.netAmount.toFixed(2)}.`);
  };

  const applyReferral = () => {
    const result = attachReferral(account.email, referralCodeInput.trim().toUpperCase());
    setWalletMessage(result.ok ? "Referral code applied." : result.reason);
    setReferralProfile(getReferralProfile(account));
  };

  const saveProfile = () => {
    const nextAccount = updateAccount(account.email, { username: profileName.trim() || account.username, profile: { ...account.profile, risk } });
    setAccount(nextAccount);
    setWalletMessage("Profile settings saved.");
  };

  const refreshAdminData = () => {
    setAdminUsers(getRegisteredUsers());
    setLedger(getLedger());
    setAuditLog(getAuditLog());
  };

  const handlePaymentSubmit = async (details) => setPayment(await submitPayment(details));
  const handleReviewPayment = async (id, status) => {
    const reviewed = await reviewPayment(id, status);
    setAdminPayments((current) => current.map((item) => item.id === id ? reviewed : item));
    setAdminMessage(`Payment ${status.toLowerCase()}.`);
  };
  const activateBot = async () => {
    setActivationMessage("");
    try {
      await authorizeTrading();
      setPayment(getPayment());
      setActive(true);
    } catch (error) {
      setActivationMessage(error.message);
      setView("payment");
    }
  };

  const changeEngineStatus = (status) => {
    if (!owner) return;
    const nextStatus = saveEngineStatus(status);
    setEngineStatus(nextStatus);
    const event = recordAuditLog({ action: `ENGINE_${nextStatus.toUpperCase()}`, actor: account.email, status: "completed" });
    setAuditLog([event, ...getAuditLog().filter((entry) => entry.id !== event.id)]);
    setAdminMessage(`Trading engine ${nextStatus}.`);
  };

  const changeUserStatus = (user) => {
    if (!owner || isOwnerAccount(user)) return;
    const nextStatus = user.status === "suspended" ? "active" : "suspended";
    updateAccount(user.email, { status: nextStatus });
    recordAuditLog({ action: `USER_${nextStatus.toUpperCase()}`, actor: account.email, target: user.email });
    refreshAdminData();
    setAdminMessage(`${user.email} is now ${nextStatus}.`);
  };

  const hydrateAccount = (nextAccount) => {
    const nextData = getAccountData(nextAccount.email);
    setAccount(nextAccount);
    setAccountData(nextData);
    setBalance(nextData.wallet.balance);
    setTrades(nextData.history);
    setPnl(0);
    setOpenPositions([]);
    setActive(nextAccount.botStatus === "active");
    setProfileName(nextAccount.username);
    setReferralProfile(getReferralProfile(nextAccount));
    engine.current = { balance: nextData.wallet.balance, pnl: 0, price: 100, prices: [100], step: 0, positions: [], trades: nextData.history };
  };

  useEffect(() => {
    const timer = setInterval(() => {
      if (!account) return;
      const state = engine.current;
      const nextPrice = Math.max(1, state.price + PRICE_STEPS[state.step % PRICE_STEPS.length]);
      state.step += 1;
      state.price = nextPrice;
      state.prices = [...state.prices, nextPrice].slice(-LONG_WINDOW);
      const analysis = getSignal(state.prices);
      setPrice(nextPrice);
      setSignal(active ? analysis.signal : "HOLD");
      setConfidence(active ? analysis.confidence : 0);
      setIndicators(analysis);

      if (!active || engineStatus === "stopped") {
        return;
      }

      const closedTrades = [];
      state.positions = state.positions.filter((position) => {
        const change = position.side === "BUY"
          ? ((nextPrice - position.entryPrice) / position.entryPrice) * 100
          : ((position.entryPrice - nextPrice) / position.entryPrice) * 100;
        const stopTriggered = change <= -safePercent(stopLoss, 0.1);
        const targetTriggered = change >= safePercent(takeProfit, 0.1);
        if (!stopTriggered && !targetTriggered) return true;

        const profitLoss = toMoney(position.amount * (change / 100));
        state.balance = Math.max(0, toMoney(state.balance + position.amount + profitLoss));
        state.pnl = toMoney(state.pnl + profitLoss);
        recordLedger({ user: account.email, type: "TRADE_SETTLEMENT", grossAmount: position.amount + profitLoss, fee: 0, netAmount: position.amount + profitLoss, referenceId: `settlement-${Date.now()}-${position.id}`, metadata: { symbol: "SIM-USD", demoOnly: true } });
        closedTrades.push({
          id: `${Date.now()}-${position.id}`,
          time: new Date().toLocaleTimeString(),
          symbol: "SIM-USD",
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice: toMoney(nextPrice),
          amount: position.amount,
          pnl: profitLoss,
          reason: stopTriggered ? "Stop-loss" : "Take-profit",
        });
        return false;
      });

      if (closedTrades.length > 0) {
        state.trades = [...closedTrades, ...state.trades].slice(0, 20);
      }

      const dailyLossLimit = Math.max(0, safePercent(maxDailyLoss, 5) / 100 * INITIAL_BALANCE);
      const lossReached = state.pnl <= -dailyLossLimit;
      const tradeAmount = Math.min(Math.max(0, Number(amount) || 0), Math.max(0, state.balance));
      const canOpen = !lossReached && analysis.signal !== "HOLD" && tradeAmount > 0 && state.positions.length < Math.max(1, Number(maxOpenTrades) || 1);
      if (canOpen) {
        const tradeFee = calculateFee(tradeAmount, feeSettings.tradingFeePercent);
        if (tradeAmount + tradeFee.fee > state.balance) return;
        state.balance = Math.max(0, toMoney(state.balance - tradeAmount - tradeFee.fee));
        const eventId = `trade-${account.email}-${state.step}`;
        recordTradingFee({ user: account.email, ...tradeFee, referenceId: eventId, eventId, metadata: { symbol: "SIM-USD", side: analysis.signal, demoOnly: true } });
        recordLedger({ user: account.email, type: "TRADE_EXECUTION", grossAmount: tradeAmount, fee: tradeFee.fee, netAmount: tradeAmount, referenceId: `execution-${state.step}`, metadata: { symbol: "SIM-USD", side: analysis.signal, demoOnly: true } });
        setLedger(getLedger());
        state.positions = [...state.positions, {
          id: state.step,
          side: analysis.signal,
          entryPrice: toMoney(nextPrice),
          amount: toMoney(tradeAmount),
          fee: tradeFee.fee,
        }];
      }

      setBalance(state.balance);
      setPnl(state.pnl);
      setTrades(state.trades);
      setLedger(getLedger());
      saveAccountData(account.email, { ...getAccountData(account.email), history: state.trades, wallet: { ...getAccountData(account.email).wallet, balance: state.balance } });
      setOpenPositions(state.positions);
      if (lossReached || tradeAmount <= 0) {
        setActive(false);
        setSignal("HOLD");
      }
    }, TICK_INTERVAL);

    return () => clearInterval(timer);
  }, [account, account?.email, active, amount, stopLoss, takeProfit, maxDailyLoss, maxOpenTrades, feeSettings.tradingFeePercent, feeSettings.referralCommissionPercent, referralProfile?.referredBy, engineStatus]);

  if (!account) return <AuthScreen onAuthenticated={(nextAccount) => { const referralCode = new URLSearchParams(window.location.search).get("ref"); if (referralCode) { const result = attachReferral(nextAccount.email, referralCode); if (result.ok) setAccountReferrer(nextAccount.email, getReferralProfile(nextAccount).referredBy); } hydrateAccount(getSession() || nextAccount); }} />;

  return (
    <div className="app">

      <header>
        <div>
          <h1>AI Trading Bot</h1>
          <p>DEMO / PAPER TRADING TERMINAL</p>
        </div>
        <div className="account-actions"><span>{account.username}</span><button className="link-button" onClick={async () => { emergencyStop(); await logout(); setAccount(null); }}>Log out</button></div>
      </header>

      <nav className="app-nav" aria-label="Main navigation">
        {["dashboard", "trading", "payment", "backtesting", "wallet", "history", "ledger", "settings", ...(owner ? ["admin"] : [])].map((item) => <button key={item} className={view === item ? "selected" : ""} onClick={() => setView(item)}>{item}</button>)}
      </nav>

      <main>

        {view === "payment" && <PaymentScreen payment={payment} paymentConfig={paymentConfig} onSubmit={handlePaymentSubmit} />}

        {view === "dashboard" && <section className="cards">

          <div className="card">
            <p>Paper Balance</p>
            <h2>${balance.toFixed(2)}</h2>
          </div>

          <div className="card">
            <p>Profit / Loss</p>
            <h2>
              {pnl >= 0 ? "+" : ""}
              ${pnl.toFixed(2)}
            </h2>
          </div>

          <div className="card">
            <p>Market Price</p>
            <h2>${price.toFixed(2)}</h2>
          </div>

          <div className="card">
            <p>AI Signal</p>
            <h2>{signal} <small>{confidence}%</small></h2>
          </div>

          <div className="card">
            <p>Win Rate</p>
            <h2>{winRate}%</h2>
          </div>

          <div className="card">
            <p>Closed Trades</p>
            <h2>{trades.length}</h2>
          </div>

          <div className="card"><p>Total Fees Paid</p><h2>${toMoney(ledger.filter((item) => item.user === account.email && item.type !== "REFERRAL_REWARD").reduce((sum, item) => sum + item.fee, 0)).toFixed(2)}</h2></div>
          <div className="card"><p>Referral Earnings</p><h2>${referralEarnings.toFixed(4)}</h2></div>

        </section>}

        {view === "dashboard" && <section className="panel dashboard-summary">
          <h2>Account Overview</h2>
          <p>Available demo funds <strong>${toMoney(accountData.wallet.balance - accountData.wallet.reserved).toFixed(2)}</strong> · Reserved <strong>${toMoney(accountData.wallet.reserved).toFixed(2)}</strong></p>
          <p>Backtest status: <strong>{backtestResult ? `${backtestResult.totalTrades} trades · ${toMoney(backtestResult.netProfitLoss) >= 0 ? "+" : ""}$${toMoney(backtestResult.netProfitLoss).toFixed(2)} net` : "Not run yet"}</strong></p>
          <span className={active ? "status active" : "status"}>{active ? "● ACTIVE" : "● STOPPED"}</span>
          <p className="muted">Trading fee: {feeSettings.tradingFeePercent}% · Deposits: {feeSettings.depositFeePercent}% · Withdrawals: {feeSettings.withdrawalFeePercent}%</p>
          <button className="primary-button" onClick={() => setView("wallet")}>OPEN WALLET</button>
        </section>}

        {view === "trading" && <section className="panel">

          <h2>Bot Control</h2>

          <button
            className="activate"
            onClick={activateBot}
          >
            ACTIVATE BOT
          </button>
          {activationMessage && <p className="form-error">{activationMessage}</p>}

          <button
            className="stop"
            onClick={emergencyStop}
          >
            EMERGENCY STOP
          </button>

        </section>}

        {view === "trading" && <section className="panel">

          <h2>Trading Settings</h2>

          <label>
            Trading Amount ($)

            <input
              type="number"
              min="1"
              value={amount}
              onChange={(e) =>
                setAmount(Math.max(0, Number(e.target.value) || 0))
              }
            />
          </label>

          <label>
            Risk Level

            <select
              value={risk}
              onChange={(e) =>
                setRisk(e.target.value)
              }
            >
              <option>Conservative</option>
              <option>Balanced</option>
              <option>Aggressive</option>
            </select>
          </label>

          <label>
            Stop Loss (%)

            <input
              type="number"
              min="0.1"
              value={stopLoss}
              onChange={(e) =>
                setStopLoss(Math.max(0.1, Number(e.target.value) || 0.1))
              }
            />
          </label>

          <label>
            Take Profit (%)

            <input
              type="number"
              min="0.1"
              value={takeProfit}
              onChange={(e) =>
                setTakeProfit(Math.max(0.1, Number(e.target.value) || 0.1))
              }
            />
          </label>

          <label>
            Maximum Daily Loss (%)
            <input type="number" min="0.1" value={maxDailyLoss} onChange={(e) => setMaxDailyLoss(Math.max(0.1, Number(e.target.value) || 0.1))} />
          </label>

          <label>
            Maximum Open Trades
            <input type="number" min="1" step="1" value={maxOpenTrades} onChange={(e) => setMaxOpenTrades(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
          </label>

          <div className="indicator-grid">
            <span>Short MA <strong>{indicators.shortAverage ? indicators.shortAverage.toFixed(2) : "--"}</strong></span>
            <span>Long MA <strong>{indicators.longAverage ? indicators.longAverage.toFixed(2) : "--"}</strong></span>
            <span>Momentum <strong>{indicators.momentum.toFixed(2)}%</strong></span>
            <span>Open trades <strong>{openPositions.length}</strong></span>
          </div>

        </section>}

        {view === "backtesting" && <section className="panel">

          <h2>Backtesting</h2>
          <p className="muted">Deterministic SIM-USD historical dataset · 96 ticks</p>

          <div className="backtest-settings">
            <label>
              Starting Balance ($)
              <input type="number" min="1" value={backtestBalance} onChange={(e) => setBacktestBalance(Math.max(1, Number(e.target.value) || 1))} />
            </label>
            <label>
              Trading Amount ($)
              <input type="number" min="0.01" value={backtestAmount} onChange={(e) => setBacktestAmount(Math.max(0.01, Number(e.target.value) || 0.01))} />
            </label>
            <label>
              Risk Level
              <select value={backtestRisk} onChange={(e) => setBacktestRisk(e.target.value)}>
                <option>Conservative</option>
                <option>Balanced</option>
                <option>Aggressive</option>
              </select>
            </label>
            <label>
              Stop Loss (%)
              <input type="number" min="0.1" value={backtestStopLoss} onChange={(e) => setBacktestStopLoss(Math.max(0.1, Number(e.target.value) || 0.1))} />
            </label>
            <label>
              Take Profit (%)
              <input type="number" min="0.1" value={backtestTakeProfit} onChange={(e) => setBacktestTakeProfit(Math.max(0.1, Number(e.target.value) || 0.1))} />
            </label>
            <label>
              Maximum Daily Loss (%)
              <input type="number" min="0.1" value={backtestMaxDailyLoss} onChange={(e) => setBacktestMaxDailyLoss(Math.max(0.1, Number(e.target.value) || 0.1))} />
            </label>
          </div>

          <button className="backtest-button" onClick={handleBacktest}>RUN BACKTEST</button>

          {backtestResult && (
            <>
              <div className="backtest-metrics">
                <span>Starting balance <strong>${toMoney(backtestResult.startingBalance).toFixed(2)}</strong></span>
                <span>Final balance <strong>${toMoney(backtestResult.finalBalance).toFixed(2)}</strong></span>
                <span>Net P/L <strong className={backtestResult.netProfitLoss >= 0 ? "positive" : "negative"}>${toMoney(backtestResult.netProfitLoss).toFixed(2)}</strong></span>
                <span>Return <strong>{toMoney(backtestResult.returnPercent).toFixed(2)}%</strong></span>
                <span>Total trades <strong>{backtestResult.totalTrades}</strong></span>
                <span>Winning trades <strong>{backtestResult.winningTrades}</strong></span>
                <span>Losing trades <strong>{backtestResult.losingTrades}</strong></span>
                <span>Win rate <strong>{toMoney(backtestResult.winRate).toFixed(1)}%</strong></span>
                <span>Max drawdown <strong>${toMoney(backtestResult.maxDrawdown).toFixed(2)}</strong></span>
                <span>Average profit <strong>${toMoney(backtestResult.averageProfit).toFixed(2)}</strong></span>
                <span>Average loss <strong>${toMoney(backtestResult.averageLoss).toFixed(2)}</strong></span>
              </div>
              <EquityCurve values={backtestResult.equity} />
              <div className="backtest-history">
                <h3>Backtest Trade History</h3>
                {backtestResult.trades.length === 0 ? <div className="empty">No trades matched these settings.</div> : (
                  <div className="table-scroll">
                    <table>
                      <thead><tr><th>Entry</th><th>Exit</th><th>Side</th><th>Entry price</th><th>Exit price</th><th>P/L</th><th>Reason</th></tr></thead>
                      <tbody>{backtestResult.trades.map((trade) => (
                        <tr key={trade.id}><td>{trade.entryTime}</td><td>{trade.exitTime}</td><td>{trade.side}</td><td>${trade.entryPrice}</td><td>${trade.exitPrice}</td><td className={trade.pnl >= 0 ? "positive" : "negative"}>${trade.pnl}</td><td>{trade.reason}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}

        </section>}

        {view === "wallet" && <section className="panel wallet-panel" aria-label="Demo wallet">
          <span className="eyebrow">DEMO / PAPER FUNDS ONLY</span><h2>Wallet</h2>
          <p className="muted">These balances are simulated and never connect to a bank, payment provider, wallet, or exchange.</p>
          <div className="wallet-cards"><div><span>Available demo balance</span><strong>${toMoney(accountData.wallet.balance - accountData.wallet.reserved).toFixed(2)}</strong></div><div><span>Reserved / trading balance</span><strong>${toMoney(accountData.wallet.reserved).toFixed(2)}</strong></div><div><span>Total demo balance</span><strong>${toMoney(accountData.wallet.balance).toFixed(2)}</strong></div><div><span>Referral earnings</span><strong>${referralEarnings.toFixed(4)}</strong></div></div>
          <div className="wallet-actions">
            <form className="wallet-form" onSubmit={(event) => { event.preventDefault(); updateWallet("deposit"); }}>
              <h3>Deposit</h3><p className="muted">Add paper money to your demo balance.</p>
              <label>Amount ($)<input type="number" min="0.01" step="0.01" inputMode="decimal" value={walletAmount} onChange={(e) => setWalletAmount(e.target.value)} /></label>
              <p className="fee-preview">Deposit fee ({feeSettings.depositFeePercent}%): ${calculateFee(walletAmount, feeSettings.depositFeePercent).fee.toFixed(2)}<br />Net credited: ${calculateFee(walletAmount, feeSettings.depositFeePercent).netAmount.toFixed(2)}</p>
              <button className="primary-button" type="submit">DEPOSIT DEMO FUNDS</button>
            </form>
            <form className="wallet-form" onSubmit={(event) => { event.preventDefault(); updateWallet("withdraw"); }}>
              <h3>Withdrawal</h3><p className="muted">Remove paper money from your demo balance.</p>
              <label>Amount ($)<input type="number" min="0.01" step="0.01" inputMode="decimal" value={walletAmount} onChange={(e) => setWalletAmount(e.target.value)} /></label>
              <p className="fee-preview">Fixed withdrawal fee: $1.00<br />Net withdrawal amount: ${Math.max(0, Number(walletAmount) - 1).toFixed(2)}</p>
              <button className="secondary-button" type="submit">WITHDRAW DEMO FUNDS</button>
            </form>
          </div>
          <div className="referral-box"><h3>Referral</h3><p>Code <strong>{referralProfile?.code}</strong></p><p className="muted">Link {referralLink}</p><p>Referred users: {referralProfile?.referredUsers?.length || 0} · Earnings: ${referralEarnings.toFixed(4)} · Commission: {feeSettings.referralCommissionPercent}%</p><label>Apply referral code<input value={referralCodeInput} onChange={(e) => setReferralCodeInput(e.target.value)} /></label><button className="secondary-button" onClick={applyReferral}>APPLY CODE</button>{referralRewardHistory.length > 0 && <div className="table-scroll"><table><caption>Referral Reward History</caption><thead><tr><th>Referred user</th><th>Event type</th><th>Fee generated</th><th>Commission %</th><th>Reward amount</th><th>Date/time</th><th>Status</th></tr></thead><tbody>{referralRewardHistory.map((reward) => <tr key={reward.id}><td>{reward.referredEmail}</td><td>{reward.eventType}</td><td>${reward.feeGenerated.toFixed(2)}</td><td>{reward.commissionPercent}%</td><td>${reward.amount.toFixed(4)}</td><td>{new Date(reward.timestamp).toLocaleString()}</td><td>{reward.status}</td></tr>)}</tbody></table></div>}</div>
          <div className="wallet-ledger"><h3>Transaction History</h3><p className="muted">Deposits, withdrawals, and trading fees for this demo account.</p><div className="table-scroll"><table><thead><tr><th>Timestamp</th><th>Type</th><th>Gross</th><th>Fee</th><th>Net</th><th>Status</th></tr></thead><tbody>{ledger.filter((item) => item.user === account.email).map((item) => <tr key={item.id}><td>{new Date(item.timestamp).toLocaleString()}</td><td>{item.type}</td><td>${item.grossAmount.toFixed(2)}</td><td>${item.fee.toFixed(2)}</td><td>${item.netAmount.toFixed(2)}</td><td>{item.status}</td></tr>)}</tbody></table></div></div>
          {walletMessage && <p className="muted">{walletMessage}</p>}
        </section>}

        {view === "history" && <section className="panel">
          <h2>Trade History</h2><p className="muted">Closed paper trades only. Backtest records remain in Backtesting.</p>
          {trades.length === 0 ? <div className="empty">No paper trades yet.</div> : <div className="table-scroll"><table><thead><tr><th>Date / time</th><th>Symbol</th><th>Side</th><th>Entry</th><th>Exit</th><th>Amount</th><th>Fee</th><th>P/L</th><th>Reason</th></tr></thead><tbody>{trades.map((trade) => <tr key={trade.id}><td>{trade.time}</td><td>{trade.symbol}</td><td>{trade.side}</td><td>${trade.entryPrice}</td><td>${trade.exitPrice}</td><td>${trade.amount}</td><td>${toMoney(trade.fee)}</td><td className={trade.pnl >= 0 ? "positive" : "negative"}>${trade.pnl}</td><td>{trade.reason}</td></tr>)}</tbody></table></div>}
        </section>}

        {view === "ledger" && <section className="panel"><h2>Transaction Ledger</h2><p className="muted">Immutable-style demo record of every balance movement.</p><div className="table-scroll"><table><thead><tr><th>Timestamp</th><th>Type</th><th>Gross</th><th>Fee</th><th>Net</th><th>Reference</th><th>Status</th></tr></thead><tbody>{ledger.filter((item) => item.user === account.email).map((item) => <tr key={item.id}><td>{new Date(item.timestamp).toLocaleString()}</td><td>{item.type}</td><td>${item.grossAmount.toFixed(2)}</td><td>${item.fee.toFixed(2)}</td><td>${item.netAmount.toFixed(2)}</td><td>{item.referenceId}</td><td>{item.status}</td></tr>)}</tbody></table></div></section>}

        {view === "admin" && owner && <OwnerDashboard account={account} revenue={revenue} ledger={ledger} users={adminUsers} referrals={referralRecords} payments={adminPayments} settings={feeSettings} auditLog={auditLog} engineStatus={engineStatus} message={adminMessage} transactions={adminTransactions} transactionSummary={transactionSummary} onEngineStatus={changeEngineStatus} onUserStatus={changeUserStatus} onReviewPayment={handleReviewPayment} onSaveSettings={(nextSettings) => { setFeeSettings(saveFeeSettings(nextSettings)); recordAuditLog({ action: "SETTINGS_UPDATED", actor: account.email }); setAuditLog(getAuditLog()); }} />}

        {view === "settings" && <section className="panel">
          <h2>Profile & Settings</h2>
          <label>Username<input value={profileName} onChange={(e) => setProfileName(e.target.value)} /></label>
          <label>Email<input value={account.email} disabled /></label>
          <p className="muted">Account created {new Date(account.createdAt).toLocaleDateString()}</p>
          <label>Default risk level<select value={risk} onChange={(e) => setRisk(e.target.value)}><option>Conservative</option><option>Balanced</option><option>Aggressive</option></select></label>
          <button className="primary-button" onClick={saveProfile}>SAVE PROFILE SETTINGS</button>
          <p className="muted">Trading controls are available in the Trading view. All balances and activity are DEMO/PAPER funds.</p>
        </section>}

        {view === "dashboard" && <section className="panel">

          <h2>Trade History</h2>

          {trades.length === 0 ? (
            <div className="empty">
              No paper trades yet.
            </div>
          ) : (
            <div className="trade-list">

              {trades.map((trade) => (
                <div className="trade" key={trade.id}>

                  <strong>{trade.side} {trade.symbol}</strong>

                  <span>
                    Entry ${trade.entryPrice} / Exit ${trade.exitPrice}
                  </span>

                  <span>
                    Amount: ${trade.amount}
                  </span>

                  <span>
                    P/L: {trade.pnl >= 0 ? "+" : ""}
                    ${trade.pnl}
                  </span>

                  <small>
                    {trade.time} · {trade.reason}
                  </small>

                </div>
              ))}

            </div>
          )}

        </section>}

      </main>

      <footer>
        ⚠️ Simulation only — no real cryptocurrency is being traded.
      </footer>

    </div>
  );
}

export default App;