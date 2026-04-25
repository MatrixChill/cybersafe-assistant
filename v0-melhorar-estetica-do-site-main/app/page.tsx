"use client"

import { useState, useEffect } from "react"
import { Sidebar } from "@/components/sidebar"
import { Dashboard } from "@/components/dashboard"
import { ThreatsPage } from "@/components/threats-page"
import { FileScannerPage } from "@/components/file-scanner-page"
import { MonitorPage } from "@/components/monitor-page"
import { SimulatorPage } from "@/components/simulator-page"

export default function Home() {
  const [activeTab, setActiveTab] = useState("dashboard")
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return null
  }

  const renderContent = () => {
    switch (activeTab) {
      case "dashboard":
        return <Dashboard />
      case "threats":
        return <ThreatsPage />
      case "scanner":
        return <FileScannerPage />
      case "monitor":
        return <MonitorPage />
      case "simulator":
        return <SimulatorPage />
      default:
        return <Dashboard />
    }
  }

  return (
    <div className="min-h-screen bg-background cyber-grid hex-pattern relative overflow-hidden">
      {/* Ambient Glow Effects */}
      <div className="fixed top-0 left-1/4 w-96 h-96 bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      <div className="fixed bottom-0 right-1/4 w-80 h-80 bg-cyber-cyan/5 rounded-full blur-3xl pointer-events-none" />
      
      <div className="flex min-h-screen relative z-10">
        <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />
        <main className="flex-1 overflow-auto">
          {renderContent()}
        </main>
      </div>
    </div>
  )
}
