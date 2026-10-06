// Logique d'un salon : joueurs, réglages, manches, tours de parole, votes, scores.
// Le serveur fait autorité : chaque joueur reçoit une vue personnalisée sans les informations secrètes des autres.
import { randomInt, randomUUID } from 'node:crypto'
import { itemView, pickPair, themeSummary } from './themes.js'
import { checkGuess } from './match.js'

export class GameError extends Error {
  constructor(message) {
    super(message)
    this.name = 'GameError'
  }
}

export const POINTS = { civil: 2, undercover: 10, mrwhite: 6 }
export const LIMITS = {
  minPlayers: 3,
  maxPlayers: 20,
  nameMax: 16,
  clueMax: 60,
  guessMax: 40,
  roundsMin: 1,
  roundsMax: 20,
}
// Un téléphone verrouillé coupe le socket : on laisse le temps de revenir avant de retirer le joueur du salon d'attente.
export const LOBBY_GRACE_MS = 5 * 60_000
export const HOST_GRACE_MS = 20_000
export const EMPTY_ROOM_TTL_MS = 30 * 60_000
// Absent depuis plus longtemps au lancement d'une manche : spectateur pour cette manche (score conservé).
export const INACTIVE_MS = 3 * 60_000

const defaultRng = { int: max => randomInt(max) }

function shuffle(list, rng) {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Retire caractères de contrôle et de formatage invisibles (espaces de largeur nulle, inversions bidi…).
function cleanText(value, max) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\u0000-\u001f\u007f]|\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function cleanName(value) {
  const name = cleanText(typeof value === 'string' ? value.normalize('NFKC') : value, LIMITS.nameMax)
  return /[\p{L}\p{N}]/u.test(name) ? name : ''
}

export function recommendedRoles(n) {
  if (n <= 3) return { undercovers: 1, mrWhites: 0 }
  if (n <= 6) return { undercovers: 1, mrWhites: 1 }
  if (n <= 9) return { undercovers: 2, mrWhites: 1 }
  if (n <= 12) return { undercovers: 3, mrWhites: 1 }
  return { undercovers: Math.floor(n / 4), mrWhites: 2 }
}

export function validateRoles(n, undercovers, mrWhites) {
  if (n < LIMITS.minPlayers) return `Il faut au moins ${LIMITS.minPlayers} joueurs.`
  if (undercovers + mrWhites < 1) return 'Il faut au moins un Undercover ou un Mr. White.'
  const civils = n - undercovers - mrWhites
  if (civils < 2) return 'Il faut au moins 2 civils.'
  if (civils < undercovers + mrWhites) return 'Il faut au moins autant de civils que d’infiltrés.'
  return null
}

let joinSeq = 0

export class Room {
  constructor(code, themes, { rng = defaultRng, now = () => Date.now() } = {}) {
    this.code = code
    this.themes = themes
    this.rng = rng
    this.now = now
    this.players = new Map()
    this.hostId = null
    this.phase = 'lobby'
    this.settings = {
      themeId: themes.keys().next().value,
      autoRoles: true,
      undercovers: 1,
      mrWhites: 0,
      rounds: 3,
      clueMode: 'oral',
    }
    this.match = null
    this.round = null
    this.emptySince = null
  }

  get theme() {
    return this.themes.get(this.settings.themeId)
  }

  // ---------- Joueurs ----------

  orderedPlayers() {
    return [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)
  }

  addPlayer(rawName) {
    const name = cleanName(rawName)
    if (!name) throw new GameError('Choisis un pseudo (avec au moins une lettre ou un chiffre).')
    if (this.players.size >= LIMITS.maxPlayers) throw new GameError('Le salon est plein.')
    const lower = name.toLocaleLowerCase('fr')
    if ([...this.players.values()].some(p => p.name.toLocaleLowerCase('fr') === lower)) {
      throw new GameError('Ce pseudo est déjà pris dans ce salon.')
    }
    const player = {
      id: randomUUID(),
      token: randomUUID(),
      name,
      connected: true,
      disconnectedAt: null,
      score: 0,
      joinedAt: ++joinSeq,
    }
    this.players.set(player.id, player)
    if (!this.hostId) this.hostId = player.id
    this.emptySince = null
    this.syncAutoRoles()
    return player
  }

