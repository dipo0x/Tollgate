'use strict'
// The owner's dashboard. No framework, no build step. Anything that came from outside (a merchant's text, a listing, a check's
// evidence, a reason typed by a person) goes into the page ONLY as a text node, never as markup. Styles are set through the
// script API, never as an attribute, so the page's strict Content-Security-Policy (no inline anything) holds.

const KEY = 'tg-operator-token'
const SVG = 'http://www.w3.org/2000/svg'
const $ = s => document.querySelector(s)
const flat = a => a.reduce((x, y) => x.concat(Array.isArray(y) ? flat(y) : [y]), [])

function el(tag, props, ...kids) {
  const n = document.createElement(tag)
  for (const k of Object.keys(props || {})) {
    const v = props[k]
    if (k === 'style') throw new Error('an inline style attribute is blocked by the Content-Security-Policy: use vars or width')
    if (k === 'class') n.className = v
    else if (k === 'vars') for (const name of Object.keys(v)) n.style.setProperty(name, v[name])
    else if (k === 'width') n.style.width = v
    else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), v)
    else if (v !== undefined && v !== false && v !== null) n.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of flat(kids)) n.append(c instanceof Node ? c : document.createTextNode(c === undefined || c === null ? '' : String(c)))
  return n
}
function svg(tag, attrs, ...kids) {
  const n = document.createElementNS(SVG, tag)
  for (const k of Object.keys(attrs || {})) n.setAttribute(k, String(attrs[k]))
  for (const c of flat(kids)) n.append(c)
  return n
}
const ICONS = {
  overview: 'M3 3h8v8H3z M13 3h8v5h-8z M13 10h8v11h-8z M3 13h8v8H3z', decisions: 'M4 6h16 M4 12h16 M4 18h10', approvals: 'M9 12l2 2 4-4 M12 21a9 9 0 100-18 9 9 0 000 18z',
  mandates: 'M12 3l9 5-9 5-9-5 9-5z M3 13l9 5 9-5 M3 17l9 5 9-5', jobs: 'M4 7h16v12H4z M9 7V5h6v2 M4 12h16', services: 'M4 5h16v6H4z M4 13h16v6H4z M8 8h.01 M8 16h.01',
  audit: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1 M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1', shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
  wallet: 'M3 7h16a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z M3 7l2-3h11 M17 13h.01', out: 'M7 17L17 7 M8 7h9v9', lock: 'M6 11h12v9H6z M8 11V8a4 4 0 018 0v3', clock: 'M12 7v5l3 2 M12 21a9 9 0 100-18 9 9 0 000 18z',
}
function icon(name) { return svg('svg', { viewBox: '0 0 24 24', fill: 'none', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg('path', { d: ICONS[name] })) }

const KEYS = { current: 'overview', filter: 'all', query: '' }
let timer = null, status = null, approvals = [], lastLoad = 0
const PAGES = [['overview', 'Overview'], ['decisions', 'Decisions'], ['approvals', 'Approvals'], ['mandates', 'Mandates'], ['jobs', 'Jobs'], ['services', 'Services'], ['audit', 'Audit']]
const SUB = {
  overview: 'What your agents are spending, and what stopped them', decisions: 'Every payment request, with the checks that judged it', approvals: 'Payments waiting for you',
  mandates: 'The rules each agent works under, and their money', jobs: 'Work your agents were hired for, with what it earned and cost', services: 'What can be paid, and what has been verified', audit: 'A tamper-evident record of everything that happened',
}

const token = () => sessionStorage.getItem(KEY)
const num = v => Number(v || 0)
const money = v => num(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const short = s => { s = String(s || ''); return s.length > 15 ? s.slice(0, 8) + '…' + s.slice(-5) : s }
function when(iso) { try { return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) } catch (e) { return String(iso) } }
function hue(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return [h % 360, (h >>> 9) % 360] }
function avatar(seed, small) { const [a, b] = hue(seed); return el('span', { class: 'avatar' + (small ? ' sm' : ''), vars: { '--h1': String(a), '--h2': String(b) } }) }
function toast(msg) { const t = el('div', { class: 'toast', role: 'status' }, msg); document.body.append(t); setTimeout(() => t.remove(), 1500) }
// Copy text, wherever the dashboard is opened. The clipboard API exists only on https and localhost; on a plain-http network
// address (a phone-testing setup) it is missing, so fall back to a hidden textarea and execCommand('copy'). Resolves true or false.
function copyText(value) {
  const text = String(value)
  if (window.isSecureContext && navigator.clipboard) return navigator.clipboard.writeText(text).then(() => true, () => copyFallback(text))
  return Promise.resolve(copyFallback(text))
}
function copyFallback(text) {
  const ta = el('textarea', { readonly: true, 'aria-hidden': 'true', class: 'offscreen' })
  ta.value = text
  document.body.append(ta); ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch (e) { ok = false }
  ta.remove()
  return ok
}
function copyBtn(value) {
  return el('button', { type: 'button', class: 'copy', title: 'Copy', onclick: e => { e.stopPropagation(); copyText(value).then(ok => toast(ok ? 'Copied' : 'Copy failed')) } }, 'copy')
}
const addr = v => el('span', { class: 'addr', title: String(v) }, short(v), copyBtn(v))
// Public explorers this dashboard will link to. A stored link is still only data, so it is checked here before it becomes an
// href: https only, a known explorer host, no embedded credentials. Anything else gets no link; the hash itself is still shown.
const EXPLORER_HOSTS = ['nearblocks.io', 'etherscan.io', 'optimistic.etherscan.io', 'polygonscan.com', 'basescan.org', 'arbiscan.io']
function safeExplorer(url) {
  if (!url) return undefined
  try {
    const u = new URL(String(url))
    return u.protocol === 'https:' && EXPLORER_HOSTS.indexOf(u.hostname) >= 0 && !u.username && !u.password ? u.href : undefined
  } catch (e) { return undefined }
}
function explorerLink(url, text) {
  const safe = safeExplorer(url)
  return safe ? el('a', { class: 'exlink', href: safe, target: '_blank', rel: 'noopener noreferrer' }, text || ('View on ' + new URL(safe).hostname), icon('out')) : undefined
}
const tokenChip = c => el('span', { class: 'tok' }, el('i', null, '$'), c || 'USDC')
// The network the payment is made on, read from the decision itself: the signed bind, else check C04's evidence. Never assumed.
const NETS = { 'eip155:42161': ['A', 'Arbitrum', 'arb'], 'eip155:8453': ['B', 'Base', 'base'], near: ['N', 'NEAR', 'near'] }
const netChip = d => {
  const id = (d && d.bind && d.bind.chain) || ((d && d.checks) || []).filter(c => c.id === 'C04').map(c => c.evidence && c.evidence.network)[0]
  const n = NETS[id]
  return n ? el('span', { class: `net ${n[2]}` }, el('i', null, n[0]), n[1]) : el('span', { class: 'net' }, id ? String(id) : 'network unknown')
}

function label(d) {
  const m = { settled: ['Paid', 'ok'], allowed: ['Allowed', 'ok'], pending: ['Needs approval', 'ap'], rejected: ['Rejected', 'mu'], expired: ['Expired', 'mu'], released: ['Refunded', 'mu'], reserving: ['In flight', 'wn'] }
  return m[d.state] || (d.decision === 'DENY' ? ['Blocked', 'no'] : [d.state, 'mu'])
}
const pill = d => { const l = label(d); return el('span', { class: 'chip ' + l[1] }, l[0]) }
const groupOf = d => { const t = label(d)[0]; return t === 'Paid' || t === 'Allowed' ? 'paid' : t === 'Blocked' || t === 'Rejected' ? 'blocked' : t === 'Needs approval' ? 'approval' : 'other' }
const CHECK_IDS = Array.from({ length: 12 }, (_, i) => 'C' + String(i + 1).padStart(2, '0'))
function ribbon(checks) {
  return el('span', { class: 'ribbon', role: 'img', 'aria-label': 'Result of each of the twelve checks' }, CHECK_IDS.map(id => {
    const c = (checks || []).find(x => x.id === id)
    return el('i', { class: c ? c.result : 'none', title: c ? id + ' ' + c.name + ': ' + c.result : id + ': not run' })
  }))
}

function api(path, opts) {
  opts = opts || {}
  return fetch(path, { method: opts.method || 'GET', headers: Object.assign({ authorization: 'Bearer ' + token() }, opts.body ? { 'content-type': 'application/json' } : {}), body: opts.body ? JSON.stringify(opts.body) : undefined })
    .then(r => {
      if (r.status === 401 || r.status === 403) { signOut('That token was not accepted.'); throw new Error('unauthorized') }
      return r.json().then(j => { if (!r.ok) throw new Error((j && j.error && j.error.message) || ('HTTP ' + r.status)); return j })
    })
}

function signOut(msg) {
  sessionStorage.removeItem(KEY); clearInterval(timer); closeDrawer()
  $('#login').hidden = false; $('#app').hidden = true; $('#view').hidden = true; $('#tabs').replaceChildren()
  $('#loginError').textContent = msg || ''
}

// ---- chrome ---------------------------------------------------------------------------------------------------------------------
function paintChrome() {
  const frozen = !!(status && status.frozen)
  const s = $('#state'), b = $('#freeze')
  s.textContent = frozen ? 'FROZEN: nothing is paid' : 'Running'; s.className = 'pill ' + (frozen ? 'no' : 'ok')
  b.textContent = frozen ? 'Unfreeze' : 'Freeze all payments'; b.className = frozen ? 'good' : 'danger'
  b.onclick = () => {
    if (!frozen && !window.confirm('Freeze every payment now? Every request will be refused until you unfreeze.')) return
    b.disabled = true
    api(frozen ? '/v1/unfreeze' : '/v1/freeze', { method: 'POST' }).then(load).catch(showError).then(() => { b.disabled = false })
  }
  $('#storage').textContent = status ? (status.storage === 'postgres' ? 'Postgres' : 'In memory (demo)') : ''
  $('#signer').textContent = status ? (status.signer ? 'Signer attached' : 'No signer') : ''
  const pending = approvals.filter(a => a.status === 'pending').length
  $('#tabs').replaceChildren(...PAGES.map(p => el('button', { type: 'button', 'aria-current': KEYS.current === p[0], onclick: () => { KEYS.current = p[0]; load() } },
    icon(p[0]), p[1], p[0] === 'approvals' && pending ? el('span', { class: 'count' }, pending) : [])))
  $('#title').replaceChildren(PAGES.find(p => p[0] === KEYS.current)[1], el('span', { class: 'sub' }, ' · ' + SUB[KEYS.current]))
}
function showError(err) { $('#view').replaceChildren(el('div', { class: 'banner', role: 'alert' }, 'Something went wrong: ' + (err && err.message ? err.message : err))) }

// ---- drawer: one decision in full ---------------------------------------------------------------------------------------------
let drawer = null
function closeDrawer() { if (drawer) { drawer.scrim.remove(); drawer.panel.remove(); drawer = null } }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer() })
function gauge(risk) {
  const r = 52, len = Math.PI * r, v = Math.max(0, Math.min(100, num(risk)))
  const color = v >= 70 ? 'var(--no)' : v >= 40 ? 'var(--wn)' : 'var(--ok)'
  return svg('svg', { class: 'gauge', viewBox: '0 0 120 70', width: 150, height: 88, role: 'img', 'aria-label': 'Risk score ' + v + ' of 100' },
    svg('path', { d: 'M8 62 A52 52 0 0 1 112 62', fill: 'none', stroke: 'rgba(255,255,255,.1)', 'stroke-width': 10, 'stroke-linecap': 'round' }),
    svg('path', { d: 'M8 62 A52 52 0 0 1 112 62', fill: 'none', stroke: color, 'stroke-width': 10, 'stroke-linecap': 'round', 'stroke-dasharray': (len * v / 100) + ' ' + len }),
    (() => { const t = svg('text', { x: 60, y: 58, 'text-anchor': 'middle', fill: '#f1f3ff', 'font-size': 22, 'font-weight': 700, 'font-family': 'ui-monospace,monospace' }); t.append(document.createTextNode(String(v))); return t })())
}
function checkList(checks) {
  return el('ul', { class: 'checks' }, (checks || []).map(c => el('li', null, el('span', { class: 'id' }, c.id), el('span', null, c.name), el('span', { class: 'chip ' + ({ pass: 'ok', fail: 'no', warn: 'wn' }[c.result] || 'mu') }, c.result), el('pre', null, JSON.stringify(c.evidence)))))
}
/**
 * The transaction section of the drawer. The decision in the feed carries no transaction: the gateway only attaches `onchain`
 * (network, hash, payer, explorer link) to GET /v1/decisions/:id, once the signer has signed. So the drawer opens with an empty
 * placeholder and fills it from that one extra call. A decision that was blocked, or is still waiting, has nothing to fill in.
 */
