/* global io */
// Client Undercover : affiche l'état envoyé par le serveur et lui transmet les actions du joueur.

const SESSION_KEY = 'undercover:session'
const NAME_KEY = 'undercover:name'
// Actions qui font avancer la partie : envoyées avec la clé de l'écran affiché pour que le serveur ignore les doublons.
const STATEFUL_ACTIONS = new Set(['start', 'clue', 'skipToVote', 'vote', 'closeVote', 'guess', 'skipGuess', 'continue', 'backToLobby'])
// Juste après un changement d'écran, un appui vient presque toujours d'un double appui sur le bouton précédent.
const REPEAT_GUARD_MS = 500

const socket = io({ reconnectionDelayMax: 3000 })
const $app = document.getElementById('app')
const $banner = document.getElementById('banner')
const $toast = document.getElementById('toast')
const $sr = document.getElementById('sr')

const urlCode = (new URLSearchParams(location.search).get('code') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4)

const ui = {
  state: null,
  session: readSession(),
  busySession: null,
  connected: false,
  resuming: false,
  cardOpen: false,
  cardKey: null,
  showQr: false,
  drafts: { code: urlCode, name: readStored(NAME_KEY) || '' },
  vibratedFor: null,
  announced: null,
  scrolledFor: null,
  menuFor: null,
  busy: false,
  keyChangedAt: 0,
  lanOrigin: null,
}

// Ouvert sur le PC serveur via localhost : les invitations doivent porter l'adresse Wi-Fi, pas « localhost ».
if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  fetch('/api/lan').then(r => r.json()).then(({ origin }) => {
    ui.lanOrigin = origin
    if (ui.state) render()
  }).catch(() => { /* hors ligne : on garde l'origine actuelle */ })
}

// Un lien d'invitation vers un autre salon l'emporte sur l'ancienne session gardée en mémoire.
if (urlCode && ui.session?.soft && ui.session.code !== urlCode) ui.session = null

// ---------- Utilitaires ----------

function readStored(key) {
  try { return localStorage.getItem(key) } catch { return null }
}

