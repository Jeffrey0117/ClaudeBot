import { useState, useEffect, type MouseEvent } from 'react'

export interface NowPlayingData {
  readonly active: boolean
  readonly playing?: boolean
  readonly title?: string
  readonly channel?: string
  readonly current?: number
  readonly duration?: number
  readonly volume?: number
}

export type NpAction = 'toggle' | 'seek' | 'volume'

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) s = 0
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

// Lo-fi pixel "now playing" widget — spinning vinyl + scrolling title +
// interactive seek/volume/play, fed by live CDP data from the machine's Chrome.
export function NowPlaying({
  data, machineLabel, onControl,
}: {
  data: NowPlayingData
  machineLabel: string
  onControl: (action: NpAction, value?: number) => void
}) {
  // Optimistic overrides so clicks feel instant; cleared when fresh poll lands.
  const [optCur, setOptCur] = useState<number | null>(null)
  const [optVol, setOptVol] = useState<number | null>(null)
  const [optPlaying, setOptPlaying] = useState<boolean | null>(null)
  useEffect(() => { setOptCur(null); setOptPlaying(null) }, [data.current, data.playing])
  useEffect(() => { setOptVol(null) }, [data.volume])

  const dur = data.duration ?? 0
  const cur = optCur ?? data.current ?? 0
  const playing = optPlaying ?? (data.playing !== false)
  const vol = optVol ?? data.volume ?? 100
  const pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0
  const paused = !playing

  const seek = (e: MouseEvent<HTMLDivElement>) => {
    if (dur <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const target = Math.floor(frac * dur)
    setOptCur(target)
    onControl('seek', target)
  }

  return (
    <div className={`np-card${paused ? ' np-paused' : ''}`}>
      <style>{NP_CSS}</style>

      <div className="np-deck">
        <div className="np-platter">
          <div className="np-label">
            <svg width="40" height="34" viewBox="0 0 28 24" shapeRendering="crispEdges" aria-hidden="true">
              <rect x="9" y="1" width="10" height="3" fill="#fff" />
              <rect x="7" y="3" width="14" height="3" fill="#fff" />
              <rect x="6" y="6" width="16" height="11" fill="#101116" />
              <rect x="7" y="7" width="14" height="9" fill="#e07a63" />
              <rect x="10" y="10" width="2" height="2" fill="#101116" />
              <rect x="16" y="10" width="2" height="2" fill="#101116" />
              <rect x="11" y="13" width="6" height="3" fill="#cf6a55" />
              <rect x="12" y="14" width="1" height="1" fill="#101116" />
              <rect x="15" y="14" width="1" height="1" fill="#101116" />
            </svg>
            <span className="np-hole" />
          </div>
        </div>
        <svg className="np-arm" viewBox="0 0 96 96" aria-hidden="true">
          <circle cx="84" cy="12" r="9" fill="#2b2e3a" stroke="#3b3f4d" strokeWidth="2" />
          <rect x="80" y="12" width="8" height="60" rx="3" transform="rotate(34 84 12)" fill="#caced9" />
          <rect x="40" y="64" width="14" height="8" rx="2" fill="#3b3f4d" />
        </svg>
      </div>

      <div className="np-info">
        <div className="np-tag"><span className="np-rec" /> Now Playing</div>
        <div className="np-title-wrap"><span className="np-title">{data.title || '(讀取中…)'}</span></div>
        <div className="np-channel">
          ♪ {data.channel ? data.channel + ' · ' : ''}派發中心 {machineLabel}
        </div>

        <div className="np-bar" onClick={seek} title="點一下跳到該位置">
          <div className="np-fill" style={{ width: `${pct}%` }}>
            <span className="np-knob" />
          </div>
        </div>
        <div className="np-times"><span>{fmt(cur)}</span><span>{fmt(dur)}</span></div>

        <div className="np-controls">
          <button
            className="np-btn"
            onClick={() => { setOptPlaying(!playing); onControl('toggle') }}
            title={playing ? '暫停' : '播放'}
          >{playing ? '❚❚' : '▶'}</button>
          <span className="np-vol-ico">{vol === 0 ? '🔇' : '🔊'}</span>
          <input
            className="np-vol"
            type="range" min={0} max={100} value={vol}
            onChange={(e) => { const x = Number(e.target.value); setOptVol(x); onControl('volume', x / 100) }}
            title={`音量 ${vol}%`}
          />
        </div>
      </div>
    </div>
  )
}

const NP_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&display=swap');
.np-card{position:relative;display:grid;grid-template-columns:128px 1fr;gap:20px;
  background:linear-gradient(160deg,#191b24,#15161d);border:2px solid #2a2d3a;border-radius:16px;
  padding:20px 22px;box-shadow:0 18px 44px rgba(0,0,0,.45);overflow:hidden;font-family:'VT323',monospace;
  animation:npRise .4s ease both;}
.np-card::before{content:"";position:absolute;inset:0;pointer-events:none;
  background-image:radial-gradient(rgba(255,255,255,.07) 1px,transparent 1.3px);background-size:13px 13px;
  mask-image:radial-gradient(circle at 30% 40%,transparent 35%,#000 90%);opacity:.5;}
@keyframes npRise{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}
.np-deck{position:relative;width:128px;height:128px;align-self:center;}
.np-platter{position:absolute;inset:0;border-radius:50%;
  background:repeating-radial-gradient(circle at 50% 50%,#141414 0 2px,#0a0a0c 2px 4px),#0a0a0c;
  box-shadow:0 6px 18px rgba(0,0,0,.6),inset 0 0 0 5px #050506,inset 0 0 30px rgba(0,0,0,.8);
  animation:npSpin 4.5s linear infinite;}
.np-platter::after{content:"";position:absolute;inset:0;border-radius:50%;
  background:linear-gradient(115deg,transparent 40%,rgba(255,255,255,.10) 48%,transparent 56%);}
.np-label{position:absolute;top:50%;left:50%;width:58px;height:58px;margin:-29px 0 0 -29px;border-radius:50%;
  background:radial-gradient(circle at 50% 35%,#ff9d8c,#ee7b6a);border:3px solid #101116;
  display:flex;align-items:center;justify-content:center;}
.np-hole{position:absolute;width:7px;height:7px;border-radius:50%;background:#101116;}
.np-arm{position:absolute;top:-4px;right:-4px;width:74px;height:74px;transform-origin:88% 12%;
  transform:rotate(-28deg);transition:transform .5s ease;}
.np-paused .np-platter{animation-play-state:paused;}
.np-paused .np-arm{transform:rotate(-46deg);}
@keyframes npSpin{to{transform:rotate(360deg);}}
.np-info{display:flex;flex-direction:column;justify-content:center;min-width:0;}
.np-tag{font-family:'Press Start 2P';font-size:8px;letter-spacing:1px;color:#8fd9a8;
  display:flex;align-items:center;gap:7px;margin-bottom:9px;text-transform:uppercase;}
.np-rec{width:8px;height:8px;border-radius:50%;background:#ee7b6a;box-shadow:0 0 8px #ee7b6a;animation:npBlink 1.1s steps(1) infinite;}
.np-paused .np-rec{animation:none;background:#6a6e7e;box-shadow:none;}
@keyframes npBlink{50%{opacity:.25;}}
.np-title-wrap{overflow:hidden;white-space:nowrap;
  -webkit-mask-image:linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent);
  mask-image:linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent);}
.np-title{display:inline-block;font-size:30px;line-height:1.05;color:#f3ead6;
  text-shadow:0 0 14px rgba(238,123,106,.25);padding-left:100%;animation:npMarquee 12s linear infinite;}
.np-paused .np-title{animation-play-state:paused;}
@keyframes npMarquee{to{transform:translateX(-100%);}}
.np-channel{font-size:18px;color:#6a6e7e;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.np-bar{position:relative;margin-top:14px;height:10px;border-radius:6px;background:#23252f;
  cursor:pointer;box-shadow:inset 0 1px 2px rgba(0,0,0,.6);}
.np-fill{position:relative;height:100%;border-radius:6px;background:linear-gradient(90deg,#ee7b6a,#ffb59f);
  box-shadow:0 0 12px rgba(238,123,106,.6);transition:width .35s linear;}
.np-knob{position:absolute;right:-5px;top:50%;width:12px;height:12px;margin-top:-6px;border-radius:50%;
  background:#ffd9cf;border:2px solid #ee7b6a;opacity:0;transition:opacity .15s;}
.np-bar:hover .np-knob{opacity:1;}
.np-times{display:flex;justify-content:space-between;font-size:16px;color:#6a6e7e;margin-top:4px;}
.np-controls{display:flex;align-items:center;gap:10px;margin-top:10px;}
.np-btn{font-family:'VT323',monospace;font-size:16px;line-height:1;color:#f3ead6;background:#23252f;
  border:2px solid #333645;border-radius:8px;width:38px;height:30px;cursor:pointer;}
.np-btn:hover{border-color:#ee7b6a;color:#ee7b6a;}
.np-vol-ico{font-size:14px;}
.np-vol{flex:1;max-width:160px;accent-color:#ee7b6a;height:4px;cursor:pointer;}
`
