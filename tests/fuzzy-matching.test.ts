import { describe, expect, it } from 'vitest';
import { normaliserDonnees, slug } from '../src/normalizer.js';
import { optimiserAffectations } from '../src/index.js';

describe('slug', () => {
  it('retire les accents et normalise en snake_case ASCII', () => {
    expect(slug('Théâtre')).toBe('theatre');
    expect(slug('  Robotique  ')).toBe('robotique');
    expect(slug('CM2-A')).toBe('cm2_a');
    expect(slug("Dupont O'Brien")).toBe('dupont_o_brien');
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
        { nom: ' Dupont  Alice ', classe: 'CM2-A', voeu1: 'théâtre ', voeu2: 'ROBOTIQUE' },
        { nom: 'Martin Bob', classe: 'CM2-A', voeu1: 'Théâtre' },
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
      eleves: [{ nom: 'Dupont Alice', classe: 'CM2-A', voeu1: 'Atelier Inexistant' }],
    });

    expect(donnees.eleves[0].voeuxIds[0]).toBeNull();
    expect(donnees.avertissements.some((a) => a.includes('Atelier Inexistant'))).toBe(true);
  });

  it('signale un avertissement quand un élève n’a aucun vœu valide', () => {
    const donnees = normaliserDonnees({
      ateliers: [{ nom: 'Théâtre', capaciteMax: 25 }],
      eleves: [{ nom: 'Sans Voeu', classe: 'CM2-A' }],
    });

    expect(donnees.avertissements.some((a) => a.includes('aucun vœu valide'))).toBe(true);
  });

  it('génère des IDs composites uniques par (classe, nom) et gère les homonymes entre classes', () => {
    const donnees = normaliserDonnees({
      ateliers: [{ nom: 'Théâtre', capaciteMax: 50 }],
      eleves: [
        { nom: 'Martin Paul', classe: 'CM2-A' },
        { nom: 'Martin Paul', classe: 'CM2-B' },
      ],
    });

    const [a, b] = donnees.eleves;
    expect(a.id).not.toBe(b.id);
    expect(a.id).toBe('el_cm2_a_martin_paul');
    expect(b.id).toBe('el_cm2_b_martin_paul');
  });

  it('résout les exclusions via le couple (classe, nom) même avec une casse différente', () => {
    const donnees = normaliserDonnees({
      ateliers: [{ nom: 'Théâtre', capaciteMax: 50 }],
      eleves: [
        { nom: 'Dupont Alice', classe: 'CM2-A' },
        { nom: 'Martin Bob', classe: 'CM2-A' },
      ],
      exclusions: [
        { eleveA: { nom: 'dupont alice', classe: 'cm2-a' }, eleveB: { nom: 'MARTIN BOB', classe: 'CM2-A' } },
      ],
    });

    expect(donnees.exclusions).toHaveLength(1);
    expect(donnees.exclusions[0].eleveAId).toBe(donnees.eleves[0].id);
    expect(donnees.exclusions[0].eleveBId).toBe(donnees.eleves[1].id);
  });

  it('ignore silencieusement (avec avertissement) une exclusion référant un élève introuvable', () => {
    const donnees = normaliserDonnees({
      ateliers: [{ nom: 'Théâtre', capaciteMax: 50 }],
      eleves: [{ nom: 'Dupont Alice', classe: 'CM2-A' }],
      exclusions: [
        { eleveA: { nom: 'Dupont Alice', classe: 'CM2-A' }, eleveB: { nom: 'Inconnu', classe: 'CM2-Z' } },
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
        { nom: 'Dupont Alice', classe: 'CM2-A', voeu1: '  théâtre' },
        { nom: 'Martin Bob', classe: 'CM2-A', voeu1: 'ROBOTIQUE  ' },
      ],
    });

    expect(resultat.succes).toBe(true);
    expect(resultat.statut).toBe('OPTIMAL');
    expect(resultat.statistiques.distributionVoeux.voeu1).toBe(2);
    expect(resultat.parClasse['CM2-A']).toEqual(
      expect.arrayContaining([
        { eleveNom: 'Dupont Alice', atelierNom: 'Théâtre', rangVoeuSatisfait: 1 },
        { eleveNom: 'Martin Bob', atelierNom: 'Robotique', rangVoeuSatisfait: 1 },
      ]),
    );
  });
});
