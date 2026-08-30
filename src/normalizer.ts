import type {
  AtelierNormalise,
  DonneesNormalisees,
  EleveNormalise,
  ExclusionNormalisee,
  InputRawData,
} from './types.js';

const POIDS_VOEUX_DEFAUT = [100, 40, 10];

/** Retire les accents et met en forme une chaîne en identifiant compact (snake_case ASCII). */
export function slug(valeur: string): string {
  const nettoye = valeur
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return nettoye || 'x';
}

/** Clé de comparaison insensible à la casse, aux accents et aux espaces multiples. */
function cleComparaison(valeur: string): string {
  return valeur
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function nettoyerEspaces(valeur: string): string {
  return valeur.trim().replace(/\s+/g, ' ');
}

/** Génère un identifiant unique, en suffixant `_2`, `_3`, ... en cas de collision. */
function idUnique(base: string, compteurs: Map<string, number>): string {
  const compte = compteurs.get(base) ?? 0;
  compteurs.set(base, compte + 1);
  return compte === 0 ? base : `${base}_${compte + 1}`;
}

/**
 * Nettoie et normalise les données brutes (potentiellement issues de plusieurs
 * fichiers CSV / classes) en un modèle exploitable par le solveur.
 */
export function normaliserDonnees(input: InputRawData): DonneesNormalisees {
  const avertissements: string[] = [];

  // --- Ateliers ------------------------------------------------------------
  const ateliers: AtelierNormalise[] = [];
  const nomVersAtelierId = new Map<string, string>();
  const compteursAtelier = new Map<string, number>();

  for (const brut of input.ateliers) {
    const nom = nettoyerEspaces(brut.nom);
    const capaciteMax = Number(brut.capaciteMax);
    if (!Number.isFinite(capaciteMax) || capaciteMax < 0) {
      throw new Error(`Capacité invalide pour l'atelier "${nom}": ${JSON.stringify(brut.capaciteMax)}`);
    }

    const id = idUnique(`at_${slug(nom)}`, compteursAtelier);
    ateliers.push({ id, nom, capaciteMax });

    const cle = cleComparaison(nom);
    if (nomVersAtelierId.has(cle)) {
      avertissements.push(`Nom d'atelier en doublon (ignoré pour le mapping des vœux): "${nom}".`);
    } else {
      nomVersAtelierId.set(cle, id);
    }
  }

  // --- Élèves ----------------------------------------------------------------
  const eleves: EleveNormalise[] = [];
  const compteursEleve = new Map<string, number>();
  const lookupEleve = new Map<string, string>(); // "classeSlug::nomSlug" -> premier id trouvé

  for (const brut of input.eleves) {
    const nom = nettoyerEspaces(brut.nom);
    const classe = nettoyerEspaces(brut.classe);

    const id = idUnique(`el_${slug(classe)}_${slug(nom)}`, compteursEleve);

    const voeuxBruts = [brut.voeu1, brut.voeu2, brut.voeu3];
    const voeuxIds: Array<string | null> = voeuxBruts.map((voeu) => {
      if (voeu === undefined || voeu === null || !nettoyerEspaces(voeu)) return null;
      const atelierId = nomVersAtelierId.get(cleComparaison(voeu));
      if (!atelierId) {
        avertissements.push(
          `Vœu "${voeu}" de l'élève "${nom}" (${classe}) ne correspond à aucun atelier connu.`,
        );
        return null;
      }
      return atelierId;
    });

    if (voeuxIds.every((v) => v === null)) {
      avertissements.push(`L'élève "${nom}" (${classe}) n'a aucun vœu valide reconnu.`);
    }

    eleves.push({ id, nom, classe, voeuxIds });

    const cleLookup = `${slug(classe)}::${slug(nom)}`;
    if (!lookupEleve.has(cleLookup)) {
      lookupEleve.set(cleLookup, id);
    }
  }

  // --- Exclusions --------------------------------------------------------
  const exclusions: ExclusionNormalisee[] = [];
  for (const brut of input.exclusions ?? []) {
    const cleA = `${slug(brut.eleveA.classe)}::${slug(brut.eleveA.nom)}`;
    const cleB = `${slug(brut.eleveB.classe)}::${slug(brut.eleveB.nom)}`;
    const idA = lookupEleve.get(cleA);
    const idB = lookupEleve.get(cleB);

    if (!idA || !idB) {
      avertissements.push(
        `Exclusion ignorée (élève introuvable): "${brut.eleveA.nom}" (${brut.eleveA.classe}) / "${brut.eleveB.nom}" (${brut.eleveB.classe}).`,
      );
      continue;
    }
    if (idA === idB) {
      avertissements.push(
        `Exclusion ignorée (les deux membres désignent le même élève): "${brut.eleveA.nom}" (${brut.eleveA.classe}).`,
      );
      continue;
    }

    exclusions.push({ eleveAId: idA, eleveBId: idB, eleveA: brut.eleveA, eleveB: brut.eleveB });
  }

  const poidsVoeux = input.options?.poidsVoeux ?? POIDS_VOEUX_DEFAUT;
  const strictExclusions = input.options?.strictExclusions ?? true;

  return {
    ateliers,
    eleves,
    exclusions,
    options: { poidsVoeux, strictExclusions },
    avertissements,
  };
}
