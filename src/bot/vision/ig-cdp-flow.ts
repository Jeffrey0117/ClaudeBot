/**
 * IG posting via Chrome CDP — drives the logged-in Chrome's Instagram tab.
 *
 * DOM-driving logic ported from AutoReel's ig-helper.user.js (v1.8.9), with
 * two protocol-level upgrades over the Tampermonkey original:
 *  - DOM.setFileInputFiles injects the local file directly (no blob fetch)
 *  - Page.bringToFront wakes the tab (Lexical ignores input when hidden)
 *
 * Flow: ensure CDP → find/open IG tab → bring to front →
 *   phase 1 (eval): clean state → click 建立 → click 貼文 → tag file input
 *   phase 2 (CDP): DOM.setFileInputFiles
 *   phase 3 (eval): crop 原始 → 下一步×2 → fill caption (Lexical) → 分享 → confirm
 */

import { ensureChromeCdp } from './chrome-cdp.js'
import { CdpClient, findOrOpenPage } from './cdp-client.js'

export interface IgPostResult {
  readonly success: boolean
  readonly duration_s: number
  readonly error?: string
  readonly step?: string
}

const IG_URL = 'https://www.instagram.com/'
const IG_URL_RE = /^https:\/\/(www\.)?instagram\.com\//i
const PHASE1_TIMEOUT_MS = 60_000
const PHASE3_TIMEOUT_MS = 240_000

// ─────────────────────────────────────────────────────────
// Page-side script (runs inside the IG tab via Runtime.evaluate)
// ─────────────────────────────────────────────────────────

/** Shared helpers prepended to every page-side phase script. */
const PAGE_HELPERS = String.raw`
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const v = fn(); if (v) return v; } catch (_) {}
    await sleep(200);
  }
  throw new Error('waitFor timeout: ' + (label || 'element'));
}

/** Topmost IG dialog — scope searches here, not the whole DOM. */
function $dialog() {
  const d = document.querySelectorAll('div[role="dialog"]');
  return d.length > 0 ? d[d.length - 1] : null;
}

function $byAria(label, root) {
  return (root || document).querySelector('[aria-label="' + label + '"]');
}

/** Exact text match via TreeWalker (cheap, scoped to dialog by default). */
function $byText(text, root) {
  const scope = root || $dialog() || document;
  const t = text.trim();
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue && node.nodeValue.trim() === t) return node.parentElement;
  }
  return null;
}

function clickEl(el) {
  const target = el.closest('a, [role="link"], [role="button"], [role="menuitem"], button') || el;
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  });
}

/** Dismiss IG's「捨棄貼文?」confirm dialog if present. */
async function dismissDiscard() {
  const dialogs = document.querySelectorAll('div[role="dialog"]');
  for (const d of dialogs) {
    if (!/捨棄|Discard/.test(d.textContent || '')) continue;
    for (const b of d.querySelectorAll('[role="button"], button')) {
      const t = (b.textContent || '').trim();
      if (t === '捨棄' || t === 'Discard') {
        clickEl(b);
        await sleep(800);
        return true;
      }
    }
  }
  return false;
}

/**
 * Dismiss IG's one-time popups (notifications prompt, cookies, feature
 * intros) that cover the create dialog and block 下一步/分享.
 * Only clicks well-known dismissal labels, scoped to dialogs.
 */
async function dismissPopups() {
  const LABELS = ['稍後再說', 'Not Now', '允許所有 Cookie', 'Allow all cookies',
    '知道了', 'Got it', '確定', 'OK'];
  const dialogs = document.querySelectorAll('div[role="dialog"]');
  // Walk from topmost dialog down; skip the create-post dialog itself
  for (let i = dialogs.length - 1; i >= 0; i--) {
    const d = dialogs[i];
    if (d.querySelector('input[type="file"]') || /下一步|Next|分享|Share/.test(d.textContent || '')) continue;
    for (const label of LABELS) {
      const el = $byText(label, d);
      if (el) {
        clickEl(el);
        await sleep(800);
        return true;
      }
    }
  }
  return false;
}
`

