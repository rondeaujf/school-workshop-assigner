export * from './types.js';
export { normaliserDonnees, slug } from './normalizer.js';
export { verifierCoherence } from './validator.js';

import { normaliserDonnees } from './normalizer.js';
import { verifierCoherence } from './validator.js';
import { resoudre } from './solver.js';
import type { HighsLoaderOptions, InputRawData, OutputResult } from './types.js';

/**
 * Résout le problème d'affectation d'élèves à des ateliers à partir de
 * données brutes (potentiellement multi-classes et tolérantes aux CSV
 * hétérogènes).
 *
 * @param input Données brutes (ateliers, élèves, exclusions, options).
 * @param loaderOptions Options passées au chargeur HiGHS WebAssembly
 *   (ex: `locateFile` pour pointer vers le `.wasm` dans un navigateur).
 * @throws {ErreurCoherence} si les données sont structurellement incohérentes
 *   (ex: capacité totale insuffisante, aucun atelier fourni).
 */
export async function optimiserAffectations(
  input: InputRawData,
  loaderOptions?: HighsLoaderOptions,
): Promise<OutputResult> {
  const donnees = normaliserDonnees(input);
  const avertissements = verifierCoherence(donnees);

  const resultat = await resoudre(donnees, loaderOptions);

  if (resultat.statut === 'INFEASIBLE' || !resultat.affectations) {
    return {
      succes: false,
      statut: 'INFEASIBLE',
      message: resultat.message ?? "Le problème n'admet pas de solution réalisable.",
      scoreTotal: 0,
      statistiques: {
        nbElevesTotaux: donnees.eleves.length,
        distributionVoeux: { voeu1: 0, voeu2: 0, voeu3: 0, horsVoeux: 0 },
      },
      parClasse: {},
      parAtelier: {},
      avertissements: avertissements.length > 0 ? avertissements : undefined,
    };
  }

  const atelierParId = new Map(donnees.ateliers.map((a) => [a.id, a]));

  const distributionVoeux = { voeu1: 0, voeu2: 0, voeu3: 0, horsVoeux: 0 };
  let scoreTotal = 0;

  const parClasse: OutputResult['parClasse'] = {};
  const parAtelier: OutputResult['parAtelier'] = {};

  for (const eleve of donnees.eleves) {
    const atelierId = resultat.affectations.get(eleve.id);
    const atelier = atelierId ? atelierParId.get(atelierId) : undefined;
    if (!atelier) continue;

    let rangVoeuSatisfait: number | null = null;
    const rangIndex = eleve.voeuxIds.findIndex((v) => v === atelierId);
    if (rangIndex !== -1) {
      rangVoeuSatisfait = rangIndex + 1;
      scoreTotal += donnees.options.poidsVoeux[rangIndex] ?? 0;
      if (rangIndex === 0) distributionVoeux.voeu1 += 1;
      else if (rangIndex === 1) distributionVoeux.voeu2 += 1;
      else if (rangIndex === 2) distributionVoeux.voeu3 += 1;
    } else {
      distributionVoeux.horsVoeux += 1;
    }

    (parClasse[eleve.classe] ??= []).push({
      eleveNom: eleve.nom,
      atelierNom: atelier.nom,
      rangVoeuSatisfait,
    });

    (parAtelier[atelier.nom] ??= []).push({ eleveNom: eleve.nom, classe: eleve.classe });
  }

  const conflitsExclusionsNonResolus =
    resultat.conflitsNonResolus.length > 0
      ? resultat.conflitsNonResolus.map((conflit) => ({
          eleveA: conflit.exclusion.eleveA,
          eleveB: conflit.exclusion.eleveB,
          atelier: atelierParId.get(conflit.atelierId)?.nom ?? conflit.atelierId,
        }))
      : undefined;

  return {
    succes: true,
    statut: resultat.statut,
    message:
      resultat.statut === 'FEASIBLE_WITH_CONFLICTS'
        ? `${resultat.conflitsNonResolus.length} conflit(s) d'exclusion n'ont pas pu être honorés.`
        : undefined,
    scoreTotal,
    statistiques: {
      nbElevesTotaux: donnees.eleves.length,
      distributionVoeux,
    },
    parClasse,
    parAtelier,
    conflitsExclusionsNonResolus,
    avertissements: avertissements.length > 0 ? avertissements : undefined,
  };
}
