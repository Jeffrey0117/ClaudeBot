// ==UserScript==
// @name         ClaudeBot Browser Bridge
// @namespace    claudebot
// @version      0.1
// @description  Runs JS pushed from ClaudeBot in this browser — DOM-precise remote control.
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  // ===== CONFIG — set these two =====
  // RELAY = the https:// form of your relay URL (from /pair; turn wss:// into https://)
  const RELAY = 'https://CHANGE-ME.trycloudflare.com';
  // TOKEN = USERSCRIPT_TOKEN in the bot's .env
  const TOKEN = 'CHANGE-ME';
  // ==================================

  const POLL_MS = 1500;
  if (RELAY.indexOf('CHANGE-ME') !== -1 || TOKEN === 'CHANGE-ME') return;

  function gm(method, url, data) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: method, url: url, data: data,
        headers: data ? { 'Content-Type': 'application/json' } : {},
        timeout: 8000,
        onload: function (r) { resolve(r.responseText); },
        onerror: function () { reject(new Error('net')); },
        ontimeout: function () { reject(new Error('timeout')); },
      });
    });
  }

  async function runCmd(c) {
    // Dedupe across tabs (per origin) so a command runs once.
    var key = 'cb_done_' + c.id;
    try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch (e) {}
    var result, error;
    try {
      // eslint-disable-next-line no-eval
      result = await eval(c.js);
      result = (result === undefined) ? 'undefined' : String(result);
    } catch (e) { error = String((e && e.message) || e); }
    try { await gm('POST', RELAY + '/us/result', JSON.stringify({ id: c.id, result: result, error: error, token: TOKEN })); } catch (e) {}
  }

  async function tick() {
    try {
      var txt = await gm('GET', RELAY + '/us/poll?token=' + encodeURIComponent(TOKEN));
      var cmds = JSON.parse(txt);
      for (var i = 0; i < cmds.length; i++) { await runCmd(cmds[i]); }
    } catch (e) { /* relay unreachable — keep trying */ }
    setTimeout(tick, POLL_MS);
  }
  tick();
})();
