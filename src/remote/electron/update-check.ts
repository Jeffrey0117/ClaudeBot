import { app, dialog, shell } from 'electron'
import { isNewerVersion } from './version-compare.js'

export interface UpdateCheckDeps {
  /** Version we last offered, so we ask once per version. */
  readonly getLastNotifiedVersion: () => string | undefined
  readonly setLastNotifiedVersion: (version: string) => void
  readonly log: (message: string) => void
}

/**
 * Tell the user when a newer build exists.
 *
 * electron-builder already emits release/latest.yml, but nothing consumed it
 * and there is no publish target, so anyone who installed the app stayed on
 * that version forever — every fix meant hand-delivering a ~150MB installer
 * again. A friend running a build from weeks ago will hit bugs that were
 * already fixed and have no way to know.
 *
 * This is a notifier, not a silent self-updater: it reads the public GitHub
 * releases feed and offers to open the release page. No extra dependency, so
 * there is nothing that can fail to bundle — full background auto-update needs
 * electron-updater plus a signed build and a real release to validate.
 */
export async function checkForUpdate(deps: UpdateCheckDeps): Promise<void> {
  if (!app.isPackaged) return
  try {
    const res = await fetch(
      'https://api.github.com/repos/Jeffrey0117/ClaudeBot/releases/latest',
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ClaudeBot-Desktop' },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) {
      deps.log(`[update] check skipped: HTTP ${res.status}`)
      return
    }
    const rel = (await res.json()) as { tag_name?: string; html_url?: string; name?: string }
    const latest = rel.tag_name ?? rel.name
    if (!latest) return
    const current = app.getVersion()
    if (!isNewerVersion(latest, current)) {
      deps.log(`[update] up to date (${current})`)
      return
    }
    // Ask once per version. Nagging on every launch is how a friend learns to
    // dismiss the dialog without reading it.
    if (deps.getLastNotifiedVersion() === latest) {
      deps.log(`[update] ${latest} already offered — not asking again`)
      return
    }
    deps.setLastNotifiedVersion(latest)

    deps.log(`[update] newer version available: ${latest} (running ${current})`)
    const choice = await dialog.showMessageBox({
      type: 'info',
      title: 'ClaudeBot 有新版本',
      message: `新版本 ${latest} 可以更新（你現在是 ${current}）`,
      detail: '點「前往下載」會開啟下載頁面，裝好新版即可。',
      buttons: ['前往下載', '稍後再說'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice.response === 0 && rel.html_url) {
      await shell.openExternal(rel.html_url)
    }
  } catch (err) {
    // Never block startup on the update check
    deps.log(`[update] check failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
