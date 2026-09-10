const apiBase = (typeof window !== "undefined" && import.meta?.env?.VITE_API_BASE_URL)
  ? String(import.meta.env.VITE_API_BASE_URL).replace(/\/$/, "")
  : "";

export const resolveApiUrl = (path) => {
  if (!path) return apiBase || "/";
  if (/^https?:\/\//i.test(path)) return path;
  return `${apiBase}${path}`;
};

export const apiRequest = async (path, options = {}) => {
  const response = await fetch(resolveApiUrl(path), {
    credentials: "include",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
};
