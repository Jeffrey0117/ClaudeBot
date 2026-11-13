/**
 * Runs `onIdle` once nothing has called `touch()` for `idleMs`.
 *
 * Used to release things that are expensive to keep but cheap enough to bring
 * back (a loaded speech model). `isBusy` lets the owner veto the release while
 * work is still in flight; the countdown then simply starts over.
 * An `idleMs` of 0 or less disables the timer.
 */

export interface IdleTimer {
  readonly touch: () => void
  readonly cancel: () => void
}

export function createIdleTimer(idleMs: number, onIdle: () => void, isBusy: () => boolean = () => false): IdleTimer {
  let timer: ReturnType<typeof setTimeout> | null = null

  const cancel = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const touch = (): void => {
    cancel()
    if (idleMs <= 0) return
    timer = setTimeout(() => {
      timer = null
      if (isBusy()) {
        touch()
        return
      }
      onIdle()
    }, idleMs)
    timer.unref?.()
  }

  return { touch, cancel }
}
