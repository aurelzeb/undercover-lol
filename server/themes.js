// Chargement des thèmes (un fichier JSON par thème dans /themes) et tirage des paires.
import fs from 'node:fs'
import path from 'node:path'
import { itemKeys } from './match.js'

export const MIN_PARTNERS = 3

export function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

export function prepareTheme(raw, source = 'thème') {
  if (!raw.id || !raw.name || !Array.isArray(raw.items) || !Array.isArray(raw.pairs)) {
    throw new Error(`${source} : il faut id, name, items[] et pairs[]`)
  }
  const itemsById = new Map()
  for (const item of raw.items) {
    if (!item.id || !item.name) throw new Error(`${source} : élément sans id ou nom`)
    if (itemsById.has(item.id)) throw new Error(`${source} : id en double ${item.id}`)
    itemsById.set(item.id, { ...item, keys: itemKeys(item) })
  }

  const seen = new Set()
  const pairs = []
  const partners = new Map()
  for (const p of raw.pairs) {
    if (!itemsById.has(p.a) || !itemsById.has(p.b) || p.a === p.b) {
      throw new Error(`${source} : paire invalide ${p.a} / ${p.b}`)
    }
    const key = pairKey(p.a, p.b)
    if (seen.has(key)) continue
    seen.add(key)
    pairs.push({ a: p.a, b: p.b, reason: p.reason || '', key })
    for (const [x, y] of [[p.a, p.b], [p.b, p.a]]) {
      if (!partners.has(x)) partners.set(x, new Set())
      partners.get(x).add(y)
    }
  }
  if (!pairs.length) throw new Error(`${source} : aucune paire`)

  return {
    id: raw.id,
    name: raw.name,
    itemLabel: raw.itemLabel || 'mot',
    version: raw.version || null,
    images: raw.images || {},
    items: [...itemsById.values()],
    itemsById,
    pairs,
    partners,
  }
}

export function loadThemes(dir) {
  const themes = new Map()
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    const theme = prepareTheme(raw, file)
    themes.set(theme.id, theme)
  }
  if (!themes.size) throw new Error(`Aucun thème trouvé dans ${dir}`)
  return themes
}

function fillTemplate(template, theme, item) {
  if (!template) return null
  return template.replaceAll('{id}', item.imageId || item.id).replaceAll('{version}', theme.version || '')
}

export function itemView(theme, id) {
  const item = theme.itemsById.get(id)
  if (!item) return null
  return {
    id: item.id,
    name: item.name,
    image: item.image || fillTemplate(theme.images.card, theme, item),
    icon: item.icon || fillTemplate(theme.images.icon, theme, item),
  }
}

export function themeSummary(theme) {
  return { id: theme.id, name: theme.name, itemLabel: theme.itemLabel, itemCount: theme.items.length, pairCount: theme.pairs.length }
}

/**
 * Tire une paire jamais jouée dans la partie en cours, en évitant si possible
 * les éléments vus lors des manches précédentes. Le sens (civil / undercover) est aléatoire.
 */
export function pickPair(theme, usedKeys, recentItems, rng) {
  let pool = theme.pairs.filter(p => !usedKeys.has(p.key))
  if (!pool.length) {
    usedKeys.clear()
    pool = theme.pairs
  }
  const fresh = pool.filter(p => !recentItems.includes(p.a) && !recentItems.includes(p.b))
  if (fresh.length) pool = fresh
  const pair = pool[rng.int(pool.length)]
  usedKeys.add(pair.key)
  const flip = rng.int(2) === 1
  return {
    key: pair.key,
    civil: flip ? pair.b : pair.a,
    undercover: flip ? pair.a : pair.b,
    reason: pair.reason,
  }
}
