// ---------------------------------------------------------------------------
// Entrées brutes (issues du parsing CSV, potentiellement multi-classes)
// ---------------------------------------------------------------------------

export interface AtelierInput {
  nom: string;
  capaciteMax: number | string;
}

export interface EleveInput {
  /** Nom de famille, ex: "Dupont". */
  nom: string;
  /** Prénom, ex: "Alice". Requis pour distinguer les jumeaux/homonymes d'une même classe. */
  prenom: string;
  classe: string;
  voeu1?: string;
  voeu2?: string;
  voeu3?: string;
}

export interface EleveRef {
  nom: string;
  prenom: string;
  classe: string;
}

export interface ExclusionInput {
  eleveA: EleveRef;
  eleveB: EleveRef;
}

export interface OptionsInput {
  /** Points attribués par rang de vœu satisfait. Défaut: [100, 40, 10]. */
  poidsVoeux?: number[];
  /**
   * Si true (défaut), les exclusions sont des contraintes dures.
   * Si false, elles sont converties en pénalités fortes dans l'objectif.
   */
  strictExclusions?: boolean;
}

export interface InputRawData {
  ateliers: AtelierInput[];
  eleves: EleveInput[];
  exclusions?: ExclusionInput[];
  options?: OptionsInput;
}

// ---------------------------------------------------------------------------
// Données normalisées (internes)
// ---------------------------------------------------------------------------

export interface AtelierNormalise {
  id: string;
  nom: string;
  capaciteMax: number;
}

export interface EleveNormalise {
  /** Identifiant composite unique: `el_<classe>_<nom>_<prenom>` (distingue les jumeaux). */
  id: string;
  nom: string;
  prenom: string;
  classe: string;
  /** IDs d'ateliers alignés sur [voeu1, voeu2, voeu3, ...], `null` si absent ou non reconnu. */
  voeuxIds: Array<string | null>;
}

export interface ExclusionNormalisee {
  eleveAId: string;
  eleveBId: string;
  eleveA: EleveRef;
  eleveB: EleveRef;
}

export interface OptionsNormalisees {
  poidsVoeux: number[];
  strictExclusions: boolean;
}

export interface DonneesNormalisees {
  ateliers: AtelierNormalise[];
  eleves: EleveNormalise[];
  exclusions: ExclusionNormalisee[];
  options: OptionsNormalisees;
  avertissements: string[];
}

export class ErreurCoherence extends Error {
  details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ErreurCoherence';
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Sortie
// ---------------------------------------------------------------------------

export type Statut = 'OPTIMAL' | 'FEASIBLE' | 'FEASIBLE_WITH_CONFLICTS' | 'INFEASIBLE';

export interface AffectationParClasse {
  /** Nom complet affiché, ex: "Dupont Alice". */
  eleveNom: string;
  nom: string;
  prenom: string;
  atelierNom: string;
  rangVoeuSatisfait: number | null;
}

export interface AffectationParAtelier {
  eleveNom: string;
  nom: string;
  prenom: string;
  classe: string;
}

export interface ConflitExclusion {
  eleveA: EleveRef;
  eleveB: EleveRef;
  atelier: string;
}

export interface OutputResult {
  succes: boolean;
  statut: Statut;
  message?: string;
  scoreTotal: number;
  statistiques: {
    nbElevesTotaux: number;
    distributionVoeux: {
      voeu1: number;
      voeu2: number;
      voeu3: number;
      horsVoeux: number;
    };
  };
  /** Affectations groupées par classe (pour l'UI et les exports CSV/PDF). */
  parClasse: Record<string, AffectationParClasse[]>;
  /** Affectations groupées par atelier (pour les listes de présence). */
  parAtelier: Record<string, AffectationParAtelier[]>;
  conflitsExclusionsNonResolus?: ConflitExclusion[];
  /** Avertissements non bloquants (vœux non reconnus, exclusions ignorées, etc.). */
  avertissements?: string[];
}

/** Options transmises au chargeur du solveur HiGHS (ex: `locateFile` pour le navigateur). */
export interface HighsLoaderOptions {
  locateFile?: (file: string) => string;
}
