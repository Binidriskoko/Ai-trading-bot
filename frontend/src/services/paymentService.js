import { apiRequest } from "./apiClient.js";

const api = (path, options = {}) => apiRequest(path, options);

let currentPayment = null;
let payments = [];
let currentPaymentConfig = null;

export const hydratePayment = async () => {
  const data = await api("/api/payments");
  currentPayment = data.payment;
  currentPaymentConfig = data.paymentConfig;
  return currentPayment;
};

export const getPayment = () => currentPayment;
export const getPaymentConfig = () => currentPaymentConfig;
export const getPayments = () => payments;

export const submitPayment = async ({ reference, proof }) => {
  const data = await api("/api/payments", { method: "POST", body: JSON.stringify({ reference, proof }) });
  currentPayment = data.payment;
  currentPaymentConfig = data.paymentConfig;
  return currentPayment;
};

export const authorizeTrading = async () => {
  const data = await api("/api/trading/activate", { method: "POST" });
  currentPayment = data.payment;
  return data;
};

export const deactivateTrading = async () => api("/api/trading/deactivate", { method: "POST" });

export const hydrateAdminPayments = async () => {
  const data = await api("/api/admin/bootstrap");
  payments = data.payments || [];
  return payments;
};

export const reviewPayment = async (id, status) => {
  const data = await api(`/api/admin/payments/${id}`, { method: "POST", body: JSON.stringify({ status }) });
  payments = payments.map((payment) => payment.id === id ? data.payment : payment);
  return data.payment;
};
