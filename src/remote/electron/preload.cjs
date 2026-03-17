/**
 * Electron preload script (CJS) — bridges main ↔ renderer via contextBridge.
 *
 * Plain JS to avoid ESM/CJS compilation issues with Electron's sandbox.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // --- Remote Agent mode ---
  connect: (relayUrl, code, baseDir) =>
    ipcRenderer.invoke('connect', relayUrl, code, baseDir),

  disconnect: () =>
    ipcRenderer.invoke('disconnect'),

  onLog: (callback) => {
    const handler = (_event, message) => callback(message)
    ipcRenderer.on('log', handler)
    return () => ipcRenderer.removeListener('log', handler)
  },

  onStatus: (callback) => {
    const handler = (_event, status) => callback(status)
    ipcRenderer.on('status', handler)
    return () => ipcRenderer.removeListener('status', handler)
  },

  // --- Chat Client mode ---
  chatConnect: (relayUrl, code) =>
    ipcRenderer.invoke('chat-connect', relayUrl, code),

  sendMessage: (text) =>
    ipcRenderer.invoke('send-message', text),

  sendCallback: (data, msgId) =>
    ipcRenderer.invoke('send-callback', data, msgId),

  onChatMessage: (callback) => {
    const handler = (_event, msg) => callback(msg)
    ipcRenderer.on('chat:message', handler)
    return () => ipcRenderer.removeListener('chat:message', handler)
  },

  onChatEdit: (callback) => {
    const handler = (_event, msg) => callback(msg)
    ipcRenderer.on('chat:edit', handler)
    return () => ipcRenderer.removeListener('chat:edit', handler)
  },

  onChatDelete: (callback) => {
    const handler = (_event, msg) => callback(msg)
    ipcRenderer.on('chat:delete', handler)
    return () => ipcRenderer.removeListener('chat:delete', handler)
  },

  onChatStatus: (callback) => {
    const handler = (_event, msg) => callback(msg)
    ipcRenderer.on('chat:status', handler)
    return () => ipcRenderer.removeListener('chat:status', handler)
  },

  // --- Window controls ---
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  closeWindow: () => ipcRenderer.invoke('window-close'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('toggle-always-on-top'),
  toggleCompact: () => ipcRenderer.invoke('toggle-compact'),
})
