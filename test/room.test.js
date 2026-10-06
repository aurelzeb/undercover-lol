import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GameError, INACTIVE_MS, POINTS, Room, recommendedRoles, validateRoles } from '../server/room.js'
import { checkGuess } from '../server/match.js'
import { pickPair } from '../server/themes.js'
import { fixtureTheme, finishClues, idsWithRole, makeRoom, themes, voteOut, zeroRng } from './helpers.js'

test('répartition conseillée valide pour 3 à 20 joueurs', () => {
  for (let n = 3; n <= 20; n++) {
    const { undercovers, mrWhites } = recommendedRoles(n)
    assert.equal(validateRoles(n, undercovers, mrWhites), null, `n=${n}`)
  }
  assert.deepEqual(recommendedRoles(4), { undercovers: 1, mrWhites: 1 })
})

test('validation des rôles', () => {
  assert.match(validateRoles(2, 1, 0), /au moins 3/)
  assert.match(validateRoles(5, 0, 0), /au moins un/)
  assert.match(validateRoles(4, 2, 1), /2 civils/)
  assert.match(validateRoles(6, 2, 2), /2 civils|autant/)
  assert.equal(validateRoles(4, 1, 1), null)
})

test('pseudos : vide, doublon (insensible à la casse) refusés', () => {
  const { room } = makeRoom(['Alice'])
  assert.throws(() => room.addPlayer('   '), GameError)
  assert.throws(() => room.addPlayer('alice'), /déjà pris/)
  assert.equal(room.addPlayer('  Bob   le   bricoleur  ').name, 'Bob le bricoleur'.slice(0, 16))
})

test('seul l’hôte peut régler et lancer, il faut 3 joueurs', () => {
  const { room, players, host } = makeRoom(['A', 'B'])
  assert.throws(() => room.startMatch(players[1].id), /hôte/)
  assert.throws(() => room.startMatch(host.id), /au moins 3/)
  room.addPlayer('C')
  assert.throws(() => room.updateSettings(players[1].id, { rounds: 5 }), /hôte/)
  room.updateSettings(host.id, { rounds: 5, clueMode: 'written' })
  assert.equal(room.settings.rounds, 5)
  assert.throws(() => room.updateSettings(host.id, { rounds: 0 }), GameError)
  room.startMatch(host.id)
  assert.equal(room.phase, 'clues')
})

test('distribution : rôles, champions, Mr. White ne parle jamais en premier', () => {
  for (let seed = 0; seed < 40; seed++) {
    let x = seed + 1
    const rng = { int: max => { x = (x * 1103515245 + 12345) % 2147483648; return x % max } }
    const { room, host, ids } = makeRoom(['A', 'B', 'C', 'D'], { rng })
    room.startMatch(host.id)
    const r = room.round
    assert.equal(idsWithRole(room, 'undercover').length, 1)
    assert.equal(idsWithRole(room, 'mrwhite').length, 1)
    assert.equal(idsWithRole(room, 'civil').length, 2)
    assert.notEqual(r.roles[r.queue[0]], 'mrwhite')
    assert.notEqual(r.pair.civil, r.pair.undercover)
    for (const id of ids) {
      const card = room.viewFor(id).round.card
      if (r.roles[id] === 'mrwhite') assert.deepEqual(card, { kind: 'mrwhite' })
      else assert.equal(card.item.id, r.roles[id] === 'civil' ? r.pair.civil : r.pair.undercover)
    }
  }
})

test('la vue ne divulgue jamais les rôles ni la paire avant la fin de manche', () => {
  const { room, host, ids } = makeRoom(['A', 'B', 'C', 'D', 'E'])
  room.startMatch(host.id)
  const { civil, undercover } = room.round.pair
  for (const id of ids) {
    const view = room.viewFor(id)
    const json = JSON.stringify(view)
    assert.ok(view.players.every(p => p.role === null))
    assert.ok(!json.includes('"undercover":"') && !json.includes('roles'))
    const mine = room.round.roles[id]
    if (mine !== 'civil') assert.ok(!json.includes(`"${civil}"`), 'le champion des civils ne doit pas fuiter')
    if (mine !== 'undercover') assert.ok(!json.includes(`"${undercover}"`), 'le champion undercover ne doit pas fuiter')
  }
})

