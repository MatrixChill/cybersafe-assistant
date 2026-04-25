"use client"

import { Shield, LayoutDashboard, AlertTriangle, FileSearch, Activity, Zap, ChevronLeft, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { useState } from "react"

interface SidebarProps {
  activeTab: string
  setActiveTab: (tab: string) => void
}

const navItems = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "threats", label: "Ameaças", icon: AlertTriangle },
  { id: "scanner", label: "File Scanner", icon: FileSearch },
  { id: "monitor", label: "Monitor", icon: Activity },
  { id: "simulator", label: "Simulador", icon: Zap },
]

export function Sidebar({ activeTab, setActiveTab }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <aside 
      className={cn(
        "bg-sidebar border-r border-sidebar-border flex flex-col transition-all duration-300 relative",
        collapsed ? "w-20" : "w-64"
      )}
    >
      {/* Decorative top line */}
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent" />
      
      {/* Logo Section */}
      <div className="p-6 border-b border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center cyber-border">
              <Shield className="w-6 h-6 text-primary cyber-glow-text" />
            </div>
            {/* Pulse indicator */}
            <div className="absolute -top-1 -right-1 w-3 h-3 bg-cyber-green rounded-full cyber-pulse">
              <div className="absolute inset-0 bg-cyber-green rounded-full animate-ping opacity-75" />
            </div>
          </div>
          {!collapsed && (
            <div className="flex flex-col">
              <span className="font-mono text-lg font-bold tracking-tight text-foreground">
                CYBER<span className="text-primary">SAFE</span>
              </span>
              <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-mono">
                Security Assistant
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-2">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = activeTab === item.id
          
          return (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 group relative overflow-hidden",
                isActive 
                  ? "bg-primary/10 text-primary cyber-border" 
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
              )}
            >
              {/* Active indicator line */}
              {isActive && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r-full" />
              )}
              
              <Icon className={cn(
                "w-5 h-5 transition-all",
                isActive && "cyber-glow-text"
              )} />
              
              {!collapsed && (
                <span className="font-medium text-sm">{item.label}</span>
              )}
              
              {/* Hover glow effect */}
              <div className={cn(
                "absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none",
                "bg-gradient-to-r from-primary/5 to-transparent"
              )} />
            </button>
          )
        })}
      </nav>

      {/* Collapse Toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-6 bg-secondary border border-border rounded-full flex items-center justify-center hover:bg-primary/20 hover:border-primary/50 transition-all"
      >
        {collapsed ? (
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronLeft className="w-4 h-4 text-muted-foreground" />
        )}
      </button>

      {/* Status Section */}
      <div className={cn("p-4 border-t border-sidebar-border", collapsed && "px-2")}>
        <div className={cn(
          "bg-cyber-green/10 border border-cyber-green/30 rounded-lg p-3",
          collapsed && "p-2"
        )}>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-cyber-green rounded-full cyber-pulse" />
            {!collapsed && (
              <span className="text-xs font-mono text-cyber-green uppercase tracking-wider">
                Sistema Online
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Version info */}
      {!collapsed && (
        <div className="p-4 pt-0">
          <div className="text-[10px] font-mono text-muted-foreground/50 text-center">
            v2.4.1 • Build 2026.03
          </div>
        </div>
      )}
    </aside>
  )
}