function fillChain(panel, box, decisionId) {
  api('/v1/decisions/' + encodeURIComponent(decisionId)).then(full => {
    const o = full && full.onchain
    if (!drawer || drawer.panel !== panel || !o) return
    const link = explorerLink(o.explorer)
    box.replaceChildren(el('h3', null, 'On the blockchain'),
      el('dl', { class: 'kv' }, el('dt', null, 'Network'), el('dd', null, o.network), el('dt', null, 'Transaction'), el('dd', null, addr(o.txHash)), el('dt', null, 'Paid from'), el('dd', null, addr(o.from))),
      link || el('p', { class: 'muted' }, 'No public explorer is known for this chain, so there is no link. The transaction id is above.'),
      el('p', { class: 'muted' }, 'The link proves this transaction is on the chain. Whether the shop was paid is 1Click’s answer above, not the explorer’s.'))
  }).catch(() => {})
}
function openDrawer(d) {
  closeDrawer()
  const scrim = el('div', { class: 'scrim', onclick: closeDrawer })
  const chain = el('div', { class: 'chain' })
  const panel = el('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'Decision detail' },
    el('button', { type: 'button', class: 'close ghost', onclick: closeDrawer }, 'Close'),
    el('div', { class: 'row' }, avatar(d.host), el('div', null, el('div', { class: 'row wrap' }, pill(d), netChip(d)), el('div', { class: 'muted' }, d.host))),
    el('div', { class: 'row' }, el('span', { class: 'bignum' }, d.amount ? money(d.amount) : '—'), tokenChip(d.currency)),
    el('h3', null, 'Result of the twelve checks'), ribbon(d.checks),
    d.failedCheck ? el('p', { class: 'no' }, 'Stopped by ' + d.failedCheck + (d.reason ? ': ' + d.reason : '')) : (d.reason ? el('p', { class: 'muted' }, d.reason) : []),
    el('h3', null, 'Details'),
    el('dl', { class: 'kv' }, el('dt', null, 'Decision'), el('dd', null, addr(d.decisionId)), el('dt', null, 'Mandate'), el('dd', null, d.mandateId), el('dt', null, 'Agent'), el('dd', null, d.agentId),
      el('dt', null, 'Purpose'), el('dd', null, d.purpose || '—'), el('dt', null, 'Time (UTC)'), el('dd', { class: 'mono' }, when(d.createdAt)),
      d.depositAddress ? [el('dt', null, 'Deposit address'), el('dd', null, addr(d.depositAddress))] : [], d.bind ? [el('dt', null, 'Will be signed'), el('dd', { class: 'mono' }, d.bind.amount + ' ' + d.bind.asset + ' to ' + short(d.bind.to) + ' on ' + d.bind.chain)] : []),
    chain,
    d.risk !== undefined ? [el('h3', null, 'Risk score'), gauge(d.risk)] : [],
    el('h3', null, 'The checks, with their evidence'), checkList(d.checks))
  document.body.append(scrim, panel); drawer = { scrim, panel }
  if (d.decisionId) fillChain(panel, chain, d.decisionId)
}

