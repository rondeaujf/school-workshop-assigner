import { describe, expect, it } from 'vitest';
import { optimiserAffectations } from '../src/index.js';
import type { AtelierInput, EleveInput, ExclusionInput } from '../src/types.js';

const NOMS = [
  'Alice', 'Bob', 'Chloe', 'David', 'Emma', 'Farid', 'Gina', 'Hugo',
  'Ines', 'Jules', 'Kim', 'Lea', 'Marc', 'Nina', 'Omar', 'Paul',
  'Quitterie', 'Remi', 'Sara', 'Theo', 'Uma', 'Victor', 'Wendy', 'Xavier', 'Yara',
];

function genererClasses(nbClasses: number, tailleParClasse: number): EleveInput[] {
  const ateliersNoms = [
    'Théâtre', 'Robotique', 'Peinture', 'Musique', 'Sport', 'Cuisine',
    'Jardinage', 'Echecs', 'Danse', 'Cinema',
  ];
  const eleves: EleveInput[] = [];
  for (let c = 0; c < nbClasses; c++) {
    const classe = `CM2-${String.fromCharCode(65 + c)}`;
    for (let i = 0; i < tailleParClasse; i++) {
      const nom = `${NOMS[i % NOMS.length]} ${classe}-${i}`;
      const v1 = ateliersNoms[(c + i) % ateliersNoms.length];
      const v2 = ateliersNoms[(c + i + 1) % ateliersNoms.length];
      const v3 = ateliersNoms[(c + i + 2) % ateliersNoms.length];
      eleves.push({ nom, classe, voeu1: v1, voeu2: v2, voeu3: v3 });
    }
  }
  return eleves;
}

function genererAteliers(capaciteParAtelier: number): AtelierInput[] {
  return [
    'Théâtre', 'Robotique', 'Peinture', 'Musique', 'Sport', 'Cuisine',
    'Jardinage', 'Echecs', 'Danse', 'Cinema',
  ].map((nom) => ({ nom, capaciteMax: capaciteParAtelier }));
}

describe('affectation multi-classes (250 élèves / 10 classes / 10 ateliers)', () => {
  it('résout en moins de 500ms et respecte toutes les contraintes', async () => {
    const nbClasses = 10;
    const tailleParClasse = 25;
    const eleves = genererClasses(nbClasses, tailleParClasse);
    const ateliers = genererAteliers(30); // 10 * 30 = 300 places pour 250 élèves

    const exclusions: ExclusionInput[] = [
      {
        eleveA: { nom: eleves[0].nom, classe: eleves[0].classe },
        eleveB: { nom: eleves[1].nom, classe: eleves[1].classe },
      },
      {
        eleveA: { nom: eleves[30].nom, classe: eleves[30].classe },
        eleveB: { nom: eleves[31].nom, classe: eleves[31].classe },
      },
    ];

    const debut = performance.now();
    const resultat = await optimiserAffectations({ ateliers, eleves, exclusions });
    const duree = performance.now() - debut;

    expect(resultat.succes).toBe(true);
    expect(['OPTIMAL', 'FEASIBLE_WITH_CONFLICTS']).toContain(resultat.statut);
    expect(resultat.statistiques.nbElevesTotaux).toBe(250);
    expect(duree).toBeLessThan(500);

    // Chaque élève est affecté exactement une fois.
    const totalAffecte = Object.values(resultat.parClasse).reduce((s, arr) => s + arr.length, 0);
    expect(totalAffecte).toBe(250);

    // Aucune capacité d'atelier n'est dépassée.
    for (const affectations of Object.values(resultat.parAtelier)) {
      expect(affectations.length).toBeLessThanOrEqual(30);
    }

    // Les exclusions doivent être honorées (capacité largement suffisante ici).
    expect(resultat.statut).toBe('OPTIMAL');
    expect(resultat.conflitsExclusionsNonResolus).toBeUndefined();
  });

  it('regroupe correctement les affectations par classe et par atelier', async () => {
    const ateliers = genererAteliers(30);
    const eleves = genererClasses(10, 25);
    const resultat = await optimiserAffectations({ ateliers, eleves });

    expect(Object.keys(resultat.parClasse).sort()).toEqual(
      Array.from({ length: 10 }, (_, c) => `CM2-${String.fromCharCode(65 + c)}`).sort(),
    );
    expect(Object.keys(resultat.parAtelier).sort()).toEqual(
      ['Cinema', 'Cuisine', 'Danse', 'Echecs', 'Jardinage', 'Musique', 'Peinture', 'Robotique', 'Sport', 'Théâtre'].sort(),
    );
  });
});

describe('cohérence des données', () => {
  it("lève une erreur explicite si la capacité totale est insuffisante", async () => {
    await expect(
      optimiserAffectations({
        ateliers: [{ nom: 'A', capaciteMax: 1 }],
        eleves: [
          { nom: 'X', classe: 'C' },
          { nom: 'Y', classe: 'C' },
        ],
      }),
    ).rejects.toMatchObject({
      name: 'ErreurCoherence',
      details: { capaciteTotale: 1, nbEleves: 2, deficit: 1 },
    });
  });
});

describe('exclusions', () => {
  it('bascule en FEASIBLE_WITH_CONFLICTS quand une exclusion stricte est impossible à honorer', async () => {
    const resultat = await optimiserAffectations({
      ateliers: [{ nom: 'UniqueAtelier', capaciteMax: 2 }],
      eleves: [
        { nom: 'A', classe: 'C1' },
        { nom: 'B', classe: 'C1' },
      ],
      exclusions: [{ eleveA: { nom: 'A', classe: 'C1' }, eleveB: { nom: 'B', classe: 'C1' } }],
    });

    expect(resultat.statut).toBe('FEASIBLE_WITH_CONFLICTS');
    expect(resultat.conflitsExclusionsNonResolus).toHaveLength(1);
    expect(resultat.conflitsExclusionsNonResolus?.[0]).toMatchObject({
      eleveA: { nom: 'A', classe: 'C1' },
      eleveB: { nom: 'B', classe: 'C1' },
      atelier: 'UniqueAtelier',
    });
  });

  it('convertit directement les exclusions en pénalités quand strictExclusions=false', async () => {
    const resultat = await optimiserAffectations({
      ateliers: [{ nom: 'UniqueAtelier', capaciteMax: 2 }],
      eleves: [
        { nom: 'A', classe: 'C1' },
        { nom: 'B', classe: 'C1' },
      ],
      exclusions: [{ eleveA: { nom: 'A', classe: 'C1' }, eleveB: { nom: 'B', classe: 'C1' } }],
      options: { strictExclusions: false },
    });

    expect(resultat.statut).toBe('FEASIBLE_WITH_CONFLICTS');
    expect(resultat.conflitsExclusionsNonResolus).toHaveLength(1);
  });
});
