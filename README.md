# school-workshop-assigner

Module NPM autonome (Node.js & navigateur) pour résoudre l'affectation d'élèves à des ateliers sous contraintes de capacités et d'exclusions, en s'appuyant sur le solveur [HiGHS](https://highs.dev) compilé en WebAssembly (paquet [`highs`](https://www.npmjs.com/package/highs)).

Conçu pour des saisies CSV hétérogènes et multi-classes (une entrée par classe, fusionnées avant l'optimisation).

## Installation

```bash
npm install school-workshop-assigner
```

## Utilisation

```ts
import { optimiserAffectations } from 'school-workshop-assigner';

const resultat = await optimiserAffectations({
  ateliers: [
    { nom: 'Théâtre', capaciteMax: 25 },
    { nom: 'Robotique', capaciteMax: 20 },
  ],
  eleves: [
    { nom: 'Dupont Alice', classe: 'CM2-A', voeu1: 'Théâtre', voeu2: 'Robotique' },
    { nom: 'Martin Bob', classe: 'CM2-A', voeu1: 'Robotique' },
  ],
  exclusions: [
    { eleveA: { nom: 'Dupont Alice', classe: 'CM2-A' }, eleveB: { nom: 'Martin Bob', classe: 'CM2-A' } },
  ],
  options: {
    poidsVoeux: [100, 40, 10],
    strictExclusions: true,
  },
});

console.log(resultat.statut, resultat.scoreTotal);
console.log(resultat.parClasse);
console.log(resultat.parAtelier);
```

Dans un navigateur, si le fichier `.wasm` de HiGHS n'est pas servi à côté du bundle JS, indiquez son emplacement via le deuxième paramètre :

```ts
await optimiserAffectations(input, {
  locateFile: (file) => `/assets/${file}`,
});
```

## Comportement

- **Normalisation tolérante** : les noms d'ateliers et les vœux sont comparés en ignorant la casse, les accents et les espaces superflus. Chaque élève reçoit un identifiant composite unique `el_<classe>_<nom>`, ce qui permet de fusionner plusieurs classes/CSV sans collision.
- **Validation préalable** : si la capacité totale des ateliers est inférieure au nombre d'élèves, `optimiserAffectations` lève une `ErreurCoherence` avec le détail des chiffres (`capaciteTotale`, `nbEleves`, `deficit`). Les vœux non reconnus ou les élèves sans vœu valide génèrent des avertissements (champ `avertissements` de la sortie), sans bloquer le calcul.
- **Exclusions** :
  - `strictExclusions: true` (défaut) : les paires exclues ne peuvent jamais partager un atelier. Si cela rend le problème infaisable, le module relâche automatiquement la contrainte en pénalité forte et renvoie le statut `FEASIBLE_WITH_CONFLICTS` avec la liste des paires n'ayant pas pu être séparées (`conflitsExclusionsNonResolus`).
  - `strictExclusions: false` : les exclusions sont directement traitées comme des pénalités fortes dans la fonction objectif.
- **Score** : chaque vœu satisfait rapporte les points définis par `poidsVoeux` (défaut `[100, 40, 10]`), utilisés à la fois comme rangs (voeu1/voeu2/voeu3) et comme poids d'objectif.

## Structure

```
src/
  index.ts       # API publique (optimiserAffectations)
  normalizer.ts  # Nettoyage, slugs, fuzzy-matching, gestion multi-classes
  validator.ts   # Vérifications d'intégrité pré-calcul
  solver.ts       # Génération du modèle LP (format CPLEX) et appel de HiGHS
  types.ts       # Interfaces TypeScript (entrée/sortie)
tests/
  multi-class.test.ts    # 250 élèves / 10 classes / 10 ateliers, < 500 ms
  fuzzy-matching.test.ts # Tolérance casse/espaces/accents dans le CSV
```

## Développement

```bash
npm install
npm run build      # compile src/ -> dist/
npm run typecheck
npm test           # vitest run
```
