document.addEventListener('DOMContentLoaded', function () {
  var searchInput = document.getElementById('command-search')
  var filterButtons = document.querySelectorAll('.command-filter')
  var tableBody = document.getElementById('command-table-body')
  var activeCategory = 'all'

  var ACTIVE_CLASSES = ['bg-ink', 'text-white']
  var INACTIVE_CLASSES = ['bg-white', 'text-slate-500', 'border', 'border-slate-200', 'hover:border-slate-300']

  function getRows() {
    return tableBody ? Array.from(tableBody.querySelectorAll('tr')) : []
  }

  function applyFilters() {
    var searchText = (searchInput ? searchInput.value : '').toLowerCase().trim()
    var rows = getRows()
    var visibleCount = 0

    rows.forEach(function (row) {
      var commandCell = row.querySelector('td:first-child')
      var descriptionCell = row.querySelector('td:nth-child(2)')
      var commandText = commandCell ? commandCell.textContent.toLowerCase() : ''
      var descriptionText = descriptionCell ? descriptionCell.textContent.toLowerCase() : ''
      var rowCategory = row.getAttribute('data-category') || ''

      var matchesSearch = searchText === '' ||
        commandText.indexOf(searchText) !== -1 ||
        descriptionText.indexOf(searchText) !== -1

      var matchesCategory = activeCategory === 'all' || rowCategory === activeCategory

      var isVisible = matchesSearch && matchesCategory

      if (isVisible) {
        row.style.display = ''
        row.style.opacity = '1'
        visibleCount++
      } else {
        row.style.opacity = '0'
        row.style.display = 'none'
      }
    })

    updateNoResultsMessage(visibleCount === 0 && rows.length > 0)
  }

  function updateNoResultsMessage(show) {
    var existingMessage = document.getElementById('no-results-message')

    if (show && !existingMessage && tableBody) {
      var colCount = tableBody.closest('table')
        ? tableBody.closest('table').querySelectorAll('thead th').length || 3
        : 3
      var row = document.createElement('tr')
      row.id = 'no-results-message'
      var cell = document.createElement('td')
      cell.setAttribute('colspan', String(colCount))
      cell.style.textAlign = 'center'
      cell.style.padding = '2rem 1rem'
      cell.style.color = '#9ca3af'
      cell.textContent = 'No matching commands found.'
      row.appendChild(cell)
      tableBody.appendChild(row)
    } else if (!show && existingMessage) {
      existingMessage.remove()
    }
  }

  function setActiveButton(activeButton) {
    filterButtons.forEach(function (btn) {
      ACTIVE_CLASSES.forEach(function (cls) { btn.classList.remove(cls) })
      INACTIVE_CLASSES.forEach(function (cls) { btn.classList.add(cls) })
    })

    INACTIVE_CLASSES.forEach(function (cls) { activeButton.classList.remove(cls) })
    ACTIVE_CLASSES.forEach(function (cls) { activeButton.classList.add(cls) })
  }

  if (searchInput) {
    searchInput.addEventListener('input', function () {
      applyFilters()
    })
  }

  filterButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      activeCategory = btn.getAttribute('data-filter') || 'all'
      setActiveButton(btn)
      applyFilters()
    })
  })

  // Add transition styles to rows for smooth animation
  getRows().forEach(function (row) {
    row.style.transition = 'opacity 0.15s ease'
  })
})
