# Undercover · League of Legends

Le jeu Undercover entre amis, chacun sur son écran, avec des thèmes. Premier thème : **League of Legends** (tous les champions, avec leur illustration officielle).

**Jouer en ligne : https://undercover-lol-7vw1.onrender.com** (hébergement gratuit : après une période d'inactivité, la première ouverture prend environ une minute).

- Les **civils** reçoivent un champion, l'**Undercover** un champion très proche (sans savoir qu'il est l'Undercover), **Mr. White** ne reçoit rien.
- Chaque champion fait partie de **plusieurs paires** : avoir Garen ne dit pas si l'autre est Darius, Jarvan IV, Sett…
- Indices à l'oral (en vrai ou sur Discord) ou écrits dans le site, votes secrets sur chaque écran, revote en cas d'égalité.
- Mr. White éliminé peut deviner le champion des civils (surnoms et fautes de frappe acceptés : « TF », « Asol », « Twisted »…).
- Plusieurs manches au choix, scores cumulés, classement final.

## Lancer le jeu

Il faut [Node.js](https://nodejs.org) 20 ou plus récent.

```bash
npm install
npm start
```

Le terminal affiche les adresses :

- `http://localhost:3000` sur ton PC ;
- `http://192.168.x.x:3000` pour les amis connectés au **même Wi-Fi** (téléphones compris).

Un joueur crée le salon, les autres le rejoignent avec le code à 4 lettres, le lien partagé ou le QR code. Il faut au moins 3 joueurs. Si tu crées le salon depuis le PC serveur (`localhost`), le lien et le QR code utilisent automatiquement l'adresse Wi-Fi du PC, pour que les téléphones puissent l'ouvrir. Si un téléphone n'y arrive pas, vérifie que le pare-feu Windows autorise Node.js sur les réseaux privés.

Pour jouer à distance (chacun chez soi), il faut héberger le serveur en ligne (Render, Railway, Fly.io, un VPS…) : c'est une application Node classique qui écoute sur `PORT`. Derrière un proxy, mets `TRUST_PROXY=1` (c'est automatique sur Render, Fly.io et Railway) pour que la limite anti-abus compte les vraies adresses des joueurs.

Les parties sont gardées en mémoire : redémarrer le serveur efface les salons en cours.

## Règles et points

| Résultat | Points |
| --- | --- |
| Victoire des civils (tous les infiltrés éliminés) | +2 par civil |
| Victoire des infiltrés (il ne reste qu'un civil) | +10 par Undercover, +6 par Mr. White |
| Mr. White devine le champion des civils | +6 pour lui seul |

Répartition automatique conseillée : 3 joueurs → 1 Undercover ; 4 à 6 → 1 Undercover + 1 Mr. White ; 7 à 9 → 2 + 1 ; 10 à 12 → 3 + 1. L'hôte peut la modifier.

Autres règles :
- Mr. White n'est jamais désigné pour ouvrir le premier tour.
- En cas d'égalité au vote, on revote entre les ex æquo ; si l'égalité persiste, tirage au sort.
- Un joueur absent depuis plus de 3 minutes au lancement d'une manche la regarde en spectateur (il garde son score).
- L'hôte peut passer un joueur, clore un vote, donner son rôle d'hôte ou exclure quelqu'un (menu « ⋯ »).

## Ajouter un thème

Chaque thème est un fichier JSON dans `themes/`, chargé au démarrage. Aucun code à modifier :

```json
{
  "id": "pokemon",
  "name": "Pokémon",
  "itemLabel": "Pokémon",
  "images": { "card": "https://exemple.com/{id}.png" },
  "items": [
    { "id": "pikachu", "name": "Pikachu", "aliases": ["pika"] },
    { "id": "raichu", "name": "Raichu" }
  ],
  "pairs": [
    { "a": "pikachu", "b": "raichu", "reason": "Souris électriques, même évolution" }
  ]
}
```

- `images` est facultatif (sans image, la carte affiche juste le nom) ; un élément peut aussi avoir son propre champ `image`.
- `reason` est affiché en fin de manche pour expliquer le point commun.
- Pour que personne ne puisse deviner l'autre mot, donne à chaque élément **au moins 3 partenaires**.

### Mettre à jour le thème League of Legends

Les paires sont dans `data/lol-pairs.json`. Après un nouveau patch (nouveau champion), régénère le thème :

```bash
npm run build:lol
```

Le script télécharge la liste officielle des champions (Data Dragon), vérifie les paires et signale les champions qui ont moins de 3 partenaires.

## Développement

```bash
npm run dev    # redémarre le serveur à chaque modification
npm test       # règles du jeu + partie simulée avec de vrais clients
```

- `server/room.js` : toutes les règles (rôles, tours, votes, égalités, Mr. White, scores, départs).
- `server/index.js` : serveur HTTP + Socket.IO, salons, reconnexion.
- `public/` : interface (HTML/CSS/JS sans étape de build).

League of Legends et ses illustrations appartiennent à Riot Games. Ce projet de fan n'est ni approuvé ni sponsorisé par Riot Games.
