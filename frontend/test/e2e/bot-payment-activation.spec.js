import { expect, test } from "@playwright/test";

const password = "PhaseOneUser1";
const ownerPassword = "ExistingOwner1";

const logIn = async (page, email, accountPassword) => {
  const loginButton = page.getByRole("button", { name: "LOG IN", exact: true });
  if (await loginButton.isVisible().catch(() => false)) {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(accountPassword);
    await loginButton.click();
  } else if (await page.getByRole("button", { name: "CREATE DEMO ACCOUNT", exact: true }).isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(accountPassword);
    await page.getByRole("button", { name: "LOG IN", exact: true }).click();
  }
};

test("payment approval gates persistent bot activation", async ({ page }) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const userEmail = `phase-one-${suffix}@example.com`;
  const paymentHash = `0x${"a".repeat(64)}`;

  await page.goto("/");
  const ownerSignup = await page.request.post("/api/auth/signup", { data: { username: "phase-one-owner", email: "binidriskoko@gmail.co", password: ownerPassword } });
  if (!ownerSignup.ok()) await page.request.post("/api/auth/login", { data: { email: "binidriskoko@gmail.co", password: ownerPassword } });
  await page.request.post("/api/auth/logout");
  await page.request.post("/api/auth/signup", { data: { username: `phase-one-${suffix}`, email: userEmail, password } });
  await page.reload();
  await expect(page.getByText("STOPPED", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "trading", exact: true }).click();
  await page.getByRole("button", { name: "ACTIVATE BOT" }).click();
  await expect(page.getByText("payment", { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/payment required/i)).toBeVisible();

  await page.getByLabel("Ethereum transaction hash").fill(paymentHash);
  await page.getByRole("button", { name: "SUBMIT $2 PAYMENT" }).click();
  await expect(page.getByText("PAYMENT PENDING")).toBeVisible();
  await page.getByRole("button", { name: "trading", exact: true }).click();
  await page.getByRole("button", { name: "ACTIVATE BOT" }).click();
  await expect(page.getByText("PAYMENT PENDING")).toBeVisible();

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("button", { name: "LOG IN", exact: true })).toBeVisible();
  await page.getByLabel("Email").fill("binidriskoko@gmail.co");
  await page.getByLabel("Password").fill(ownerPassword);
  await page.getByRole("button", { name: "LOG IN", exact: true }).click();
  await page.getByRole("button", { name: "admin", exact: true }).click();
  const paymentRow = page.locator("tr").filter({ hasText: userEmail });
  await expect(paymentRow).toContainText("PENDING");
  await paymentRow.getByRole("button", { name: "APPROVE" }).click();
  await expect(paymentRow).toContainText("APPROVED");

  await page.getByRole("button", { name: "Log out" }).click();
  await logIn(page, userEmail, password);
  await page.getByRole("button", { name: "trading", exact: true }).click();
  await page.getByRole("button", { name: "ACTIVATE BOT" }).click();
  await page.getByRole("button", { name: "dashboard", exact: true }).click();
  await expect(page.getByText("ACTIVE", { exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByText("ACTIVE", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Log out" }).click();
  await logIn(page, userEmail, password);
  await expect(page.getByText("ACTIVE", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "trading", exact: true }).click();
  await page.getByRole("button", { name: "ACTIVATE BOT" }).click();
  await page.getByRole("button", { name: "dashboard", exact: true }).click();
  await expect(page.getByText("ACTIVE", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Log out" }).click();
  await logIn(page, "binidriskoko@gmail.co", ownerPassword);
  await page.getByRole("button", { name: "admin", exact: true }).click();
  const paymentReview = page.getByRole("heading", { name: "Bot Payment Review" }).locator("..");
  await expect(paymentReview.locator("tr").filter({ hasText: userEmail })).toHaveCount(1);
});