// ---- charts ---------------------------------------------------------------------------------------------------------------------------
function ring(parts, centerTop, centerBottom) {
  const R = 54, C = 2 * Math.PI * R, total = parts.reduce((a, p) => a + p.v, 0) || 1
  let acc = 0
  const segs = parts.filter(p => p.v > 0).map(p => {
    const frac = p.v / total, seg = svg('circle', { cx: 70, cy: 70, r: R, fill: 'none', stroke: p.c, 'stroke-width': 14, 'stroke-linecap': 'butt', 'stroke-dasharray': (frac * C) + ' ' + C, transform: 'rotate(' + (-90 + acc * 360) + ' 70 70)' })
    acc += frac; return seg
  })
  const text = (y, size, weight, fill, s) => { const t = svg('text', { x: 70, y, 'text-anchor': 'middle', fill, 'font-size': size, 'font-weight': weight, 'font-family': 'ui-monospace,monospace' }); t.append(document.createTextNode(s)); return t }
  return svg('svg', { class: 'ring', viewBox: '0 0 140 140', width: 190, height: 190, role: 'img', 'aria-label': 'Budget breakdown' },
    svg('circle', { cx: 70, cy: 70, r: R, fill: 'none', stroke: 'rgba(255,255,255,.07)', 'stroke-width': 14 }), ...segs, text(68, 22, 700, '#f1f3ff', centerTop), text(86, 10, 500, '#9aa0c3', centerBottom))
}
function legend(rows) { return el('div', { class: 'legend' }, rows.map(r => el('div', null, el('i', { vars: { background: r.c } }), r.label, el('b', null, r.value)))) }
function stat(title, value, sub, ic, cls) { return el('div', { class: 'card stat' }, el('h2', null, title), el('div', { class: 'spark ' + cls }, icon(ic)), el('div', { class: 'v' }, value, el('small', null, 'USDC')), el('div', { class: 'd' }, sub)) }