/** Phase 1: clean residue → open create dialog → tag the file input. */
const PHASE1_SCRIPT = String.raw`
(async () => {
${PAGE_HELPERS}
  let step = 'clean_state';
  try {
    // One-time popups (notifications / cookies) block everything underneath
    await dismissPopups();
    // Clear leftover create-post modal (closing it pops the discard confirm)
    await dismissDiscard();
    const stuck = $dialog();
    if (stuck && (stuck.querySelector('input[type="file"]')
        || /建立新貼文|新貼文|Create new post|裁切|Crop|分享|Share|下一步|Next/.test(stuck.textContent || ''))) {
      const x = $byAria('關閉', stuck) || $byAria('Close', stuck)
        || (stuck.querySelector('svg[aria-label="關閉"]') || stuck.querySelector('svg[aria-label="Close"]'))
          ?.closest('[role="button"], button');
      if (x) { clickEl(x); await sleep(800); await dismissDiscard(); }
    }

    step = 'click_create';
    const createBtn = await waitFor(
      () => $byAria('新貼文') || $byAria('建立') || $byAria('Create') || $byAria('新增') || $byAria('New post'),
      15000, 'Create button（這個 Chrome profile 登入 IG 了嗎?）'
    );
    clickEl(createBtn);
    await sleep(600);

    step = 'click_post';
    // Menu layout varies; if the option is missing the create dialog may have
    // opened directly — tolerate failure when a file input already exists.
    try {
      const opt = await waitFor(
        () => $byText('貼文', document) || $byText('Post', document)
          || $byAria('貼文') || $byAria('Post')
          || document.querySelector('svg[aria-label="貼文"]')?.closest('button, [role="button"], a, div[tabindex]')
          || document.querySelector('svg[aria-label*="post" i]')?.closest('button, [role="button"], a, div[tabindex]'),
        5000, 'post menu item'
      );
      clickEl(opt);
      await sleep(800);
    } catch (e) {
      if (!document.querySelector('input[type="file"]')) throw e;
    }

    step = 'find_file_input';
    await sleep(1000);
    const input = await waitFor(
      () => ($dialog() || document).querySelector('input[type="file"]'),
      15000, 'file input'
    );
    document.querySelectorAll('input[data-igflow]').forEach(i => i.removeAttribute('data-igflow'));
    input.setAttribute('data-igflow', '1');
    return JSON.stringify({ ok: true });
  } catch (e) {
    return JSON.stringify({ ok: false, step, error: (e && e.message) || String(e) });
  }
})()
`