// La session vit dans l'onglet (sessionStorage) ; une copie dans localStorage permet de revenir
// après avoir fermé l'onglet, sans voler la place d'un autre onglet encore connecté.
function readSession() {
  try {
    const tab = JSON.parse(sessionStorage.getItem(SESSION_KEY))
    if (tab) return { ...tab, soft: false }
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY))
    return saved ? { ...saved, soft: true } : null
  } catch { return null }
}
function saveSession(s) {
  ui.session = s ? { code: s.code, playerId: s.playerId, token: s.token, soft: false } : null
  try {
    if (s) {
      const json = JSON.stringify({ code: s.code, playerId: s.playerId, token: s.token })
      sessionStorage.setItem(SESSION_KEY, json)
      localStorage.setItem(SESSION_KEY, json)
    } else {
      sessionStorage.removeItem(SESSION_KEY)
      localStorage.removeItem(SESSION_KEY)
    }
  } catch { /* stockage indisponible : la session reste en mémoire */ }
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}
function initials(name) {
  return esc(String(name || '?').trim().slice(0, 1).toUpperCase())
}
function plural(n, one, many) { return `${n} ${n > 1 ? many : one}` }
function joinNames(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} et ${names[names.length - 1]}`
}

let toastTimer
function toast(message, kind = 'info') {
  $toast.textContent = message
  $toast.className = `toast ${kind}`
  $toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { $toast.hidden = true }, 3600)
}

function emit(event, payload = {}) {
  return new Promise(resolve => {
    if (!socket.connected) {
      toast('Connexion perdue, nouvelle tentative…', 'error')
      return resolve({ ok: false })
    }
    socket.timeout(8000).emit(event, payload, (err, res) => {
      if (err) {
        toast('Le serveur ne répond pas.', 'error')
        return resolve({ ok: false })
      }
      if (res && !res.ok && res.error) toast(res.error, 'error')
      resolve(res || { ok: false })
    })
  })
}

const pending = new Set()
async function act(type, payload = {}) {
  const stateful = STATEFUL_ACTIONS.has(type)
  if (stateful && (pending.has(type) || performance.now() - ui.keyChangedAt < REPEAT_GUARD_MS)) {
    return { ok: false, duplicate: true }
  }
  if (stateful) pending.add(type)
  try {
    const res = await emit('action', { type, ...payload, at: stateful ? ui.state?.stateKey : undefined })
    if (res.stale) toast('La partie a avancé entre-temps : vérifie l’écran et réessaie si besoin.')
    return res
  } finally {
    pending.delete(type)
  }
}

const ICONS = {
  crown: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7z"/></svg>',
  qr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/></svg>',
  leave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>',
  sigil: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M32 4 56 18v28L32 60 8 46V18z"/><path d="M32 14 47 23v18L32 50 17 41V23z" opacity=".6"/><circle cx="32" cy="32" r="7"/></svg>',
}

const ROLE_LABEL = { civil: 'Civil', undercover: 'Undercover', mrwhite: 'Mr. White' }
const roleBadge = role => (role ? `<span class="badge ${role}">${ROLE_LABEL[role]}</span>` : '')

function rulesHtml(points = { civil: 2, undercover: 10, mrwhite: 6 }) {
  return `
  <details class="rules panel" id="rules">
    <summary>Règles du jeu</summary>
    <ul>
      <li>Chaque joueur reçoit en secret un <b>champion</b>. Les <b>civils</b> ont tous le même. L’<b>Undercover</b> a un champion très proche… sans savoir qu’il est l’Undercover.</li>
      <li><b>Mr. White</b> ne reçoit rien : il écoute, bluffe et essaie de se fondre dans la masse. Il n’est jamais désigné pour ouvrir le premier tour.</li>
      <li>À chaque tour, chacun donne <b>un indice</b> sur son champion (un mot ou une courte phrase), sans jamais le nommer.</li>
      <li>Puis tout le monde <b>vote</b> en secret pour éliminer un suspect. Son rôle est révélé. En cas d’égalité, on revote entre les ex æquo ; si ça bloque encore, tirage au sort.</li>
      <li>Mr. White éliminé a une dernière chance : s’il devine le champion des civils, il <b>gagne seul</b> la manche.</li>
      <li>Les civils gagnent quand tous les infiltrés sont éliminés. Les infiltrés (Undercover et Mr. White) gagnent s’il ne reste plus qu’<b>un seul civil</b>.</li>
      <li>Points : civil gagnant <b>+${points.civil}</b>, Undercover gagnant <b>+${points.undercover}</b>, Mr. White gagnant <b>+${points.mrwhite}</b>.</li>
    </ul>
  </details>`
}

// ---------- Rendu ----------
// Le HTML est régénéré à chaque état, puis seules les différences sont appliquées au DOM :
// le champ en cours de saisie garde le focus (clavier mobile ouvert), les sections dépliées restent dépliées.

function render() {
  const s = ui.state
  let html
  if (!s) html = ui.resuming ? loadingView() : homeView()
  else if (s.phase === 'lobby') html = lobbyView(s)
  else html = gameView(s)
  const template = document.createElement('template')
  template.innerHTML = html
  morph($app, template.content)
  markBrokenImages()
  restoreDrafts()
  updateBanner()
  updateTitle()
  announce()
  scrollToAction()
}

function nodeKey(n) {
  return n.nodeType === 1 ? n.id || n.getAttribute('data-key') || null : null
}

function sameNode(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false
  return a.nodeType !== 1 || nodeKey(a) === nodeKey(b)
}

// Applique « next » sur « live ». Les éléments identifiés (id ou data-key) sont retrouvés même s'ils
// ont changé de position : on retire ou insère ce qui les entoure, sans jamais les déplacer (le focus serait perdu).
function morph(live, next) {
  const wanted = [...next.childNodes]
  const wantedKeys = new Set(wanted.map(nodeKey).filter(Boolean))
  for (let i = 0; i < wanted.length; i++) {
    const nb = wanted[i]
    let na = live.childNodes[i]
    const key = nodeKey(nb)
    if (key && na && nodeKey(na) !== key) {
      const later = [...live.childNodes].slice(i + 1).find(c => nodeKey(c) === key)
      if (later) {
        while (live.childNodes[i] !== later) live.childNodes[i].remove()
        na = later
      }
    }
    if (!na) { live.appendChild(nb); continue }
    if (!sameNode(na, nb)) {
      const liveKey = nodeKey(na)
      if (liveKey && wantedKeys.has(liveKey)) live.insertBefore(nb, na)
      else live.replaceChild(nb, na)
      continue
    }
    if (na.nodeType !== 1) {
      if (na.nodeValue !== nb.nodeValue) na.nodeValue = nb.nodeValue
      continue
    }
    for (const attr of [...na.attributes]) {
      if (!nb.hasAttribute(attr.name) && !(na.tagName === 'DETAILS' && attr.name === 'open')) na.removeAttribute(attr.name)
    }
    for (const attr of [...nb.attributes]) {
      if (na.getAttribute(attr.name) !== attr.value) na.setAttribute(attr.name, attr.value)
    }
    const selected = na.tagName === 'SELECT' ? nb.querySelector('option[selected]')?.value : null
    morph(na, nb)
    if (na.tagName === 'INPUT' && na.type === 'checkbox') na.checked = nb.hasAttribute('checked')
    if (selected != null) na.value = selected
  }
  while (live.childNodes.length > wanted.length) live.lastChild.remove()
}

// Une image en échec perd sa classe « broken » quand le rendu resynchronise les attributs : on la remet.
function markBrokenImages() {
  for (const img of $app.querySelectorAll('img')) {
    if (img.complete && !img.naturalWidth) img.classList.add('broken')
  }
}

function restoreDrafts() {
  for (const el of $app.querySelectorAll('[data-draft]')) {
    const draft = ui.drafts[el.id]
    if (draft !== undefined && el.value !== draft) el.value = draft
  }
}

function updateBanner() {
  const lost = !ui.connected && (ui.state || ui.session)
  $banner.hidden = !lost
  if (lost) $banner.textContent = 'Connexion perdue — reconnexion en cours…'
}

function myTurn(s) {
  return Boolean(s && s.phase === 'clues' && s.round?.currentSpeaker === s.me.id)
}

function updateTitle() {
  document.title = `${myTurn(ui.state) ? '🔔 À toi ! · ' : ''}Undercover · League of Legends`
}

function nameOf(s, id) {
  return s.players.find(p => p.id === id)?.name || s.round?.result?.names?.[id] || 'Joueur parti'
}

// Annonce les moments clés aux lecteurs d'écran (une seule fois par moment).
function announce() {
  const s = ui.state
  if (!s || !s.round || !$sr) return
  const r = s.round
  let key = `${s.phase}:${r.uid}:${r.turn}`
  let message = ''
  if (s.phase === 'clues') {
    key += `:${r.currentSpeaker}`
    message = myTurn(s) ? 'À toi de donner ton indice.' : `${nameOf(s, r.currentSpeaker)} donne son indice.`
  } else if (s.phase === 'vote') {
    key += `:${r.vote.attempt}`
    message = r.vote.attempt === 2 ? 'Égalité, nouveau vote.' : 'Le vote est ouvert.'
  } else if (s.phase === 'elimination') {
    message = `${nameOf(s, r.elimination.playerId)} est éliminé. C’était ${ROLE_LABEL[r.elimination.role]}.`
  } else if (s.phase === 'roundEnd' && r.result) {
    message = { civils: 'Victoire des civils.', infiltres: 'Victoire des infiltrés.', mrwhite: 'Mr. White a trouvé.' }[r.result.camp]
  }
  if (key === ui.announced) return
  ui.announced = key
  $sr.textContent = message
}

// Quand c'est à moi d'agir (parler, voter, deviner) ou qu'une nouvelle phase commence, l'action est ramenée à l'écran.
function scrollToAction() {
  const s = ui.state
  if (!s || !s.round) return
  const r = s.round
  const key = `${s.phase}:${r.uid}:${r.turn}:${r.vote?.attempt || ''}:${myTurn(s)}`
  if (key === ui.scrolledFor) return
  ui.scrolledFor = key
  const target = $app.querySelector('[data-focus]')
  if (!target) return
  const box = target.getBoundingClientRect()
  if (box.top < 0 || box.bottom > window.innerHeight) {
    target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
}

function loadingView() {
  return `<section class="hero"><div class="logo">Undercover</div><p class="tagline">Reconnexion au salon…</p></section>`
}

function homeView() {
  const hasCode = Boolean(ui.drafts.code)
  const busy = ui.busySession
  return `
  <section class="hero">
    <h1 class="logo">Undercover</h1>
    <div class="logo-sub">League of Legends</div>
    <p class="tagline">Trouve qui n’a pas le même champion que toi.</p>
  </section>
  ${busy ? `
  <section class="panel stack">
    <p class="notice info">Tu es déjà dans le salon <b>${esc(busy.code)}</b> sur un autre onglet ou appareil.</p>
    <button class="btn primary block" data-action="takeOver">Continuer ici</button>
    <p class="muted small center">L’autre onglet sera déconnecté du salon.</p>
  </section>` : ''}
  <section class="panel stack">
    <label class="field"><span>Ton pseudo</span>
      <input id="name" class="input" data-draft maxlength="16" autocomplete="nickname" placeholder="Ex. Faker" enterkeyhint="go">
    </label>
    ${hasCode ? '' : `<button class="btn primary block" data-action="create">Créer un salon</button><div class="divider">ou rejoindre</div>`}
    <form class="row" data-submit="join" id="join-form">
      <input id="code" class="input code grow" data-draft maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="CODE" aria-label="Code du salon">
      <button class="btn ${hasCode ? 'primary' : ''}" type="submit">Rejoindre</button>
    </form>
    ${hasCode ? `<div class="divider">ou</div><button class="btn ghost block" data-action="create">Créer un autre salon</button>` : ''}
  </section>
  ${rulesHtml()}`
}

function topbar(s, title) {
  return `
  <header class="topbar">
    <div class="title">${title}</div>
    <div class="row">
      <span class="code-chip" title="Code du salon">${esc(s.code)}</span>
      <button class="icon-btn" data-action="leave" title="Quitter le salon" aria-label="Quitter le salon">${ICONS.leave}</button>
    </div>
  </header>`
}

function joinLink(s) {
  return `${ui.lanOrigin || location.origin}/?code=${s.code}`
}

function playerRow(s, p, { extra = '', classes = '' } = {}) {
  const isMe = p.id === s.me.id
  const menuOpen = s.me.isHost && !isMe && ui.menuFor === p.id
  const hostTools = s.me.isHost && !isMe
    ? `<button class="icon-btn" data-action="hostMenu" data-id="${p.id}" title="Gérer ${esc(p.name)}" aria-label="Gérer ${esc(p.name)}" aria-expanded="${menuOpen}">${menuOpen ? ICONS.x : '⋯'}</button>`
    : ''
  return `
  <li class="player ${isMe ? 'me' : ''} ${classes}" data-key="${p.id}">
    <div class="avatar" aria-hidden="true">${initials(p.name)}</div>
    <div class="grow">
      <div class="pname">${esc(p.name)}${isMe ? ' <span class="muted small">(toi)</span>' : ''}</div>
      <div class="pmeta">
        ${p.isHost ? `<span class="crown" title="Hôte">${ICONS.crown}</span>Hôte` : ''}
        ${p.connected ? '' : '<span class="dot off" aria-hidden="true"></span>Hors ligne'}
        ${extra}
      </div>
      ${menuOpen ? `<div class="row wrap" style="margin-top:8px">
        <button class="btn tiny ghost" data-action="makeHost" data-id="${p.id}">${ICONS.crown} Donner l’hôte</button>
        <button class="btn tiny danger" data-action="kick" data-id="${p.id}">Exclure</button>
      </div>` : ''}
    </div>
    ${hostTools}
  </li>`
}

// ---------- Salon d'attente ----------

function lobbyView(s) {
  const host = s.me.isHost
  const st = s.settings
  const n = s.players.length
  const active = s.activeCount ?? n
  const civils = active - st.undercovers - st.mrWhites
  const theme = s.themes.find(t => t.id === st.themeId)
  const dis = host ? '' : 'disabled'
  const stepper = (key, label, value, min, max) => `
    <div class="stepper" role="group" aria-label="${label}">
      <button data-action="step" data-key="${key}" data-delta="-1" ${!host || value <= min ? 'disabled' : ''} aria-label="${label} : un de moins">−</button>
      <output aria-live="polite">${value}</output>
      <button data-action="step" data-key="${key}" data-delta="1" ${!host || value >= max ? 'disabled' : ''} aria-label="${label} : un de plus">+</button>
    </div>`

  return `
  ${topbar(s, 'Salon')}
  <section class="panel center">
    <h2>Invite tes amis</h2>
    <div class="big-code" aria-label="Code du salon : ${esc(s.code.split('').join(' '))}">${esc(s.code)}</div>
    <div class="row wrap" style="justify-content:center">
      <button class="btn ghost" data-action="share">${ICONS.share} Partager</button>
      <button class="btn ghost" data-action="toggleQr" aria-expanded="${ui.showQr}">${ICONS.qr} ${ui.showQr ? 'Masquer' : 'QR code'}</button>
    </div>
    ${ui.showQr ? `<img class="qr" src="/qr.svg?u=${encodeURIComponent(joinLink(s))}" alt="QR code pour rejoindre le salon ${esc(s.code)}">` : ''}
    ${ui.lanOrigin ? `<p class="muted small" style="margin-top:10px">Sur le même Wi-Fi : <b>${esc(ui.lanOrigin)}</b></p>` : ''}
  </section>

  <section class="panel">
    <div class="panel-title"><h2>Joueurs</h2><span class="muted small">${n} / ${s.limits.maxPlayers}</span></div>
    <ul class="players">${s.players.map(p => playerRow(s, p)).join('')}</ul>
    ${n < s.limits.minPlayers ? `<p class="muted small" style="margin-top:10px">Encore ${plural(s.limits.minPlayers - n, 'joueur', 'joueurs')} minimum pour lancer.</p>` : ''}
  </section>

  <section class="panel">
    <div class="panel-title"><h2>Réglages</h2>${host ? '' : '<span class="muted small">Choisis par l’hôte</span>'}</div>
    <div class="setting stacked">
      <div class="setting-label" id="theme-label">Thème<small>${theme ? `${theme.itemCount} ${theme.itemLabel}s · ${theme.pairCount} paires` : ''}</small></div>
      <select class="input" data-setting="themeId" ${dis} aria-labelledby="theme-label">
        ${s.themes.map(t => `<option value="${esc(t.id)}" ${t.id === st.themeId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
      </select>
    </div>
    <div class="setting">
      <div class="setting-label">Rôles automatiques<small>Répartition conseillée selon le nombre de joueurs</small></div>
      <label class="switch"><input type="checkbox" data-setting="autoRoles" aria-label="Rôles automatiques" ${st.autoRoles ? 'checked' : ''} ${dis}><span></span></label>
    </div>
    <div class="setting">
      <div class="setting-label">Undercover</div>
      ${stepper('undercovers', 'Undercover', st.undercovers, 0, Math.max(0, active - 2))}
    </div>
    <div class="setting">
      <div class="setting-label">Mr. White</div>
      ${stepper('mrWhites', 'Mr. White', st.mrWhites, 0, Math.max(0, active - 2))}
    </div>
    <div class="setting">
      <div class="setting-label">Civils<small>Calculé automatiquement</small></div>
      <div class="role-summary"><span class="badge civil">${Math.max(0, civils)} civil${civils > 1 ? 's' : ''}</span></div>
    </div>
    <div class="setting">
      <div class="setting-label">Nombre de manches<small>Les scores s’additionnent</small></div>
      ${stepper('rounds', 'Nombre de manches', st.rounds, s.limits.roundsMin, s.limits.roundsMax)}
    </div>
    <div class="setting">
      <div class="setting-label">Indices<small>${st.clueMode === 'oral' ? 'Donnés à voix haute (en vrai ou en vocal)' : 'Chacun écrit son indice dans le site'}</small></div>
      <div class="segmented" role="group" aria-label="Mode des indices">
        <button data-action="setting" data-key="clueMode" data-value="oral" class="${st.clueMode === 'oral' ? 'on' : ''}" aria-pressed="${st.clueMode === 'oral'}" ${dis}>À l’oral</button>
        <button data-action="setting" data-key="clueMode" data-value="written" class="${st.clueMode === 'written' ? 'on' : ''}" aria-pressed="${st.clueMode === 'written'}" ${dis}>Écrits</button>
      </div>
    </div>
    ${s.settingsError ? `<p class="notice" style="margin-top:8px">${esc(s.settingsError)}</p>` : ''}
  </section>

  <div style="margin-top:16px">
    ${host
      ? `<button class="btn primary block ${s.settingsError ? '' : 'pulse'}" data-action="start" ${s.settingsError ? 'disabled' : ''}>Lancer la partie</button>`
      : `<p class="center muted">En attente que l’hôte lance la partie…</p>`}
  </div>
  ${rulesHtml(s.points)}`
}

// ---------- Partie ----------

function gameView(s) {
  const r = s.round
  const m = s.match
  const title = s.phase === 'matchEnd'
    ? 'Fin de la partie'
    : `Manche <b>${m.number}</b>/${m.totalRounds}${s.phase === 'roundEnd' ? '' : ` · Tour <b>${r.turn}</b>`}`
  let body = ''
  switch (s.phase) {
    case 'clues': body = cluesView(s); break
    case 'vote': body = voteView(s); break
    case 'elimination': body = eliminationView(s); break
    case 'roundEnd': body = roundEndView(s); break
    case 'matchEnd': body = matchEndView(s); break
  }
  const inPlay = !['roundEnd', 'matchEnd'].includes(s.phase)
  return `
  ${topbar(s, title)}
  ${m.notice && s.phase === 'clues' && r.turn === 1 ? `<p class="notice info" style="margin-top:12px">${esc(m.notice)}</p>` : ''}
  ${body}
  ${inPlay ? cardView(s) : ''}
  ${inPlay ? playersPanel(s) : ''}
  ${inPlay && r.clues.length ? cluesHistory(s) : ''}
  ${rulesHtml(s.points)}`
}

function spectatorText(s) {
  return s.match.number >= s.match.totalRounds
    ? 'Tu as rejoint pendant la dernière manche : tu joueras à la prochaine partie.'
    : 'Tu as rejoint en cours de manche : tu joueras à la prochaine.'
}

function cardView(s) {
  const r = s.round
  const key = `${s.code}-${r.uid}`
  if (ui.cardKey !== key) {
    ui.cardKey = key
    ui.cardOpen = false
  }
  if (!r.card) {
    return `<section class="panel center"><p class="muted">${spectatorText(s)}</p></section>`
  }
  const out = r.inRound && !r.amAlive ? ' · tu es éliminé·e' : ''
  if (!ui.cardOpen) {
    return `
    <section class="panel card-closed-wrap" id="card">
      <button class="card-closed" data-action="toggleCard" aria-label="Voir ma carte">
        <span class="sigil">${ICONS.sigil}</span>
        <span class="grow"><b>Voir ma carte</b><small>Garde-la à l’abri des regards${out}</small></span>
        <span class="chev" aria-hidden="true">›</span>
      </button>
    </section>`
  }
  let inner
  let label
  if (r.card.kind === 'mrwhite') {
    inner = `<div class="card-mrwhite"><div><div class="q">?</div><h3>Mr. White</h3><p>Tu n’as pas de champion. Écoute les indices, bluffe, et devine celui des civils.</p></div></div>`
    label = 'Tu es Mr. White, tu n’as pas de champion. Touche pour cacher.'
  } else {
    const item = r.card.item
    inner = `${item.image ? `<img src="${esc(item.image)}" alt="" onerror="this.classList.add('broken')">` : ''}<div class="card-name">${esc(item.name)}</div>`
    label = `Ton ${r.itemLabel} : ${item.name}. Touche pour cacher.`
  }
  return `
  <section class="panel card-zone" id="card">
    <button class="game-card" data-action="toggleCard" aria-label="${esc(label)}">${inner}</button>
    <p class="card-hint">Touche la carte pour la cacher${out}.</p>
  </section>`
}

function playersPanel(s) {
  const r = s.round
  const rows = s.players.map(p => {
    const speaking = r.currentSpeaker === p.id
    const out = p.inRound && !p.alive
    let extra = ''
    if (!p.inRound) extra += '<span class="badge neutral">Spectateur</span>'
    if (p.role) extra += roleBadge(p.role)
    if (s.phase === 'vote' && p.inRound && p.alive) extra += p.hasVoted ? '<span class="check">✓ a voté</span>' : '<span>vote…</span>'
    if (speaking) extra += '<span style="color:var(--teal)">parle</span>'
    return playerRow(s, p, { extra, classes: `${out ? 'out' : ''} ${speaking ? 'speaking' : ''}` })
  })
  return `<section class="panel"><div class="panel-title"><h2>Joueurs</h2><span class="muted small">${s.players.filter(p => p.inRound && p.alive).length} en jeu</span></div><ul class="players">${rows.join('')}</ul></section>`
}

function cluesView(s) {
  const r = s.round
  const speaker = s.players.find(p => p.id === r.currentSpeaker)
  const mine = myTurn(s)
  const idx = r.queue.indexOf(r.currentSpeaker)
  const written = r.clueMode === 'written'

  if (mine && ui.vibratedFor !== s.stateKey) {
    ui.vibratedFor = s.stateKey
    // Le navigateur refuse la vibration tant que la page n'a reçu aucun appui de l'utilisateur.
    if (navigator.userActivation?.hasBeenActive) try { navigator.vibrate?.(180) } catch { /* vibration non supportée */ }
  }

  const order = r.queue.map((id, i) => {
    const cls = i < idx ? 'done' : i === idx ? 'current' : ''
    return `<li class="${cls}" data-key="${id}"><span class="n">${i + 1}</span>${esc(nameOf(s, id))}${i < idx ? ' ✓' : ''}</li>`
  }).join('')

  let action
  if (mine) {
    action = written
      ? `<div class="callout you" data-focus><div class="big">À toi de jouer !</div><p class="muted small">Écris un indice sur ton ${esc(r.itemLabel)}, sans le nommer.</p></div>
         <form class="row" data-submit="clue">
           <input id="clue" class="input grow" data-draft maxlength="60" autocomplete="off" placeholder="Ton indice…" enterkeyhint="send" aria-label="Ton indice">
           <button class="btn primary" type="submit">Envoyer</button>
         </form>`
      : `<div class="callout you" data-focus><div class="big">À toi de jouer !</div><p class="muted small">Donne ton indice à voix haute, puis valide.</p></div>
         <button class="btn primary block" data-action="clueDone">J’ai donné mon indice</button>`
  } else {
    action = `<div class="callout"><div class="big">${esc(speaker ? speaker.name : '…')}</div><p class="muted small">${written ? 'écrit son indice…' : 'donne son indice…'}</p></div>`
  }

  const hostTools = s.me.isHost
    ? `<div class="row wrap" style="justify-content:center;margin-top:12px">
        ${!mine ? `<button class="btn tiny ghost" data-action="passSpeaker">Passer ${esc(speaker ? speaker.name : '')}</button>` : ''}
        <button class="btn tiny ghost" data-action="skipToVote">Aller directement au vote</button>
      </div>`
    : ''

  return `
  <section class="panel" id="phase-clues">
    <div class="phase-head"><h2>Indices · tour ${r.turn}</h2><span class="muted small">${idx + 1}/${r.queue.length}</span></div>
    <ol class="order" style="margin-top:10px">${order}</ol>
    <div style="margin-top:12px">${action}</div>
    ${hostTools}
  </section>`
}

function cluesHistory(s) {
  const r = s.round
  const turns = [...new Set(r.clues.map(c => c.turn))].sort((a, b) => b - a)
  return `
  <section class="panel">
    <h2 style="margin-bottom:10px">Indices donnés</h2>
    <div class="clues">
      ${turns.map(t => `
        <div class="clue-turn" data-key="turn-${t}">
          <h3>Tour ${t}</h3>
          ${r.clues.filter(c => c.turn === t).map(c => `
            <div class="clue"><span class="who">${esc(nameOf(s, c.playerId))}</span>
              ${c.text ? `<span class="what">« ${esc(c.text)} »</span>` : `<span class="what oral">${c.skipped ? 'passé' : 'à l’oral'}</span>`}
            </div>`).join('')}
        </div>`).join('')}
    </div>
  </section>`
}

function voteView(s) {
  const r = s.round
  const v = r.vote
  const me = s.me.id
  const canVote = r.inRound && r.amAlive
  const tied = v.attempt === 2

  const buttons = v.candidates
    .filter(id => id !== me)
    .map(id => `<button class="vote-btn ${v.myVote === id ? 'on' : ''}" data-action="vote" data-id="${id}" data-key="${id}" aria-pressed="${v.myVote === id}">
        <span class="avatar" aria-hidden="true">${initials(nameOf(s, id))}</span><span class="grow pname">${esc(nameOf(s, id))}</span></button>`)
    .join('')

  const pct = Math.round((v.votedCount / v.voters.length) * 100)
  return `
  <section class="panel" id="phase-vote-${v.attempt}">
    <div class="phase-head"><h2>${tied ? 'Égalité · revote' : 'Vote'}</h2><span class="muted small">${v.votedCount}/${v.voters.length} votes</span></div>
    ${tied ? `<p class="notice info" style="margin-top:10px">Égalité entre ${joinNames(v.candidates.map(id => `<b>${esc(nameOf(s, id))}</b>`))}. Ils peuvent se défendre, puis on revote entre eux.</p>` : ''}
    <div class="progress" style="margin-top:12px" role="progressbar" aria-label="Votes reçus" aria-valuemin="0" aria-valuemax="${v.voters.length}" aria-valuenow="${v.votedCount}"><div style="width:${pct}%"></div></div>
    <div style="margin-top:14px" ${canVote && !v.myVote ? 'data-focus' : ''}>
      ${canVote
        ? `<p class="muted small" style="margin-bottom:10px">${v.myVote ? `Vote enregistré contre <b>${esc(nameOf(s, v.myVote))}</b>. Tu peux encore changer d’avis tant que tout le monde n’a pas voté.` : 'Qui est l’infiltré ? Vote en secret.'}</p><div class="vote-grid">${buttons}</div>`
        : `<p class="center muted">${r.inRound ? 'Tu es éliminé·e : tu ne votes plus.' : spectatorText(s)}</p>`}
    </div>
    ${s.me.isHost && v.votedCount > 0 && v.votedCount < v.voters.length
      ? `<div class="center" style="margin-top:12px"><button class="btn tiny ghost" data-action="closeVote">Clore le vote maintenant</button></div>`
      : ''}
  </section>`
}

function eliminationView(s) {
  const r = s.round
  const e = r.elimination
  const isMe = e.playerId === s.me.id
  const host = s.me.isHost

  let guessBlock = ''
  if (e.awaitingGuess) {
    guessBlock = isMe
      ? `<div class="stack" style="margin-top:14px" data-focus>
          <p class="center"><b>Démasqué !</b> Dernière chance : quel est le ${esc(r.itemLabel)} des civils ?</p>
          <form class="row" data-submit="guess">
            <input id="guess" class="input grow" data-draft list="guess-options" maxlength="40" autocomplete="off" placeholder="Nom du ${esc(r.itemLabel)}…" enterkeyhint="send" aria-label="Ta proposition">
            <button class="btn primary" type="submit">Valider</button>
          </form>
          <datalist id="guess-options">${(e.guessOptions || []).map(n => `<option value="${esc(n)}">`).join('')}</datalist>
        </div>`
      : `<p class="center muted" style="margin-top:14px">Mr. White tente de deviner le ${esc(r.itemLabel)} des civils…</p>
         ${host ? `<div class="center" style="margin-top:10px"><button class="btn tiny ghost" data-action="skipGuess">Passer sa proposition</button></div>` : ''}`
  } else if (e.guess) {
    const g = e.guess
    guessBlock = g.skipped
      ? `<p class="center muted" style="margin-top:14px">Mr. White n’a pas fait de proposition.</p>`
      : `<div class="verdict ${g.correct ? 'ok' : 'ko'}" style="margin-top:14px">
          Proposition : « ${esc(g.text)} »${g.matched && !g.correct ? ` (${esc(g.matched.name)})` : ''}<br>
          <b>${g.correct ? `Bonne réponse ! C’était bien ${esc(e.answer?.name || '')}.` : 'Raté !'}</b>
        </div>`
  }

  const ballots = (e.ballots || [])
    .map(b => `<div><span><b>${esc(nameOf(s, b.voter))}</b> → ${esc(nameOf(s, b.target))}</span></div>`)
    .join('')

  const cta = e.outcome ? 'Voir le résultat' : 'Tour suivant'
  return `
  <section class="panel" id="phase-elimination">
    <div class="reveal" ${e.awaitingGuess && isMe ? '' : 'data-focus'}>
      <p class="muted small">${e.tie ? `Égalité persistante entre ${esc(joinNames(e.tie.map(id => nameOf(s, id))))} : tirage au sort.` : 'Le vote a tranché…'}</p>
      <div class="name">${esc(nameOf(s, e.playerId))}${isMe ? ' (toi)' : ''}</div>
      <p class="muted">est éliminé·e. C’était…</p>
      ${roleBadge(e.role)}
    </div>
    ${guessBlock}
    ${ballots ? `<details style="margin-top:14px" id="ballots"><summary class="muted small" style="cursor:pointer">Détail des votes</summary><div class="ballots" style="margin-top:8px">${ballots}</div></details>` : ''}
    <div style="margin-top:16px">
      ${host
        ? `<button class="btn primary block" data-action="continue" ${e.awaitingGuess ? 'disabled' : ''}>${cta}</button>`
        : `<p class="center muted small">${e.awaitingGuess ? '' : 'En attente de l’hôte…'}</p>`}
    </div>
  </section>`
}

function figure(item, label, role) {
  return `<figure>
    <div class="frame">${item?.image ? `<img src="${esc(item.image)}" alt="${esc(item.name)}" onerror="this.classList.add('broken')">` : ''}</div>
    <figcaption><b>${esc(item?.name || '?')}</b><span class="badge ${role}">${label}</span></figcaption>
  </figure>`
}

// Rang partagé en cas d'égalité : 1 + nombre de joueurs strictement devant.
function rankPlayers(players) {
  const sorted = [...players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'fr'))
  return sorted.map(p => ({ ...p, rank: 1 + sorted.filter(q => q.score > p.score).length }))
}

