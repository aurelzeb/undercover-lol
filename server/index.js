// Serveur HTTP + Socket.IO : sert l'interface et relaie les actions des joueurs vers leur salon.
import express from 'express'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomInt } from 'node:crypto'
import { Server } from 'socket.io'
import QRCode from 'qrcode'
import { loadThemes } from './themes.js'
import { GameError, Room } from './room.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const SWEEP_MS = 5_000
const MAX_ROOMS = 5_000
// Par adresse IP : de quoi jouer entre amis derrière la même box, pas de quoi remplir le serveur ou deviner les codes.
const CREATE_LIMIT = { count: 15, windowMs: 10 * 60_000 }
const BAD_CODE_LIMIT = { count: 40, windowMs: 60_000 }
// Actions qui font avancer la partie : envoyées avec la clé de l'écran affiché, ignorées si la partie a déjà avancé.
const STATEFUL_ACTIONS = new Set(['start', 'clue', 'skipToVote', 'vote', 'closeVote', 'skipGuess', 'continue', 'backToLobby'])
// Ces actions ne dépendent pas de l'orateur en cours : seule la partie « phase:manche:tour » de la clé compte.
const PHASE_ONLY_ACTIONS = new Set(['skipToVote'])

function rateLimiter({ count, windowMs }) {
  const hits = new Map()
  const recent = key => (hits.get(key) || []).filter(t => Date.now() - t < windowMs)
  return {
    allowed: key => recent(key).length < count,
    record: key => hits.set(key, [...recent(key), Date.now()]),
    prune: () => { for (const key of [...hits.keys()]) if (!recent(key).length) hits.delete(key) },
  }
}

function isStale(payload, stateKey) {
  if (!STATEFUL_ACTIONS.has(payload.type) || payload.at === undefined) return false
  if (PHASE_ONLY_ACTIONS.has(payload.type)) return String(payload.at).split('|')[0] !== stateKey.split('|')[0]
  return payload.at !== stateKey
}

// Adresses du PC sur le réseau local, la plus probable d'abord (box domestique, puis réseaux d'entreprise/virtuels).
export function lanAddresses() {
  const rank = ip => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2)
  return Object.values(networkInterfaces())
    .flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => i.address)
    .sort((a, b) => rank(a) - rank(b))
}

