document.addEventListener('DOMContentLoaded', function () {
  var REGISTRY_URL = 'https://raw.githubusercontent.com/Jeffrey0117/claudebot-plugins/master/registry.json'

  var fallbackPlugins = [
    { name: 'dice', description: '擲骰子遊戲', descriptionEn: 'Dice game', commands: [{ name: 'dice', description: '擲骰子' }], author: 'Jeffrey' },
    { name: 'coin', description: '擲硬幣', descriptionEn: 'Coin flip', commands: [{ name: 'coin', description: '擲硬幣' }], author: 'Jeffrey' },
    { name: 'reminder', description: '定時提醒', descriptionEn: 'Scheduled reminders', commands: [{ name: 'reminder', description: '設定提醒' }], author: 'Jeffrey' },
    { name: 'calc', description: '計算機', descriptionEn: 'Calculator', commands: [{ name: 'calc', description: '計算數學表達式' }], author: 'Jeffrey' },
    { name: 'search', description: '網路搜尋', descriptionEn: 'Web search', commands: [{ name: 'search', description: '搜尋網路' }], author: 'Jeffrey' },
    { name: 'browse', description: '網頁瀏覽', descriptionEn: 'Web browsing', commands: [{ name: 'browse', description: '瀏覽網頁' }], author: 'Jeffrey' },
    { name: 'screenshot', description: '網頁截圖', descriptionEn: 'Web screenshot', commands: [{ name: 'screenshot', description: '截取網頁' }], author: 'Jeffrey' },
    { name: 'cost', description: 'AI 費用追蹤', descriptionEn: 'AI cost tracking', commands: [{ name: 'cost', description: '查看費用' }], author: 'Jeffrey' },
    { name: 'github', description: 'GitHub Star 通知', descriptionEn: 'GitHub Star notifications', commands: [{ name: 'star', description: 'Star 通知' }], author: 'Jeffrey' },
    { name: 'mcp', description: 'MCP 伺服器管理', descriptionEn: 'MCP server management', commands: [{ name: 'mcp', description: 'MCP 管理' }], author: 'Jeffrey' },
    { name: 'scheduler', description: '排程任務', descriptionEn: 'Scheduled tasks', commands: [{ name: 'scheduler', description: '排程管理' }], author: 'Jeffrey' },
    { name: 'sysinfo', description: '系統資訊', descriptionEn: 'System information', commands: [{ name: 'sysinfo', description: '系統資訊' }], author: 'Jeffrey' },
    { name: 'stats', description: '使用統計', descriptionEn: 'Usage statistics', commands: [{ name: 'stats', description: '統計數據' }], author: 'Jeffrey' },
  ]

  var pluginGrid = document.getElementById('plugin-grid')
  var searchInput = document.getElementById('plugin-search')
  var allPlugins = []

  function getCurrentLangSafe() {
    if (typeof getCurrentLang === 'function') {
      return getCurrentLang()
    }
    return document.documentElement.lang || 'zh'
  }

  function getDescription(plugin) {
    var lang = getCurrentLangSafe()
    if (lang === 'en' && plugin.descriptionEn) {
      return plugin.descriptionEn
    }
    return plugin.description || ''
  }

  function getAuthorLabel() {
    var lang = getCurrentLangSafe()
    return lang === 'en' ? 'Author' : '作者'
  }

  function renderCard(plugin) {
    var firstLetter = (plugin.name || '?').charAt(0).toUpperCase()
    var description = getDescription(plugin)
    var commands = plugin.commands || []
    var author = plugin.author || 'Unknown'

    var commandBadges = commands.map(function (cmd) {
      return '<span class="px-2 py-1 bg-blue-50 text-blue-700 rounded-md text-xs font-mono">/' + escapeHtml(cmd.name) + '</span>'
    }).join('\n    ')

    return '<div class="plugin-card bg-white rounded-xl p-6 shadow-sm border border-gray-100 hover:shadow-md transition-all duration-300" data-name="' + escapeAttr(plugin.name) + '" data-description="' + escapeAttr(description) + '">' +
      '<div class="flex items-center gap-3 mb-3">' +
        '<div class="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-white font-bold text-lg">' +
          escapeHtml(firstLetter) +
        '</div>' +
        '<h3 class="font-semibold text-gray-900 text-lg">' + escapeHtml(plugin.name) + '</h3>' +
      '</div>' +
      '<p class="text-gray-600 text-sm mb-4">' + escapeHtml(description) + '</p>' +
      '<div class="flex flex-wrap gap-2 mb-3">' +
        commandBadges +
      '</div>' +
      '<div class="text-xs text-gray-400">' +
        '<span data-i18n="plugins_author">' + escapeHtml(getAuthorLabel()) + '</span>: ' + escapeHtml(author) +
      '</div>' +
    '</div>'
  }

  function renderPlugins(plugins) {
    if (!pluginGrid) return
    pluginGrid.innerHTML = plugins.map(renderCard).join('')
  }

  function filterPlugins() {
    if (!searchInput || !pluginGrid) return
    var query = searchInput.value.toLowerCase().trim()
    var cards = pluginGrid.querySelectorAll('.plugin-card')

    cards.forEach(function (card) {
      var name = (card.getAttribute('data-name') || '').toLowerCase()
      var description = (card.getAttribute('data-description') || '').toLowerCase()
      var matches = query === '' || name.indexOf(query) !== -1 || description.indexOf(query) !== -1

      card.style.display = matches ? '' : 'none'
    })
  }

  function escapeHtml(str) {
    var div = document.createElement('div')
    div.appendChild(document.createTextNode(str))
    return div.innerHTML
  }

  function escapeAttr(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }

  function hideLoading() {
    var loadingEl = document.getElementById('plugin-loading')
    if (loadingEl) loadingEl.style.display = 'none'
  }

  function showError() {
    var errorEl = document.getElementById('plugin-error')
    if (errorEl) errorEl.classList.remove('hidden')
  }

  function loadPlugins() {
    fetch(REGISTRY_URL)
      .then(function (response) {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status)
        }
        return response.json()
      })
      .then(function (data) {
        hideLoading()
        allPlugins = Array.isArray(data) ? data : (data.plugins || [])
        renderPlugins(allPlugins)
      })
      .catch(function () {
        hideLoading()
        showError()
        allPlugins = fallbackPlugins
        renderPlugins(allPlugins)
      })
  }

  if (searchInput) {
    searchInput.addEventListener('input', function () {
      filterPlugins()
    })
  }

  loadPlugins()
})
