import { useState, useEffect } from 'react'
import { useDashboardStore } from '../stores/dashboard-store'
import { useDispatchStore, type DispatchTask } from '../stores/dispatch-store'
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
  readonly index: number
  readonly onToggle: () => void
}

function MachineCard({ row, selected, index, onToggle }: MachineCardProps) {
  const running = row.online && row.runner !== null
  const status = !row.online ? 'offline' : running ? 'running' : 'idle'
  const statusColor =
    status === 'offline' ? 'var(--text-muted)'
    : status === 'running' ? 'var(--accent)'
    : 'var(--accent-yellow)'
  const statusLabel = status === 'offline' ? '離線' : status === 'running' ? '執行中' : '待命'

  return (
    <button
      onClick={row.online ? onToggle : undefined}
      disabled={!row.online}
      style={{
        position: 'relative',
        textAlign: 'left',
        appearance: 'none',
        font: 'inherit',
        background: selected ? 'var(--accent-soft)' : 'var(--bg-card)',
        border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 'var(--radius)',
        padding: '18px 18px 14px',
        cursor: row.online ? 'pointer' : 'default',
        opacity: row.online ? 1 : 0.6,
        boxShadow: selected ? 'var(--shadow-lift)' : 'var(--shadow)',
        transition: 'transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s, background 0.18s',
        animation: `riseIn 0.4s ease both`,
        animationDelay: `${Math.min(index * 50, 400)}ms`,
      }}
      onMouseEnter={(e) => { if (row.online) e.currentTarget.style.transform = 'translateY(-2px)' }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)' }}
    >
      {/* selection check */}
      <span style={{
        position: 'absolute',
        top: '14px',
        right: '14px',
        width: '22px',
        height: '22px',
        borderRadius: '50%',
        border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
        background: selected ? 'var(--accent)' : 'transparent',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '13px',
        lineHeight: 1,
      }}>
        {selected ? '✓' : ''}
      </span>

      <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '12px', paddingRight: '28px' }}>
        <span style={{
          width: '9px', height: '9px', borderRadius: '50%', background: statusColor,
          boxShadow: running ? `0 0 0 4px color-mix(in srgb, ${statusColor} 18%, transparent)` : 'none',
          flexShrink: 0,
        }} />
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '17px' }}>{row.label}</span>
        <span style={{
          marginLeft: 'auto',
          fontSize: '11px',
          fontWeight: 600,
          color: statusColor,
          background: `color-mix(in srgb, ${statusColor} 12%, transparent)`,
          padding: '2px 9px',
          borderRadius: '999px',
        }}>{statusLabel}</span>
      </div>

      {running && row.runner ? (
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <div>📁 {row.runner.projectName}</div>
          <div>🔧 {row.runner.lastTool ?? '思考中…'} · {row.runner.toolCount} tools</div>
          <div>⏱ {formatElapsed(row.runner.elapsedMs)} · {row.runner.model}</div>
        </div>
      ) : (
        <div style={{ fontSize: '13px', color: 'var(--text-muted)', fontStyle: 'italic', minHeight: '22px' }}>
          {row.online ? '待命中 — 可指派任務' : 'agent 已斷線'}
        </div>
      )}

      <div style={{
        display: 'flex', justifyContent: 'space-between', gap: '8px',
        marginTop: '14px', paddingTop: '10px', borderTop: '1px solid var(--border)',
        fontSize: '11px', color: 'var(--text-muted)',
      }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.hostname ?? row.label}</span>
        <span style={{ flexShrink: 0 }}>via {row.botId}</span>
      </div>
    </button>
  )
}

