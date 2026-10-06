import { prepareTheme } from '../server/themes.js'
import { Room } from '../server/room.js'

export const fixtureTheme = prepareTheme({
  id: 'test',
  name: 'Test',
  itemLabel: 'champion',
  images: { card: 'https://img.test/{id}.jpg' },
  items: [
    { id: 'Garen', name: 'Garen' },
    { id: 'Darius', name: 'Darius' },
    { id: 'Sett', name: 'Sett' },
    { id: 'TwistedFate', name: 'Twisted Fate', aliases: ['TF'] },
    { id: 'Graves', name: 'Graves' },
    { id: 'AurelionSol', name: 'Aurelion Sol', aliases: ['Asol'] },
    { id: 'Kayle', name: 'Kayle' },
    { id: 'Kayn', name: 'Kayn' },
  ],
  pairs: [
    { a: 'Garen', b: 'Darius', reason: 'Colosses rivaux' },
    { a: 'Garen', b: 'Sett', reason: 'Brutes' },
    { a: 'Darius', b: 'Sett', reason: 'Brutes' },
    { a: 'TwistedFate', b: 'Graves', reason: 'Duo de Bilgewater' },
    { a: 'Kayle', b: 'Kayn', reason: 'Ailes et faux' },
  ],
})

export const themes = new Map([[fixtureTheme.id, fixtureTheme]])

/** Générateur déterministe : renvoie toujours 0 (pas de mélange, pas d'inversion). */
export const zeroRng = { int: () => 0 }

export function makeRoom(names, { rng = zeroRng } = {}) {
  const room = new Room('TEST', themes, { rng })
  const players = names.map(n => room.addPlayer(n))
  return { room, players, host: players[0], ids: players.map(p => p.id) }
}

export function roleOf(room, id) {
  return room.round.roles[id]
}

export function idsWithRole(room, role) {
  return Object.keys(room.round.roles).filter(id => room.round.roles[id] === role)
}

/** Fait parler tous les joueurs du tour en cours. */
export function finishClues(room) {
  while (room.phase === 'clues') room.submitClue(room.currentSpeaker(), 'indice')
}

/** Tous les vivants votent contre `target` (la cible vote pour quelqu'un d'autre). */
export function voteOut(room, target) {
  const alive = [...room.round.alive]
  const fallback = alive.find(id => id !== target)
  for (const id of alive) {
    if (room.phase !== 'vote') break
    room.castVote(id, id === target ? fallback : target)
  }
}
