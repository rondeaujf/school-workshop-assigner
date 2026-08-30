import { describe, expect, it } from 'vitest';
import { optimiserAffectations } from '../src/index.js';
import type { AtelierInput, EleveInput, ExclusionInput } from '../src/types.js';

const PRENOMS = [
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
      const nom = `Nom${classe}-${i}`;
      const prenom = PRENOMS[i % PRENOMS.length];
      const v1 = ateliersNoms[(c + i) % ateliersNoms.length];
      const v2 = ateliersNoms[(c + i + 1) % ateliersNoms.length];
      const v3 = ateliersNoms[(c + i + 2) % ateliersNoms.length];
      eleves.push({ nom, prenom, classe, voeu1: v1, voeu2: v2, voeu3: v3 });
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
        eleveA: { nom: eleves[0].nom, prenom: eleves[0].prenom, classe: eleves[0].classe },
        eleveB: { nom: eleves[1].nom, prenom: eleves[1].prenom, classe: eleves[1].classe },
      },
      {
        eleveA: { nom: eleves[30].nom, prenom: eleves[30].prenom, classe: eleves[30].classe },
        eleveB: { nom: eleves[31].nom, prenom: eleves[31].prenom, classe: eleves[31].classe },
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
          { nom: 'Dupont', prenom: 'X', classe: 'C' },
          { nom: 'Dupont', prenom: 'Y', classe: 'C' },
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
        { nom: 'Dupont', prenom: 'A', classe: 'C1' },
        { nom: 'Dupont', prenom: 'B', classe: 'C1' },
      ],
      exclusions: [
        {
          eleveA: { nom: 'Dupont', prenom: 'A', classe: 'C1' },
          eleveB: { nom: 'Dupont', prenom: 'B', classe: 'C1' },
        },
      ],
    });

    expect(resultat.statut).toBe('FEASIBLE_WITH_CONFLICTS');
    expect(resultat.conflitsExclusionsNonResolus).toHaveLength(1);
    expect(resultat.conflitsExclusionsNonResolus?.[0]).toMatchObject({
      eleveA: { nom: 'Dupont', prenom: 'A', classe: 'C1' },
      eleveB: { nom: 'Dupont', prenom: 'B', classe: 'C1' },
      atelier: 'UniqueAtelier',
    });
  });

  it('convertit directement les exclusions en pénalités quand strictExclusions=false', async () => {
    const resultat = await optimiserAffectations({
      ateliers: [{ nom: 'UniqueAtelier', capaciteMax: 2 }],
      eleves: [
        { nom: 'Dupont', prenom: 'A', classe: 'C1' },
        { nom: 'Dupont', prenom: 'B', classe: 'C1' },
      ],
      exclusions: [
        {
          eleveA: { nom: 'Dupont', prenom: 'A', classe: 'C1' },
          eleveB: { nom: 'Dupont', prenom: 'B', classe: 'C1' },
        },
      ],
      options: { strictExclusions: false },
    });

    expect(resultat.statut).toBe('FEASIBLE_WITH_CONFLICTS');
    expect(resultat.conflitsExclusionsNonResolus).toHaveLength(1);
  });
});

describe('jumeaux (même nom de famille et même classe)', () => {
  it("génère des IDs distincts et affecte correctement chaque jumeau grâce au prénom", async () => {
    const resultat = await optimiserAffectations({
      ateliers: [
        { nom: 'Théâtre', capaciteMax: 1 },
        { nom: 'Robotique', capaciteMax: 1 },
      ],
      eleves: [
        { nom: 'Martin', prenom: 'Léo', classe: 'CM2-A', voeu1: 'Théâtre' },
        { nom: 'Martin', prenom: 'Noé', classe: 'CM2-A', voeu1: 'Robotique' },
      ],
    });

    expect(resultat.succes).toBe(true);
    expect(resultat.statut).toBe('OPTIMAL');

    const affectations = resultat.parClasse['CM2-A'];
    expect(affectations).toHaveLength(2);

    const leo = affectations.find((a) => a.prenom === 'Léo');
    const noe = affectations.find((a) => a.prenom === 'Noé');
    expect(leo).toMatchObject({ nom: 'Martin', prenom: 'Léo', atelierNom: 'Théâtre', rangVoeuSatisfait: 1 });
    expect(noe).toMatchObject({ nom: 'Martin', prenom: 'Noé', atelierNom: 'Robotique', rangVoeuSatisfait: 1 });
  });

  it("distingue une exclusion entre jumeaux (même nom, même classe) grâce au prénom", async () => {
    const resultat = await optimiserAffectations({
      ateliers: [{ nom: 'UniqueAtelier', capaciteMax: 2 }],
      eleves: [
        { nom: 'Martin', prenom: 'Léo', classe: 'CM2-A' },
        { nom: 'Martin', prenom: 'Noé', classe: 'CM2-A' },
      ],
      exclusions: [
        {
          eleveA: { nom: 'Martin', prenom: 'Léo', classe: 'CM2-A' },
          eleveB: { nom: 'Martin', prenom: 'Noé', classe: 'CM2-A' },
        },
      ],
    });

    // Un seul atelier disponible : l'exclusion ne peut pas être honorée, mais les
    // deux jumeaux doivent bien avoir été résolus comme des élèves distincts.
    expect(resultat.statut).toBe('FEASIBLE_WITH_CONFLICTS');
    expect(resultat.conflitsExclusionsNonResolus?.[0]).toMatchObject({
      eleveA: { nom: 'Martin', prenom: 'Léo', classe: 'CM2-A' },
      eleveB: { nom: 'Martin', prenom: 'Noé', classe: 'CM2-A' },
    });
  });
});