function DispatchRow({ task }: { task: DispatchTask }) {
  const color = task.status === 'error' ? 'var(--danger, #c1503f)'
    : task.status === 'done' ? 'var(--success, #2e9e6b)'
    : 'var(--accent)'
  const label = task.status === 'error' ? '失敗' : task.status === 'done' ? '完成' : '執行中'
  const preview = task.output.trim().slice(-600)
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', padding: '12px 14px', boxShadow: 'var(--shadow)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: preview ? '8px' : 0 }}>
        <span style={{
          width: '8px', height: '8px', borderRadius: '50%', background: color,
          boxShadow: task.status === 'running' ? `0 0 0 4px color-mix(in srgb, ${color} 18%, transparent)` : 'none',
        }} />
        <span style={{ fontFamily: 'var(--font-display)', fontSize: '14px', fontWeight: 600 }}>{task.label}</span>
        <span style={{
          marginLeft: 'auto', fontSize: '12px', fontWeight: 600, color,
          background: `color-mix(in srgb, ${color} 12%, transparent)`,
          padding: '2px 9px', borderRadius: '999px',
        }}>{label}</span>
      </div>
      {preview && (
        <pre style={{
          margin: 0, maxHeight: '160px', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: '12px',
          color: 'var(--text-secondary)', lineHeight: 1.5,
        }}>{preview}</pre>
      )}
    </div>
  )
}