function scoreboard(s, gains = {}) {
  return `<table class="table">${rankPlayers(s.players).map(p => `
    <tr><td><span class="muted">${p.rank}.</span> ${esc(p.name)}${p.id === s.me.id ? ' <span class="muted small">(toi)</span>' : ''}</td>
    <td>${gains[p.id] ? `<span class="gain">+${gains[p.id]}</span> ` : ''}<span class="score">${p.score} pts</span></td></tr>`).join('')}
  </table>`
}

function roundEndView(s) {
  const r = s.round
  const res = r.result
  const m = s.match
  const titles = {
    civils: 'Victoire des civils',
    infiltres: 'Victoire des infiltrés',
    mrwhite: 'Mr. White a trouvé !',
  }
  const subtitle = res.camp === 'mrwhite'
    ? `${esc(res.names[res.guesser])} a deviné le champion des civils.`
    : res.camp === 'civils' ? 'Tous les infiltrés ont été démasqués.' : 'Il ne reste plus qu’un seul civil.'
  const last = m.number >= m.totalRounds || s.players.length < s.limits.minPlayers
  const ids = Object.keys(res.roles)
  const order = { undercover: 0, mrwhite: 1, civil: 2 }
  ids.sort((a, b) => order[res.roles[a]] - order[res.roles[b]])

  return `
  <section class="panel" id="phase-roundEnd" data-focus>
    <div class="victory ${res.camp}"><div class="title">${titles[res.camp]}</div><p class="muted" style="margin-top:6px">${subtitle}</p></div>
  </section>
  <section class="panel stack">
    <div class="duo ${res.undercover ? '' : 'single'}">${figure(res.civil, 'Civils', 'civil')}${res.undercover ? figure(res.undercover, 'Undercover', 'undercover') : ''}</div>
    ${res.reason ? `<p class="reason">${esc(res.reason)}</p>` : ''}
  </section>
  <section class="panel">
    <h2 style="margin-bottom:8px">Rôles</h2>
    <table class="table">${ids.map(id => `
      <tr><td>${esc(res.names[id])}${id === s.me.id ? ' <span class="muted small">(toi)</span>' : ''}</td>
      <td>${roleBadge(res.roles[id])} ${res.points[id] ? `<span class="gain">+${res.points[id]}</span>` : ''}</td></tr>`).join('')}
    </table>
  </section>
  <section class="panel">
    <h2 style="margin-bottom:8px">Classement</h2>
    ${scoreboard(s, res.points)}
  </section>
  <div style="margin-top:16px">
    ${s.me.isHost
      ? `<button class="btn primary block" data-action="continue">${last ? 'Voir le classement final' : `Manche suivante (${m.number + 1}/${m.totalRounds})`}</button>`
      : '<p class="center muted">En attente de l’hôte…</p>'}
  </div>`
}

