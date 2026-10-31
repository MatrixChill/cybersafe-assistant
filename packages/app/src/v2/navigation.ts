import {
  LayoutDashboard,
  AlertTriangle,
  FileSearch,
  Activity,
  Zap,
  
  
  
  FileBarChart,
  
  ListTodo,
  Monitor,
  Wrench,
  Settings2,
  Network,
} from "lucide-react"
import {FEATURES,type FeatureKey} from '../lib/featureControl';
export type Page = "dashboard" | "pccenter" | "threats" | "quarantine" | "scanner" | "monitor" | "simulator" | "reports" | "taskmanager" | "otimizar" | "settings" | "business";
export const navGroups: { label: string; items: { id: Page; label: string; icon: typeof LayoutDashboard; feature: FeatureKey; proOnly: boolean; iconSize?: number; iconStrokeWidth?: number }[] }[] = [
  {
    label: "Painel",
    items: [
      { id: "dashboard", label: "Painel", icon: LayoutDashboard, feature: FEATURES.DASHBOARD_BASIC, proOnly: false },
    ],
  },
  {
    label: "Segurança",
    items: [
      { id: "scanner", label: "Análise de Segurança", icon: FileSearch, feature: FEATURES.SCANNER, proOnly: false },
      // A Quarentena passou a aba dentro de Ameaças: "Deteções" e "Quarentena"
      // são dois factos separados do mesmo domínio, não duas páginas do menu.
      // A rota "quarantine" continua a existir em App.tsx para os deep links
      // antigos (tray incluído) — cai na aba certa.
      { id: "threats", label: "Ameaças", icon: AlertTriangle, feature: FEATURES.THREATS, proOnly: false },
      // A página abre como "Monitor em Tempo Real". Id interno inalterado ("monitor"),
      // rota/deep link e storage inalterados (comportamento, nome de rota e chaves
      // de estado ficam onde estão). Só o rótulo do menu sai do ecrã.
      { id: "monitor", label: "Monitor em Tempo Real", icon: Activity, feature: FEATURES.MONITOR_BASIC, proOnly: false },
    ],
  },
  {
    label: "Computador",
    items: [
      { id: "pccenter", label: "PC Center", icon: Monitor, feature: FEATURES.DASHBOARD_BASIC, proOnly: false },
      { id: "taskmanager", label: "Gestor de Tarefas", icon: ListTodo, feature: FEATURES.MONITOR_BASIC, proOnly: false },
    ],
  },
  {
    label: "Ferramentas",
    items: [
      { id: "otimizar", label: "Otimizar", icon: Wrench, feature: FEATURES.DASHBOARD_BASIC, proOnly: false },
      // Raio ligeiramente maior/traco mais firme (pedido do utilizador: "parece pequeno").
      // Mesma arte Zap; o alvo de clique continua a ser o <button> inteiro.
      { id: "simulator", label: "Simulador", icon: Zap, feature: FEATURES.SIMULATOR, proOnly: false, iconSize: 20, iconStrokeWidth: 1.85 },
    ],
  },
  {
    label: "Definições",
    items: [
      { id: "settings", label: "Configurações", icon: Settings2, feature: FEATURES.DASHBOARD_BASIC, proOnly: false },
    ],
  },
  {
    label: "Experimental",
    items: [
      { id: "business", label: "Business Center", icon: Network, feature: FEATURES.BUSINESS_SECURITY_CENTER, proOnly: true },
      // Sem placa «PRO»: Relatórios deixou de depender do plano (é isolamento de
      // conta, `featureControl.canAccess`),
      // não há neste produto nenhum caminho para comprar `pro`/`premium`. Uma placa de tier
      // seria anunciar uma venda que não existe. A placa BUSINESS do item de cima descreve
      // a conta, não um preço, e fica.
      { id: "reports", label: "Relatórios", icon: FileBarChart, feature: FEATURES.REPORTS, proOnly: false },
    ],
  },
];




