/**
 * Jarvis voice UI — single embedded page, zero frontend dependencies.
 *
 * State machine: idle → listening → thinking → speaking → idle.
 * Speech in via webkitSpeechRecognition (Chrome/Edge built-in, zh-TW),
 * speech out via speechSynthesis. Token is read from the page URL and
 * reused for the WebSocket connection.
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
  const TTS_MAX = 400

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
  const stripCtx = (s) => s.replace(/\\[CTX\\][\\s\\S]*?\\[\\/CTX\\]/g, '').trim()

  // --- WebSocket ---
  let ws = null
  let wsReady = false
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(proto + '://' + location.host + '/ws?token=' + encodeURIComponent(token))
    ws.onopen = () => { wsReady = true; if (state === 'idle') statusEl.textContent = STATUS.idle }
    ws.onclose = () => { wsReady = false; statusEl.textContent = '連線中斷,重連中……'; setTimeout(connect, 3000) }
    ws.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      if (msg.type === 'chunk' && state === 'thinking') {
        showText('<span class="interim">' + esc(stripCtx(msg.text)) + '</span>')
      } else if (msg.type === 'answer') {
        const clean = stripCtx(msg.text)
        showText(esc(clean))
        speak(clean)
      } else if (msg.type === 'error') {
        showText('<span class="interim">⚠ ' + esc(msg.text) + '</span>')
        setState('idle')
      }
    }
  }
  connect()

  // --- Speech recognition ---
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  let recog = null
  let finalText = ''

  function startListening() {
    if (!SR) { showText('<span class="interim">⚠ 這個瀏覽器不支援語音辨識,請用 Chrome/Edge</span>'); return }
    if (!wsReady) { statusEl.textContent = '還沒連上 bot,稍等……'; return }
    finalText = ''
    recog = new SR()
    recog.lang = 'zh-TW'
    recog.interimResults = true
    recog.continuous = true
    recog.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript
        if (e.results[i].isFinal) finalText += t
        else interim += t
      }
      showText(esc(finalText) + '<span class="interim">' + esc(interim) + '</span>')
    }
    recog.onerror = () => { if (state === 'listening') backToIdle('沒聽清楚,再點一次') }
    recog.onend = () => { if (state === 'listening') sendOrIdle() }
    recog.start()
    startMicMeter()
    setState('listening')
  }

  function sendOrIdle() {
    stopMicMeter()
    const text = finalText.trim()
    if (!text) { backToIdle('沒聽到內容,再點一次'); return }
    ws.send(JSON.stringify({ type: 'ask', text }))
    setState('thinking')
  }

  function backToIdle(hint) {
    stopMicMeter()
    setState('idle')
    if (hint) statusEl.textContent = hint
  }

  // --- Mic volume → dot scale (the show-off part) ---
  let audioCtx = null, meterRaf = 0, micStream = null
  async function startMicMeter() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      audioCtx = new AudioContext()
      const src = audioCtx.createMediaStreamSource(micStream)
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
    } catch { /* no mic permission — ripple animation still plays */ }
  }
  function stopMicMeter() {
    cancelAnimationFrame(meterRaf)
    dot.style.transform = ''
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null }
  }

  // --- TTS ---
  let zhVoice = null
  function pickVoice() {
    const voices = speechSynthesis.getVoices()
    zhVoice = voices.find((v) => /zh[-_]TW/i.test(v.lang))
      || voices.find((v) => /^zh/i.test(v.lang))
      || null
  }
  pickVoice()
  speechSynthesis.onvoiceschanged = pickVoice

  function speak(text) {
    const spoken = text.length > TTS_MAX ? text.slice(0, TTS_MAX) + '……詳細內容我發到 Telegram 了' : text
    speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(spoken)
    if (zhVoice) u.voice = zhVoice
    u.lang = 'zh-TW'
    u.rate = 1.05
    u.onend = () => { if (state === 'speaking') setState('idle') }
    u.onerror = () => { if (state === 'speaking') setState('idle') }
    setState('speaking')
    speechSynthesis.speak(u)
  }

  // --- The dot ---
  dot.addEventListener('click', () => {
    if (state === 'idle') startListening()
    else if (state === 'listening') { recog && recog.stop() }
    else if (state === 'speaking') { speechSynthesis.cancel(); setState('idle') }
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
