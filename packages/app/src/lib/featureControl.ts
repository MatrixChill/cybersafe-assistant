// ── Feature Control System ──
// Sistema escalável de permissões: accountType + plan

export const FEATURES = {
  // Dashboard
  DASHBOARD_BASIC: "dashboard_basic",
  DASHBOARD_ADVANCED: "dashboard_advanced",
  DASHBOARD_PRO: "dashboard_pro",
  
  // Threats
  THREATS: "threats",
  THREATS_HISTORY_EXPANDED: "threats_history_expanded",
  
  // Scanner
  SCANNER: "scanner",
  SCANNER_DEEP: "scanner_deep",
  SCANNER_CLOUD: "scanner_cloud",
  
  // Monitor
  MONITOR_BASIC: "monitor_basic",
  MONITOR_ADVANCED: "monitor_advanced",
  MONITOR_REALTIME: "monitor_realtime",
  
  // Simulator/Games
  SIMULATOR: "simulator",
  SIMULATOR_ALL: "simulator_all",
  
  // AI Assistant
  AI_ASSISTANT: "ai_assistant",
  AI_ASSISTANT_PRO: "ai_assistant_pro",
  AI_ASSISTANT_ADVANCED: "ai_assistant_advanced",
  
  // Reports
  REPORTS: "reports",
  REPORTS_ADVANCED: "reports_advanced",
  REPORTS_EXPORT: "reports_export",
  
  // Multi-device
  MULTI_DEVICE: "multi_device",
  DEVICE_MANAGEMENT: "device_management",
  
  // Logs
  DETAILED_LOGS: "detailed_logs",
  LOG_EXPORT: "log_export",
  
  // Core
  QUARANTINE: "quarantine",
  BEHAVIORAL_DETECTION: "behavioral_detection",
  AUTO_QUARANTINE: "auto_quarantine",
  
  // Security (Business only)
  USB_PROTECTION: "usb_protection",
  STARTUP_PROTECTION: "startup_protection",
  NETWORK_PROTECTION: "network_protection",
  
  // Notifications
  NOTIFICATIONS_ADVANCED: "notifications_advanced",
  NOTIFICATIONS_EMAIL: "notifications_email",
  
  // Support
  SUPPORT_PRIORITY: "support_priority",
} as const;

export type FeatureKey = (typeof FEATURES)[keyof typeof FEATURES];
export type AccountType = "personal" | "business";
export type PlanType = "free" | "pro" | "premium";

interface PlanDefinition {
  name: string;
  description: string;
  features: FeatureKey[];
  limits?: {
    maxDevices?: number;
    maxStorage?: number;
    scansPerDay?: number;
  };
}

export const PLANS: Record<PlanType, PlanDefinition> = {
  free: {
    name: "Free",
    description: "Proteção essencial para começar",
    features: [
      FEATURES.DASHBOARD_BASIC,
      FEATURES.THREATS,
      FEATURES.SCANNER,
      FEATURES.MONITOR_BASIC,
      FEATURES.SIMULATOR,
      FEATURES.AI_ASSISTANT,
      FEATURES.QUARANTINE,
    ],
    limits: { maxDevices: 1, scansPerDay: 3 }
  },
  pro: {
    name: "Pro",
    description: "Proteção avançada para uso pessoal",
    features: [
      FEATURES.DASHBOARD_ADVANCED,
      FEATURES.THREATS_HISTORY_EXPANDED,
      FEATURES.SCANNER_DEEP,
      FEATURES.MONITOR_REALTIME,
      FEATURES.SIMULATOR_ALL,
      FEATURES.AI_ASSISTANT_PRO,
      FEATURES.BEHAVIORAL_DETECTION,
      FEATURES.NOTIFICATIONS_ADVANCED,
      FEATURES.AUTO_QUARANTINE,
    ],
    limits: { maxDevices: 3, scansPerDay: -1 }
  },
  premium: {
    name: "Premium",
    description: "Proteção completa e suporte prioritário",
    features: [
      FEATURES.DASHBOARD_PRO,
      FEATURES.SCANNER_CLOUD,
      FEATURES.MONITOR_ADVANCED,
      FEATURES.AI_ASSISTANT_ADVANCED,
      FEATURES.REPORTS_EXPORT,
      FEATURES.LOG_EXPORT,
    ],
    limits: { maxDevices: -1, scansPerDay: -1 }
  }
};

