import { describe, expect, it } from 'vitest';
import { normaliserDonnees, slug } from '../src/normalizer.js';
import { optimiserAffectations } from '../src/index.js';

describe('slug', () => {
  it('retire les accents et normalise en snake_case ASCII', () => {
    expect(slug('Théâtre')).toBe('theatre');
    expect(slug('  Robotique  ')).toBe('robotique');
    expect(slug('CM2-A')).toBe('cm2_a');
    expect(slug("O'Brien")).toBe('o_brien');
  });
});

describe('normaliserDonnees — tolérance aux CSV hétérogènes', () => {
  it('reconnaît les vœux malgré casse, espaces et accents différents', () => {
    const donnees = normaliserDonnees({
      ateliers: [
        { nom: 'Théâtre', capaciteMax: '25' },
        { nom: '  Robotique', capaciteMax: 10 },
      ],
      eleves: [
        { nom: 'Dupont', prenom: ' Alice ', classe: 'CM2-A', voeu1: 'théâtre ', voeu2: 'ROBOTIQUE' },
        { nom: 'Martin', prenom: 'Bob', classe: 'CM2-A', voeu1: 'Théâtre' },
      ],
    });

    expect(donnees.ateliers.map((a) => a.capaciteMax)).toEqual([25, 10]);
    expect(donnees.eleves[0].voeuxIds[0]).toBe(donnees.ateliers[0].id);
    expect(donnees.eleves[0].voeuxIds[1]).toBe(donnees.ateliers[1].id);
    expect(donnees.eleves[1].voeuxIds[0]).toBe(donnees.ateliers[0].id);
    expect(donnees.avertissements).toHaveLength(0);
  });

  it('signale un avertissement pour un vœu non reconnu, sans faire échouer la normalisation', () => {
    const donnees = normaliserDonnees({
      ateliers: [{ nom: 'Théâtre', capaciteMax: 25 }],
      eleves: [{ nom: 'Dupont', prenom: 'Alice', classe: 'CM2-A', voeu1: 'Atelier Inexistant' }],
    });

    expect(donnees.eleves[0].voeuxIds[0]).toBeNull();
    expect(donnees.avertissements.some((a) => a.includes('Atelier Inexistant'))).toBe(true);
  });

  it('signale un avertissement quand un élève n’a aucun vœu valide', () => {
    const donnees = normaliserDonnees({
      ateliers: [{ nom: 'Théâtre', capaciteMax: 25 }],
      eleves: [{ nom: 'Sans', prenom: 'Voeu', classe: 'CM2-A' }],
    });

    expect(donnees.avertissements.some((a) => a.includes('aucun vœu valide'))).toBe(true);
  });

  it('génère des IDs composites uniques par (classe, nom, prénom) et gère les homonymes entre classes', () => {
    const donnees = normaliserDonnees({
      ateliers: [{ nom: 'Théâtre', capaciteMax: 50 }],
      eleves: [
        { nom: 'Martin', prenom: 'Paul', classe: 'CM2-A' },
        { nom: 'Martin', prenom: 'Paul', classe: 'CM2-B' },
      ],
    });

    const [a, b] = donnees.eleves;
    expect(a.id).not.toBe(b.id);
    expect(a.id).toBe('el_cm2_a_martin_paul');
    expect(b.id).toBe('el_cm2_b_martin_paul');
  });

  it('distingue des jumeaux (même nom de famille et même classe) grâce au prénom', () => {
    const donnees = normaliserDonnees({
      ateliers: [{ nom: 'Théâtre', capaciteMax: 50 }],
      eleves: [
        { nom: 'Martin', prenom: 'Léo', classe: 'CM2-A' },
        { nom: 'Martin', prenom: 'Noé', classe: 'CM2-A' },
      ],
    });

    const [leo, noe] = donnees.eleves;
    expect(leo.id).not.toBe(noe.id);
    expect(leo.id).toBe('el_cm2_a_martin_leo');
    expect(noe.id).toBe('el_cm2_a_martin_noe');
  });

  it('résout les exclusions via le triplet (classe, nom, prénom) même avec une casse différente', () => {
    const donnees = normaliserDonnees({
      ateliers: [{ nom: 'Théâtre', capaciteMax: 50 }],
      eleves: [
        { nom: 'Dupont', prenom: 'Alice', classe: 'CM2-A' },
        { nom: 'Martin', prenom: 'Bob', classe: 'CM2-A' },
      ],
      exclusions: [
        {
          eleveA: { nom: 'dupont', prenom: 'alice', classe: 'cm2-a' },
          eleveB: { nom: 'MARTIN', prenom: 'BOB', classe: 'CM2-A' },
        },
      ],
    });

    expect(donnees.exclusions).toHaveLength(1);
    expect(donnees.exclusions[0].eleveAId).toBe(donnees.eleves[0].id);
    expect(donnees.exclusions[0].eleveBId).toBe(donnees.eleves[1].id);
  });

  it('résout correctement une exclusion ciblant un jumeau précis (même nom, prénoms différents)', () => {
    const donnees = normaliserDonnees({
      ateliers: [{ nom: 'Théâtre', capaciteMax: 50 }],
      eleves: [
        { nom: 'Martin', prenom: 'Léo', classe: 'CM2-A' },
        { nom: 'Martin', prenom: 'Noé', classe: 'CM2-A' },
        { nom: 'Curie', prenom: 'Marie', classe: 'CM2-A' },
      ],
      exclusions: [
        {
          eleveA: { nom: 'Martin', prenom: 'Noé', classe: 'CM2-A' },
          eleveB: { nom: 'Curie', prenom: 'Marie', classe: 'CM2-A' },
        },
      ],
    });

    const leo = donnees.eleves.find((e) => e.prenom === 'Léo')!;
    const noe = donnees.eleves.find((e) => e.prenom === 'Noé')!;

    expect(donnees.exclusions).toHaveLength(1);
    expect(donnees.exclusions[0].eleveAId).toBe(noe.id);
    expect(donnees.exclusions[0].eleveAId).not.toBe(leo.id);
  });

  it('ignore silencieusement (avec avertissement) une exclusion référant un élève introuvable', () => {
    const donnees = normaliserDonnees({
      ateliers: [{ nom: 'Théâtre', capaciteMax: 50 }],
      eleves: [{ nom: 'Dupont', prenom: 'Alice', classe: 'CM2-A' }],
      exclusions: [
        {
          eleveA: { nom: 'Dupont', prenom: 'Alice', classe: 'CM2-A' },
          eleveB: { nom: 'Inconnu', prenom: 'X', classe: 'CM2-Z' },
        },
      ],
    });

    expect(donnees.exclusions).toHaveLength(0);
    expect(donnees.avertissements.some((a) => a.includes('introuvable'))).toBe(true);
  });
});

