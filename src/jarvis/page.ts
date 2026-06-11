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
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    background: #06080f;
    color: #c8d0e0;
    font-family: system-ui, -apple-system, "Noto Sans TC", sans-serif;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 28px; overflow: hidden; user-select: none;
  }
  #fs {
    position: fixed; top: 16px; right: 16px;
    background: none; border: 1px solid #2a3350; color: #5a6b88;
    border-radius: 8px; padding: 6px 12px; font-size: 16px; cursor: pointer;
  }
  #fs:hover { color: #c8d0e0; border-color: #4a5a80; }

  #stage { position: relative; width: 220px; height: 220px; display: grid; place-items: center; }

  /* The dot */
  #dot {
    width: 140px; height: 140px; border-radius: 50%; cursor: pointer;
    background: radial-gradient(circle at 35% 35%, #ff5a5a, #b3001b 70%);
    box-shadow: 0 0 60px rgba(255, 40, 40, .35);
    transition: transform .08s linear, background .4s, box-shadow .4s;
    will-change: transform;
  }
  body[data-state="idle"] #dot { animation: breathe 3.2s ease-in-out infinite; }
  @keyframes breathe {
    0%, 100% { transform: scale(1); box-shadow: 0 0 50px rgba(255,40,40,.25); }
    50%      { transform: scale(1.06); box-shadow: 0 0 90px rgba(255,40,40,.5); }
  }

  /* Listening: expanding ripple rings */
  .ripple {
    position: absolute; inset: 0; margin: auto;
    width: 140px; height: 140px; border-radius: 50%;
    border: 2px solid rgba(255, 80, 80, .6); pointer-events: none; opacity: 0;
  }
  body[data-state="listening"] .ripple { animation: ripple 1.8s ease-out infinite; }
  body[data-state="listening"] .ripple:nth-child(2) { animation-delay: .9s; }
  @keyframes ripple {
    0%   { transform: scale(1); opacity: .7; }
    100% { transform: scale(1.55); opacity: 0; }
  }

  /* Thinking: blue dot + spinning arc */
  body[data-state="thinking"] #dot {
    background: radial-gradient(circle at 35% 35%, #5ab0ff, #0b3ba6 70%);
    box-shadow: 0 0 70px rgba(60, 130, 255, .4);
  }
  #spinner {
    position: absolute; inset: 0; margin: auto;
    width: 180px; height: 180px; border-radius: 50%;
    border: 3px solid transparent; border-top-color: #4d9fff;
    opacity: 0; pointer-events: none;
  }
  body[data-state="thinking"] #spinner { opacity: 1; animation: spin 1.1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Speaking: teal pulse */
  body[data-state="speaking"] #dot {
    background: radial-gradient(circle at 35% 35%, #4dffd2, #00806b 70%);
    box-shadow: 0 0 70px rgba(40, 230, 190, .4);
    animation: speak .55s ease-in-out infinite;
  }
  @keyframes speak {
    0%, 100% { transform: scale(1); }
    50%      { transform: scale(1.08); }
  }

  #status { font-size: 15px; color: #5a6b88; letter-spacing: .08em; }
  #text {
    min-height: 4.5em; max-height: 38vh; overflow-y: auto;
    max-width: min(640px, 86vw); text-align: center;
    font-size: 17px; line-height: 1.7; white-space: pre-wrap; word-break: break-word;
  }
  #text .interim { color: #5a6b88; }
  #text::-webkit-scrollbar { width: 0; }
</style>
</head>
<body data-state="idle">
  <button id="fs" title="全螢幕">⛶</button>
  <div id="stage">
    <div class="ripple"></div>
    <div class="ripple"></div>
    <div id="spinner"></div>
    <div id="dot"></div>
  </div>
  <div id="status">點一下紅點開始說話</div>
  <div id="text"></div>

<script>
(() => {
  const token = new URLSearchParams(location.search).get('token') || ''
  const dot = document.getElementById('dot')
  const statusEl = document.getElementById('status')
  const textEl = document.getElementById('text')
  const TTS_MAX = 400 // cap on total spoken chars per answer

  const STATUS = {
    idle: '點一下紅點開始說話',
    listening: '聽你說……(再點一下送出)',
    thinking: '思考中……',
    speaking: '回答中(點一下打斷)',
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
        showText('<span class="interim">⚠ ' + esc(msg.text) + '</span>')
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
      showText('<span class="interim">⚠ 這個瀏覽器不支援語音輸入,請用 Chrome/Edge</span>')
      return
    }

    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      if (!SR) { showText('<span class="interim">⚠ 拿不到麥克風權限</span>'); return }
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
