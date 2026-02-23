import type { Plugin } from '../../types/plugin.js'
import { screenshotCommand } from './screenshot-command.js'

const screenshotPlugin: Plugin = {
  name: 'screenshot',
  description: '桌面與網頁截圖',
  commands: [
    {
      name: 'screenshot',
      description: '截取畫面 (1-9/list/URL)',
      handler: screenshotCommand,
    },
  ],
}

export default screenshotPlugin
