/**
 * Tool dispatch hub for remote agent operations.
 * Constants, ToolDispatcher interface, and createToolDispatcher.
 * Re-exports createPathValidator for external consumers.
 */

import { createPathValidator } from './path-validator.js'
import { handleReadFile, handleWriteFile, handleListDirectory, handleSearchFiles, handleFetchFile, handlePushFile, handleListProjects } from './file-tools.js'
import { handleExecuteCommand, handleGrep, handleSystemInfo, handleProjectOverview } from './exec-tools.js'
import { handleBrowserOpen, handleBrowserSnapshot, handleBrowserClick, handleBrowserFill, handleBrowserPress, handleBrowserScreenshot, handleBrowserBack, handleBrowserGetUrl, handleBrowserConnect, handleSpawnDetached } from './browser-tools.js'

export { createPathValidator } from './path-validator.js'

export const MAX_FILE_SIZE = 500 * 1024
export const MAX_TRANSFER_SIZE = 20 * 1024 * 1024 // 20 MB for file transfer
export const EXEC_TIMEOUT_MS = 120_000
export const MAX_OUTPUT_SIZE = 1024 * 1024 // 1 MB output cap
export const MAX_SEARCH_RESULTS = 50
export const IS_WIN = process.platform === 'win32'

export interface ToolDispatcher {
  dispatch(tool: string, args: Record<string, unknown>): Promise<string>
}

export function createToolDispatcher(baseDir: string): ToolDispatcher {
  const validatePath = createPathValidator(baseDir)

  return {
    async dispatch(tool: string, args: Record<string, unknown>): Promise<string> {
      switch (tool) {
        case 'remote_read_file': return handleReadFile(args, validatePath)
        case 'remote_write_file': return handleWriteFile(args, validatePath, baseDir)
        case 'remote_list_directory': return handleListDirectory(args, validatePath)
        case 'remote_search_files': return handleSearchFiles(args, validatePath, baseDir)
        case 'remote_execute_command': return handleExecuteCommand(args, validatePath, baseDir)
        case 'remote_grep': return handleGrep(args, validatePath, baseDir)
        case 'remote_system_info': return handleSystemInfo(baseDir)
        case 'remote_project_overview': return handleProjectOverview(args, validatePath, baseDir)
        case 'remote_fetch_file': return handleFetchFile(args, validatePath)
        case 'remote_push_file': return handlePushFile(args, validatePath)
        case 'remote_list_projects': return handleListProjects(baseDir)
        case 'ab_open': return handleBrowserOpen(args)
        case 'ab_snapshot': return handleBrowserSnapshot()
        case 'ab_click': return handleBrowserClick(args)
        case 'ab_fill': return handleBrowserFill(args)
        case 'ab_press': return handleBrowserPress(args)
        case 'ab_screenshot': return handleBrowserScreenshot()
        case 'ab_back': return handleBrowserBack()
        case 'ab_get_url': return handleBrowserGetUrl()
        case 'ab_connect_browser': return handleBrowserConnect()
        case 'remote_spawn_detached': return handleSpawnDetached(args, baseDir)
        default: throw new Error(`Unknown tool: ${tool}`)
      }
    },
  }
}
