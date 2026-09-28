import { test } from "node:test";
import assert from "node:assert/strict";
import { canAccess, canUserAccess, FEATURES, isBusinessFeature } from "../src/lib/featureControl";

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

test("Business Security Center — matriz accountType × plan × role", () => {
  // Personal normal nunca vê, em nenhum plano
  assert.ok(!canAccess(FEATURES.BUSINESS_SECURITY_CENTER, "personal", "free", "user"));
  assert.ok(!canAccess(FEATURES.BUSINESS_SECURITY_CENTER, "personal", "pro", "user"));
  assert.ok(!canAccess(FEATURES.BUSINESS_SECURITY_CENTER, "personal", "premium", "user"));
  // Business vê em todos os planos
  assert.ok(canAccess(FEATURES.BUSINESS_SECURITY_CENTER, "business", "free", "user"));
  assert.ok(canAccess(FEATURES.BUSINESS_SECURITY_CENTER, "business", "pro", "user"));
  assert.ok(canAccess(FEATURES.BUSINESS_SECURITY_CENTER, "business", "premium", "user"));
  // Admin vê mesmo sendo uma conta personal
  assert.ok(canAccess(FEATURES.BUSINESS_SECURITY_CENTER, "personal", "premium", "admin"));
  assert.ok(canAccess(FEATURES.BUSINESS_SECURITY_CENTER, "business", "free", "admin"));
});

test("role por omissão é 'user' (chamadas de 3 argumentos continuam a comportar-se como antes)", () => {
  assert.ok(!canAccess(FEATURES.BUSINESS_SECURITY_CENTER, "personal", "premium"));
  assert.ok(canAccess(FEATURES.BUSINESS_SECURITY_CENTER, "business", "free"));
});

test("role admin não desbloqueia outras features business para contas personal", () => {
  assert.ok(!canAccess(FEATURES.USB_PROTECTION, "personal", "free", "admin"));
  assert.ok(!canAccess(FEATURES.REPORTS, "personal", "free", "admin"));
  assert.ok(!canAccess(FEATURES.DEVICE_MANAGEMENT, "personal", "pro", "admin"));
});

test("canUserAccess usa a mesma regra com fallbacks defensivos", () => {
  // Sem utilizador (login pendente) → nada acessível além do que o default permite
  assert.ok(!canUserAccess(FEATURES.BUSINESS_SECURITY_CENTER, null));
  assert.ok(!canUserAccess(FEATURES.BUSINESS_SECURITY_CENTER, undefined));
  // Payload antigo sem role → tratado como "user"
  assert.ok(!canUserAccess(FEATURES.BUSINESS_SECURITY_CENTER, { type: "personal", plan: "premium" }));
  assert.ok(canUserAccess(FEATURES.BUSINESS_SECURITY_CENTER, { type: "business", plan: "free" }));
  // Admin personal vê; business pro continua a ver reports (regra por plano intacta)
  assert.ok(canUserAccess(FEATURES.BUSINESS_SECURITY_CENTER, { type: "personal", plan: "premium", role: "admin" }));
  assert.ok(canUserAccess(FEATURES.REPORTS, { type: "business", plan: "pro", role: "user" }));
  assert.ok(!canUserAccess(FEATURES.REPORTS, { type: "business", plan: "free", role: "user" }));
});

// ─── Entitlement premium-leak regression tests ────────────────────────────────

test("personal premium DOES NOT get business-only features (USB_PROTECTION, REPORTS, DEVICE_MANAGEMENT)", () => {
  // Before the fix, personal premium got Object.values(FEATURES) which includes
  // all BUSINESS_SPECIFIC_FEATURES — this was the leak.
  assert.ok(!canAccess(FEATURES.USB_PROTECTION, "personal", "premium"),
    "personal premium must not have USB_PROTECTION");
  assert.ok(!canAccess(FEATURES.REPORTS, "personal", "premium"),
    "personal premium must not have REPORTS");
  assert.ok(!canAccess(FEATURES.DEVICE_MANAGEMENT, "personal", "premium"),
    "personal premium must not have DEVICE_MANAGEMENT");
  assert.ok(!canAccess(FEATURES.REPORTS_ADVANCED, "personal", "premium"),
    "personal premium must not have REPORTS_ADVANCED");
  assert.ok(!canAccess(FEATURES.MULTI_DEVICE, "personal", "premium"),
    "personal premium must not have MULTI_DEVICE");
  assert.ok(!canAccess(FEATURES.DETAILED_LOGS, "personal", "premium"),
    "personal premium must not have DETAILED_LOGS");
  assert.ok(!canAccess(FEATURES.NOTIFICATIONS_EMAIL, "personal", "premium"),
    "personal premium must not have NOTIFICATIONS_EMAIL");
  assert.ok(!canAccess(FEATURES.SUPPORT_PRIORITY, "personal", "premium"),
    "personal premium must not have SUPPORT_PRIORITY");
  assert.ok(!canAccess(FEATURES.STARTUP_PROTECTION, "personal", "premium"),
    "personal premium must not have STARTUP_PROTECTION");
  assert.ok(!canAccess(FEATURES.NETWORK_PROTECTION, "personal", "premium"),
    "personal premium must not have NETWORK_PROTECTION");
});