export function MachinesPanel() {
  const bots = useDashboardStore((s) => s.bots)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [task, setTask] = useState('')
  const [sending, setSending] = useState(false)
  const dispatchTasks = useDispatchStore((s) => s.tasks)
  const startDispatch = useDispatchStore((s) => s.start)
  const clearDispatch = useDispatchStore((s) => s.clear)

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

  // Only one machine? Auto-select it so the user can just type + dispatch.
  // Keyed on that machine's code: re-selects if the sole machine changes, but
  // a manual deselect sticks (effect won't re-run without a key change).
  const soleCode = rows.length === 1 ? rows[0].code : null
  useEffect(() => {
    if (soleCode) setSelected((prev) => (prev.has(soleCode) ? prev : new Set([soleCode])))
  }, [soleCode])

  const toggle = (code: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code); else next.add(code)
      return next
    })
  }

  const selectedRows = rows.filter((r) => selected.has(r.code))
  const onlineCount = rows.filter((r) => r.online).length
  // What we actually dispatch to: explicit selection, or — if nothing is
  // ticked but there's exactly one machine — that machine (it's obviously her).
  const effectiveTargets = selectedRows.length > 0 ? selectedRows : (rows.length === 1 ? rows : [])

  const dispatch = async () => {
    const prompt = task.trim()
    if (!prompt || effectiveTargets.length === 0 || sending) return
    setSending(true)
    try {
      await Promise.all(
        effectiveTargets.map(async (row) => {
          const res = await apiPost<{ command: DashboardCommand }>('/api/commands', {
            targetBot: row.botId,
            type: 'dispatch_remote',
            payload: { prompt, code: row.code, label: row.label },
          })
          if (res?.command?.id) startDispatch(res.command.id, row.label)
        }),
      )
      setTask('')
      setSelected(new Set())
    } catch {
      /* silent */
    } finally {
      setSending(false)
    }
  }

  const canDispatch = effectiveTargets.length > 0 && task.trim() !== '' && !sending

  return (
    <div style={{
      maxWidth: '1080px',
      margin: '0 auto',
      padding: '36px 28px 0',
      minHeight: '100%',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{ marginBottom: '26px' }}>
        <h1 style={{ fontSize: '30px', fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.1 }}>
          派發中心
        </h1>
        <p style={{ marginTop: '6px', fontSize: '14px', color: 'var(--text-secondary)' }}>
          {rows.length === 0
            ? '尚無已配對的機器'
            : `${onlineCount} 台在線${selectedRows.length > 0 ? ` · 已選 ${selectedRows.length} 台` : ''}`}
        </p>
      </div>

      {/* Dispatch status */}
      {Object.keys(dispatchTasks).length > 0 && (
        <div style={{ marginBottom: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <span style={{ fontFamily: 'var(--font-display)', fontSize: '15px', fontWeight: 600 }}>派發狀態</span>
            <button
              onClick={clearDispatch}
              style={{ fontSize: '12px', color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
            >清除</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {Object.values(dispatchTasks)
              .sort((a, b) => b.startedAt - a.startedAt)
              .map((t) => <DispatchRow key={t.commandId} task={t} />)}
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div style={{
          background: 'var(--bg-card)',
          border: '1px dashed var(--border)',
          borderRadius: 'var(--radius)',
          padding: '40px 28px',
          textAlign: 'center',
          color: 'var(--text-secondary)',
          boxShadow: 'var(--shadow)',
        }}>
          <div style={{ fontSize: '34px', marginBottom: '10px' }}>🖥️</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '17px', fontWeight: 600, color: 'var(--text-primary)' }}>
            還沒有機器連進來
          </div>
          <p style={{ marginTop: '8px', fontSize: '13px', lineHeight: 1.7 }}>
            在另一台電腦開 ClaudeBot 桌面端,於 Telegram 打 <code style={{ background: 'var(--bg-hover)', padding: '1px 6px', borderRadius: '5px' }}>/pair</code>,
            <br />把 Server 網址 + 配對碼貼進去,連上後就會出現在這裡。
          </p>
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))',
          gap: '18px',
          paddingBottom: '140px',
        }}>
          {rows.map((row, i) => (
            <MachineCard
              key={`${row.botId}:${row.label}`}
              row={row}
              index={i}
              selected={selected.has(row.code)}
              onToggle={() => toggle(row.code)}
            />
          ))}
        </div>
      )}

      {/* Sticky dispatch bar */}
      {rows.length > 0 && (
        <div style={{
          position: 'sticky',
          bottom: '0',
          marginTop: 'auto',
          background: 'color-mix(in srgb, var(--bg-primary) 86%, transparent)',
          backdropFilter: 'blur(8px)',
          borderTop: '1px solid var(--border)',
          padding: '16px 0 22px',
        }}>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder={effectiveTargets.length === 0
                ? '先勾選上面的機器…'
                : '要這些機器做什麼?(例:git clone <repo> && npm i && npm start)'}
              rows={2}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); dispatch() }
              }}
              style={{
                flex: 1,
                resize: 'none',
                background: 'var(--bg-card)',
                border: '1.5px solid var(--border)',
                borderRadius: 'var(--radius)',
                color: 'var(--text-primary)',
                padding: '12px 14px',
                fontSize: '14px',
                fontFamily: 'var(--font-body)',
                lineHeight: 1.5,
                outline: 'none',
                boxShadow: 'var(--shadow)',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)' }}
            />
            <button
              onClick={dispatch}
              disabled={!canDispatch}
              style={{
                flexShrink: 0,
                height: '56px',
                padding: '0 22px',
                background: canDispatch ? 'var(--accent)' : 'var(--bg-hover)',
                color: canDispatch ? '#fff' : 'var(--text-muted)',
                border: 'none',
                borderRadius: 'var(--radius)',
                fontFamily: 'var(--font-display)',
                fontSize: '15px',
                fontWeight: 700,
                cursor: canDispatch ? 'pointer' : 'not-allowed',
                whiteSpace: 'nowrap',
                boxShadow: canDispatch ? 'var(--shadow-lift)' : 'none',
                transition: 'background 0.15s, transform 0.1s',
              }}
              onMouseDown={(e) => { if (canDispatch) e.currentTarget.style.transform = 'scale(0.97)' }}
              onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)' }}
            >
              {sending ? '派發中…' : `派發 → ${effectiveTargets.length || ''}`}
            </button>
          </div>
          <div style={{ marginTop: '7px', fontSize: '11px', color: 'var(--text-muted)' }}>
            ⌘/Ctrl + Enter 送出 · 任務會丟給每台勾選的機器各自執行
          </div>
        </div>
      )}
    </div>
  )
}
