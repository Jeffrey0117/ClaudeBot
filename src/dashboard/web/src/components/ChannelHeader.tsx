import { useDashboardStore } from '../stores/dashboard-store'
import { useChatStore } from '../stores/chat-store'
import { useTranslation } from '../hooks/useTranslation'

const BOT_OPTIONS = ['any', 'main', 'bot2', 'bot3', 'bot4'] as const

export function ChannelHeader() {
  const { t } = useTranslation()
  const projects = useDashboardStore((s) => s.projects)
  const bots = useDashboardStore((s) => s.bots)
  const selectedChannel = useChatStore((s) => s.selectedChannel)
  const setChannel = useChatStore((s) => s.setChannel)
  const targetBot = useChatStore((s) => s.targetBot)
  const setTargetBot = useChatStore((s) => s.setTargetBot)

  const activeRunnerCount = bots.reduce((acc, b) => {
    if (!b.online) return acc
    return acc + b.activeRunners.filter((r) => r.projectName === selectedChannel).length
  }, 0)

  const queueCount = bots.reduce((acc, b) => {
    if (!b.online || !selectedChannel) return acc
    return acc + (b.queueByProject[selectedChannel] ?? 0)
  }, 0)

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      padding: '10px 16px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--bg-secondary)',
      flexShrink: 0,
    }}>
      <select
        value={selectedChannel ?? ''}
        onChange={(e) => setChannel(e.target.value || null)}
        style={{
          padding: '6px 10px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          color: 'var(--text-primary)',
          fontSize: '14px',
          fontWeight: 600,
        }}
      >
        <option value="">{t('sidebar.projects')}</option>
        {projects.map((p) => (
          <option key={p.path} value={p.name}>#{p.name}</option>
        ))}
      </select>

      <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
        Runners: {activeRunnerCount} | Queue: {queueCount}
      </span>

      <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px' }}>
        {BOT_OPTIONS.map((botId) => (
          <button
            key={botId}
            onClick={() => setTargetBot(botId === 'any' ? null : botId)}
            style={{
              padding: '4px 10px',
              fontSize: '12px',
              fontWeight: 600,
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              background: (targetBot === botId || (botId === 'any' && targetBot === null))
                ? 'var(--accent-blue)'
                : 'var(--bg-card)',
              color: (targetBot === botId || (botId === 'any' && targetBot === null))
                ? '#fff'
                : 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            @{botId}
          </button>
        ))}
      </div>
    </div>
  )
}