test('tour de parole : seul l’orateur (ou l’hôte qui passe) avance, mode écrit exige un texte', () => {
  const { room, host } = makeRoom(['A', 'B', 'C', 'D'])
  room.updateSettings(host.id, { clueMode: 'written' })
  room.startMatch(host.id)
  const speaker = room.currentSpeaker()
  const other = room.round.queue.find(id => id !== speaker && id !== host.id)
  if (other) assert.throws(() => room.submitClue(other, 'x'), /pas ton tour/)
  assert.throws(() => room.submitClue(speaker, '  '), /Écris/)
  room.submitClue(speaker, 'grosse épée')
  assert.equal(room.round.clues[0].text, 'grosse épée')
  // L'hôte passe le joueur suivant s'il n'est pas lui-même l'orateur.
  const next = room.currentSpeaker()
  if (next !== host.id) {
    room.submitClue(host.id, 'ignoré')
    assert.deepEqual(room.round.clues[1], { turn: 1, playerId: next, text: null, skipped: true })
  }
  finishClues(room)
  assert.equal(room.phase, 'vote')
})

test('vote : pas contre soi, changement possible, élimination à la majorité', () => {
  const { room, host, ids } = makeRoom(['A', 'B', 'C', 'D', 'E'])
  room.startMatch(host.id)
  finishClues(room)
  assert.throws(() => room.castVote(ids[0], ids[0]), /toi-même/)
  room.castVote(ids[0], ids[1])
  room.castVote(ids[0], ids[2])
  assert.equal(room.round.vote.ballots.get(ids[0]), ids[2])
  const civilian = idsWithRole(room, 'civil')[0]
  voteOut(room, civilian)
  assert.equal(room.phase, 'elimination')
  assert.equal(room.round.elimination.playerId, civilian)
  assert.equal(room.round.elimination.role, 'civil')
  assert.ok(!room.round.alive.has(civilian))
  // Le rôle de l'éliminé est public.
  assert.equal(room.viewFor(ids[0]).players.find(p => p.id === civilian).role, 'civil')
})

test('égalité : revote entre ex æquo puis tirage au sort', () => {
  const { room, host, ids } = makeRoom(['A', 'B', 'C', 'D'])
  room.startMatch(host.id)
  finishClues(room)
  const [a, b, c, d] = ids
  room.castVote(a, b)
  room.castVote(b, a)
  room.castVote(c, a)
  room.castVote(d, b)
  assert.equal(room.phase, 'vote')
  assert.equal(room.round.vote.attempt, 2)
  assert.deepEqual([...room.round.vote.candidates].sort(), [a, b].sort())
  assert.throws(() => room.castVote(c, d), /ne fait pas partie/)
  room.castVote(a, b)
  room.castVote(b, a)
  room.castVote(c, a)
  room.castVote(d, b)
  assert.equal(room.phase, 'elimination')
  assert.deepEqual([...room.round.elimination.tie].sort(), [a, b].sort())
})

test('l’hôte peut clore un vote incomplet', () => {
  const { room, host, ids } = makeRoom(['A', 'B', 'C', 'D', 'E'])
  room.startMatch(host.id)
  finishClues(room)
  assert.throws(() => room.closeVote(host.id), /Personne/)
  room.castVote(ids[1], ids[2])
  room.closeVote(host.id)
  assert.equal(room.round.elimination.playerId, ids[2])
})

test('victoire des civils et attribution des points', () => {
  const { room, host } = makeRoom(['A', 'B', 'C', 'D', 'E'])
  room.updateSettings(host.id, { autoRoles: false, undercovers: 1, mrWhites: 0, rounds: 2 })
  room.startMatch(host.id)
  finishClues(room)
  const uc = idsWithRole(room, 'undercover')[0]
  voteOut(room, uc)
  assert.equal(room.round.elimination.outcome.camp, 'civils')
  room.continueGame(host.id)
  assert.equal(room.phase, 'roundEnd')
  for (const id of idsWithRole(room, 'civil')) assert.equal(room.players.get(id).score, POINTS.civil)
  assert.equal(room.players.get(uc).score, 0)
  const view = room.viewFor(uc)
  assert.equal(view.round.result.camp, 'civils')
  assert.equal(view.round.result.roles[uc], 'undercover')
  room.continueGame(host.id)
  assert.equal(room.round.number, 2)
  assert.equal(room.phase, 'clues')
})

test('victoire des infiltrés quand il ne reste qu’un civil (partie à 4)', () => {
  const { room, host } = makeRoom(['A', 'B', 'C', 'D'])
  room.startMatch(host.id)
  finishClues(room)
  const civ = idsWithRole(room, 'civil')[0]
  voteOut(room, civ)
  assert.equal(room.round.elimination.outcome.camp, 'infiltres')
  room.continueGame(host.id)
  for (const id of idsWithRole(room, 'undercover')) assert.equal(room.players.get(id).score, POINTS.undercover)
  for (const id of idsWithRole(room, 'mrwhite')) assert.equal(room.players.get(id).score, POINTS.mrwhite)
  for (const id of idsWithRole(room, 'civil')) assert.equal(room.players.get(id).score, 0)
})