export function createGameServer({
  themesDir = path.join(root, 'themes'),
  trustProxy = Boolean(process.env.TRUST_PROXY || process.env.RENDER || process.env.FLY_APP_NAME || process.env.RAILWAY_ENVIRONMENT),
} = {}) {
  const themes = loadThemes(themesDir)
  const rooms = new Map()
  const createLimiter = rateLimiter(CREATE_LIMIT)
  const badCodeLimiter = rateLimiter(BAD_CODE_LIMIT)

  const app = express()
  const httpServer = createServer(app)
  const io = new Server(httpServer, { pingInterval: 10_000, pingTimeout: 8_000 })

  app.disable('x-powered-by')
  app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }))
  app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }))
  // Ouvert depuis le PC serveur (localhost), le lien d'invitation doit utiliser l'adresse Wi-Fi pour les téléphones.
  app.get('/api/lan', (req, res) => {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    const ip = local ? lanAddresses()[0] : null
    res.json({ origin: ip ? `http://${ip}:${httpServer.address().port}` : null })
  })
  app.get('/qr.svg', async (req, res) => {
    const text = typeof req.query.u === 'string' ? req.query.u.slice(0, 300) : ''
    if (!text) return res.status(400).end()
    try {
      const svg = await QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#010a13', light: '#f0e6d2' } })
      res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(svg)
    } catch {
      res.status(500).end()
    }
  })

  function newCode() {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = ''
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
      if (!rooms.has(code)) return code
    }
    throw new GameError('Impossible de créer un salon, réessaie.')
  }

  function broadcast(room) {
    for (const p of room.players.values()) {
      if (p.socketId) io.to(p.socketId).emit('state', room.viewFor(p.id))
    }
  }

  function bind(socket, room, player) {
    // Ce socket représentait déjà un autre joueur : on le libère (sinon ce joueur resterait « connecté » pour toujours).
    const prev = socket.data
    if (prev?.playerId && prev.playerId !== player.id) {
      const prevRoom = rooms.get(prev.code)
      const prevPlayer = prevRoom?.players.get(prev.playerId)
      if (prevPlayer && prevPlayer.socketId === socket.id) {
        prevPlayer.socketId = null
        // Dans un salon d'attente, le joueur abandonné est retiré (sinon : salons et joueurs fantômes).
        if (prevRoom.phase === 'lobby') prevRoom.removePlayer(prevPlayer.id)
        else prevRoom.setConnected(prevPlayer.id, false)
        if (!prevRoom.players.size) rooms.delete(prevRoom.code)
        else if (prevRoom !== room) broadcast(prevRoom)
      }
    }
    // Un même joueur ouvert dans un autre onglet : l'ancien onglet est déconnecté du salon.
    if (player.socketId && player.socketId !== socket.id) {
      const old = io.sockets.sockets.get(player.socketId)
      if (old) {
        old.data = {}
        old.emit('session:replaced')
      }
    }
    player.socketId = socket.id
    socket.data = { code: room.code, playerId: player.id }
    room.setConnected(player.id, true)
  }

  function session(player, room) {
    return { ok: true, code: room.code, playerId: player.id, token: player.token }
  }

  function safe(handler) {
    return (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {}
      try {
        reply(handler(payload && typeof payload === 'object' ? payload : {}) ?? { ok: true })
      } catch (err) {
        if (err instanceof GameError) return reply({ ok: false, error: err.message })
        console.error(err)
        reply({ ok: false, error: 'Erreur inattendue du serveur.' })
      }
    }
  }

  const ACTIONS = {
    updateSettings: (room, id, p) => room.updateSettings(id, p.patch),
    start: (room, id) => room.startMatch(id),
    clue: (room, id, p) => room.submitClue(id, p.text),
    skipToVote: (room, id) => room.skipToVote(id),
    vote: (room, id, p) => room.castVote(id, p.targetId),
    closeVote: (room, id) => room.closeVote(id),
    guess: (room, id, p) => room.submitGuess(id, p.text),
    skipGuess: (room, id) => room.skipGuess(id),
    continue: (room, id) => room.continueGame(id),
    backToLobby: (room, id) => room.backToLobby(id),
    transferHost: (room, id, p) => room.transferHost(id, p.targetId),
  }

  io.on('connection', socket => {
    socket.data = {}
    const forwarded = trustProxy && socket.handshake.headers['x-forwarded-for']
    const ip = (typeof forwarded === 'string' && forwarded.split(',')[0].trim()) || socket.handshake.address

    const current = () => {
      const { code, playerId } = socket.data
      const room = code && rooms.get(code)
      if (!room || !room.players.has(playerId)) throw new GameError('Tu n’es plus dans ce salon.')
      return { room, playerId }
    }

    socket.on('room:create', safe(({ name }) => {
      if (!createLimiter.allowed(ip)) throw new GameError('Trop de salons créés, patiente quelques minutes.')
      if (rooms.size >= MAX_ROOMS) throw new GameError('Le serveur est plein, réessaie plus tard.')
      const room = new Room(newCode(), themes)
      const player = room.addPlayer(name)
      createLimiter.record(ip)
      rooms.set(room.code, room)
      bind(socket, room, player)
      broadcast(room)
      return session(player, room)
    }))

    socket.on('room:join', safe(({ code, name }) => {
      if (!badCodeLimiter.allowed(ip)) throw new GameError('Trop d’essais, patiente une minute.')
      const room = typeof code === 'string' && rooms.get(code.trim().toUpperCase())
      if (!room) {
        badCodeLimiter.record(ip)
        throw new GameError('Aucun salon avec ce code.')
      }
      const player = room.addPlayer(name)
      bind(socket, room, player)
      broadcast(room)
      return session(player, room)
    }))

    // soft = reprise depuis la mémoire du navigateur (onglet rouvert) : refusée si le joueur est déjà connecté ailleurs.
    socket.on('room:resume', safe(({ code, playerId, token, soft }) => {
      const room = typeof code === 'string' && rooms.get(code.toUpperCase())
      if (!room) return { ok: false, reason: 'gone' }
      const player = room.authenticate(playerId, token)
      // Le salon existe mais ce joueur n'y est plus (absence prolongée, exclusion) : il peut le rejoindre à nouveau.
      if (!player) return { ok: false, reason: 'removed', code: room.code }
      if (soft && player.socketId && player.socketId !== socket.id) return { ok: false, reason: 'busy' }
      bind(socket, room, player)
      broadcast(room)
      return session(player, room)
    }))

    socket.on('room:leave', safe(() => {
      const { room, playerId } = current()
      room.removePlayer(playerId)
      socket.data = {}
      if (!room.players.size) rooms.delete(room.code)
      else broadcast(room)
    }))

    socket.on('action', safe(payload => {
      const { room, playerId } = current()
      if (isStale(payload, room.stateKey)) return { ok: true, stale: true }
      if (payload.type === 'kick') {
        const target = room.players.get(payload.targetId)
        room.kick(playerId, payload.targetId)
        const targetSocket = target?.socketId && io.sockets.sockets.get(target.socketId)
        if (targetSocket) {
          targetSocket.data = {}
          targetSocket.emit('kicked')
        }
      } else {
        const action = ACTIONS[payload.type]
        if (!action) throw new GameError('Action inconnue.')
        action(room, playerId, payload)
      }
      broadcast(room)
    }))

    socket.on('disconnect', () => {
      const { code, playerId } = socket.data
      const room = code && rooms.get(code)
      const player = room && room.players.get(playerId)
      if (!player || player.socketId !== socket.id) return
      player.socketId = null
      room.setConnected(playerId, false)
      broadcast(room)
    })
  })

  const sweeper = setInterval(() => {
    for (const [code, room] of rooms) {
      const { changed, dead } = room.sweep()
      if (dead) rooms.delete(code)
      else if (changed) broadcast(room)
    }
    createLimiter.prune()
    badCodeLimiter.prune()
  }, SWEEP_MS)
  sweeper.unref()

  return { app, httpServer, io, rooms, themes, close: () => { clearInterval(sweeper); io.close() } }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  // Filet de sécurité : une erreur isolée ne doit pas arrêter le serveur et effacer toutes les parties en mémoire.
  process.on('unhandledRejection', err => console.error('Promesse rejetée non gérée :', err))
  const port = Number(process.env.PORT) || 3000
  const { httpServer, themes } = createGameServer()
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`Undercover prêt (${[...themes.values()].map(t => `${t.name} : ${t.pairs.length} paires`).join(', ')})`)
    console.log(`  Sur ce PC :        http://localhost:${port}`)
    for (const ip of lanAddresses()) console.log(`  Sur le même Wi-Fi : http://${ip}:${port}`)
  })
}