// ---- pages ------------------------------------------------------------------------------------------------------------------------------
const decisionRow = d => el('tr', { class: 'row', onclick: () => openDrawer(d) },
  el('td', null, el('div', { class: 'cell' }, avatar(d.host), el('div', null, el('b', null, d.host), el('small', null, d.purpose || '')))),
  el('td', null, pill(d)),
  el('td', null, el('div', { class: 'cell' }, el('span', { class: 'amt' }, d.amount ? money(d.amount) : '—'), tokenChip(d.currency))),
  el('td', null, ribbon(d.checks)),
  el('td', null, d.failedCheck ? el('span', { class: 'chip no plain' }, d.failedCheck) : (d.reason ? el('span', { class: 'chip mu plain' }, d.reason) : '')),
  el('td', { class: 'mono muted' }, when(d.createdAt).slice(11)))

const PAGE_LOADERS = {
  overview() {
    return Promise.all([api('/v1/mandates'), api('/v1/decisions?limit=200')]).then(([m, dd]) => {
      const decisions = dd.decisions, tops = m.mandates.filter(x => !x.parentId && x.balance)
      const sum = k => tops.reduce((a, x) => a + num(x.balance[k]), 0)
      const total = sum('total'), spent = sum('settled'), held = sum('committed'), left = sum('remaining')
      const paid = decisions.filter(d => groupOf(d) === 'paid').length, blocked = decisions.filter(d => groupOf(d) === 'blocked').length, waiting = decisions.filter(d => groupOf(d) === 'approval').length
      const names = {}; decisions.forEach(d => (d.checks || []).forEach(c => { names[c.id] = c.name }))
      const stops = {}; decisions.forEach(d => { if (d.failedCheck && groupOf(d) === 'blocked') stops[d.failedCheck] = (stops[d.failedCheck] || 0) + 1 })
      const rows = Object.keys(stops).sort((a, b) => stops[b] - stops[a]).slice(0, 6), top = rows.length ? stops[rows[0]] : 1
      const used = total > 0 ? Math.round(((spent + held) / total) * 100) : 0
      return [
        el('div', { class: 'grid g4' }, stat('Budget', money(total), tops.length + ' mandate' + (tops.length === 1 ? '' : 's'), 'wallet', 'bl'), stat('Spent', money(spent), 'settled with 1Click', 'out', 'ok'), stat('Held', money(held), 'reserved, or carved out for workers', 'lock', 'ap'), stat('Remaining', money(left), 'still available to spend', 'clock', 'wn')),
        el('div', { class: 'grid g3' }, 
          el('div', { class: 'card' }, el('h2', null, 'Budget'), ring([{ v: spent, c: 'var(--ok)' }, { v: held, c: 'var(--ac)' }, { v: left, c: 'rgba(255,255,255,.14)' }], used + '%', 'used'),
            legend([{ label: 'Spent', c: 'var(--ok)', value: money(spent) }, { label: 'Held', c: 'var(--ac)', value: money(held) }, { label: 'Remaining', c: 'rgba(255,255,255,.3)', value: money(left) }])),
          el('div', { class: 'card' }, el('h2', null, 'Outcomes, last ' + decisions.length),
            el('div', { class: 'row wrap' }, el('div', null, el('div', { class: 'bignum ok' }, paid), el('small', { class: 'muted' }, 'paid')), el('div', null, el('div', { class: 'bignum no' }, blocked), el('small', { class: 'muted' }, 'blocked')), el('div', null, el('div', { class: 'bignum ap' }, waiting), el('small', { class: 'muted' }, 'waiting'))),
            el('div', { class: 'beat', role: 'img', 'aria-label': 'The most recent decisions, oldest to newest' }, decisions.slice(0, 48).reverse().map(d => el('i', { class: label(d)[1], title: label(d)[0] + ' · ' + d.host })))),
          el('div', { class: 'card' }, el('h2', null, 'What stopped payments'),
            rows.length ? el('div', { class: 'bars' }, rows.map(id => el('div', null, el('div', { class: 'b' }, el('span', { class: 'mono muted' }, id), el('div', { class: 'track' }, el('div', { class: 'fill', width: Math.round((stops[id] / top) * 100) + '%' })), el('b', { class: 'mono' }, stops[id])), el('small', null, names[id] || '')))) : el('p', { class: 'empty' }, 'Nothing has been stopped yet.'))),
        el('div', { class: 'card' }, el('h2', null, 'Recent decisions'), decisions.length ? el('div', { class: 'feed' }, decisions.slice(0, 8).map(d => el('div', { class: 'item', onclick: () => openDrawer(d) }, avatar(d.host), el('div', { class: 'grow' }, el('b', null, d.host), el('small', null, d.purpose || '')), ribbon(d.checks), pill(d), el('span', { class: 'amt' }, d.amount ? money(d.amount) : '—'), tokenChip(d.currency)))) : el('p', { class: 'empty' }, 'No decisions yet. Every payment request an agent makes will appear here with the checks that judged it.')),
      ]
    })
  },
  decisions() {
    return api('/v1/decisions?limit=200').then(r => {
      const q = KEYS.query.trim().toLowerCase()
      const shown = r.decisions.filter(d => (KEYS.filter === 'all' || groupOf(d) === KEYS.filter) && (!q || (d.host + ' ' + (d.purpose || '') + ' ' + (d.failedCheck || '')).toLowerCase().includes(q)))
      const chips = [['all', 'All'], ['paid', 'Paid'], ['blocked', 'Blocked'], ['approval', 'Needs approval']].map(f => el('button', { type: 'button', class: 'f', 'aria-pressed': KEYS.filter === f[0], onclick: () => { KEYS.filter = f[0]; load() } }, f[1]))
      const search = el('input', { type: 'search', placeholder: 'Search host, purpose or check', 'aria-label': 'Search', value: KEYS.query })
      search.addEventListener('input', () => { KEYS.query = search.value; clearTimeout(search._t); search._t = setTimeout(load, 250) })
      return [el('div', { class: 'filters' }, chips, search),
        shown.length ? el('div', { class: 'tablewrap' }, el('table', null, el('thead', null, el('tr', null, ['Merchant', 'Outcome', 'Amount', 'The twelve checks', 'Stopped by', 'Time'].map(h => el('th', null, h)))), el('tbody', null, shown.map(decisionRow))))
          : el('p', { class: 'empty' }, r.decisions.length ? 'Nothing matches that filter.' : 'No decisions yet. Every payment request an agent makes will appear here with the checks that judged it.')]
    })
  },
  approvals() {
    const pending = approvals.filter(a => a.status === 'pending'), done = approvals.filter(a => a.status !== 'pending')
    return Promise.resolve([
      el('p', { class: 'note' }, 'A payment waits here when the mandate says a person must decide: an amount above your threshold, a first payee, a price above tolerance, or a high risk score.'),
      pending.length ? el('div', { class: 'grid g2' }, pending.map(approvalCard)) : el('div', { class: 'card' }, el('p', { class: 'empty' }, 'Nothing is waiting for you.')),
      done.length ? [el('h2', { class: 'note' }, 'Decided'), el('div', { class: 'feed' }, done.slice(-20).reverse().map(a => el('div', { class: 'item', onclick: () => a.decision && openDrawer(a.decision) }, avatar(a.decision ? a.decision.host : a.decisionId), el('div', { class: 'grow' }, el('b', null, a.decision ? a.decision.host : ''), el('small', null, a.reason || '')), el('span', { class: 'chip ' + (a.status === 'approved' ? 'ok' : 'mu') }, a.status), el('span', { class: 'amt' }, a.decision && a.decision.amount ? money(a.decision.amount) : ''))))] : [],
    ])
  },
  mandates() {
    return api('/v1/mandates').then(r => Promise.all(r.mandates.map(m => m.status === 'active' ? api('/v1/agents/' + encodeURIComponent(m.id) + '/tasks?limit=5').then(t => t.tasks, () => []) : Promise.resolve([])))
      .then(threads => { r.mandates.forEach((m, i) => { m.tasks = threads[i] }); return r })).then(r => {
      if (!r.mandates.length) return el('div', { class: 'card' }, el('p', { class: 'empty' }, 'No mandates yet. Create one with POST /v1/mandates.'))
      const ordered = r.mandates.slice().sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0))
      return el('div', { class: 'grid g2' }, ordered.map(m => {
        const b = m.balance, total = b ? num(b.total) : 0, pct = v => total > 0 ? Math.min(100, (num(v) / total) * 100) + '%' : '0%'
        return el('div', { class: 'card' }, el('div', { class: 'row' }, avatar(m.id), el('div', { class: 'grow' }, el('b', { class: 'mono' }, m.id), el('div', { class: 'muted' }, m.agentId)), el('span', { class: 'chip ' + (m.status === 'active' ? 'ok' : 'mu') }, m.status)),
          m.parentId ? el('p', { class: 'muted' }, 'Hired by ', el('span', { class: 'chip bl' }, m.parentId)) : [],
          b ? [el('div', { class: 'row wrap' }, el('span', { class: 'bignum' }, money(b.remaining)), el('span', { class: 'muted' }, 'of ' + money(b.total) + ' ' + m.currency + ' remaining')),
            el('div', { class: 'meter' }, el('i', { class: 's', width: pct(b.settled) }), el('i', { class: 'h', width: pct(b.committed) })),
            legend([{ label: 'Spent', c: 'var(--ok)', value: money(b.settled) }, { label: 'Held', c: 'var(--ac)', value: money(b.committed) }, { label: 'Waiting for approval', c: 'var(--ap)', value: money(b.proposed) }])] : [],
          el('dl', { class: 'kv' }, el('dt', null, 'Per payment'), el('dd', null, m.perPayment + ' ' + m.currency), el('dt', null, 'Valid until'), el('dd', { class: 'mono' }, when(m.validUntil))),
          m.status === 'active' ? thread(m) : [])
      }))
    })
  },
  jobs() {
    return Promise.all([api('/v1/jobs?limit=200'), api('/v1/history?limit=200')]).then(([r, h]) => {
      const jobs = r.jobs, past = h.history
      if (!jobs.length && !past.length) return el('div', { class: 'card' }, el('p', { class: 'empty' }, 'Nothing here yet. A job appears when you register work for an agent (POST /v1/jobs); a real payment appears once it is recorded.'))
      return [
        el('h3', { class: 'sect' }, 'Jobs your agents were hired for'),
        jobs.length ? el('div', { class: 'tablewrap' }, el('table', null, el('thead', null, el('tr', null, ['Job', 'Agent mandate', 'Price', 'Earned', 'Spent', 'Net', 'Blocked'].map(h => el('th', null, h)))),
          el('tbody', null, jobs.map(x => el('tr', null,
            el('td', null, el('div', { class: 'cell' }, avatar(x.job.id), el('div', null, el('b', null, x.job.goal || x.job.id), el('small', null, x.job.id)))),
            el('td', { class: 'mono' }, short(x.job.mandateId)),
            el('td', null, el('span', { class: 'amt' }, x.job.price), ' ', tokenChip(x.job.currency)),
            el('td', null, x.summary ? money(x.summary.revenue) : '—'), el('td', null, x.summary ? money(x.summary.settled) : '—'),
            el('td', { class: x.summary && num(x.summary.net) < 0 ? 'no' : 'ok' }, x.summary ? money(x.summary.net) : '—'),
            el('td', null, x.summary ? x.summary.blockedAttempts : '—')))))) : el('p', { class: 'note' }, 'No jobs registered yet. Earned and spent come from the ledger and verified revenue receipts, never from the agent.'),
        el('h3', { class: 'sect' }, 'Real runs recorded from outside the decision log'),
        el('p', { class: 'note' }, 'Each is a real run saved as plain facts and marked imported. Its twelve checks are not stored here, so none are shown.'),
        past.length ? el('div', { class: 'tablewrap' }, el('table', null, el('thead', null, el('tr', null, ['Run', 'When (UTC)', 'Amount', 'Status', 'Transaction'].map(h => el('th', null, h)))),
          el('tbody', null, past.map(x => el('tr', null,
            el('td', null, el('div', { class: 'cell' }, avatar(x.id), el('div', null, el('b', null, x.title), el('small', null, x.note)))),
            el('td', { class: 'mono muted' }, when(x.occurredAt)),
            el('td', null, el('span', { class: 'amt' }, x.amount), ' ', tokenChip(x.currency)),
            el('td', null, el('span', { class: 'chip bl plain' }, 'imported'), ' ', x.status),
            el('td', null, x.txHash ? (explorerLink(x.explorer, short(x.txHash)) || addr(x.txHash)) : '—')))))) : el('p', { class: 'empty' }, 'None recorded.')]
    })
  },
  services() {
    return api('/v1/services').then(r => {
      if (!r.services.length) return el('div', { class: 'card' }, el('p', { class: 'empty' }, 'No services registered. Nothing can be paid until a service is probed and enabled.'))
      return [el('p', { class: 'note' }, 'A service can be paid only when it has been probed and enabled. Listing text is third-party text: it is shown to you here and never to the agent\'s model.'),
        el('div', { class: 'tablewrap' }, el('table', null, el('thead', null, el('tr', null, ['Service', 'Verification', 'Status', 'Payee', 'Quoted', 'Listing text'].map(h => el('th', null, h)))),
          el('tbody', null, r.services.map(s => el('tr', null,
            el('td', null, el('div', { class: 'cell' }, avatar(s.host), el('div', null, el('b', null, s.name), el('small', null, s.host)))),
            el('td', null, el('span', { class: 'chip ' + (s.verification === 'unverified' || s.verification === 'disabled' ? 'no' : 'ok') }, s.verification)),
            el('td', null, s.enabled ? el('span', { class: 'chip ok' }, 'enabled') : el('span', { class: 'chip mu' }, 'off')),
            el('td', null, s.payee ? addr(s.payee) : '—'), el('td', null, el('span', { class: 'amt' }, s.pricing.quoted), ' ', tokenChip(s.pricing.currency)),
            el('td', null, s.listingText ? el('div', null, el('span', { class: 'chip wn plain' }, 'untrusted'), ' ', s.listingText) : '')))))) ]
    })
  },
  audit() {
    const result = el('span', { id: 'auditResult', class: 'muted' }, 'Each entry carries the hash of the one before, so changing any past entry breaks every hash after it.')
    const btn = el('button', { type: 'button', class: 'primary', onclick: () => api('/v1/audit/verify').then(v => result.replaceChildren(v.ok ? el('span', { class: 'ok' }, 'The chain verifies: ' + v.length + ' entries, head ' + String(v.head).slice(0, 16) + '...') : el('span', { class: 'no' }, 'BROKEN at entry ' + v.brokenAt + ': ' + v.reason))).catch(showError) }, 'Verify the whole chain')
    return api('/v1/audit?limit=100').then(r => {
      const recent = r.entries.slice(-8)
      return [el('div', { class: 'card' }, el('h2', null, 'Chain integrity'), el('div', { class: 'row wrap' }, btn, result),
          el('div', { class: 'chain' }, flat(recent.map((e, i) => [i ? el('i', { class: 'link' }) : [], el('div', { class: 'block' }, el('b', null, '#' + e.seq), el('small', null, e.type), el('small', null, short(e.hash)))])))),
        el('p', { class: 'note' }, r.length + ' entries, newest first.'),
        el('div', { class: 'tablewrap' }, el('table', null, el('thead', null, el('tr', null, ['#', 'Time (UTC)', 'Event', 'Details'].map(h => el('th', null, h)))),
          el('tbody', null, r.entries.slice().reverse().map(e => el('tr', null, el('td', { class: 'mono' }, e.seq), el('td', { class: 'mono muted' }, when(e.ts)), el('td', null, el('span', { class: 'chip bl plain' }, e.type)), el('td', null, el('pre', null, JSON.stringify(e.payload))))))))]
    })
  },
}