/** Phase 3: crop → next×2 → caption → share → confirm. */
function buildPhase3Script(caption: string, isVideo: boolean): string {
  return String.raw`
(async () => {
${PAGE_HELPERS}
  const CAPTION = ${JSON.stringify(caption)};

  function findDialogButton(labels) {
    // Search ALL dialogs (a popup may stack above the create dialog)
    const dialogs = document.querySelectorAll('div[role="dialog"]');
    for (let i = dialogs.length - 1; i >= 0; i--) {
      for (const e of dialogs[i].querySelectorAll('[role="button"]')) {
        const t = (e.textContent || '').trim();
        if (labels.includes(t) && e.getAttribute('aria-disabled') !== 'true') return e;
      }
    }
    return null;
  }

  /** Wait for a dialog button; on timeout dismiss blocking popups and retry. */
  async function clickDialogButton(labels, name) {
    try {
      const el = await waitFor(() => findDialogButton(labels), 15000, name);
      clickEl(el);
      return;
    } catch (_) {
      // A one-time popup (notifications / cookies / intro) may be covering
      // the create dialog — dismiss and retry once.
      await dismissPopups();
      const el = await waitFor(() => findDialogButton(labels), 15000, name);
      clickEl(el);
    }
  }

  async function clickNext() {
    await clickDialogButton(['下一步', 'Next'], '下一步');
  }

  async function clickShare() {
    await clickDialogButton(['分享', 'Share'], '分享');
  }

  /**
   * Fill IG's Lexical caption editor. DOM textContent having text does NOT
   * mean Lexical internal state has it — submit can still send empty.
   * Strategy 1: single beforeinput insertText (Lexical's input handler)
   * Strategy 2: ClipboardEvent paste (some versions only honour onPaste)
   * Strategy 3: char-by-char typing (Lexical can't miss it)
   * Then force-commit: input event + blur/focus so React reconciles state.
   */
  async function fillCaption(caption) {
    const dlg = $dialog();
    const ed = await waitFor(() => {
      const scope = dlg || document;
      return scope.querySelector('div[aria-label*="說明" i][contenteditable="true"]')
        || scope.querySelector('div[aria-label*="caption" i][contenteditable="true"]')
        || scope.querySelector('div[contenteditable="true"][role="textbox"]');
    }, 8000, 'caption editor');

    clickEl(ed);
    await sleep(300);
    ed.focus();
    await sleep(300);

    // Clear existing content via Lexical-compatible beforeinput
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
    await sleep(100);
    ed.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'deleteContentBackward',
    }));
    await sleep(200);
    sel.collapseToStart();

    // Strategy 1: full-string insertText
    ed.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: caption,
    }));
    await sleep(600);
    let filled = ed.textContent && ed.textContent.trim().length > 0;

    // Strategy 2: clipboard paste
    if (!filled) {
      ed.focus();
      sel.collapseToStart();
      const dt = new DataTransfer();
      dt.setData('text/plain', caption);
      ed.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: dt,
      }));
      await sleep(500);
      filled = ed.textContent && ed.textContent.trim().length > 0;
    }

    // Strategy 3: char-by-char
    if (!filled) {
      ed.focus();
      sel.collapseToStart();
      for (const ch of caption) {
        ed.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true, cancelable: true, inputType: 'insertText', data: ch,
        }));
        await sleep(8);
      }
      await sleep(300);
    }

    // Force Lexical to commit state (DOM has text ≠ Lexical state has text)
    ed.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: false, inputType: 'insertText', data: '',
    }));
    await sleep(300);
    ed.blur();
    await sleep(300);
    ed.focus();
    await sleep(500);

    if ((ed.textContent || '').trim().length === 0) {
      // Last resort: retry char-by-char once more
      ed.focus();
      window.getSelection().collapseToStart();
      for (const ch of caption) {
        ed.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true, cancelable: true, inputType: 'insertText', data: ch,
        }));
        await sleep(10);
      }
      await sleep(500);
      ed.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: false, inputType: 'insertText', data: '',
      }));
      await sleep(300);
      if ((ed.textContent || '').trim().length === 0) {
        throw new Error('Lexical caption 填入失敗（三策略皆空）');
      }
    }
  }

  /**
   * After 分享: watch for explicit error/success keywords in the dialog.
   * Absence of error within window == success (share is already committed;
   * post-publish SPA navigation makes waiting for confirmation unreliable).
   */
  async function waitForShared() {
    const OK = ['已分享', '貼文已分享', '貼文已發布', '分享成功', '已發布',
      'has been shared', 'Your post has been shared', 'Your reel has been shared'];
    const ERR = ['出了點問題', '發生錯誤', '無法分享', '無法發佈', '請再試一次',
      'Something went wrong', "couldn't be shared", 'Try again', 'Error'];
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const dlg = $dialog();
      const text = dlg ? dlg.textContent : '';
      if (text) {
        if (ERR.some(k => text.includes(k))) return 'error';
        if (OK.some(k => text.includes(k))) return 'confirmed';
      }
      await sleep(400);
    }
    return 'timeout';
  }

  let step = 'wait_processing';
  try {
    // Give IG time to process the injected file
    await sleep(${isVideo ? 5000 : 4000});
    await dismissPopups();

    // Crop → 原始 aspect. Layout sometimes skips this screen — non-fatal.
    step = 'select_crop';
    try {
      const dlg = $dialog();
      const crop = await waitFor(
        () => $byAria('選擇「裁切」', dlg) || $byAria('Select crop', dlg)
          || $byAria('裁切', dlg) || $byAria('Crop', dlg)
          || (dlg || document).querySelector('[aria-label*="裁切"]')
          || (dlg || document).querySelector('[aria-label*="crop" i]')
          || (dlg || document).querySelector('svg[aria-label*="裁切"]')?.closest('button, [role="button"]')
          || (dlg || document).querySelector('svg[aria-label*="crop" i]')?.closest('button, [role="button"]'),
        10000, 'crop selector'
      );
      clickEl(crop);
      await sleep(800);

      step = 'select_original';
      const orig = await waitFor(() => $byText('原始') || $byText('Original'), 5000, '原始');
      clickEl(orig);
      await sleep(1500);

      // Dismiss crop panel by clicking the preview area
      const dlg2 = $dialog();
      const preview = dlg2
        ? (dlg2.querySelector('video') || dlg2.querySelector('img') || dlg2.querySelector('div[style*="padding"]'))
        : null;
      if (preview) clickEl(preview);
      await sleep(1000);
    } catch (_) { /* crop UI absent — continue to 下一步 */ }

    step = 'next_1';
    await clickNext();
    await sleep(3000);

    step = 'next_2';
    await clickNext();
    await sleep(2000);

    step = 'fill_caption';
    await fillCaption(CAPTION);
    await sleep(3000); // let Lexical truly commit before share

    step = 'click_share';
    await clickShare();

    step = 'wait_for_shared';
    const verdict = await waitForShared();
    if (verdict === 'error') {
      return JSON.stringify({ ok: false, step, error: 'IG 在分享後回報錯誤' });
    }

    // Cleanup: only ever click 完成/Done (appears on success). Never click X —
    // mid-publish X triggers the discard dialog. Fire-and-forget.
    (async () => {
      try {
        const done = await waitFor(() => $byText('完成') || $byText('Done'), 20000, '');
        clickEl(done);
      } catch (_) { /* leave it — next run's clean-state handles residue */ }
    })();

    return JSON.stringify({ ok: true, verdict });
  } catch (e) {
    return JSON.stringify({ ok: false, step, error: (e && e.message) || String(e) });
  }
})()
`
}

