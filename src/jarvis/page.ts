/**
 * Jarvis voice UI — single embedded page, zero frontend dependencies.
 *
 * State machine: idle → listening → thinking → speaking → idle.
 *
 * Speech in: Web Speech API is the primary transcriber (live interim
 * captions + final text — clearly better for mixed Chinese/English everyday
 * speech). MediaRecorder records in parallel and the audio goes to POST /asr
 * (Sherpa) only as fallback when Web Speech produced nothing.
 *
 * Speech out: sentence-level streaming — complete sentences from response
 * chunks are spoken as they arrive instead of waiting for the full answer.
 */
export function jarvisPage(): string {
  return `<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>JARVIS</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=LXGW+WenKai+TC&family=Michroma&display=swap');

  :root {
    --bg: #02050b;
    --core: #bfe9ff;
    --ink: #eaf4ff;
    --dim: #7e97b8;
    --line: rgba(140, 200, 255, .22);
    --warn: #ffb454;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    background:
      radial-gradient(ellipse 70% 55% at 50% 38%, rgba(40, 110, 190, .16), transparent 65%),
      radial-gradient(ellipse 120% 90% at 50% 110%, rgba(10, 35, 70, .35), transparent 60%),
      var(--bg);
    color: var(--ink);
    font-family: "LXGW WenKai TC", "Noto Sans TC", system-ui, sans-serif;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 30px; overflow: hidden; user-select: none;
  }
  /* faint HUD grain */
  body::after {
    content: ''; position: fixed; inset: 0; pointer-events: none; opacity: .05;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.6'/%3E%3C/svg%3E");
  }

  #wordmark {
    position: fixed; top: 22px; left: 26px;
    font-family: Michroma, sans-serif; font-size: 11px; letter-spacing: .5em;
    color: var(--dim); opacity: 0; animation: fadein 1.4s .3s ease forwards;
  }
  #wordmark b { color: var(--core); font-weight: 400; }
  #fs {
    position: fixed; top: 16px; right: 18px; width: 38px; height: 38px;
    background: none; border: 1px solid var(--line); color: var(--dim);
    border-radius: 50%; font-size: 15px; cursor: pointer;
    transition: color .3s, border-color .3s, box-shadow .3s;
    opacity: 0; animation: fadein 1.4s .5s ease forwards;
  }
  #fs:hover { color: var(--core); border-color: var(--core); box-shadow: 0 0 18px rgba(120, 200, 255, .25); }
  @keyframes fadein { to { opacity: 1; } }

  /* ── The reactor ───────────────────────────────────── */
  #stage {
    position: relative; width: 320px; height: 320px;
    display: grid; place-items: center;
    animation: arrive 1.2s cubic-bezier(.2, .8, .2, 1) both;
  }
  @keyframes arrive { from { opacity: 0; transform: scale(.85); } }

  #stage > * { grid-area: 1 / 1; }

  /* wide soft halo */
  #halo {
    width: 320px; height: 320px; border-radius: 50%; pointer-events: none;
    background: radial-gradient(circle, rgba(90, 180, 255, .14), transparent 60%);
    transition: opacity .6s; opacity: .6;
  }
  body[data-state="listening"] #halo { opacity: 1; }
  body[data-state="speaking"] #halo { animation: halopulse 1.1s ease-in-out infinite; }
  @keyframes halopulse { 50% { opacity: 1; transform: scale(1.06); } }

  /* tick ring — thin instrument bezel */
  #ring {
    width: 230px; height: 230px; border-radius: 50%; pointer-events: none;
    background: repeating-conic-gradient(rgba(150, 210, 255, .5) 0 .5deg, transparent .5deg 6deg);
    -webkit-mask: radial-gradient(circle, transparent 64%, #000 65%, #000 70%, transparent 71%);
            mask: radial-gradient(circle, transparent 64%, #000 65%, #000 70%, transparent 71%);
    opacity: .35; animation: rotate 60s linear infinite;
    transition: opacity .5s;
  }
  body[data-state="listening"] #ring { opacity: .9; animation-duration: 18s; }
  body[data-state="speaking"]  #ring { opacity: .7; animation-duration: 30s; }
  @keyframes rotate { to { transform: rotate(360deg); } }

  /* the core */
  #dot {
    width: 150px; height: 150px; border-radius: 50%; cursor: pointer;
    background:
      radial-gradient(circle at 50% 45%, #ffffff 0%, var(--core) 22%, rgba(70, 150, 230, .85) 48%, rgba(20, 50, 100, .9) 78%, rgba(8, 20, 44, 1) 100%);
    box-shadow:
      0 0 24px rgba(150, 215, 255, .55),
      0 0 90px rgba(70, 160, 255, .30),
      inset 0 0 34px rgba(255, 255, 255, .25);
    transition: transform .08s linear, box-shadow .6s, filter .6s;
    will-change: transform;
  }
  #dot:active { filter: brightness(1.25); }
  body[data-state="idle"] #dot { animation: breathe 4.2s ease-in-out infinite; filter: brightness(.75) saturate(.9); }
  @keyframes breathe {
    0%, 100% { transform: scale(1); }
    50%      { transform: scale(1.045); box-shadow: 0 0 36px rgba(150, 215, 255, .7), 0 0 130px rgba(70, 160, 255, .4), inset 0 0 40px rgba(255,255,255,.3); }
  }
  body[data-state="listening"] #dot { filter: brightness(1.12); }
  body[data-state="thinking"]  #dot { filter: brightness(.9); animation: simmer 2.6s ease-in-out infinite; }
  @keyframes simmer { 50% { filter: brightness(1.08); } }
  body[data-state="speaking"]  #dot { animation: speak .62s ease-in-out infinite; }
  @keyframes speak {
    0%, 100% { transform: scale(1); }
    50%      { transform: scale(1.05); box-shadow: 0 0 40px rgba(150, 215, 255, .75), 0 0 140px rgba(70, 160, 255, .45), inset 0 0 40px rgba(255,255,255,.35); }
  }

  /* listening ripples — hairline rings */
  .ripple {
    width: 150px; height: 150px; border-radius: 50%; pointer-events: none;
    border: 1px solid rgba(160, 215, 255, .65); opacity: 0;
  }
  body[data-state="listening"] .ripple { animation: ripple 2.2s cubic-bezier(.2, .6, .35, 1) infinite; }
  body[data-state="listening"] .ripple:nth-child(3) { animation-delay: 1.1s; }
  @keyframes ripple {
    0%   { transform: scale(1); opacity: .8; }
    100% { transform: scale(2.05); opacity: 0; }
  }

  /* thinking — twin counter-orbiting arcs */
  #spinner { width: 200px; height: 200px; position: relative; pointer-events: none; opacity: 0; transition: opacity .4s; }
  body[data-state="thinking"] #spinner { opacity: 1; }
  #spinner::before, #spinner::after {
    content: ''; position: absolute; inset: 0; border-radius: 50%;
    border: 1px solid transparent;
  }
  #spinner::before {
    border-top-color: rgba(170, 220, 255, .9); border-right-color: rgba(170, 220, 255, .25);
    animation: rotate 1.5s linear infinite;
  }
  #spinner::after {
    inset: 14px;
    border-bottom-color: rgba(120, 190, 255, .6);
    animation: rotate 2.3s linear infinite reverse;
  }

  /* ── Text ──────────────────────────────────────────── */
  #status {
    font-family: Michroma, "LXGW WenKai TC", sans-serif;
    font-size: 13px; letter-spacing: .42em; text-indent: .42em;
    color: var(--dim); text-transform: uppercase;
    transition: color .4s;
  }
  body[data-state="listening"] #status,
  body[data-state="speaking"]  #status { color: var(--core); text-shadow: 0 0 14px rgba(120, 200, 255, .5); }

  #text {
    min-height: 3.2em; max-height: 34vh; overflow-y: auto;
    max-width: min(760px, 88vw); text-align: center;
    font-size: clamp(22px, 2.6vw, 30px); line-height: 1.75;
    white-space: pre-wrap; word-break: break-word;
    color: var(--ink); text-shadow: 0 0 26px rgba(110, 190, 255, .22);
  }
  #text .interim { color: var(--dim); text-shadow: none; }
  #text .warn { color: var(--warn); font-size: .8em; }
  #text::-webkit-scrollbar { width: 0; }
</style>
</head>
<body data-state="idle">
  <div id="wordmark"><b>◉</b>&nbsp; J A R V I S</div>
  <button id="fs" title="全螢幕">⛶</button>
  <div id="stage">
    <div id="halo"></div>
    <div class="ripple"></div>
    <div class="ripple"></div>
    <div id="ring"></div>
    <div id="spinner"></div>
    <div id="dot"></div>
  </div>
  <div id="status">點一下,開始說話</div>
  <div id="text"></div>

<script>
(() => {
  const token = new URLSearchParams(location.search).get('token') || ''
  const dot = document.getElementById('dot')
  const statusEl = document.getElementById('status')
  const textEl = document.getElementById('text')
  const TTS_MAX = 400 // cap on total spoken chars per answer

  const STATUS = {
    idle: 'TAP · 點一下說話',
    listening: 'LISTENING · 聽你說',
    thinking: 'THINKING · 處理中',
    speaking: 'SPEAKING · 點一下打斷',
  }

  let state = 'idle'
  function setState(s) {
    state = s
    document.body.dataset.state = s
    statusEl.textContent = STATUS[s] || ''
  }

  function showText(html) { textEl.innerHTML = html; textEl.scrollTop = textEl.scrollHeight }
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

  // Strip things that must never be spoken or shown: CTX digests (including a
  // trailing half-streamed one), @directives, fenced code blocks (an unclosed
  // fence cuts the text — we hold until it closes).
  const FENCE = String.fromCharCode(96, 96, 96)
  const fencePair = new RegExp(FENCE + '[\\\\s\\\\S]*?' + FENCE, 'g')
  function sanitize(s) {
    let t = s.replace(/\\[CTX\\][\\s\\S]*?\\[\\/CTX\\]/g, '')
    const ctxStart = t.indexOf('[CTX')
    if (ctxStart >= 0) t = t.slice(0, ctxStart)
    t = t.replace(fencePair, '')
    const fence = t.indexOf(FENCE)
    if (fence >= 0) t = t.slice(0, fence)
    return t.replace(/@\\w+\\([^)]*\\)/g, '')
  }

  // --- Streaming TTS: speak complete sentences as chunks arrive ---
  let zhVoice = null
  function pickVoice() {
    const voices = speechSynthesis.getVoices()
    zhVoice = voices.find((v) => /zh[-_]TW/i.test(v.lang))
      || voices.find((v) => /^zh/i.test(v.lang))
      || null
  }
  pickVoice()
  speechSynthesis.onvoiceschanged = pickVoice

  let sp = null // per-answer speech state
  function resetSpeech() {
    speechSynthesis.cancel()
    sp = { cursor: 0, lastClean: '', total: 0, pending: 0, muted: false, capped: false, answered: false }
  }

  function utter(t) {
    const u = new SpeechSynthesisUtterance(t)
    if (zhVoice) u.voice = zhVoice
    u.lang = 'zh-TW'
    u.rate = 1.05
    sp.pending++
    u.onend = u.onerror = () => { sp.pending--; maybeDone() }
    if (state === 'thinking') setState('speaking')
    speechSynthesis.speak(u)
  }

  function enqueueSpeech(text) {
    if (!sp || sp.muted) return
    const t = text.trim()
    if (t.length < 2) return
    if (sp.total >= TTS_MAX) {
      if (!sp.capped) { sp.capped = true; utter('後面還很長,細節我發到 Telegram 了') }
      return
    }
    sp.total += t.length
    utter(t)
  }

  function maybeDone() {
    if (sp && sp.answered && sp.pending <= 0 && state === 'speaking') setState('idle')
  }

  // Last index just past a sentence boundary, or 0 if none yet
  function boundaryEnd(buf) {
    const re = /[。!?！？;；…]\\s*|\\n+/g
    let end = 0, m
    while ((m = re.exec(buf))) end = m.index + m[0].length
    return end
  }

  function onChunk(raw) {
    if (!sp) return
    const clean = sanitize(raw)
    if (clean.length < sp.cursor) sp.cursor = 0 // new assistant segment — stream reset
    sp.lastClean = clean
    const buf = clean.slice(sp.cursor)
    const cut = boundaryEnd(buf)
    if (cut > 0) {
      enqueueSpeech(buf.slice(0, cut))
      sp.cursor += cut
    }
    if (state === 'thinking' || state === 'speaking') {
      showText('<span class="interim">' + esc(clean) + '</span>')
    }
  }

  function onAnswer(raw) {
    if (!sp) return
    sp.answered = true
    const clean = sanitize(raw)
    showText(esc(clean))
    if (sp.muted) { setState('idle'); return }
    if (sp.total === 0) {
      // No chunks streamed (or nothing speakable) — speak the final answer
      enqueueSpeech(clean.slice(0, TTS_MAX))
    } else {
      // Flush the unspoken tail of the last streamed segment
      enqueueSpeech(sp.lastClean.slice(sp.cursor))
    }
    if (sp.pending <= 0) setState('idle')
  }

  // --- WebSocket ---
  let ws = null
  let wsReady = false
  let asrAvailable = false
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(proto + '://' + location.host + '/ws?token=' + encodeURIComponent(token))
    ws.onopen = () => { wsReady = true; if (state === 'idle') statusEl.textContent = STATUS.idle }
    ws.onclose = () => { wsReady = false; statusEl.textContent = '連線中斷,重連中……'; setTimeout(connect, 3000) }
    ws.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      if (msg.type === 'hello') {
        asrAvailable = !!msg.asr
      } else if (msg.type === 'chunk') {
        onChunk(msg.text)
      } else if (msg.type === 'answer') {
        onAnswer(msg.text)
      } else if (msg.type === 'error') {
        showText('<span class="warn">⚠' + esc(msg.text) + '</span>')
        setState('idle')
      }
    }
  }
  connect()

  function sendAsk(text) {
    resetSpeech()
    showText(esc(text))
    ws.send(JSON.stringify({ type: 'ask', text }))
    setState('thinking')
  }

  // --- Speech capture: MediaRecorder → /asr (Sherpa), Web Speech as captions/fallback ---
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  let recog = null
  let webSpeechText = ''
  let recorder = null
  let recChunks = []
  let micStream = null
  let useAsr = false

  async function startListening() {
    if (!wsReady) { statusEl.textContent = '還沒連上 bot,稍等……'; return }
    useAsr = asrAvailable && !!window.MediaRecorder
    if (!useAsr && !SR) {
      showText('<span class="warn">⚠這個瀏覽器不支援語音輸入,請用 Chrome/Edge</span>')
      return
    }

    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      if (!SR) { showText('<span class="warn">⚠拿不到麥克風權限</span>'); return }
      micStream = null // Web Speech manages its own mic
    }

    if (micStream) startMicMeter(micStream)

    // Record in parallel — only uploaded if Web Speech comes up empty
    if (useAsr && micStream) {
      recChunks = []
      try {
        recorder = new MediaRecorder(micStream, { mimeType: 'audio/webm;codecs=opus' })
      } catch {
        recorder = new MediaRecorder(micStream)
      }
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data) }
      recorder.start(250)
    } else {
      useAsr = false
    }

    webSpeechText = ''
    if (SR) {
      recog = new SR()
      recog.lang = 'zh-TW'
      recog.interimResults = true
      recog.continuous = true
      recog.onresult = (e) => {
        let interim = ''
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript
          if (e.results[i].isFinal) webSpeechText += t
          else interim += t
        }
        if (state === 'listening') {
          showText(esc(webSpeechText) + '<span class="interim">' + esc(interim) + '</span>')
        }
      }
      recog.onerror = () => { /* finishCapture falls back to Sherpa */ }
      // Silence (or our stop() call) ends recognition. Final results land
      // just before onend, so only here is the transcript complete.
      recog.onend = () => { if (state === 'listening') finishCapture() }
      recog.start()
    }

    setState('listening')
  }

  function stopListening() {
    if (recog) {
      // Wait for onend — Web Speech delivers its last final result just before it
      statusEl.textContent = '處理中……'
      try { recog.stop() } catch { finishCapture() }
    } else {
      finishCapture()
    }
  }

  // Web Speech text wins (better for everyday mixed Chinese/English);
  // Sherpa transcribes the recording only when Web Speech produced nothing.
  function finishCapture() {
    const text = webSpeechText.trim()
    if (text) {
      releaseMic()
      sendAsk(text)
      return
    }
    if (useAsr && recorder && recorder.state !== 'inactive') {
      setState('thinking')
      statusEl.textContent = '辨識中……'
      recorder.onstop = () => {
        const blob = new Blob(recChunks, { type: 'audio/webm' })
        releaseMic()
        finishWithAsr(blob)
      }
      recorder.stop()
      return
    }
    backToIdle('沒聽到內容,再點一次')
  }

  async function finishWithAsr(blob) {
    try {
      const res = await fetch('/asr?token=' + encodeURIComponent(token), { method: 'POST', body: blob })
      const data = await res.json()
      if (data.ok && data.text) { sendAsk(data.text.trim()); return }
      throw new Error(data.error || 'ASR failed')
    } catch {
      backToIdle('辨識失敗,再點一次')
    }
  }

  function backToIdle(hint) {
    releaseMic()
    setState('idle')
    if (hint) statusEl.textContent = hint
  }

  // --- Mic volume → dot scale (the show-off part) ---
  let audioCtx = null, meterRaf = 0
  function startMicMeter(stream) {
    try {
      audioCtx = new AudioContext()
      const src = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      src.connect(analyser)
      const buf = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        analyser.getByteFrequencyData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) sum += buf[i]
        const vol = sum / buf.length / 255
        dot.style.transform = 'scale(' + (1 + Math.min(vol * 1.6, 0.45)) + ')'
        meterRaf = requestAnimationFrame(tick)
      }
      tick()
    } catch { /* meter is cosmetic — ripple animation still plays */ }
  }
  function releaseMic() {
    cancelAnimationFrame(meterRaf)
    dot.style.transform = ''
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null }
    recorder = null
  }

  // --- The dot ---
  dot.addEventListener('click', () => {
    if (state === 'idle') startListening()
    else if (state === 'listening') stopListening()
    else if (state === 'speaking') {
      // Shut up: mute the rest of this answer; queue keeps running
      speechSynthesis.cancel()
      if (sp) { sp.muted = true; sp.pending = 0 }
      if (sp && sp.answered) setState('idle')
      else { setState('thinking'); statusEl.textContent = '已靜音,等它做完……' }
    }
    // thinking: queue is running — let it finish
  })

  // --- Fullscreen ---
  document.getElementById('fs').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen()
    else document.documentElement.requestFullscreen().catch(() => {})
  })
})()
</script>
</body>
</html>`
}