test('Mr. White éliminé : bonne réponse = victoire seul, mauvaise = la partie continue', () => {
  const setup = () => {
    const ctx = makeRoom(['A', 'B', 'C', 'D', 'E', 'F'])
    ctx.room.startMatch(ctx.host.id)
    finishClues(ctx.room)
    const mw = idsWithRole(ctx.room, 'mrwhite')[0]
    voteOut(ctx.room, mw)
    return { ...ctx, mw }
  }

  const win = setup()
  assert.equal(win.room.round.elimination.awaitingGuess, true)
  assert.throws(() => win.room.continueGame(win.host.id), /Mr. White/)
  const others = win.ids.filter(id => id !== win.mw)
  assert.throws(() => win.room.submitGuess(others[0], 'x'), /pas à toi/)
  const answer = fixtureTheme.itemsById.get(win.room.round.pair.civil).name
  win.room.submitGuess(win.mw, answer.toLowerCase() + ' ')
  assert.equal(win.room.round.elimination.guess.correct, true)
  win.room.continueGame(win.host.id)
  assert.equal(win.room.round.result.camp, 'mrwhite')
  assert.deepEqual(win.room.round.result.points, { [win.mw]: POINTS.mrwhite })

  const lose = setup()
  lose.room.submitGuess(lose.mw, 'Kayle')
  assert.equal(lose.room.round.elimination.guess.correct, false)
  assert.equal(lose.room.round.elimination.outcome, null)
  lose.room.continueGame(lose.host.id)
  assert.equal(lose.room.phase, 'clues')
  assert.equal(lose.room.round.turn, 2)
  assert.ok(!lose.room.round.queue.includes(lose.mw))
})

test('partie complète : nombre de manches respecté, pas de paire répétée, retour au salon', () => {
  const { room, host } = makeRoom(['A', 'B', 'C', 'D', 'E'])
  room.updateSettings(host.id, { rounds: 3 })
  room.startMatch(host.id)
  const seen = new Set()
  for (let m = 1; m <= 3; m++) {
    assert.equal(room.round.number, m)
    assert.ok(!seen.has(room.round.pair.key), 'paire déjà jouée')
    seen.add(room.round.pair.key)
    // Éliminer les infiltrés un par un (Mr. White se trompe).
    while (room.phase !== 'roundEnd') {
      if (room.phase === 'clues') finishClues(room)
      if (room.phase === 'vote') {
        const target = [...room.round.alive].find(id => room.round.roles[id] !== 'civil')
        voteOut(room, target)
      }
      if (room.phase === 'elimination') {
        if (room.round.elimination.awaitingGuess) room.submitGuess(room.round.elimination.playerId, 'zzz')
        room.continueGame(host.id)
      }
    }
    assert.equal(room.round.result.camp, 'civils')
    room.continueGame(host.id)
  }
  assert.equal(room.phase, 'matchEnd')
  assert.equal(room.viewFor(host.id).match.history.length, 3)
  room.backToLobby(host.id)
  assert.equal(room.phase, 'lobby')
  assert.equal(room.round, null)
})

test('départ en pleine manche : retiré de l’ordre de parole et du vote, fin de manche si décisif', () => {
  const { room, host, ids } = makeRoom(['A', 'B', 'C', 'D', 'E', 'F'])
  room.startMatch(host.id)
  const queue = [...room.round.queue]
  const leaver = queue.find(id => id !== host.id && id !== queue[0])
  room.kick(host.id, leaver)
  assert.ok(!room.round.queue.includes(leaver))
  assert.ok(!room.round.alive.has(leaver))
  finishClues(room)
  assert.equal(room.phase, 'vote')
  assert.ok(!room.round.vote.candidates.includes(leaver))

  // Si tous les infiltrés partent, les civils gagnent aussitôt.
  const ctx = makeRoom(['A', 'B', 'C', 'D', 'E'])
  ctx.room.updateSettings(ctx.host.id, { autoRoles: false, undercovers: 1, mrWhites: 0 })
  ctx.room.startMatch(ctx.host.id)
  const uc = idsWithRole(ctx.room, 'undercover')[0]
  if (uc === ctx.host.id) ctx.room.transferHost(ctx.host.id, ctx.ids.find(id => id !== uc))
  ctx.room.removePlayer(uc)
  assert.equal(ctx.room.phase, 'roundEnd')
  assert.equal(ctx.room.round.result.camp, 'civils')
  assert.ok(ids.length)
})