/**
 * Messages with one agent: the same inbox the phone app's chat uses (POST/GET /v1/agents/:id/tasks). Words only; a payment the agent
 * asks for still lands in Approvals. Agent text is put in as text nodes by el(), never as HTML.
 */
function thread(m) {
  const lines = (m.tasks || []).flatMap(t => t.messages.map(x => Object.assign({ status: t.status }, x))).sort((a, b) => a.at < b.at ? -1 : 1).slice(-6)
  const waiting = (m.tasks || []).find(t => t.status === 'queued' || t.status === 'working')
  const input = el('input', { class: 'msgin', maxlength: 500, placeholder: 'Message ' + m.agentId, 'aria-label': 'Message ' + m.agentId })
  const send = e => {
    e.preventDefault()
    const text = input.value.trim(); if (!text) return
    input.disabled = true
    api('/v1/agents/' + encodeURIComponent(m.id) + '/tasks', { method: 'POST', body: { text } }).then(() => { input.value = ''; input.blur(); toast('Sent'); load() }, err => toast(err.message)).finally(() => { input.disabled = false })
  }
  return el('div', { class: 'thread' }, el('h3', { class: 'sect' }, 'Messages'),
    lines.length ? lines.map(x => el('div', { class: 'msg ' + x.from }, el('small', null, (x.from === 'owner' ? 'You' : m.agentId) + ' · ' + when(x.at)), x.text,
      x.decisionId ? el('button', { type: 'button', class: 'linkish', onclick: () => { KEYS.current = 'approvals'; load() } }, 'See the payment') : [])) : el('p', { class: 'muted' }, 'No messages yet. Tell this agent what to buy; it asks you before paying.'),
    waiting ? el('p', { class: 'muted' }, waiting.status === 'working' ? m.agentId + ' is working…' : 'Waiting for the agent to pick this up.') : [],
    el('form', { class: 'msgform', onsubmit: send }, input, el('button', { type: 'submit', class: 'ghost' }, 'Send')))
}

