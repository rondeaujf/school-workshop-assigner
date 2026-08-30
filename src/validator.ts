import { ErreurCoherence, type DonneesNormalisees } from './types.js';

/**
 * Vérifie la cohérence globale des données normalisées avant de lancer le
 * solveur. Lève une {@link ErreurCoherence} pour les problèmes bloquants
 * (capacité insuffisante, aucun atelier) et retourne la liste des
 * avertissements non bloquants (vœux non reconnus, etc.) accumulés pendant
 * la normalisation.
 */
export function verifierCoherence(donnees: DonneesNormalisees): string[] {
  if (donnees.ateliers.length === 0) {
    throw new ErreurCoherence('Aucun atelier fourni.', { nbAteliers: 0 });
  }

  const capaciteTotale = donnees.ateliers.reduce((somme, a) => somme + a.capaciteMax, 0);
  const nbEleves = donnees.eleves.length;

  if (capaciteTotale < nbEleves) {
    throw new ErreurCoherence(
      `Capacité totale insuffisante: ${capaciteTotale} places disponibles pour ${nbEleves} élèves ` +
        `(déficit de ${nbEleves - capaciteTotale} place(s)).`,
      { capaciteTotale, nbEleves, deficit: nbEleves - capaciteTotale },
    );
  }

  return [...donnees.avertissements];
}