// ─────────────────────────────────────────────────────────
// Node-side driver
// ─────────────────────────────────────────────────────────

interface PhaseResult {
  readonly ok: boolean
  readonly step?: string
  readonly error?: string
  readonly verdict?: string
}

interface EvalResponse {
  readonly exceptionDetails?: {
    readonly exception?: { readonly description?: string }
    readonly text?: string
  }
  readonly result?: { readonly value?: unknown }
}

async function evalPhase(client: CdpClient, expression: string, timeoutMs: number): Promise<PhaseResult> {
  const res = await client.send<EvalResponse>(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    timeoutMs,
  )
  if (res.exceptionDetails) {
    const desc = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'page exception'
    return { ok: false, step: 'eval', error: desc.slice(0, 300) }
  }
  try {
    return JSON.parse(String(res.result?.value)) as PhaseResult
  } catch {
    return { ok: false, step: 'eval', error: `unexpected eval result: ${String(res.result?.value).slice(0, 200)}` }
  }
}

const VIDEO_EXT_RE = /\.(mp4|mov|m4v|webm)$/i

/** Connect to the IG tab (launching Chrome with CDP if needed). */
async function connectIgTab(): Promise<CdpClient> {
  await ensureChromeCdp()
  const target = await findOrOpenPage(IG_URL_RE, IG_URL)
  return CdpClient.connect(target.webSocketDebuggerUrl!)
}

/**
 * Resume a stuck create-post flow from the CURRENT screen state (crop step
 * or later). Skips create/inject — runs crop → 下一步×2 → caption → 分享.
 * For when a one-time popup interrupted a run and the user dismissed it.
 */
export async function runIgCdpResume(caption: string): Promise<IgPostResult> {
  const started = Date.now()
  let client: CdpClient
  try {
    client = await connectIgTab()
  } catch (err) {
    return {
      success: false,
      duration_s: (Date.now() - started) / 1000,
      error: err instanceof Error ? err.message : String(err),
      step: 'cdp_connect',
    }
  }

  try {
    await client.send('Page.bringToFront', {}, 5000).catch(() => { /* non-fatal */ })
    const p3 = await evalPhase(client, buildPhase3Script(caption, false), PHASE3_TIMEOUT_MS)
    if (!p3.ok) {
      return {
        success: false,
        duration_s: (Date.now() - started) / 1000,
        error: p3.error ?? 'resume failed',
        step: p3.step ?? 'phase3',
      }
    }
    return { success: true, duration_s: (Date.now() - started) / 1000 }
  } finally {
    client.close()
  }
}

/**
 * Post a single video/image to Instagram through the CDP-controlled Chrome.
 * filePath must be an absolute local path; caption is plain text.
 */
export async function runIgCdpPost(filePath: string, caption: string): Promise<IgPostResult> {
  const started = Date.now()
  const fail = (step: string, error: string): IgPostResult => ({
    success: false,
    duration_s: (Date.now() - started) / 1000,
    error,
    step,
  })

  // 1+2. Chrome with CDP up + connected to the IG tab
  let client: CdpClient
  try {
    client = await connectIgTab()
  } catch (err) {
    return fail('cdp_connect', err instanceof Error ? err.message : String(err))
  }

  try {
    // 3. Foreground the tab — Lexical ignores input events on hidden tabs
    await client.send('Page.bringToFront', {}, 5000).catch(() => { /* non-fatal */ })

    // 4. Phase 1: open create dialog, tag the file input
    const p1 = await evalPhase(client, PHASE1_SCRIPT, PHASE1_TIMEOUT_MS)
    if (!p1.ok) return fail(p1.step ?? 'phase1', p1.error ?? 'phase1 failed')

    // 5. Phase 2: protocol-level file injection (no blob fetch needed)
    try {
      const doc = await client.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 1 }, 10_000)
      const node = await client.send<{ nodeId: number }>(
        'DOM.querySelector',
        { nodeId: doc.root.nodeId, selector: 'input[data-igflow="1"]' },
        10_000,
      )
      if (!node.nodeId) return fail('inject_file', '找不到已標記的 file input')
      await client.send('DOM.setFileInputFiles', { files: [filePath], nodeId: node.nodeId }, 30_000)
    } catch (err) {
      return fail('inject_file', err instanceof Error ? err.message : String(err))
    }

    // 6. Phase 3: crop → next×2 → caption → share → confirm
    const p3 = await evalPhase(
      client,
      buildPhase3Script(caption, VIDEO_EXT_RE.test(filePath)),
      PHASE3_TIMEOUT_MS,
    )
    if (!p3.ok) return fail(p3.step ?? 'phase3', p3.error ?? 'phase3 failed')

    return { success: true, duration_s: (Date.now() - started) / 1000 }
  } finally {
    client.close()
  }
}