function approvalCard(a) {
  const d = a.decision || {}, reason = el('input', { type: 'text', placeholder: 'A reason (required)', maxlength: 500, 'aria-label': 'Reason' })
  const decide = what => { if (!reason.value.trim()) { reason.focus(); return } api('/v1/approvals/' + encodeURIComponent(a.decisionId) + '/' + what, { method: 'POST', body: { reason: reason.value.trim() } }).then(load).catch(showError) }
  return el('div', { class: 'card' }, el('div', { class: 'row' }, avatar(d.host || a.decisionId), el('div', { class: 'grow' }, el('b', null, d.host || ''), el('div', { class: 'muted' }, d.purpose || '')), netChip(d)),
    el('div', { class: 'row wrap' }, el('span', { class: 'bignum' }, money(d.amount)), tokenChip(d.currency), d.risk !== undefined ? gauge(d.risk) : []),
    ribbon(d.checks), el('p', { class: 'muted' }, 'Expires ' + when(a.expiresAt)),
    el('div', { class: 'row wrap' }, reason, el('button', { type: 'button', class: 'good', onclick: () => decide('approve') }, 'Approve'), el('button', { type: 'button', class: 'danger', onclick: () => decide('reject') }, 'Reject'), el('button', { type: 'button', class: 'ghost', onclick: () => d.checks && openDrawer(d) }, 'See all checks')))
}

