import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { io as connect } from 'socket.io-client'
import { createGameServer } from '../server/index.js'

let server
let url
const sockets = []

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercover-themes-'))
  fs.writeFileSync(path.join(dir, 'test.json'), JSON.stringify({
    id: 'test',
    name: 'Test',
    items: [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Bravo' }, { id: 'C', name: 'Charlie' }],
    pairs: [{ a: 'A', b: 'B' }, { a: 'B', b: 'C' }, { a: 'A', b: 'C' }],
  }))
  server = createGameServer({ themesDir: dir })
  await new Promise(resolve => server.httpServer.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.httpServer.address().port}`
})

after(() => {
  for (const s of sockets) s.disconnect()
  server.close()
  server.httpServer.close()
})

function client() {
  const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false })
  socket.latest = null
  socket.on('state', s => { socket.latest = s })
  sockets.push(socket)
  return new Promise(resolve => socket.on('connect', () => resolve(socket)))
}

const call = (socket, event, payload = {}) => socket.timeout(3000).emitWithAck(event, payload)
const action = (socket, type, payload = {}) => call(socket, 'action', { type, ...payload })
const settle = () => new Promise(r => setTimeout(r, 60))

test('partie en ligne : création, rejoindre, cartes privées, vote, reconnexion', async () => {
  const host = await client()
  const created = await call(host, 'room:create', { name: 'Hôte' })
  assert.equal(created.ok, true)
  assert.match(created.code, /^[A-Z]{4}$/)

  const players = [host]
  for (const name of ['Bob', 'Chloé', 'Dina']) {
    const s = await client()
    const res = await call(s, 'room:join', { code: created.code.toLowerCase(), name })
    assert.equal(res.ok, true, res.error)
    s.session = res
    players.push(s)
  }
  host.session = created
  assert.equal((await call(players[1], 'room:join', { code: 'ZZZZ', name: 'X' })).error, 'Aucun salon avec ce code.')

  await settle()
  assert.equal(host.latest.players.length, 4)
  assert.equal(host.latest.phase, 'lobby')

  // Un non-hôte ne peut pas lancer.
  const refused = await action(players[1], 'start')
  assert.equal(refused.ok, false)

  assert.equal((await action(host, 'start')).ok, true)
  await settle()

  // Chaque joueur ne voit que sa propre carte.
  const cards = players.map(p => p.latest.round.card)
  assert.equal(cards.filter(c => c.kind === 'mrwhite').length, 1)
  const items = cards.filter(c => c.kind === 'item').map(c => c.item.id)
  assert.equal(items.length, 3)
  assert.equal(new Set(items).size, 2, 'deux champions différents parmi les cartes')
  for (const p of players) assert.ok(p.latest.players.every(x => x.role === null))

  // Tour de parole complet.
  for (let i = 0; i < 4; i++) {
    const speakerId = host.latest.round.currentSpeaker
    const speaker = players.find(p => p.latest.me.id === speakerId)
    assert.equal((await action(speaker, 'clue', { text: '' })).ok, true)
    await settle()
  }
  assert.equal(host.latest.phase, 'vote')

  // Déconnexion / reconnexion d'un joueur pendant le vote.
  const dina = players[3]
  const dinaSession = dina.session
  dina.disconnect()
  await settle()
  assert.equal(host.latest.players.find(p => p.id === dinaSession.playerId).connected, false)
  const dina2 = await client()
  const resumed = await call(dina2, 'room:resume', { code: dinaSession.code, playerId: dinaSession.playerId, token: dinaSession.token })
  assert.equal(resumed.ok, true)
  await settle()
  assert.equal(dina2.latest.phase, 'vote')
  assert.deepEqual(dina2.latest.round.card, cards[3], 'la carte est conservée après reconnexion')
  assert.equal((await call(await client(), 'room:resume', { ...dinaSession, token: 'faux' })).ok, false)
  players[3] = dina2

  // Tout le monde vote contre le même joueur (lui vote pour un autre).
  const target = players[1].latest.me.id
  for (const p of players) {
    const me = p.latest.me.id
    const res = await action(p, 'vote', { targetId: me === target ? players[2].latest.me.id : target })
    assert.equal(res.ok, true, res.error)
  }
  await settle()
  assert.equal(host.latest.phase, 'elimination')
  assert.equal(host.latest.round.elimination.playerId, target)
  assert.ok(['civil', 'undercover', 'mrwhite'].includes(host.latest.round.elimination.role))
})

test('exclusion : le joueur exclu est prévenu et ne peut plus agir', async () => {
  const host = await client()
  const created = await call(host, 'room:create', { name: 'Hôte' })
  const bob = await client()
  const joined = await call(bob, 'room:join', { code: created.code, name: 'Bob' })
  const kicked = new Promise(resolve => bob.once('kicked', resolve))
  assert.equal((await action(host, 'kick', { targetId: joined.playerId })).ok, true)
  await kicked
  const res = await action(bob, 'start')
  assert.equal(res.ok, false)
  assert.match(res.error, /plus dans ce salon/)
  await settle()
  assert.equal(host.latest.players.length, 1)
})

test('QR code et santé du serveur', async () => {
  const health = await fetch(`${url}/healthz`).then(r => r.json())
  assert.equal(health.ok, true)
  const qr = await fetch(`${url}/qr.svg?u=${encodeURIComponent('http://x/?code=ABCD')}`)
  assert.equal(qr.headers.get('content-type'), 'image/svg+xml; charset=utf-8')
  assert.match(await qr.text(), /<svg/)
  const page = await fetch(url).then(r => r.text())
  assert.match(page, /Undercover/)
})

test('requêtes malveillantes : le serveur survit (qr.svg avec objet, payloads invalides)', async () => {
  const bad = await fetch(`${url}/qr.svg?u[toString]=x`)
  assert.equal(bad.status, 400)
  const s = await client()
  for (const payload of [null, 42, 'x', { name: { toString: 'x' } }, { code: ['A'] }]) {
    const res = await s.timeout(3000).emitWithAck('room:join', payload)
    assert.equal(res.ok, false)
  }
  const res = await call(s, 'room:create', { name: { toString: 'x' } })
  assert.equal(res.ok, false)
  assert.equal((await fetch(`${url}/healthz`).then(r => r.json())).ok, true)
})

test('reprise : « removed » si le salon existe encore, « gone » sinon', async () => {
  const host = await client()
  const created = await call(host, 'room:create', { name: 'Hôte' })
  const bob = await client()
  const joined = await call(bob, 'room:join', { code: created.code, name: 'Bob' })
  await action(host, 'kick', { targetId: joined.playerId })
  const other = await client()
  const removed = await call(other, 'room:resume', { code: joined.code, playerId: joined.playerId, token: joined.token })
  assert.deepEqual(removed, { ok: false, reason: 'removed', code: created.code })
  const gone = await call(other, 'room:resume', { code: 'QQQQ', playerId: 'x', token: 'y' })
  assert.equal(gone.reason, 'gone')
})

test('un socket qui crée un 2e salon libère le 1er (salon d’attente vide supprimé)', async () => {
  const s = await client()
  const first = await call(s, 'room:create', { name: 'Un' })
  const second = await call(s, 'room:create', { name: 'Deux' })
  assert.equal(server.rooms.has(first.code), false)
  assert.equal(server.rooms.has(second.code), true)
})

test('lien d’invitation : l’adresse Wi-Fi est donnée seulement au PC serveur', async () => {
  const res = await fetch(`${url}/api/lan`).then(r => r.json())
  assert.ok(res.origin === null || /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(res.origin))
})

test('double appui sur « Continuer » : la 2e action, périmée, est ignorée', async () => {
  const sockets4 = []
  const host = await client()
  const created = await call(host, 'room:create', { name: 'Hôte' })
  sockets4.push(host)
  for (const name of ['B', 'C', 'D', 'E']) {
    const s = await client()
    await call(s, 'room:join', { code: created.code, name })
    sockets4.push(s)
  }
  const room = server.rooms.get(created.code)
  await action(host, 'start')
  while (room.phase === 'clues') room.submitClue(room.currentSpeaker(), '')
  const target = [...room.round.alive].find(id => room.round.roles[id] === 'civil')
  for (const id of [...room.round.alive]) room.castVote(id, id === target ? [...room.round.alive].find(x => x !== target) : target)
  assert.equal(room.phase, 'elimination')
  const at = room.stateKey
  const [r1, r2] = await Promise.all([action(host, 'continue', { at }), action(host, 'continue', { at })])
  assert.equal(r1.ok && r2.ok, true)
  assert.ok(r1.stale || r2.stale, 'une des deux actions doit être ignorée')
  assert.equal(room.phase, 'clues')
  assert.equal(room.round.turn, 2)
})