const PERSONAL_SPECIFIC_FEATURES: FeatureKey[] = [
  FEATURES.AI_ASSISTANT_PRO,
  FEATURES.BEHAVIORAL_DETECTION,
  FEATURES.AUTO_QUARANTINE,
];

const BUSINESS_SPECIFIC_FEATURES: FeatureKey[] = [
  FEATURES.REPORTS,
  FEATURES.REPORTS_ADVANCED,
  FEATURES.MULTI_DEVICE,
  FEATURES.DEVICE_MANAGEMENT,
  FEATURES.DETAILED_LOGS,
  FEATURES.LOG_EXPORT,
  FEATURES.USB_PROTECTION,
  FEATURES.STARTUP_PROTECTION,
  FEATURES.NETWORK_PROTECTION,
  FEATURES.NOTIFICATIONS_EMAIL,
  FEATURES.SUPPORT_PRIORITY,
];

export function getUserFeatures(accountType: AccountType, plan: PlanType): FeatureKey[] {
  const planFeatures = PLANS[plan].features;
  const accountSpecific = accountType === "business" ? BUSINESS_SPECIFIC_FEATURES : PERSONAL_SPECIFIC_FEATURES;
  
  if (plan === "premium") {
    return [...planFeatures, ...accountSpecific, ...Object.values(FEATURES)];
  }
  if (plan === "pro") {
    return [...planFeatures, ...accountSpecific];
  }
  return planFeatures;
}

export function canAccess(feature: FeatureKey, accountType: AccountType, plan: PlanType): boolean {
  return getUserFeatures(accountType, plan).includes(feature);
}

export function getUserLimits(_accountType: AccountType, plan: PlanType) {
  return PLANS[plan].limits;
}

export function getPlanDisplayName(accountType: AccountType, plan: PlanType): string {
  if (plan === "free") return "Free";
  if (plan === "pro") return accountType === "business" ? "Business Pro" : "Personal Pro";
  if (plan === "premium") return accountType === "business" ? "Business Premium" : "Personal Premium";
  return "Unknown";
}

export function isUpgradeAvailable(fromPlan: PlanType, toPlan: PlanType): boolean {
  const order: PlanType[] = ["free", "pro", "premium"];
  return order.indexOf(toPlan) > order.indexOf(fromPlan);
}

export function getNextPlan(currentPlan: PlanType): PlanType | null {
  if (currentPlan === "free") return "pro";
  if (currentPlan === "pro") return "premium";
  return null;
}

export interface NavFeatureConfig {
  id: string;
  requiredFeature: FeatureKey;
  proOnly: boolean;
}

export const NAV_FEATURE_MAP: NavFeatureConfig[] = [
  { id: "dashboard", requiredFeature: FEATURES.DASHBOARD_BASIC, proOnly: false },
  { id: "threats", requiredFeature: FEATURES.THREATS, proOnly: false },
  { id: "scanner", requiredFeature: FEATURES.SCANNER, proOnly: false },
  { id: "monitor", requiredFeature: FEATURES.MONITOR_BASIC, proOnly: false },
  { id: "simulator", requiredFeature: FEATURES.SIMULATOR, proOnly: false },
  { id: "reports", requiredFeature: FEATURES.REPORTS, proOnly: true },
];

export type UserType = AccountType;
export type SubscriptionTier = PlanType;

// Legacy compatibility - convert old tier format to new accountType + plan
export function getUserFeaturesLegacy(tier: SubscriptionTier): FeatureKey[] {
  // Free = personal free, Pro = personal pro, Premium = business premium (simplified)
  const accountType: AccountType = tier === "premium" ? "business" : "personal";
  return getUserFeatures(accountType, tier);
}

export function canAccessLegacy(feature: FeatureKey, tier: SubscriptionTier): boolean {
  return getUserFeaturesLegacy(tier).includes(feature);
}

export function isProFeature(feature: FeatureKey): boolean {
  return !PLANS.free.features.includes(feature);
}

export function isBusinessFeature(feature: FeatureKey): boolean {
  return BUSINESS_SPECIFIC_FEATURES.includes(feature);
}
