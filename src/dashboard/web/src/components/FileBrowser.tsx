import { useState, useEffect } from 'react'
import { apiFetch } from '../hooks/useApi'

interface Entry { name: string; dir: boolean; size: number; mtime: number; path: string }
interface Listing { cwd?: string; parent?: string; entries?: Entry[]; error?: string }

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

// On-demand remote file browser — navigate any connected machine's filesystem
// and pull individual files, without downloading whole folders. Each click
// fetches just that listing / that one file (reuses remote_browse + fetch_file).
export function FileBrowser({ machines, onClose }: {
  machines: { code: string; label: string }[]
  onClose: () => void
}) {
  const [code, setCode] = useState(machines[0]?.code ?? '')
  const [path, setPath] = useState('')
  const [data, setData] = useState<Listing | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!code) return
    setLoading(true)
    apiFetch<Listing>(`/api/files/list?code=${encodeURIComponent(code)}&path=${encodeURIComponent(path)}`)
      .then((d) => setData(d))
      .catch((e) => setData({ error: String(e) }))
      .finally(() => setLoading(false))
  }, [code, path])

  const download = async (p: string) => {
    try {
      const r = await apiFetch<{ name?: string; base64?: string; error?: string }>(
        `/api/files/get?code=${encodeURIComponent(code)}&path=${encodeURIComponent(p)}`,
      )
      if (r.error || !r.base64) { alert(`下載失敗:${r.error ?? '未知'}`); return }
      const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes]))
      const a = document.createElement('a')
      a.href = url; a.download = r.name || 'file'; a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      alert(`下載失敗:${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '720px', maxWidth: '100%', maxHeight: '82vh', display: 'flex', flexDirection: 'column',
          background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-lift)', overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '16px' }}>📁 機器檔案</span>
          <select
            value={code}
            onChange={(e) => { setCode(e.target.value); setPath('') }}
            style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', borderRadius: '8px', padding: '5px 10px', color: 'var(--text-primary)', fontSize: '13px' }}
          >
            {machines.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}
          </select>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '20px', cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 18px', borderBottom: '1px solid var(--border)', fontSize: '12px', color: 'var(--text-secondary)' }}>
          <button
            onClick={() => data?.parent && setPath(data.parent)}
            disabled={!data?.parent || loading}
            style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', borderRadius: '6px', padding: '3px 10px', cursor: 'pointer', color: 'var(--text-primary)' }}
          >⬆ 上層</button>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono, monospace)' }}>
            {loading ? '載入中…' : (data?.cwd ?? '')}
          </span>
        </div>

        <div style={{ overflow: 'auto', padding: '6px 0' }}>
          {data?.error ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
              {/Unknown tool/.test(data.error)
                ? '這台還沒有 remote_browse —— 請先 /selfupdate 那台 agent。'
                : `讀取失敗:${data.error}`}
            </div>
          ) : (data?.entries ?? []).length === 0 && !loading ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>(空資料夾)</div>
          ) : (
            (data?.entries ?? []).map((e) => (
              <div
                key={e.path}
                onClick={() => e.dir ? setPath(e.path) : download(e.path)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 18px',
                  cursor: 'pointer', fontSize: '13px',
                }}
                onMouseEnter={(ev) => { ev.currentTarget.style.background = 'var(--bg-hover)' }}
                onMouseLeave={(ev) => { ev.currentTarget.style.background = 'transparent' }}
              >
                <span style={{ width: '18px' }}>{e.dir ? '📁' : '📄'}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>{e.name}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: '11px', flexShrink: 0 }}>
                  {e.dir ? '' : fmtSize(e.size)}{e.dir ? '' : '  ⬇'}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
