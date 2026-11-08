/**
 * Shell-command blacklist for the remote tools.
 *
 * Deliberately a LEAF module — it imports nothing local. index.ts exports the
 * shared constants while also importing every tool module, and each tool module
 * imports those constants back from index.js, so the directory is already one
 * big import cycle. Having browser-tools pull this check straight out of
 * exec-tools added a sibling edge to that cycle and changed module
 * initialization order enough to trip a TDZ error on IS_WIN. Keeping the
 * blacklist dependency-free lets every tool share it without touching the order.
 */

const DANGEROUS_PATTERNS: readonly RegExp[] = [
  // Destructive file operations
  /rm\s+(-[a-z]*r[a-z]*\s+(-[a-z]*f[a-z]*\s+)?|(-[a-z]*f[a-z]*\s+)?-[a-z]*r[a-z]*\s+)[/\\]/i,
  /\brm\s+-rf\s+\/(?!\w)/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /\bdd\s+if=\/dev\/(zero|random)/i,
  // Fork bombs
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;?\s*:/,
  /\bfork\s*bomb/i,
  // Kill node/electron processes (blocks all variants)
  /taskkill\s+[/\\]+f\s+[/\\]+im\s+(node|electron)\.exe/i,
  /Get-Process\s+(node|electron)\s*\|\s*Stop-Process/i,
  /Stop-Process\s+-Name\s+(node|electron)/i,
  /\bpkill\s+(node|electron)\b/i,
  /\bkillall\s+(node|electron)\b/i,
  // System shutdown/reboot
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\binit\s+[06]\b/,
  // Flag-order-tolerant destructive variants the original patterns miss
  /\brm\s+(?=[^\n]*\s-\w*r)(?=[^\n]*\s-\w*f)/i,          // rm … -r … -f (any order, split flags)
  /\bdel\s+(?=[^\n]*\/s)(?=[^\n]*\/q)/i,                  // del /s /q (any order)
  /\b(?:rd|rmdir)\s+(?:\/\w+\s+)*\/s\b/i,                 // rd /s, rmdir /q /s
  /Remove-Item\b(?=[^\n]*-Recurse)(?=[^\n]*-Force)/i,     // PS recursive force delete
  /\bvssadmin\s+delete/i,                                 // shadow copy wipe
  /\bcipher\s+\/w/i,                                      // free-space wipe
  /\breg\s+(?:delete|add)\s+HKLM/i,                       // machine-level registry edits
  /\bbcdedit\b/i,
  /\bdiskpart\b/i,
  /\bwevtutil\s+cl\b/i,                                   // event-log clearing
]

/** Returns a reason string when the command is blacklisted, else null. */
export function isDangerousCommand(command: string): string | null {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked dangerous command matching: ${pattern.source}`
    }
  }
  return null
}