function matchEndView(s) {
  const ranked = rankPlayers(s.players)
  const best = ranked[0]
  const winners = best ? ranked.filter(p => p.score === best.score) : []
  const podium = [ranked[1], ranked[0], ranked[2]]
  const cls = ['p2', 'p1', 'p3']
  const campLabel = { civils: 'Civils', infiltres: 'Infiltrés', mrwhite: 'Mr. White' }
  const campRole = { civils: 'civil', infiltres: 'undercover', mrwhite: 'mrwhite' }
  const headline = winners.length > 1
    ? `<div class="title">Égalité !</div><p class="muted">${esc(joinNames(winners.map(p => p.name)))} terminent ex æquo avec ${best.score} points</p>`
    : best ? `<div class="title">${esc(best.name)}</div><p class="muted">remporte la partie avec ${best.score} points</p>` : ''
  return `
  <section class="panel" id="phase-matchEnd" data-focus>
    <div class="victory civils">${headline}</div>
    <div class="podium" style="margin-top:16px">
      ${podium.map((p, i) => p ? `<div class="step ${cls[i]}"><div class="rank">${p.rank}</div><div class="who">${esc(p.name)}</div><div class="score">${p.score} pts</div></div>` : '<div></div>').join('')}
    </div>
  </section>
  <section class="panel">
    <h2 style="margin-bottom:8px">Classement final</h2>
    ${scoreboard(s)}
  </section>
  <section class="panel">
    <h2 style="margin-bottom:8px">Manches jouées</h2>
    <ul class="history">${s.match.history.map(h => `
      <li><span><span class="muted">${h.number}.</span> ${esc(h.civil?.name)}${h.undercover ? ` <span class="muted">vs</span> ${esc(h.undercover.name)}` : ''}</span>
      <span class="badge ${campRole[h.camp]}">${campLabel[h.camp]}</span></li>`).join('')}
    </ul>
  </section>
  <div class="stack" style="margin-top:16px">
    ${s.me.isHost ? '<button class="btn primary block" data-action="backToLobby">Nouvelle partie</button>' : '<p class="center muted">L’hôte peut relancer une nouvelle partie.</p>'}
    <button class="btn ghost block" data-action="leave">Quitter le salon</button>
  </div>`
}

