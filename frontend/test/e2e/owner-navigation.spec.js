import { expect, test } from "@playwright/test";

test("canonical owner sees and opens the protected Admin Dashboard", async ({ page }) => {
  const password = "ExistingOwner1";
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.waitForTimeout(500);
  await page.getByLabel("Username").fill("existing-owner");
  await page.getByLabel("Email").fill("binidriskoko@gmail.co");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "CREATE DEMO ACCOUNT" }).click();
  await page.waitForTimeout(2000);
  if (await page.getByLabel("Email").isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Log in" }).click();
    await page.waitForTimeout(500);
    await page.getByLabel("Email").fill("binidriskoko@gmail.co");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "LOG IN", exact: true }).click();
  }
  await expect(page.getByRole("button", { name: "admin", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "admin", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Admin Dashboard" })).toBeVisible();
});
