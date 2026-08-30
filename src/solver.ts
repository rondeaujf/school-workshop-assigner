import highsLoader from 'highs';
import type { DonneesNormalisees, ExclusionNormalisee, HighsLoaderOptions, Statut } from './types.js';

type Highs = Awaited<ReturnType<typeof highsLoader>>;
type HighsSolution = ReturnType<Highs['solve']>;

/**
 * Pénalité appliquée par occurrence de conflit d'exclusion non résolu, dans le
 * mode "souple". Très supérieure au score maximal atteignable
 * (nbElèves * poids max) pour ne jamais être préférée à une solution qui
 * évite le conflit.
 */
const PENALITE_EXCLUSION = 1_000_000;

type ModeExclusion = 'aucune' | 'dure' | 'souple';

interface ModeleLP {
  lp: string;
  /** nom de variable `x_i_j` -> index élève / index atelier */
  varAffectation: Map<string, { eleveIndex: number; atelierIndex: number }>;
}

function construireLP(donnees: DonneesNormalisees, mode: ModeExclusion): ModeleLP {
  const { eleves, ateliers, exclusions, options } = donnees;
  const nomVarX = (i: number, j: number) => `x_${i}_${j}`;
  const nomVarZ = (p: number, j: number) => `z_${p}_${j}`;

  const atelierIndexParId = new Map(ateliers.map((a, j) => [a.id, j]));
  const eleveIndexParId = new Map(eleves.map((e, i) => [e.id, i]));
  const varAffectation = new Map<string, { eleveIndex: number; atelierIndex: number }>();

  const termesObjectif: string[] = [];

  eleves.forEach((eleve, i) => {
    ateliers.forEach((_, j) => varAffectation.set(nomVarX(i, j), { eleveIndex: i, atelierIndex: j }));

    eleve.voeuxIds.forEach((atelierId, rang) => {
      if (!atelierId) return;
      const poids = options.poidsVoeux[rang];
      const j = atelierIndexParId.get(atelierId);
      if (!poids || j === undefined) return;
      termesObjectif.push(`+ ${poids} ${nomVarX(i, j)}`);
    });
  });

  const lignesContraintes: string[] = [];

  // Unicité d'affectation : chaque élève va exactement dans un atelier.
  eleves.forEach((_, i) => {
    const nomsVar = ateliers.map((__, j) => nomVarX(i, j));
    lignesContraintes.push(`c_u_${i}: ${nomsVar.join(' + ')} = 1`);
  });

  // Capacité maximale de chaque atelier.
  ateliers.forEach((atelier, j) => {
    const nomsVar = eleves.map((__, i) => nomVarX(i, j));
    lignesContraintes.push(`c_c_${j}: ${nomsVar.join(' + ')} <= ${atelier.capaciteMax}`);
  });

  const lignesBornes: string[] = [];

  if (mode !== 'aucune') {
    exclusions.forEach((exclusion, p) => {
      const i = eleveIndexParId.get(exclusion.eleveAId);
      const k = eleveIndexParId.get(exclusion.eleveBId);
      if (i === undefined || k === undefined) return;

      ateliers.forEach((_, j) => {
        if (mode === 'dure') {
          lignesContraintes.push(`c_e_${p}_${j}: ${nomVarX(i, j)} + ${nomVarX(k, j)} <= 1`);
        } else {
          const z = nomVarZ(p, j);
          lignesContraintes.push(`c_z_${p}_${j}: ${z} - ${nomVarX(i, j)} - ${nomVarX(k, j)} >= -1`);
          lignesBornes.push(`${z} <= 1`);
          termesObjectif.push(`- ${PENALITE_EXCLUSION} ${z}`);
        }
      });
    });
  }

  const lignesBinaires = Array.from(varAffectation.keys());

  const lp = [
    'Maximize',
    ` obj: ${termesObjectif.length > 0 ? termesObjectif.join(' ') : `0 ${lignesBinaires[0]}`}`,
    'Subject To',
    ...lignesContraintes.map((ligne) => ` ${ligne}`),
    ...(lignesBornes.length > 0 ? ['Bounds', ...lignesBornes.map((ligne) => ` ${ligne}`)] : []),
    'Binaries',
    ...lignesBinaires.map((ligne) => ` ${ligne}`),
    'End',
  ].join('\n');

  return { lp, varAffectation };
}

function estInfaisable(status: string): boolean {
  return status.toLowerCase().includes('infeasible');
}

export interface ConflitInterne {
  exclusion: ExclusionNormalisee;
  atelierId: string;
}

export interface ResultatSolveur {
  statut: Statut;
  /** eleveId -> atelierId, ou `null` si aucune solution exploitable. */
  affectations: Map<string, string> | null;
  conflitsNonResolus: ConflitInterne[];
  message?: string;
}

export async function resoudre(
  donnees: DonneesNormalisees,
  loaderOptions?: HighsLoaderOptions,
): Promise<ResultatSolveur> {
  if (donnees.eleves.length === 0) {
    return { statut: 'OPTIMAL', affectations: new Map(), conflitsNonResolus: [] };
  }

  const highs = await highsLoader(loaderOptions);

  const modeInitial: ModeExclusion =
    donnees.exclusions.length === 0 ? 'aucune' : donnees.options.strictExclusions ? 'dure' : 'souple';

  let modeUtilise = modeInitial;
  let { lp, varAffectation } = construireLP(donnees, modeInitial);
  let solution: HighsSolution = highs.solve(lp);

  if (estInfaisable(solution.Status) && modeInitial === 'dure') {
    // Relâchement automatique : les exclusions dures deviennent des pénalités fortes.
    modeUtilise = 'souple';
    ({ lp, varAffectation } = construireLP(donnees, 'souple'));
    solution = highs.solve(lp);
  }

  if (estInfaisable(solution.Status)) {
    return {
      statut: 'INFEASIBLE',
      affectations: null,
      conflitsNonResolus: [],
      message: `Le solveur a déterminé que le problème est infaisable (statut HiGHS: ${solution.Status}).`,
    };
  }

  if (solution.Status !== 'Optimal' || !('Columns' in solution)) {
    return {
      statut: 'INFEASIBLE',
      affectations: null,
      conflitsNonResolus: [],
      message: `Le solveur n'a pas retourné de solution exploitable (statut HiGHS: ${solution.Status}).`,
    };
  }

  const affectations = new Map<string, string>();
  for (const [nomVar, { eleveIndex, atelierIndex }] of varAffectation) {
    const colonne = solution.Columns[nomVar];
    if (colonne && colonne.Primal > 0.5) {
      affectations.set(donnees.eleves[eleveIndex].id, donnees.ateliers[atelierIndex].id);
    }
  }

  const conflitsNonResolus: ConflitInterne[] = [];
  if (modeUtilise === 'souple') {
    for (const exclusion of donnees.exclusions) {
      const atelierA = affectations.get(exclusion.eleveAId);
      const atelierB = affectations.get(exclusion.eleveBId);
      if (atelierA && atelierA === atelierB) {
        conflitsNonResolus.push({ exclusion, atelierId: atelierA });
      }
    }
  }

  const statut: Statut =
    modeUtilise === 'souple' && conflitsNonResolus.length > 0 ? 'FEASIBLE_WITH_CONFLICTS' : 'OPTIMAL';

  return { statut, affectations, conflitsNonResolus };
}