// ---------- Actions ----------

function readName() {
  const name = (ui.drafts.name || '').trim()
  if (!name) {
    toast('Choisis d’abord un pseudo.', 'error')
    document.getElementById('name')?.focus()
    return null
  }
  try { localStorage.setItem(NAME_KEY, name) } catch { /* stockage indisponible */ }
  return name
}

async function enterRoom(event, payload) {
  if (ui.busy) return
  ui.busy = true
  const res = await emit(event, payload)
  ui.busy = false
  if (res.ok) {
    ui.busySession = null
    saveSession(res)
    history.replaceState(null, '', `/?code=${res.code}`)
  }
}

const handlers = {
  create() {
    const name = readName()
    if (name) enterRoom('room:create', { name })
  },
  join() {
    const name = readName()
    const code = (ui.drafts.code || '').trim().toUpperCase()
    if (!name) return
    if (code.length !== 4) return toast('Le code fait 4 lettres.', 'error')
    enterRoom('room:join', { name, code })
  },
  async takeOver() {
    const session = ui.busySession
    if (!session) return
    await enterRoom('room:resume', { ...session, soft: false })
    if (!ui.session) {
      ui.busySession = null
      render()
      toast('Impossible de reprendre ta place : rejoins le salon à nouveau.', 'error')
    }
  },
  async leave() {
    if (!confirm('Quitter le salon ?')) return
    const res = await emit('room:leave')
    // Hors connexion, rien n'est parti : on garde la session pour ne pas laisser un joueur fantôme côté serveur.
    if (!res.ok && !res.error) return
    leaveLocally()
  },
  async share() {
    const link = joinLink(ui.state)
    if (navigator.share) {
      try { await navigator.share({ title: 'Undercover · League of Legends', text: `Rejoins mon salon Undercover (code ${ui.state.code})`, url: link }); return } catch { /* partage annulé : on copie */ }
    }
    try {
      await navigator.clipboard.writeText(link)
      toast('Lien copié !')
    } catch {
      prompt('Copie ce lien :', link)
    }
  },
  toggleQr() { ui.showQr = !ui.showQr; render() },
  toggleCard() { ui.cardOpen = !ui.cardOpen; render() },
  setting(el) { act('updateSettings', { patch: { [el.dataset.key]: el.dataset.value } }) },
  step(el) {
    const key = el.dataset.key
    const value = ui.state.settings[key] + Number(el.dataset.delta)
    act('updateSettings', { patch: { [key]: value } })
  },
  start() { act('start') },
  clueDone() { act('clue', { text: '' }) },
  async clue() {
    const text = (ui.drafts.clue || '').trim()
    if (!text) return toast('Écris ton indice.', 'error')
    const res = await act('clue', { text })
    if (res.ok && !res.stale) ui.drafts.clue = ''
  },
  passSpeaker() { act('clue', { text: '' }) },
  skipToVote() { if (confirm('Passer directement au vote ?')) act('skipToVote') },
  vote(el) { act('vote', { targetId: el.dataset.id }) },
  closeVote() { if (confirm('Clore le vote avec les votes déjà exprimés ?')) act('closeVote') },
  async guess() {
    const text = (ui.drafts.guess || '').trim()
    if (!text) return toast('Propose un nom.', 'error')
    const res = await act('guess', { text })
    if (res.ok) ui.drafts.guess = ''
  },
  skipGuess() { if (confirm('Passer la proposition de Mr. White ?')) act('skipGuess') },
  continue() { act('continue') },
  backToLobby() { act('backToLobby') },
  hostMenu(el) {
    ui.menuFor = ui.menuFor === el.dataset.id ? null : el.dataset.id
    render()
  },
  makeHost(el) {
    const p = ui.state.players.find(x => x.id === el.dataset.id)
    ui.menuFor = null
    if (p && confirm(`Donner le rôle d’hôte à ${p.name} ?`)) act('transferHost', { targetId: p.id })
    else render()
  },
  kick(el) {
    const p = ui.state.players.find(x => x.id === el.dataset.id)
    ui.menuFor = null
    const inGame = ui.state.phase !== 'lobby'
    if (p && confirm(`Exclure ${p.name} du salon ?${inGame ? ' Il sera retiré de la manche en cours.' : ''}`)) act('kick', { targetId: p.id })
    else render()
  },
}