test('départ de l’hôte : la main passe au joueur suivant connecté', () => {
  const { room, host, players } = makeRoom(['A', 'B', 'C'])
  room.setConnected(players[1].id, false)
  room.removePlayer(host.id)
  assert.equal(room.hostId, players[2].id)
})

test('nouveau joueur en cours de partie : spectateur jusqu’à la manche suivante', () => {
  const { room, host } = makeRoom(['A', 'B', 'C', 'D'])
  room.startMatch(host.id)
  const late = room.addPlayer('Retard')
  const view = room.viewFor(late.id)
  assert.equal(view.round.card, null)
  assert.equal(view.round.inRound, false)
  assert.throws(() => room.castVote(late.id, host.id), GameError)
})

test('Mr. White : tolérance de saisie (casse, accents, surnoms, préfixe, faute de frappe)', () => {
  const ok = (guess, id) => assert.equal(checkGuess(fixtureTheme, guess, id).correct, true, guess)
  const ko = (guess, id) => assert.equal(checkGuess(fixtureTheme, guess, id).correct, false, guess)
  ok('twisted fate', 'TwistedFate')
  ok('TF', 'TwistedFate')
  ok('Twisted', 'TwistedFate')
  ok('Twistd Fate', 'TwistedFate')
  ok('ASOL', 'AurelionSol')
  ok('aurélion sol', 'AurelionSol')
  ok('Garen', 'Garen')
  ok('Gare n', 'Garen')
  ko('Darius', 'Garen')
  ko('Kayn', 'Kayle')
  ko('Kay', 'Kayle')
  ko('', 'Garen')
})

test('tirage des paires : jamais deux fois la même tant qu’il en reste, sens aléatoire', () => {
  const used = new Set()
  let i = 0
  const rng = { int: max => (i++ * 7) % max }
  const keys = []
  for (let k = 0; k < fixtureTheme.pairs.length; k++) keys.push(pickPair(fixtureTheme, used, [], rng).key)
  assert.equal(new Set(keys).size, fixtureTheme.pairs.length)
  pickPair(fixtureTheme, used, [], rng)
  assert.equal(used.size, 1, 'le stock se réinitialise une fois épuisé')
})

// ---------- Régressions issues de la relecture ----------

test('ordre de parole : Mr. White jamais 1er au tour 1 et pas surreprésenté en 2e position', async () => {
  const { randomInt } = await import('node:crypto')
  const rng = { int: max => randomInt(max) }
  const positions = [0, 0, 0, 0]
  const trials = 4000
  for (let i = 0; i < trials; i++) {
    const { room, host } = makeRoom(['A', 'B', 'C', 'D'], { rng })
    room.startMatch(host.id)
    const mw = idsWithRole(room, 'mrwhite')[0]
    positions[room.round.queue.indexOf(mw)]++
  }
  assert.equal(positions[0], 0)
  for (const k of [1, 2, 3]) {
    const share = positions[k] / trials
    assert.ok(share > 0.28 && share < 0.39, `position ${k + 1} : ${(share * 100).toFixed(1)} % (attendu ~33 %)`)
  }
})

test('ordre de parole affiché stable : passer ou perdre un joueur ne réordonne jamais la file', () => {
  for (let seed = 0; seed < 60; seed++) {
    let x = seed + 7
    const rng = { int: max => { x = (x * 1103515245 + 12345) % 2147483648; return x % max } }
    const { room, host } = makeRoom(['A', 'B', 'C', 'D', 'E'], { rng })
    room.startMatch(host.id)
    const before = [...room.round.queue]
    room.submitClue(host.id, '') // l'hôte passe (ou valide) le premier orateur
    if (room.phase !== 'clues') continue
    assert.deepEqual(room.round.queue, before)
    const leaver = before.find(id => id !== host.id && id !== room.currentSpeaker())
    room.kick(host.id, leaver)
    if (room.phase === 'clues') assert.deepEqual(room.round.queue, before.filter(id => id !== leaver))
  }
})

