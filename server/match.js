// Comparaison tolérante d'une proposition de Mr. White avec les éléments d'un thème.

export function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

export function levenshtein(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

// Fautes de frappe tolérées selon la longueur du nom visé.
function typoTolerance(length) {
  if (length >= 8) return 2
  if (length >= 5) return 1
  return 0
}

// Clés normalisées d'un élément : nom affiché, id technique, surnoms.
export function itemKeys(item) {
  const keys = new Set([normalize(item.name), normalize(item.id), ...(item.aliases || []).map(normalize)])
  keys.delete('')
  return [...keys]
}

/**
 * Identifie l'élément visé par une proposition libre.
 * Ordre : correspondance exacte (nom, id, surnom) → préfixe unique (≥ 4 lettres) → faute de frappe proche et sans ambiguïté.
 * Renvoie l'id trouvé ou null.
 */
export function resolveGuess(theme, guess, preferId = null) {
  const g = normalize(guess)
  if (!g) return null

  const exact = theme.items.filter(item => item.keys.includes(g))
  if (exact.length) return exact.some(i => i.id === preferId) ? preferId : exact[0].id

  if (g.length >= 4) {
    const prefixed = theme.items.filter(item => item.keys.some(k => k.startsWith(g)))
    if (prefixed.length === 1) return prefixed[0].id
  }

  let best = null
  let bestDistance = Infinity
  let tie = false
  for (const item of theme.items) {
    for (const key of item.keys) {
      const d = levenshtein(g, key)
      if (d > typoTolerance(key.length)) continue
      if (d < bestDistance) {
        best = item
        bestDistance = d
        tie = false
      } else if (d === bestDistance && best && best.id !== item.id) {
        tie = true
      }
    }
  }
  if (best && !tie) return best.id
  return null
}

export function checkGuess(theme, guess, answerId) {
  const matchedId = resolveGuess(theme, guess, answerId)
  return { correct: matchedId === answerId, matchedId }
}
