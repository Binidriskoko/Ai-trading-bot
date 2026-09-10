import assert from "node:assert/strict";
import test from "node:test";
import { isOwnerAccount, OWNER_EMAIL, signUp } from "../src/services/authService.js";

const resetStorage = () => {
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
};

test.beforeEach(resetStorage);

test("only the canonical owner email resolves as owner", () => {
  assert.equal(isOwnerAccount(OWNER_EMAIL), true);
  assert.equal(isOwnerAccount("BINIDRISKOKO@GMAIL.CO"), true);
  assert.equal(isOwnerAccount({ email: "owner@example.com", role: "admin" }), false);
  assert.equal(isOwnerAccount({ email: "ordinary@example.com", username: "admin" }), false);
});

test("signup role cannot be elevated by username", async () => {
  const account = await signUp({ username: "admin", email: "ordinary@example.com", password: "Ordinary1" });
  assert.equal(account.role, "user");
  assert.equal(isOwnerAccount(account), false);
});
