// Construit themes/lol.json à partir de data/lol-pairs.json et de la liste officielle des champions (Data Dragon).
// Usage : npm run build:lol            (télécharge le dernier patch)
//         npm run build:lol -- --offline (réutilise les champions déjà présents dans themes/lol.json)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareTheme, MIN_PARTNERS } from '../server/themes.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pairsFile = path.join(root, 'data', 'lol-pairs.json')
const themeFile = path.join(root, 'themes', 'lol.json')
const DDRAGON = 'https://ddragon.leagueoflegends.com'

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res.json()
}

async function loadChampions(offline) {
  if (offline) {
    const current = JSON.parse(fs.readFileSync(themeFile, 'utf8'))
    return { version: current.version, champions: current.items.map(({ id, name }) => ({ id, name })) }
  }
  const [version] = await fetchJson(`${DDRAGON}/api/versions.json`)
  const data = (await fetchJson(`${DDRAGON}/cdn/${version}/data/fr_FR/champion.json`)).data
  const champions = Object.values(data).map(c => ({ id: c.id, name: c.name }))
  return { version, champions }
}

const offline = process.argv.includes('--offline')
const { version, champions } = await loadChampions(offline)
const source = JSON.parse(fs.readFileSync(pairsFile, 'utf8'))
const known = new Set(champions.map(c => c.id))

const pairs = source.pairs.filter(p => known.has(p.a) && known.has(p.b))
const skipped = source.pairs.length - pairs.length

const theme = {
  id: 'lol',
  name: 'League of Legends',
  itemLabel: 'champion',
  version,
  images: {
    card: `${DDRAGON}/cdn/img/champion/loading/{id}_0.jpg`,
    icon: `${DDRAGON}/cdn/{version}/img/champion/{id}.png`,
  },
  items: champions
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
    .map(c => ({ id: c.id, name: c.name, aliases: source.aliases?.[c.id] || [] })),
  pairs: pairs.map(({ a, b, reason }) => ({ a, b, reason })),
}

// Validation : même code que le serveur, plus le contrôle du nombre de partenaires par champion.
const prepared = prepareTheme(theme, 'lol.json')
const lonely = prepared.items.filter(i => (prepared.partners.get(i.id)?.size || 0) < MIN_PARTNERS)

fs.mkdirSync(path.dirname(themeFile), { recursive: true })
fs.writeFileSync(themeFile, JSON.stringify(theme, null, 1) + '\n')

const degrees = prepared.items.map(i => prepared.partners.get(i.id)?.size || 0)
console.log(`themes/lol.json : patch ${version}, ${theme.items.length} champions, ${prepared.pairs.length} paires`)
console.log(`Partenaires par champion : min ${Math.min(...degrees)}, médiane ${degrees.sort((a, b) => a - b)[degrees.length >> 1]}, max ${Math.max(...degrees)}`)
if (skipped) console.warn(`${skipped} paire(s) ignorée(s) : champion absent du patch`)
if (lonely.length) {
  console.warn(`Champions avec moins de ${MIN_PARTNERS} partenaires (devinables ou jamais tirés) :`)
  console.warn('  ' + lonely.map(i => `${i.name} (${prepared.partners.get(i.id)?.size || 0})`).join(', '))
  process.exitCode = 1
}
