import { useDashboardStore } from '../stores/dashboard-store'
import { useChatStore } from '../stores/chat-store'
import { useTranslation } from '../hooks/useTranslation'
import { ModelSelector } from './ModelSelector'
import { QuickActions } from './QuickActions'
import { PromptTemplates } from './PromptTemplates'
import type { ActiveView } from '../stores/dashboard-store'
import type { BotHeartbeat, ProjectInfo } from '../types'

const VIEW_TABS: readonly { readonly id: ActiveView; readonly zh: string; readonly en: string }[] = [
  { id: 'chat', zh: 'Chat', en: 'Chat' },
  { id: 'dashboard', zh: 'Monitor', en: 'Monitor' },
]

export function Sidebar() {
  const { t } = useTranslation()
  const bots = useDashboardStore((s) => s.bots)
  const projects = useDashboardStore((s) => s.projects)
  const selectedBotId = useDashboardStore((s) => s.selectedBotId)
  const setSelectedBotId = useDashboardStore((s) => s.setSelectedBotId)
  const activeView = useDashboardStore((s) => s.activeView)
  const setActiveView = useDashboardStore((s) => s.setActiveView)
  const setChannel = useChatStore((s) => s.setChannel)

  return (
    <aside style={{
      width: 'var(--sidebar-width)',
      background: 'var(--bg-secondary)',
      borderRight: '1px solid var(--border)',
      height: '100vh',
      overflowY: 'auto',
      flexShrink: 0,
      padding: '12px 0',
    }}>
      {/* View switcher tabs */}
      <div style={{
        display: 'flex',
        margin: '0 12px 12px',
        background: 'var(--bg-primary)',
        borderRadius: 'var(--radius)',
        padding: '3px',
      }}>
        {VIEW_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveView(tab.id)}
            style={{
              flex: 1,
              padding: '6px 0',
              fontSize: '12px',
              fontWeight: 600,
              border: 'none',
              borderRadius: '5px',
              cursor: 'pointer',
              background: activeView === tab.id ? 'var(--accent-blue)' : 'transparent',
              color: activeView === tab.id ? '#fff' : 'var(--text-secondary)',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            {tab.en}
          </button>
        ))}
      </div>

      <SidebarSection title={t('sidebar.bots')}>
        {bots.map((bot) => (
          <BotItem
            key={bot.botId}
            bot={bot}
            selected={selectedBotId === bot.botId}
            onClick={() => setSelectedBotId(
              selectedBotId === bot.botId ? null : bot.botId
            )}
          />
        ))}
        {bots.length === 0 && (
          <div style={{ padding: '4px 16px', color: 'var(--text-muted)', fontSize: '12px' }}>
            {t('sidebar.noBots')}
          </div>
        )}
      </SidebarSection>

      <SidebarSection title={activeView === 'chat' ? t('sidebar.channels') : t('sidebar.projects')}>
        {projects.map((project) => (
          <ProjectItem
            key={project.path}
            project={project}
            chatMode={activeView === 'chat'}
            onSelectChannel={() => {
              setChannel(project.name)
              setActiveView('chat')
            }}
          />
        ))}
      </SidebarSection>

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
        <PromptTemplates />
        <ModelSelector />
        <QuickActions />
      </div>
    </aside>
  )
}

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '16px' }}>
      <div style={{
        padding: '4px 16px',
        fontSize: '11px',
        fontWeight: 600,
        color: 'var(--text-muted)',
        letterSpacing: '0.5px',
        textTransform: 'uppercase',
      }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function BotItem({
  bot,
  selected,
  onClick,
}: {
  bot: BotHeartbeat
  selected: boolean
  onClick: () => void
}) {
  const isActive = bot.activeRunners.length > 0
  const dotColor = !bot.online
    ? 'var(--text-muted)'
    : isActive
      ? 'var(--accent-green)'
      : 'var(--accent-yellow)'

  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '6px 16px',
        border: 'none',
        background: selected ? 'var(--bg-hover)' : 'transparent',
        color: 'var(--text-primary)',
        cursor: 'pointer',
        fontSize: '13px',
        textAlign: 'left',
      }}
    >
      <span style={{
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        background: dotColor,
        flexShrink: 0,
      }} />
      <span>{bot.botId}</span>
      {bot.queueLength > 0 && (
        <span style={{
          marginLeft: 'auto',
          fontSize: '11px',
          background: 'var(--bg-hover)',
          padding: '1px 6px',
          borderRadius: '4px',
          color: 'var(--text-secondary)',
        }}>
          {bot.queueLength}
        </span>
      )}
    </button>
  )
}

function ProjectItem({
  project,
  chatMode,
  onSelectChannel,
}: {
  project: ProjectInfo
  chatMode: boolean
  onSelectChannel: () => void
}) {
  const setSelectedProjectPath = useDashboardStore((s) => s.setSelectedProjectPath)
  const selectedProjectPath = useDashboardStore((s) => s.selectedProjectPath)
  const selectedChannel = useChatStore((s) => s.selectedChannel)

  const selected = chatMode
    ? selectedChannel === project.name
    : selectedProjectPath === project.path

  const handleClick = () => {
    if (chatMode) {
      onSelectChannel()
    } else {
      setSelectedProjectPath(selected ? null : project.path)
    }
  }

  return (
    <button
      onClick={handleClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '6px 16px',
        border: 'none',
        background: selected ? 'var(--bg-hover)' : 'transparent',
        color: 'var(--text-primary)',
        cursor: 'pointer',
        fontSize: '13px',
        textAlign: 'left',
      }}
    >
      <span>{chatMode ? '#' : ''}{project.name}</span>
      {project.lockHolder && (
        <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--accent-yellow)' }}>
          {'\u{1F512}'}
        </span>
      )}
    </button>
  )
}