test('clé d’écran : jamais réutilisée après un départ (pas d’effet ABA)', () => {
  const { room, host, ids } = makeRoom(['A', 'B', 'C', 'D', 'E', 'F'])
  room.startMatch(host.id)
  const seen = new Set([room.stateKey])
  const first = room.currentSpeaker()
  room.submitClue(first, 'x')
  seen.add(room.stateKey)
  room.submitClue(room.currentSpeaker(), 'y')
  // Le premier orateur, qui a déjà parlé, quitte : l'orateur courant ne change pas, la clé non plus,
  // et aucune clé passée ne revient.
  const keyBefore = room.stateKey
  if (first !== host.id) room.kick(host.id, first)
  if (room.phase === 'clues') {
    assert.equal(room.stateKey, keyBefore)
    room.submitClue(room.currentSpeaker(), 'z')
    if (room.phase === 'clues') assert.ok(!seen.has(room.stateKey))
  }
  assert.ok(ids.length)
})

test('une issue annoncée n’est pas renversée par une exclusion pendant l’écran d’élimination', () => {
  const { room, host } = makeRoom(['A', 'B', 'C', 'D'])
  room.startMatch(host.id)
  finishClues(room)
  const civ = idsWithRole(room, 'civil').find(id => id !== host.id) || idsWithRole(room, 'civil')[0]
  voteOut(room, civ)
  assert.equal(room.round.elimination.outcome.camp, 'infiltres')
  let hostId = host.id
  for (const id of [...room.round.alive].filter(id => room.round.roles[id] !== 'civil')) {
    if (id === hostId) {
      hostId = [...room.players.keys()].find(p => p !== id)
      room.transferHost(id, hostId)
    }
    room.kick(hostId, id)
  }
  assert.equal(room.round.elimination.outcome.camp, 'infiltres')
})

test('joueurs absents depuis longtemps : spectateurs à la manche suivante', () => {
  let now = 0
  const room = new Room('T', themes, { rng: zeroRng, now: () => now })
  const players = ['A', 'B', 'C', 'D'].map(n => room.addPlayer(n))
  room.startMatch(players[0].id)
  room.setConnected(players[3].id, false)
  now += INACTIVE_MS + 1
  room.round.alive.clear()
  room.endRound({ camp: 'civils' })
  room.continueGame(players[0].id)
  assert.equal(room.round.participants.length, 3)
  assert.ok(!room.round.participants.includes(players[3].id))
  assert.equal(room.viewFor(players[3].id).round.card, null)
})

test('clé d’écran : change à chaque étape (orateur, vote, revote, élimination)', () => {
  const { room, host, ids } = makeRoom(['A', 'B', 'C', 'D'])
  room.startMatch(host.id)
  const keys = new Set([room.stateKey])
  room.submitClue(room.currentSpeaker(), 'x')
  keys.add(room.stateKey)
  finishClues(room)
  keys.add(room.stateKey)
  const [a, b, c, d] = ids
  room.castVote(a, b); room.castVote(b, a); room.castVote(c, a); room.castVote(d, b)
  keys.add(room.stateKey)
  assert.equal(keys.size, 4)
})

test('pseudos : caractères invisibles retirés, doublon visuel refusé, pseudo vide refusé', () => {
  const { room } = makeRoom(['Bob'])
  assert.throws(() => room.addPlayer('Bob\u200b'), /déjà pris/)
  assert.throws(() => room.addPlayer('\u202eboB'.split('').reverse().join('')), GameError)
  assert.throws(() => room.addPlayer('\u200b\u200b'), /pseudo/)
  assert.throws(() => room.addPlayer({ toString: 'x' }), /pseudo/)
  assert.equal(room.addPlayer('Ｂｅａ').name, 'Bea')
})

test('partie sans Undercover : pas de champion Undercover affiché en fin de manche', () => {
  const { room, host } = makeRoom(['A', 'B', 'C', 'D'])
  room.updateSettings(host.id, { undercovers: 0, mrWhites: 1 })
  room.startMatch(host.id)
  finishClues(room)
  const mw = idsWithRole(room, 'mrwhite')[0]
  voteOut(room, mw)
  room.submitGuess(mw, 'zzz')
  room.continueGame(host.id)
  const result = room.viewFor(host.id).round.result
  assert.equal(result.undercover, null)
  assert.equal(result.reason, null)
  assert.equal(room.viewFor(host.id).match.history[0].undercover, null)
})

test('la vue ne contient plus les bulletins du 1er vote pendant le revote', () => {
  const { room, host, ids } = makeRoom(['A', 'B', 'C', 'D'])
  room.startMatch(host.id)
  finishClues(room)
  const [a, b, c, d] = ids
  room.castVote(a, b); room.castVote(b, a); room.castVote(c, a); room.castVote(d, b)
  const json = JSON.stringify(room.viewFor(c))
  assert.ok(!json.includes('ballots') && !json.includes('previousTally'))
})