  authenticate(playerId, token) {
    const player = this.players.get(playerId)
    return player && player.token === token ? player : null
  }

  setConnected(playerId, connected) {
    const player = this.players.get(playerId)
    if (!player) return
    player.connected = connected
    player.disconnectedAt = connected ? null : this.now()
    if (connected) this.emptySince = null
    else if (![...this.players.values()].some(p => p.connected)) this.emptySince = this.now()
  }

  requireHost(playerId) {
    if (playerId !== this.hostId) throw new GameError('Seul l’hôte peut faire ça.')
  }

  requirePhase(...phases) {
    if (!phases.includes(this.phase)) throw new GameError('Action impossible à ce moment de la partie.')
  }

  transferHost(playerId, targetId) {
    this.requireHost(playerId)
    if (!this.players.has(targetId)) throw new GameError('Joueur introuvable.')
    this.hostId = targetId
  }

  kick(playerId, targetId) {
    this.requireHost(playerId)
    if (targetId === playerId) throw new GameError('Utilise « Quitter » pour partir.')
    if (!this.players.has(targetId)) throw new GameError('Joueur introuvable.')
    this.removePlayer(targetId)
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId)
    if (!player) return
    this.players.delete(playerId)
    if (this.hostId === playerId) {
      const next = this.orderedPlayers().find(p => p.connected) || this.orderedPlayers()[0]
      this.hostId = next ? next.id : null
    }
    if (this.round && this.round.participants.includes(playerId)) this.handleDeparture(playerId)
    if (this.players.size && ![...this.players.values()].some(p => p.connected)) this.emptySince ??= this.now()
    this.syncAutoRoles()
  }

  /** Joueurs à qui distribuer une carte : les connectés et les absents récents. */
  activePlayerIds() {
    const now = this.now()
    const all = this.orderedPlayers()
    const active = all.filter(p => p.connected || now - p.disconnectedAt < INACTIVE_MS)
    return (active.length >= LIMITS.minPlayers ? active : all).map(p => p.id)
  }

  /**
   * Identifie l'écran en cours : une action envoyée depuis un écran périmé (double appui, latence) est ignorée.
   * Forme « phase:manche:tour|orateur:vote » ; la partie avant « | » suffit pour les actions qui ne dépendent pas de l'orateur.
   */
  get stateKey() {
    const r = this.round
    if (!r) return this.phase
    return `${this.phase}:${r.uid}:${r.turn}|${this.currentSpeaker() ?? ''}:${r.vote ? r.vote.seq : ''}`
  }

  /**
   * Nettoyage périodique : retire les absents du salon d'attente, passe la main si l'hôte a disparu.
   * Renvoie { changed, dead } ; dead = le salon peut être supprimé.
   */
  sweep() {
    const now = this.now()
    let changed = false
    if (this.phase === 'lobby') {
      for (const p of [...this.players.values()]) {
        if (!p.connected && p.disconnectedAt && now - p.disconnectedAt > LOBBY_GRACE_MS) {
          this.removePlayer(p.id)
          changed = true
        }
      }
    }
    const host = this.players.get(this.hostId)
    if (host && !host.connected && host.disconnectedAt && now - host.disconnectedAt > HOST_GRACE_MS) {
      const next = this.orderedPlayers().find(p => p.connected)
      if (next) {
        this.hostId = next.id
        changed = true
      }
    }
    const dead = this.players.size === 0 || (this.emptySince !== null && now - this.emptySince > EMPTY_ROOM_TTL_MS)
    return { changed, dead }
  }

  // ---------- Réglages ----------

  syncAutoRoles() {
    if (this.phase === 'lobby' && this.settings.autoRoles) {
      Object.assign(this.settings, recommendedRoles(this.activePlayerIds().length))
    }
  }

  updateSettings(playerId, patch = {}) {
    this.requireHost(playerId)
    this.requirePhase('lobby')
    const s = this.settings
    if ('themeId' in patch) {
      if (!this.themes.has(patch.themeId)) throw new GameError('Thème inconnu.')
      s.themeId = patch.themeId
    }
    if ('rounds' in patch) {
      const r = Number(patch.rounds)
      if (!Number.isInteger(r) || r < LIMITS.roundsMin || r > LIMITS.roundsMax) throw new GameError('Nombre de manches invalide.')
      s.rounds = r
    }
    if ('clueMode' in patch) {
      if (!['oral', 'written'].includes(patch.clueMode)) throw new GameError('Mode d’indices invalide.')
      s.clueMode = patch.clueMode
    }
    // Passer en manuel part de la répartition affichée, pas d'une valeur auto périmée.
    if (s.autoRoles && ('undercovers' in patch || 'mrWhites' in patch || patch.autoRoles === false)) {
      Object.assign(s, this.rolesFor(this.activePlayerIds().length))
    }
    for (const key of ['undercovers', 'mrWhites']) {
      if (key in patch) {
        const v = Number(patch[key])
        if (!Number.isInteger(v) || v < 0 || v > LIMITS.maxPlayers) throw new GameError('Nombre de rôles invalide.')
        s[key] = v
        s.autoRoles = false
      }
    }
    if ('autoRoles' in patch) {
      s.autoRoles = Boolean(patch.autoRoles)
      this.syncAutoRoles()
    }
  }

  rolesFor(n) {
    return this.settings.autoRoles
      ? recommendedRoles(n)
      : { undercovers: this.settings.undercovers, mrWhites: this.settings.mrWhites }
  }

  // ---------- Partie ----------

  startMatch(playerId) {
    this.requireHost(playerId)
    this.requirePhase('lobby')
    const n = this.activePlayerIds().length
    const { undercovers, mrWhites } = this.rolesFor(n)
    const error = validateRoles(n, undercovers, mrWhites)
    if (error) throw new GameError(error)
    for (const p of this.players.values()) p.score = 0
    this.match = {
      totalRounds: this.settings.rounds,
      number: 0,
      usedPairs: new Set(),
      recentItems: [],
      history: [],
      notice: null,
    }
    this.startRound()
  }

  startRound() {
    const ids = this.activePlayerIds()
    let { undercovers, mrWhites } = this.rolesFor(ids.length)
    this.match.notice = null
    if (validateRoles(ids.length, undercovers, mrWhites)) {
      ;({ undercovers, mrWhites } = recommendedRoles(ids.length))
      this.match.notice = `Rôles ajustés automatiquement à ${ids.length} joueurs.`
    }

    const pair = pickPair(this.theme, this.match.usedPairs, this.match.recentItems, this.rng)
    this.match.recentItems = [pair.civil, pair.undercover, ...this.match.recentItems].slice(0, 6)

    const roles = {}
    shuffle(ids, this.rng).forEach((id, i) => {
      roles[id] = i < undercovers ? 'undercover' : i < undercovers + mrWhites ? 'mrwhite' : 'civil'
    })

    // Mr. White ne commence jamais le premier tour. Tirage uniforme parmi les ordres valides,
    // pour ne pas rendre une position (ex. 2e orateur) statistiquement plus suspecte.
    const starters = ids.filter(id => roles[id] !== 'mrwhite')
    const first = starters[this.rng.int(starters.length)]
    const order = [first, ...shuffle(ids.filter(id => id !== first), this.rng)]

    this.roundSeq = (this.roundSeq || 0) + 1
    this.round = {
      uid: this.roundSeq,
      number: ++this.match.number,
      themeId: this.theme.id,
      pair,
      participants: ids,
      names: Object.fromEntries(ids.map(id => [id, this.players.get(id).name])),
      roles,
      alive: new Set(ids),
      order,
      turn: 1,
      queue: [],
      speakerIdx: 0,
      clues: [],
      vote: null,
      elimination: null,
      eliminations: [],
      result: null,
    }
    this.beginTurn()
  }

  beginTurn() {
    const r = this.round
    const alive = r.order.filter(id => r.alive.has(id))
    const shift = (r.turn - 1) % alive.length
    r.queue = [...alive.slice(shift), ...alive.slice(0, shift)]
    r.speakerIdx = 0
    r.vote = null
    r.elimination = null
    this.phase = 'clues'
  }

  currentSpeaker() {
    const r = this.round
    return r && this.phase === 'clues' ? r.queue[r.speakerIdx] ?? null : null
  }

  submitClue(playerId, rawText) {
    this.requirePhase('clues')
    const r = this.round
    const speaker = this.currentSpeaker()
    const isSpeaker = playerId === speaker
    if (!isSpeaker && playerId !== this.hostId) throw new GameError('Ce n’est pas ton tour de parler.')
    const text = cleanText(rawText, LIMITS.clueMax)
    if (isSpeaker && this.settings.clueMode === 'written' && !text) throw new GameError('Écris ton indice.')
    r.clues.push({ turn: r.turn, playerId: speaker, text: isSpeaker ? text || null : null, skipped: !isSpeaker })
    this.advanceSpeaker()
  }

  advanceSpeaker() {
    const r = this.round
    r.speakerIdx++
    while (r.speakerIdx < r.queue.length && !r.alive.has(r.queue[r.speakerIdx])) r.speakerIdx++
    if (r.speakerIdx >= r.queue.length) this.startVote([...r.alive], 1)
  }

  skipToVote(playerId) {
    this.requireHost(playerId)
    this.requirePhase('clues')
    this.startVote([...this.round.alive], 1)
  }

  startVote(candidates, attempt) {
    this.voteSeq = (this.voteSeq || 0) + 1
    this.round.vote = { seq: this.voteSeq, candidates, attempt, ballots: new Map() }
    this.phase = 'vote'
  }

  castVote(playerId, targetId) {
    this.requirePhase('vote')
    const r = this.round
    if (!r.alive.has(playerId)) throw new GameError('Tu ne participes pas à ce vote.')
    if (targetId === playerId) throw new GameError('Tu ne peux pas voter contre toi-même.')
    if (!r.vote.candidates.includes(targetId)) throw new GameError('Ce joueur ne fait pas partie du vote.')
    r.vote.ballots.set(playerId, targetId)
    if ([...r.alive].every(id => r.vote.ballots.has(id))) this.tally()
  }

  closeVote(playerId) {
    this.requireHost(playerId)
    this.requirePhase('vote')
    if (!this.round.vote.ballots.size) throw new GameError('Personne n’a encore voté.')
    this.tally()
  }

  tally() {
    const r = this.round
    const counts = {}
    for (const target of r.vote.ballots.values()) counts[target] = (counts[target] || 0) + 1
    const max = Math.max(...Object.values(counts))
    const top = Object.keys(counts).filter(id => counts[id] === max)
    const ballots = [...r.vote.ballots].map(([voter, target]) => ({ voter, target }))
    if (top.length === 1) return this.eliminate(top[0], { tally: counts, ballots, tie: null })
    if (r.vote.attempt === 1) return this.startVote(top, 2)
    const loser = top[this.rng.int(top.length)]
    this.eliminate(loser, { tally: counts, ballots, tie: top })
  }

  eliminate(playerId, { tally, ballots, tie }) {
    const r = this.round
    r.alive.delete(playerId)
    const role = r.roles[playerId]
    r.eliminations.push({ playerId, role, turn: r.turn, left: false })
    const awaitingGuess = role === 'mrwhite' && this.players.has(playerId)
    r.elimination = { playerId, role, tally, ballots, tie, awaitingGuess, guess: null, outcome: null }
    if (!awaitingGuess) r.elimination.outcome = this.computeOutcome()
    r.vote = null
    this.phase = 'elimination'
  }

  computeOutcome() {
    const r = this.round
    let civils = 0
    let infiltrators = 0
    for (const id of r.alive) {
      if (r.roles[id] === 'civil') civils++
      else infiltrators++
    }
    if (infiltrators === 0) return { camp: 'civils' }
    if (civils <= 1) return { camp: 'infiltres' }
    return null
  }

  submitGuess(playerId, rawGuess) {
    this.requirePhase('elimination')
    const e = this.round.elimination
    if (!e.awaitingGuess || e.playerId !== playerId) throw new GameError('Ce n’est pas à toi de deviner.')
    const text = cleanText(rawGuess, LIMITS.guessMax)
    if (!text) throw new GameError('Propose un nom.')
    const { correct, matchedId } = checkGuess(this.theme, text, this.round.pair.civil)
    e.guess = { text, correct, matchedId, skipped: false }
    e.awaitingGuess = false
    e.outcome = correct ? { camp: 'mrwhite', guesser: playerId } : this.computeOutcome()
  }

  skipGuess(playerId) {
    this.requireHost(playerId)
    this.requirePhase('elimination')
    const e = this.round.elimination
    if (!e.awaitingGuess) throw new GameError('Aucune proposition en attente.')
    e.guess = { text: null, correct: false, matchedId: null, skipped: true }
    e.awaitingGuess = false
    e.outcome = this.computeOutcome()
  }

  continueGame(playerId) {
    this.requireHost(playerId)
    this.requirePhase('elimination', 'roundEnd')
    if (this.phase === 'elimination') {
      const e = this.round.elimination
      if (e.awaitingGuess) throw new GameError('Mr. White doit d’abord faire sa proposition.')
      if (e.outcome) return this.endRound(e.outcome)
      this.round.turn++
      return this.beginTurn()
    }
    if (this.players.size < LIMITS.minPlayers || this.match.number >= this.match.totalRounds) {
      this.phase = 'matchEnd'
      return
    }
    this.startRound()
  }

  endRound(outcome) {
    const r = this.round
    const points = {}
    if (outcome.camp === 'mrwhite') {
      points[outcome.guesser] = POINTS.mrwhite
    } else {
      for (const id of r.participants) {
        const role = r.roles[id]
        const won = outcome.camp === 'civils' ? role === 'civil' : role !== 'civil'
        if (won) points[id] = POINTS[role]
      }
    }
    for (const [id, pts] of Object.entries(points)) {
      const player = this.players.get(id)
      if (player) player.score += pts
    }
    r.result = { camp: outcome.camp, guesser: outcome.guesser || null, points }
    r.vote = null
    this.match.history.push({
      number: r.number,
      civil: r.pair.civil,
      undercover: this.hasUndercover() ? r.pair.undercover : null,
      camp: outcome.camp,
      winners: Object.keys(points),
    })
    this.phase = 'roundEnd'
  }

  hasUndercover() {
    return Object.values(this.round.roles).includes('undercover')
  }

  backToLobby(playerId) {
    this.requireHost(playerId)
    this.match = null
    this.round = null
    this.phase = 'lobby'
    this.syncAutoRoles()
  }

  /** Un joueur quitte (ou est exclu) en pleine manche : il est retiré comme un éliminé. */
  handleDeparture(playerId) {
    const r = this.round
    if (this.phase === 'roundEnd' || this.phase === 'matchEnd') return
    const wasAlive = r.alive.delete(playerId)
    if (wasAlive) r.eliminations.push({ playerId, role: r.roles[playerId], turn: r.turn, left: true })

    if (this.phase === 'elimination') {
      const e = r.elimination
      if (e.awaitingGuess && e.playerId === playerId) {
        e.awaitingGuess = false
        e.guess = { text: null, correct: false, matchedId: null, skipped: true }
      }
      // Une issue déjà annoncée ne bouge plus (sinon exclure les gagnants renverserait le résultat).
      if (!e.awaitingGuess && !e.outcome) e.outcome = this.computeOutcome()
      return
    }
    if (!wasAlive) return

    const outcome = this.computeOutcome()
    if (outcome) return this.endRound(outcome)

    if (this.phase === 'clues') {
      const idx = r.queue.indexOf(playerId)
      if (idx >= 0) {
        r.queue.splice(idx, 1)
        if (idx < r.speakerIdx) r.speakerIdx--
      }
      if (r.speakerIdx >= r.queue.length) this.startVote([...r.alive], 1)
      return
    }
    if (this.phase === 'vote') {
      const v = r.vote
      v.ballots.delete(playerId)
      for (const [voter, target] of [...v.ballots]) if (target === playerId) v.ballots.delete(voter)
      v.candidates = v.candidates.filter(id => id !== playerId)
      if (v.candidates.length < 2) return this.startVote([...r.alive], 1)
      if (v.ballots.size && [...r.alive].every(id => v.ballots.has(id))) this.tally()
    }
  }

  // ---------- Vue personnalisée ----------

  nameOf(id) {
    return this.players.get(id)?.name ?? this.round?.names[id] ?? 'Joueur parti'
  }

  revealedRole(id) {
    const r = this.round
    if (!r || !r.participants.includes(id)) return null
    if (this.phase === 'roundEnd' || this.phase === 'matchEnd') return r.roles[id]
    const out = r.eliminations.find(e => e.playerId === id)
    return out ? out.role : null
  }

  viewFor(playerId) {
    const r = this.round
    const theme = r ? this.themes.get(r.themeId) : this.theme
    const players = this.orderedPlayers().map(p => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      score: p.score,
      isHost: p.id === this.hostId,
      inRound: Boolean(r && r.participants.includes(p.id)),
      alive: r ? r.alive.has(p.id) : true,
      role: this.revealedRole(p.id),
      hasVoted: this.phase === 'vote' && r.vote.ballots.has(p.id),
    }))
    const n = this.activePlayerIds().length
    const roles = this.rolesFor(n)

    const view = {
      code: this.code,
      phase: this.phase,
      stateKey: this.stateKey,
      me: { id: playerId, isHost: playerId === this.hostId },
      hostId: this.hostId,
      players,
      settings: { ...this.settings, ...roles },
      activeCount: n,
      settingsError: validateRoles(n, roles.undercovers, roles.mrWhites),
      themes: [...this.themes.values()].map(themeSummary),
      limits: LIMITS,
      points: POINTS,
      match: this.match
        ? {
            number: this.match.number,
            totalRounds: this.match.totalRounds,
            notice: this.match.notice,
            history: this.match.history.map(h => ({
              ...h,
              civil: itemView(theme, h.civil),
              undercover: h.undercover ? itemView(theme, h.undercover) : null,
            })),
          }
        : null,
      round: null,
    }
    if (!r) return view

    const myRole = r.roles[playerId]
    const inRound = Boolean(myRole)
    const round = {
      uid: r.uid,
      number: r.number,
      turn: r.turn,
      themeName: theme.name,
      itemLabel: theme.itemLabel,
      clueMode: this.settings.clueMode,
      card: !inRound
        ? null
        : myRole === 'mrwhite'
          ? { kind: 'mrwhite' }
          : { kind: 'item', item: itemView(theme, myRole === 'civil' ? r.pair.civil : r.pair.undercover) },
      inRound,
      amAlive: r.alive.has(playerId),
      queue: this.phase === 'clues' ? r.queue : [],
      currentSpeaker: this.currentSpeaker(),
      clues: r.clues,
      vote: null,
      elimination: null,
      result: null,
    }

    if (this.phase === 'vote') {
      const v = r.vote
      round.vote = {
        candidates: v.candidates,
        attempt: v.attempt,
        myVote: v.ballots.get(playerId) || null,
        voters: [...r.alive],
        votedCount: v.ballots.size,
      }
    }

    if (this.phase === 'elimination') {
      const e = r.elimination
      round.elimination = {
        playerId: e.playerId,
        role: e.role,
        tally: e.tally,
        ballots: e.ballots,
        tie: e.tie,
        awaitingGuess: e.awaitingGuess,
        guess: e.guess
          ? { ...e.guess, matched: e.guess.matchedId ? itemView(theme, e.guess.matchedId) : null }
          : null,
        outcome: e.outcome ? e.outcome.camp : null,
        guessOptions: e.awaitingGuess && e.playerId === playerId ? theme.items.map(i => i.name).sort((a, b) => a.localeCompare(b, 'fr')) : null,
      }
      if (e.guess && e.guess.correct) round.elimination.answer = itemView(theme, r.pair.civil)
    }

    if (this.phase === 'roundEnd' || this.phase === 'matchEnd') {
      const hasUndercover = this.hasUndercover()
      round.result = r.result
        ? {
            ...r.result,
            civil: itemView(theme, r.pair.civil),
            undercover: hasUndercover ? itemView(theme, r.pair.undercover) : null,
            reason: hasUndercover ? r.pair.reason : null,
            roles: r.roles,
            names: Object.fromEntries(r.participants.map(id => [id, this.nameOf(id)])),
          }
        : null
    }

    view.round = round
    return view
  }
}
