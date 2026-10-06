import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadThemes, MIN_PARTNERS } from '../server/themes.js'
import { resolveGuess } from '../server/match.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const themes = loadThemes(path.join(root, 'themes'))

for (const theme of themes.values()) {
  test(`thème ${theme.name} : chaque élément a au moins ${MIN_PARTNERS} partenaires`, () => {
    const lonely = theme.items.filter(i => (theme.partners.get(i.id)?.size || 0) < MIN_PARTNERS).map(i => i.name)
    assert.deepEqual(lonely, [])
  })

  test(`thème ${theme.name} : phrases « point commun » courtes et sans réserve`, () => {
    for (const p of theme.pairs) {
      assert.ok(p.reason && p.reason.length <= 90, `${p.a}/${p.b} : « ${p.reason} »`)
      assert.doesNotMatch(p.reason, /\b(mais|contrairement|différent)\b/i, `${p.a}/${p.b}`)
    }
  })

  test(`thème ${theme.name} : noms et surnoms désignent tous leur propre élément`, () => {
    const wrong = []
    for (const item of theme.items) {
      for (const guess of [item.name, item.id, ...(item.aliases || [])]) {
        const found = resolveGuess(theme, guess)
        if (found !== item.id) wrong.push(`${guess} → ${found}`)
      }
    }
    assert.deepEqual(wrong, [])
  })
}
