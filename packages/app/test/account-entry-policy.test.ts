import assert from "node:assert/strict";
import { test } from "node:test";
import { accountEntrySurface } from "../src/lib/accountEntryPolicy";

test("generic editions maintain the loading and login gates", () => {
  assert.equal(accountEntrySurface("required", true, false, false), "loading");
  assert.equal(accountEntrySurface("required", false, false, false), "account");
  assert.equal(accountEntrySurface("required", false, true, false), "app");
});

test("Nigor opens locally, offers voluntary login, and returns to local use after logout", () => {
  assert.equal(accountEntrySurface("local-optional", false, false, false), "app");
  assert.equal(accountEntrySurface("local-optional", false, false, true), "account");
  assert.equal(accountEntrySurface("local-optional", false, true, true), "app");
  assert.equal(accountEntrySurface("local-optional", false, false, false), "app");
});
