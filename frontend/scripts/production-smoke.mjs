const origin = String(process.env.SMOKE_URL || `http://127.0.0.1:${process.env.PORT || 8787}`).replace(/\/$/, "");
const response = await fetch(`${origin}/api/health`);
if (!response.ok) throw new Error(`Health check returned HTTP ${response.status}.`);

const health = await response.json();
if (health.ok !== true || health.status !== "healthy" || health.mode === "LIVE") {
  throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
}

console.log(`Production startup smoke check passed: ${origin}/api/health`);