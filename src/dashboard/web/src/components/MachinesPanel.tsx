import { useState } from 'react'
import { useDashboardStore } from '../stores/dashboard-store'
import { apiPost } from '../hooks/useApi'
import type { ActiveRunnerInfo, DashboardCommand } from '../types'

interface MachineRow {
  readonly botId: string
  readonly label: string
  readonly code: string
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

interface MachineCardProps {
  readonly row: MachineRow
  readonly selected: boolean
  readonly onToggle: () => void
}

function MachineCard({ row, selected, onToggle }: MachineCardProps) {
  const running = row.online && row.runner !== null
  const statusColor = !row.online
    ? 'var(--text-muted)'
    : running
      ? 'var(--accent-green)'
      : 'var(--accent-yellow)'

  return (
    <div style={{
      background: 'var(--bg-card)',
      border: selected ? '1px solid var(--accent-green)' : '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding: '16px',
      minWidth: '260px',
      boxShadow: 'var(--shadow)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            disabled={!row.online}
          />
          <span style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: statusColor,
            display: 'inline-block',
            boxShadow: running ? `0 0 6px ${statusColor}` : 'none',
          }} />
          <span style={{ fontWeight: 600, fontSize: '16px' }}>{row.label}</span>
        </label>
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
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [task, setTask] = useState('')
  const [sending, setSending] = useState(false)

  const rows: MachineRow[] = bots.flatMap((bot) =>
    bot.machines.map((m) => ({
      botId: bot.botId,
      label: m.label,
      code: m.code,
      hostname: m.hostname,
      online: bot.online,
      runner: bot.activeRunners.find((r) => r.machine === m.label) ?? null,
    }))
  )

  // No machines paired → hide the panel entirely.
  if (rows.length === 0) return null

  const toggle = (code: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  // Only keep selections that still refer to a live machine.
  const selectedRows = rows.filter((r) => selected.has(r.code))

  const dispatch = async () => {
    const prompt = task.trim()
    if (!prompt || selectedRows.length === 0 || sending) return
    setSending(true)
    try {
      // Fan out: one command per machine, routed to the bot that owns it.
      await Promise.all(
        selectedRows.map((row) =>
          apiPost<{ command: DashboardCommand }>('/api/commands', {
            targetBot: row.botId,
            type: 'dispatch_remote',
            payload: { prompt, code: row.code, label: row.label },
          }),
        ),
      )
      setTask('')
      setSelected(new Set())
    } catch {
      // silent for now
    } finally {
      setSending(false)
    }
  }

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
          <MachineCard
            key={`${row.botId}:${row.label}`}
            row={row}
            selected={selected.has(row.code)}
            onToggle={() => toggle(row.code)}
          />
        ))}
      </div>

      <div style={{
        display: 'flex',
        gap: '8px',
        marginTop: '16px',
        alignItems: 'flex-end',
      }}>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="任務（例：git clone <repo> && npm i && npm start）— 派發給勾選的機器"
          rows={2}
          style={{
            flex: 1,
            resize: 'vertical',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-primary)',
            padding: '8px 12px',
            fontSize: '14px',
            fontFamily: 'inherit',
          }}
        />
        <button
          onClick={dispatch}
          disabled={sending || selectedRows.length === 0 || task.trim() === ''}
          style={{
            background: selectedRows.length > 0 ? 'var(--accent-green)' : 'var(--bg-hover)',
            border: 'none',
            borderRadius: 'var(--radius)',
            color: '#fff',
            padding: '10px 16px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: selectedRows.length > 0 && !sending ? 'pointer' : 'not-allowed',
            whiteSpace: 'nowrap',
          }}
        >
          {sending ? '派發中…' : `派發到 ${selectedRows.length} 台`}
        </button>
      </div>
    </div>
  )
}