// ---- loading ----------------------------------------------------------------------------------------------------------------------------
function load() {
  if (!token()) return
  Promise.all([api('/v1/status'), api('/v1/approvals')]).then(([s, a]) => {
    status = s; approvals = a.approvals; paintChrome()
    return PAGE_LOADERS[KEYS.current]()
  }).then(content => { $('#view').replaceChildren(...flat([content])); lastLoad = Date.now(); $('#live').textContent = 'Live' }).catch(e => { if (e.message !== 'unauthorized') showError(e) })
}

function start() {
  $('#login').hidden = true; $('#app').hidden = false; $('#view').hidden = false
  $('#sideLogo').replaceChildren(icon('shield')); load()
  clearInterval(timer); timer = setInterval(() => { if (!document.hidden && !drawer && !document.activeElement.matches('input,textarea')) load() }, 4000)
}

$('#loginLogo').replaceChildren(icon('shield'))
$('#login').addEventListener('submit', e => {
  e.preventDefault()
  sessionStorage.setItem(KEY, $('#token').value.trim()); $('#token').value = ''
  api('/v1/mandates').then(start).catch(() => { /* signOut already showed why */ })
})
$('#signout').addEventListener('click', () => signOut(''))

// ---- pair a phone ---------------------------------------------------------------------------------------------------------------------
// The Tollgate app scans this to pair: {"tollgate":1,"url":"…","key":"…"} (parsePairingCode in apps/mobile/src/api/gateway.ts).
// The code carries the operator token, so it is shown only on request, only in this tab, and hides itself after two minutes.
let pairTimer = null
function qrSvg(text) {
  if (typeof window.qrcode !== 'function') return el('p', { class: 'err' }, 'The QR encoder did not load. Use the address and key below.')
  const q = window.qrcode(0, 'M'); q.addData(text, 'Byte'); q.make()
  const n = q.getModuleCount(); let d = ''
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += 'M' + x + ' ' + y + 'h1v1h-1z'
  return svg('svg', { viewBox: '-4 -4 ' + (n + 8) + ' ' + (n + 8), width: 240, height: 240, role: 'img', 'aria-label': 'Pairing code for the Tollgate app', 'shape-rendering': 'crispEdges' },
    svg('rect', { x: -4, y: -4, width: n + 8, height: n + 8, fill: '#fff' }), svg('path', { d: d, fill: '#000' }))
}
// A phone can only use an address on this computer's network. 127.0.0.1 / localhost on a phone means the phone itself.
const isLoopback = host => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(host)
function hostOf(url) { try { return new URL(url).hostname } catch { return '' } }

