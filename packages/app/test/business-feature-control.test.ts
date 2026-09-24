import { test } from "node:test";
import assert from "node:assert/strict";
import { canAccess, FEATURES, isBusinessFeature } from "../src/lib/featureControl";

test("Business account can access BUSINESS_SECURITY_CENTER on free, pro and premium", () => {
  // Business Security Center basic is tied to ACCOUNT TYPE, not plan
  assert.ok(canAccess(FEATURES.BUSINESS_SECURITY_CENTER, "business", "free"));
  assert.ok(canAccess(FEATURES.BUSINESS_SECURITY_CENTER, "business", "pro"));
  assert.ok(canAccess(FEATURES.BUSINESS_SECURITY_CENTER, "business", "premium"));
});

test("Personal account CANNOT access BUSINESS_SECURITY_CENTER on any plan", () => {
  // Business center is a Business-account feature, not granted by paid plans
  assert.ok(!canAccess(FEATURES.BUSINESS_SECURITY_CENTER, "personal", "free"));
  assert.ok(!canAccess(FEATURES.BUSINESS_SECURITY_CENTER, "personal", "pro"));
  assert.ok(!canAccess(FEATURES.BUSINESS_SECURITY_CENTER, "personal", "premium"));
});

test("BUSINESS_SECURITY_CENTER is classified as business feature", () => {
  assert.ok(isBusinessFeature(FEATURES.BUSINESS_SECURITY_CENTER));
});

test("Existing base features are not affected by the new rule", () => {
  // Basic features available to all accounts
  assert.ok(canAccess(FEATURES.DASHBOARD_BASIC, "personal", "free"));
  assert.ok(canAccess(FEATURES.SCANNER, "personal", "free"));
  assert.ok(canAccess(FEATURES.THREATS, "personal", "free"));
  assert.ok(canAccess(FEATURES.DASHBOARD_BASIC, "business", "free"));

  // Scanner is on the free plan for everyone (plan-based)
  assert.ok(canAccess(FEATURES.SCANNER, "business", "free"));
});

test("Paid-plan features remain plan-gated (not account-type gated)", () => {
  // SCANNER_DEEP is pro-only, for both personal and business free
  assert.ok(!canAccess(FEATURES.SCANNER_DEEP, "personal", "free"));
  assert.ok(!canAccess(FEATURES.SCANNER_DEEP, "business", "free"));
  assert.ok(canAccess(FEATURES.SCANNER_DEEP, "personal", "pro"));
  assert.ok(canAccess(FEATURES.SCANNER_DEEP, "business", "pro"));
});
