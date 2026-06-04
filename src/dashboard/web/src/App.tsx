import { useEffect } from 'react'
import { Layout } from './components/Layout'
import { MachinesPanel } from './components/MachinesPanel'
import { ChatPanel } from './components/ChatPanel'
import { useWebSocket } from './hooks/useWebSocket'
import { useDashboardStore } from './stores/dashboard-store'
import { apiFetch } from './hooks/useApi'
import type { ProjectInfo } from './types'

export function App() {
  useWebSocket()

  const setProjects = useDashboardStore((s) => s.setProjects)
  const setCommands = useDashboardStore((s) => s.setCommands)
  const activeView = useDashboardStore((s) => s.activeView)

  useEffect(() => {
    apiFetch<{ projects: readonly ProjectInfo[] }>('/api/projects')
      .then((data) => setProjects(data.projects))
      .catch(() => {})

    // Refresh projects every 10s
    const interval = setInterval(() => {
      apiFetch<{ projects: readonly ProjectInfo[] }>('/api/projects')
        .then((data) => setProjects(data.projects))
        .catch(() => {})
    }, 10_000)

    return () => clearInterval(interval)
  }, [setProjects])

  useEffect(() => {
    apiFetch<{ commands: readonly import('./types').DashboardCommand[] }>('/api/commands')
      .then((data) => setCommands([...data.commands]))
      .catch(() => {})
  }, [setCommands])

  return (
    <Layout>
      {activeView === 'chat' ? <ChatPanel /> : <MachinesPanel />}
    </Layout>
  )
}