function leaveLocally(message, { keepCode = false } = {}) {
  const code = ui.session?.code || ui.state?.code || ''
  saveSession(null)
  ui.state = null
  ui.showQr = false
  ui.menuFor = null
  ui.drafts.code = keepCode ? code : ''
  history.replaceState(null, '', keepCode && code ? `/?code=${code}` : '/')
  render()
  if (message) toast(message, 'error')
}

$app.addEventListener('click', e => {
  const el = e.target.closest('[data-action]')
  if (!el || el.disabled) return
  const handler = handlers[el.dataset.action]
  if (handler) {
    e.preventDefault()
    handler(el)
  }
})

$app.addEventListener('submit', e => {
  const form = e.target.closest('[data-submit]')
  if (!form) return
  e.preventDefault()
  handlers[form.dataset.submit]?.(form)
})

$app.addEventListener('input', e => {
  const el = e.target
  if (el.matches('[data-draft]')) {
    if (el.id === 'code') {
      const pos = el.selectionStart
      el.value = el.value.toUpperCase().replace(/[^A-Z]/g, '')
      try { el.setSelectionRange(pos, pos) } catch { /* ignoré */ }
    }
    ui.drafts[el.id] = el.value
  }
})

$app.addEventListener('change', e => {
  const el = e.target
  if (!el.dataset.setting) return
  const value = el.type === 'checkbox' ? el.checked : el.value
  act('updateSettings', { patch: { [el.dataset.setting]: value } })
})

