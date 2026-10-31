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
  
  // Business Security Center
  BUSINESS_SECURITY_CENTER: "business_security_center",

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
export type Role = "user" | "admin";

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
  FEATURES.BUSINESS_SECURITY_CENTER,
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
    // Include all features EXCEPT business-specific ones for non-business accounts.
    // BUSINESS_SPECIFIC_FEATURES are already in accountSpecific for business accounts,
    // so filtering them out of the spread prevents personal-premium from leaking them.
    const allFeatures = (Object.values(FEATURES) as FeatureKey[]).filter(
      (f) => accountType === "business" || !BUSINESS_SPECIFIC_FEATURES.includes(f)
    );
    return [...new Set([...planFeatures, ...accountSpecific, ...allFeatures])];
  }
  if (plan === "pro") {
    // Compatibilidade, não bónus: o `pro` foi escrito como lista fechada, por isso
    // um titular legado de `pro` PERDIA o essencial do `free` — `canAccess(SCANNER,
    // "personal", "pro")` era `false` e a sidebar escondia-lhe a Análise de
    // Segurança, o PC Center e as Ameaças (medido a 13/10: SCANNER, THREATS,
    // DASHBOARD_BASIC, MONITOR_BASIC, QUARANTINE e AI_ASSISTANT todos `false` em
    // `pro`). Não é de somar entitlements futuros: é a base gratuita continuar a
    // base gratuita quando o plano sobe. As negações de negócio (USB_PROTECTION,
    // REPORTS, DEVICE_MANAGEMENT para `personal`) ficam como estavam porque a
    // lista somada é apenas `PLANS.free.features`.
    return [...new Set([...PLANS.free.features, ...planFeatures, ...accountSpecific])];
  }
  return planFeatures;
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
  { id: "business", requiredFeature: FEATURES.BUSINESS_SECURITY_CENTER, proOnly: true },
];

export type UserType = AccountType;
export type SubscriptionTier = PlanType;

// Legacy compatibility - convert old tier format to new accountType + plan
export function getUserFeaturesLegacy(tier: SubscriptionTier): FeatureKey[] {
  // Free = personal free, Pro = personal pro, Premium = business premium (simplified)
  const accountType: AccountType = tier === "premium" ? "business" : "personal";
  return getUserFeatures(accountType, tier);
}

export function isProFeature(feature: FeatureKey): boolean {
  return !PLANS.free.features.includes(feature);
}

export function isBusinessFeature(feature: FeatureKey): boolean {
  return BUSINESS_SPECIFIC_FEATURES.includes(feature);
}

export function canAccess(feature: FeatureKey, accountType: AccountType, plan: PlanType, role: Role = "user"): boolean {
  // Business Security Center básico é associado ao ACCOUNT TYPE, não ao plano.
  // Qualquer conta Business — incluindo o plano free — pode aceder.
  // Contas Personal não podem aceder, independentemente do plano.
  // Exceção: role "admin" também acede (ex. conta de desenvolvimento),
  // sem deixar de ser uma conta Personal.
  if (feature === FEATURES.BUSINESS_SECURITY_CENTER) {
    return accountType === "business" || role === "admin";
  }
  // REPORTS obedece à MESMA razão do centro de empresa, desde 13/10: é
  // isolamento de CONTA, não preço. Antes dependia só do plano, e esta edição
  // não sabe atribuir planos — `POST /auth/register` ignora `plan` e nasce
  // `free` (`packages/api/src/index.ts:322-325`), não existe mutation de conta
  // que mude plano, e `getNextPlan`/`isUpgradeAvailable`/`getUserLimits`/
  // `isProFeature`/`NAV_FEATURE_MAP` não têm um único consumidor em
  // `packages/app/src`. Uma conta de empresa criada hoje não podia abrir o
  // relatório do Painel de Relatórios — um paywall sem porta.
  // Não alarga nada: `personal` continua sem REPORTS em qualquer plano e
  // qualquer role, e REPORTS_ADVANCED / USB_PROTECTION / DEVICE_MANAGEMENT
  // ficam exatamente como estavam.
  if (feature === FEATURES.REPORTS) {
    return accountType === "business";
  }
  return getUserFeatures(accountType, plan).includes(feature);
}

export interface FeatureAccessUser {
  type: AccountType;
  plan: PlanType;
  role?: Role;
}

// Fonte de verdade única usada por Sidebar e App: deriva accountType/plan/role
// do utilizador autenticado, com fallbacks defensivos para payloads antigos.
export function canUserAccess(feature: FeatureKey, user: FeatureAccessUser | null | undefined): boolean {
  return canAccess(feature, user?.type ?? "personal", user?.plan ?? "free", user?.role ?? "user");
}

export function canAccessLegacy(feature: FeatureKey, tier: SubscriptionTier): boolean {
  return getUserFeaturesLegacy(tier).includes(feature);
}