test("business premium has all features including business-specific ones", () => {
  // Business premium should get everything via accountSpecific + the full spread
  assert.ok(canAccess(FEATURES.USB_PROTECTION, "business", "premium"),
    "business premium must have USB_PROTECTION");
  assert.ok(canAccess(FEATURES.REPORTS, "business", "premium"),
    "business premium must have REPORTS");
  assert.ok(canAccess(FEATURES.DEVICE_MANAGEMENT, "business", "premium"),
    "business premium must have DEVICE_MANAGEMENT");
  assert.ok(canAccess(FEATURES.REPORTS_ADVANCED, "business", "premium"),
    "business premium must have REPORTS_ADVANCED");
  assert.ok(canAccess(FEATURES.MULTI_DEVICE, "business", "premium"),
    "business premium must have MULTI_DEVICE");
  assert.ok(canAccess(FEATURES.DETAILED_LOGS, "business", "premium"),
    "business premium must have DETAILED_LOGS");
  assert.ok(canAccess(FEATURES.NOTIFICATIONS_EMAIL, "business", "premium"),
    "business premium must have NOTIFICATIONS_EMAIL");
  assert.ok(canAccess(FEATURES.SUPPORT_PRIORITY, "business", "premium"),
    "business premium must have SUPPORT_PRIORITY");
  // Plus premium-plan features
  assert.ok(canAccess(FEATURES.SCANNER_CLOUD, "business", "premium"),
    "business premium must have SCANNER_CLOUD");
  assert.ok(canAccess(FEATURES.DASHBOARD_PRO, "business", "premium"),
    "business premium must have DASHBOARD_PRO");
});

test("personal premium still keeps its own premium + personal features (no regression)", () => {
  // Personal premium should retain its own plan features and personal-specific features
  assert.ok(canAccess(FEATURES.SCANNER_CLOUD, "personal", "premium"),
    "personal premium must retain SCANNER_CLOUD (premium plan feature)");
  assert.ok(canAccess(FEATURES.DASHBOARD_PRO, "personal", "premium"),
    "personal premium must retain DASHBOARD_PRO (premium plan feature)");
  assert.ok(canAccess(FEATURES.AI_ASSISTANT_ADVANCED, "personal", "premium"),
    "personal premium must retain AI_ASSISTANT_ADVANCED (premium plan feature)");
  assert.ok(canAccess(FEATURES.AI_ASSISTANT_PRO, "personal", "premium"),
    "personal premium must retain AI_ASSISTANT_PRO (personal-specific feature)");
  assert.ok(canAccess(FEATURES.BEHAVIORAL_DETECTION, "personal", "premium"),
    "personal premium must retain BEHAVIORAL_DETECTION (personal-specific feature)");
  // Non-business premium features from all-features spread
  assert.ok(canAccess(FEATURES.SCANNER, "personal", "premium"),
    "personal premium must retain SCANNER");
  assert.ok(canAccess(FEATURES.THREATS, "personal", "premium"),
    "personal premium must retain THREATS");
});

test("free and pro plan access is unchanged by the premium fix", () => {
  // Free plan: only base features
  assert.ok(!canAccess(FEATURES.USB_PROTECTION, "personal", "free"),
    "personal free must not have USB_PROTECTION");
  assert.ok(!canAccess(FEATURES.REPORTS, "personal", "free"),
    "personal free must not have REPORTS");
  assert.ok(!canAccess(FEATURES.SCANNER_DEEP, "personal", "free"),
    "personal free must not have SCANNER_DEEP");
  // Pro plan: plan features + personal-specific, no business-specific
  assert.ok(!canAccess(FEATURES.USB_PROTECTION, "personal", "pro"),
    "personal pro must not have USB_PROTECTION");
  assert.ok(!canAccess(FEATURES.REPORTS, "personal", "pro"),
    "personal pro must not have REPORTS");
  assert.ok(canAccess(FEATURES.SCANNER_DEEP, "personal", "pro"),
    "personal pro must have SCANNER_DEEP (pro plan feature)");
  assert.ok(canAccess(FEATURES.AI_ASSISTANT_PRO, "personal", "pro"),
    "personal pro must have AI_ASSISTANT_PRO (personal-specific)");
  // Business pro: gets BUSINESS_SPECIFIC_FEATURES
  assert.ok(canAccess(FEATURES.REPORTS, "business", "pro"),
    "business pro must have REPORTS (business-specific)");
  assert.ok(!canAccess(FEATURES.REPORTS, "business", "free"),
    "business free must NOT have REPORTS");
});