/** What stops a phone from pairing, in steps a person can follow. null: nothing, the code can be shown. */
function pairingBlocker(info, url) {
  if (!info) return ['The dashboard could not ask the gateway where it can be reached. Reload this page and press Pair a phone again.']
  if (!info.openToNetwork) return [
    'Your gateway only accepts connections from this computer, so your phone cannot reach it.',
    '1. Stop the gateway (Ctrl+C in its terminal).',
    '2. Add the line GATEWAY_HOST=0.0.0.0 to the .env file in the Tollgate folder.',
    '3. Start it again (pnpm dev) and press Pair a phone again.',
    'Every request still needs your key. Do this only on a network you trust, like your home Wi-Fi.',
  ]
  if (!url) return [
    'This computer has no Wi-Fi or network address your phone could use.',
    'Connect this computer to the same Wi-Fi as your phone, then press Pair a phone again.',
  ]
  if (isLoopback(hostOf(url))) return [
    hostOf(url) + ' cannot work for a phone: on the phone, that address is the phone itself.',
    'Use this computer’s Wi-Fi address instead' + (info.addresses.length ? ', for example http://' + info.addresses[0] + ':' + info.port + '.' : '.'),
  ]
  return null
}

function openPairing() {
  const close = () => { clearTimeout(pairTimer); overlay.remove() }
  const address = el('input', { type: 'url', value: '', 'aria-label': 'Gateway address the phone will use' })
  const box = el('div', { class: 'pairqr' })
  const help = el('div', { class: 'pairhelp' })
  const keyBox = el('div')
  // If even the fallback copy is refused, show the key, selected, so it can be copied by hand. Never a button that does nothing.
  const copyKey = () => copyText(token()).then(ok => {
    if (ok) { toast('Key copied'); keyBox.replaceChildren(); return }
    const field = el('input', { type: 'text', readonly: true, 'aria-label': 'Gateway key, selected for copying' })
    field.value = token()
    keyBox.replaceChildren(el('label', null, 'Your browser blocked copying. Press Cmd+C to copy the key:', field))
    field.focus(); field.select()
  })
  let info = null
  const paint = () => {
    clearTimeout(pairTimer)
    const url = address.value.trim().replace(/\/+$/, '')
    const blocker = pairingBlocker(info, url)
    if (blocker) {
      // Never show a code that cannot work: a phone that scans it can only fail, and the reason would be hidden from the person.
      box.replaceChildren(el('p', { class: 'muted' }, 'No code yet.'))
      help.replaceChildren(...blocker.map((line, i) => el('p', { class: i === 0 ? 'err' : 'muted' }, line)))
      return
    }
    help.replaceChildren(el('p', { class: 'muted' }, 'Your phone must be on the same Wi-Fi as this computer.'))
    box.replaceChildren(qrSvg(JSON.stringify({ tollgate: 1, url: url, key: token() })))
    pairTimer = setTimeout(() => box.replaceChildren(el('button', { type: 'button', onclick: paint }, 'Show the code again')), 120000)
  }
  address.addEventListener('change', paint)
  const overlay = el('div', { class: 'pair', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Pair a phone', onclick: e => { if (e.target === overlay) close() } },
    el('div', { class: 'card pairbox' },
      el('h2', null, 'Pair a phone'),
      el('p', { class: 'muted' }, 'Open the Tollgate app and scan this. The phone can then approve, reject and freeze, and add agents that always need your approval. Show it only to your own phone.'),
      box,
      help,
      el('label', null, 'Address the phone will use', address),
      keyBox,
      el('div', { class: 'row wrap' },
        el('button', { type: 'button', class: 'ghost', onclick: copyKey }, 'Copy key instead'),
        el('span', { class: 'grow' }),
        el('button', { type: 'button', class: 'primary', onclick: close }, 'Done'))))
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc) } })
  document.body.append(overlay)
  box.replaceChildren(el('p', { class: 'muted' }, 'Finding this computer’s Wi-Fi address…'))
  api('/v1/pairing').then(j => { info = j }, () => { info = null }).then(() => {
    // Prefer this computer's .local NAME: the router may give it a new number later, which would break a phone paired to the old one.
    // Opened on a Wi-Fi address already: the phone can use the same one. Opened as 127.0.0.1: use the name, else the Wi-Fi number.
    const port = location.port || info.port
    const lan = info && info.localName ? 'http://' + info.localName + ':' + port : info && info.addresses.length ? 'http://' + info.addresses[0] + ':' + port : ''
    address.value = isLoopback(location.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname) ? (lan || location.origin) : location.origin
    paint()
  })
}
$('#pair').addEventListener('click', openPairing)
if (token()) start()
