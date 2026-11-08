// Small enhancements. Every page reads fine without this file: search, the mobile menu and Copy buttons are the only things it adds.
(function () {
  var side = document.getElementById('side'), btn = document.querySelector('.menu')
  if (btn && side) btn.addEventListener('click', function () {
    var open = side.classList.toggle('open'); btn.setAttribute('aria-expanded', open ? 'true' : 'false'); btn.textContent = open ? 'Close' : 'Menu'
  })
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.copy'); if (!b) return
    var code = b.closest('.code').querySelector('code').textContent
    var done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy' }, 1500) }
    if (navigator.clipboard) navigator.clipboard.writeText(code).then(done, function () { b.textContent = 'Press Ctrl+C' })
  })

  var q = document.getElementById('q'), box = document.getElementById('results'), index = null, cur = -1
  if (!q || !box) return
  function load() {
    if (index) return Promise.resolve(index)
    return fetch('/search.json').then(function (r) { return r.json() }).then(function (j) { index = j; return j }, function () { index = []; return index })
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] }) }
  function score(p, words) {
    var t = p.t.toLowerCase(), hs = p.h.map(function (h) { return h.t.toLowerCase() }), x = p.x.toLowerCase(), s = 0
    for (var i = 0; i < words.length; i++) {
      var w = words[i], hit = 0
      if (t.indexOf(w) > -1) { s += 30; hit = 1 }
      for (var j = 0; j < hs.length; j++) if (hs[j].indexOf(w) > -1) { s += 12; hit = 1; break }
      if (x.indexOf(w) > -1) { s += 3; hit = 1 }
      if (!hit) return 0
    }
    return s
  }
  function find(p, words) {
    for (var j = 0; j < p.h.length; j++) { var h = p.h[j].t.toLowerCase(); if (words.every(function (w) { return h.indexOf(w) > -1 })) return p.h[j] }
    return null
  }
  function show(list) {
    cur = -1
    if (!list) { box.hidden = true; box.innerHTML = ''; return }
    box.hidden = false
    box.innerHTML = list.length ? list.map(function (r) { return '<li><a href="' + r.href + '"><span>' + esc(r.t) + '</span><small>' + esc(r.s) + '</small></a></li>' }).join('') : '<li class="none">Nothing found. Try one word, such as shop, mandate or signer.</li>'
  }
  function run() {
    var words = q.value.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return show(null)
    load().then(function (idx) {
      var rs = idx.map(function (p) { return { p: p, s: score(p, words) } }).filter(function (r) { return r.s > 0 }).sort(function (a, b) { return b.s - a.s }).slice(0, 8)
      show(rs.map(function (r) { var h = find(r.p, words); return { href: r.p.u + (h ? '#' + h.id : ''), t: h ? r.p.t + ' › ' + h.t : r.p.t, s: r.p.s } }))
    })
  }
  q.addEventListener('focus', load)
  q.addEventListener('input', run)
  q.addEventListener('keydown', function (e) {
    var items = box.querySelectorAll('a')
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!items.length) return
      cur = (cur + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items.forEach(function (a, i) { a.classList.toggle('on', i === cur) })
    } else if (e.key === 'Enter' && items.length) { items[Math.max(cur, 0)].click() }
    else if (e.key === 'Escape') { show(null); q.blur() }
  })
  document.addEventListener('click', function (e) { if (!e.target.closest('.search')) show(null) })
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== q && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); q.focus() }
  })
})()