$app.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'name' && !ui.state) {
    e.preventDefault()
    if (ui.drafts.code) handlers.join()
    else handlers.create()
  }
})

// ---------- Socket ----------

socket.on('connect', async () => {
  ui.connected = true
  if (ui.session) {
    const session = ui.session
    ui.resuming = !ui.state
    render()
    const res = await emit('room:resume', session)
    ui.resuming = false
    if (res.ok) {
      saveSession(res)
    } else if (res.reason === 'busy') {
      // Ce joueur est déjà connecté ailleurs : on propose de reprendre la main ici.
      ui.session = null
      ui.busySession = { code: session.code, playerId: session.playerId, token: session.token }
    } else if (res.reason === 'removed') {
      leaveLocally('Tu as été retiré du salon (absence prolongée ou exclusion). Rejoins-le à nouveau.', { keepCode: true })
      return
    } else if (res.reason === 'gone') {
      if (ui.state) return leaveLocally('Le salon n’existe plus.')
      // Vieille session d'un salon expiré : on l'oublie sans toucher au code du lien d'invitation.
      saveSession(null)
    }
  }
  render()
})

socket.on('disconnect', () => {
  ui.connected = false
  updateBanner()
})

socket.on('state', state => {
  if (state.stateKey !== ui.state?.stateKey) ui.keyChangedAt = performance.now()
  ui.state = state
  if (state.phase === 'lobby') ui.cardOpen = false
  render()
})

socket.on('kicked', () => leaveLocally('Tu as été exclu du salon.'))

socket.on('session:replaced', () => {
  // La session (partagée entre onglets) appartient désormais à l'autre onglet : on l'oublie seulement ici.
  ui.state = null
  ui.session = null
  try { sessionStorage.removeItem(SESSION_KEY) } catch { /* ignoré */ }
  render()
  toast('Ce salon est maintenant ouvert dans un autre onglet.', 'error')
})

render()
