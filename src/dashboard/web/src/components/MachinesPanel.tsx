import { useDashboardStore } from '../stores/dashboard-store'
import type { ActiveRunnerInfo } from '../types'

interface MachineRow {
  readonly botId: string
  readonly label: string
  readonly hostname: string | null
  readonly online: boolean
  readonly runner: ActiveRunnerInfo | null
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

function MachineCard({ row }: { readonly row: MachineRow }) {
  const running = row.online && row.runner !== null
  const statusColor = !row.online
    ? 'var(--text-muted)'
    : running
      ? 'var(--accent-green)'
      : 'var(--accent-yellow)'

  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding: '16px',
      minWidth: '260px',
      boxShadow: 'var(--shadow)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: statusColor,
            display: 'inline-block',
            boxShadow: running ? `0 0 6px ${statusColor}` : 'none',
          }} />
          <span style={{ fontWeight: 600, fontSize: '16px' }}>{row.label}</span>
        </div>
        <span style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
          {!row.online ? 'offline' : running ? 'running' : 'idle'}
        </span>
      </div>

      {running && row.runner ? (
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          <div>📁 {row.runner.projectName}</div>
          <div>🔧 {row.runner.lastTool ?? 'thinking…'} · {row.runner.toolCount} tools</div>
          <div>⏱ {formatElapsed(row.runner.elapsedMs)} · {row.runner.model}</div>
        </div>
      ) : (
        <div style={{ color: 'var(--text-muted)', fontSize: '13px', fontStyle: 'italic' }}>
          {row.online ? 'idle — no task running' : 'agent disconnected'}
        </div>
      )}

      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        marginTop: '12px',
        paddingTop: '8px',
        borderTop: '1px solid var(--border)',
        fontSize: '12px',
        color: 'var(--text-secondary)',
      }}>
        <span>{row.hostname ?? row.label}</span>
        <span>via {row.botId}</span>
      </div>
    </div>
  )
}

export function MachinesPanel() {
  const bots = useDashboardStore((s) => s.bots)

  const rows: MachineRow[] = bots.flatMap((bot) =>
    bot.machines.map((m) => ({
      botId: bot.botId,
      label: m.label,
      hostname: m.hostname,
      online: bot.online,
      runner: bot.activeRunners.find((r) => r.machine === m.label) ?? null,
    }))
  )

  // No machines paired → hide the panel entirely (keeps the dashboard clean
  // for users who don't use remote machines).
  if (rows.length === 0) return null

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ fontSize: '18px' }}>Machines</h2>
        <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
          {rows.length} connected
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
        {rows.map((row) => (
          <MachineCard key={`${row.botId}:${row.label}`} row={row} />
        ))}
      </div>
    </div>
  )
}