describe('optimiserAffectations — bout en bout avec CSV hétérogène', () => {
  it('affecte correctement malgré des vœux mal saisis (casse/espaces/accents)', async () => {
    const resultat = await optimiserAffectations({
      ateliers: [
        { nom: 'Théâtre', capaciteMax: '2' },
        { nom: 'Robotique', capaciteMax: 2 },
      ],
      eleves: [
        { nom: 'Dupont', prenom: 'Alice', classe: 'CM2-A', voeu1: '  théâtre' },
        { nom: 'Martin', prenom: 'Bob', classe: 'CM2-A', voeu1: 'ROBOTIQUE  ' },
      ],
    });

    expect(resultat.succes).toBe(true);
    expect(resultat.statut).toBe('OPTIMAL');
    expect(resultat.statistiques.distributionVoeux.voeu1).toBe(2);
    expect(resultat.parClasse['CM2-A']).toEqual(
      expect.arrayContaining([
        { eleveNom: 'Dupont Alice', nom: 'Dupont', prenom: 'Alice', atelierNom: 'Théâtre', rangVoeuSatisfait: 1 },
        { eleveNom: 'Martin Bob', nom: 'Martin', prenom: 'Bob', atelierNom: 'Robotique', rangVoeuSatisfait: 1 },
      ]),
    );
  });
});
