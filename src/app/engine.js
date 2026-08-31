/* ============================================================
 * Moteur de calcul — portage fidèle de deux classeurs :
 *  - secteur "agri"      : 20250902_SIMULATEUR AGRI.xlsm (MSA, exonération TO-DE)
 *  - secteur "tarifaire" : SIMULATEUR_TARIFAIRE_11_2024.xlsm (Industrie/BTP, allègement Fillon)
 * Feuilles portées : SIMULATOR, "NE PAS TOUCHER NI REGARDER" (scénario
 * IFM+ICCP forcés), SIMULATEUR TODE (agri).
 * Les clés des objets résultats reprennent les adresses de cellules Excel
 * (F42, H88, O64...) pour permettre la vérification contre les classeurs.
 * ============================================================ */
"use strict";

const OUI = s => String(s == null ? "" : s).trim().toUpperCase() === "OUI";

/* Constantes communes figées dans les classeurs */
const CONST = {
  SMIC: 11.88,            // SMIC horaire (TO-DE, Fillon, assiette mini)
  SMIC_FIGE: 11.52,       // "Figé au 31/12/2023" — plafonds 2,5 / 3,5 SMIC (D108/D109)
  ICCP_TAUX: 0.10,        // E33
  IFM_TAUX: 0.10,         // E32
  FILLON_T: 0.3194        // D98
};

/* Valeurs officielles vérifiées multi-sources (URSSAF + BOSS + presse paie
 * concordants) le 19/08/2026 — utilisées comme DÉFAUTS de l'interface.
 * Les barèmes repas/nuitée n'ont pas d'API : gardés ici, surveillés par la
 * vérification programmée de janvier/juillet. SMIC et plafond SS sont en plus
 * actualisés en direct via OpenFisca à chaque ouverture. */
const BAKED_OFFICIAL = {
  asOf: "2026-08-19",
  smic: { value: 12.31, date: "2026-06-01" },            // SMIC horaire brut en vigueur
  pss: { value: 4005, date: "2026-01-01" },              // plafond SS mensuel
  repasLieuTravail: { value: 7.50, date: "2026-01-01" }, // panier (barème repas PD)
  repasHorsLocaux: { value: 10.40, date: "2026-01-01" },
  repasRestaurant: { value: 21.40, date: "2026-01-01" }, // barème repas GD
  nuiteeGDParis: { value: 76.60, date: "2026-01-01" },
  nuiteeGDProvince: { value: 56.80, date: "2026-01-01" },
  /* grand déplacement par durée (URSSAF/BOSS 2026 : plein / −15 % du 4ᵉ au 24ᵉ mois / −30 % au-delà) */
  nuiteeGDParisPeriodes: [76.60, 65.10, 53.60],
  nuiteeGDProvincePeriodes: [56.80, 48.30, 39.80],
  zonesBTPInchangees: true // 3,00/6,10/9,10/12,10/15,20 — identiques au classeur, confirmé BOSS 30/04/2026
};

/* RGDU 2026 (réduction générale dégressive unique, remplace Fillon au 01/01/2026)
 * Coefficient = Tmin + Tdelta × [½ × (plafond × SMIC réf / rémunération − 1)]^P,
 * plafonné à Tmin+Tdelta, nul dès `plafond` SMIC, arrondi à 4 décimales.
 * Paramètres du décret tels que codifiés par OpenFisca France (DINUM),
 * `allegement_general.ensemble_des_entreprises`, valeurs au 01/01/2026 —
 * actualisables en direct par l'application : */
const RGDU_DEFAULTS = {
  smicRef: 12.02,         // SMIC horaire au 01/01/2026 (figé pour l'année RGDU)
  tmin: 0.02,             // t_min
  tdeltaPetite: 0.3781,   // t_delta_petites_entreprises (< 50 salariés) → Tmax 0,3981
  tdeltaGrande: 0.3821,   // t_delta_grandes_entreprises (≥ 50 salariés) → Tmax 0,4021
  p: 1.75,                // puissance
  plafondSmic: 3,         // plafond (nul dès 3 SMIC)
  interimMajoration: 1.1  // CONFIRMÉ : art. D.241-10 III CSS (b = 1,1, intérimaires hors CDI-I ; Légifrance)
};

/* Grille du taux neutre du prélèvement à la source (BOFiP BOI-BAREME-000037-20260407,
 * mensuel métropole, en vigueur depuis le 01/05/2026). Le moteur convertit les
 * limites en hebdomadaire (× 12/52). Au-delà de la dernière tranche modélisée,
 * le taux 9,9 % est conservé avec un indicateur `pasHorsGrille`. */
const PAS_GRILLE_2026 = [
  [1635, 0], [1698, 0.5], [1807, 1.3], [1928, 2.1], [2060, 2.9],
  [2170, 3.5], [2315, 4.1], [2738, 5.3], [3135, 7.5], [3571, 9.9]
];
const PAS_ABAT_CONTRAT_COURT = 766; // €/mois — CDD/missions ≤ 2 mois (BOI-IR-PAS-20-20-30-10 §230/260, au 01/06/2026)

/* Retenue à la source des NON-RÉSIDENTS fiscaux (art. 182 A CGI), barème 2026
 * (LF 2026, +0,9 % — BOFiP ACTU-2026-00021) : base = net imposable × 0,9
 * (déduction forfaitaire 10 %), puis 0 % / 12 % / 20 % par tranches annuelles.
 * Proratisation journalière : limite annuelle / 312 (convention du classeur,
 * qui utilisait 55 €/j ≈ 17 121/312 pour 2025). La formule linéaire du classeur
 * était ce même barème limité à la tranche 12 %. */
const RASNR_2026 = { t1Annuel: 17275, t2Annuel: 50122, tauxMid: 0.12, tauxHaut: 0.20, joursAnnee: 312 };

/* Panier de cotisations exonérées TO-DE (MSA) :
 * [maladie, CSA, vieillesse plaf., vieillesse déplaf., AT éligible, famille, FNAL, chômage] + [retraite T1, CEG] */
const TODE_RATES_CLASSEUR = { msa: [7, 0.3, 8.55, 2.02, 0.46, 3.45, 0.1, 4.05], retraite: [4.72, 1.29] };
const TODE_RATES_2026 = { msa: [7, 0.3, 8.55, 2.11, 0.49, 3.45, 0.1, 4.00], retraite: [4.72, 1.29] };
// 2026 (décret 2025-1446 + Unédic) : vieillesse déplaf. 2,02→2,11 ; AT éligible 0,46→0,49 ; chômage 4,05→4,00.
// Les taux réduits maladie 7 % / famille 3,45 % restent applicables « à titre résiduel » aux contrats TO-DE.

/* Divergences constatées entre sources lors de la vérification du 19/08/2026 —
 * affichées à l'utilisateur pour contrôle manuel (la source officielle prime) : */
const BAKED_CONTRADICTIONS = [
  "Vieillesse déplafonnée patronale : <b>2,11 %</b> retenu (Légifrance, décret 2025-1446) — PayFit affichait encore 2,02 % (page non à jour).",
  "Grille du taux neutre PAS janv.–avril 2026 : bornes fiche-paie.fr ≠ BOFiP. Retenu : <b>BOFiP</b> (grille de mai 2026 appliquée).",
  "Majoration RGDU intérim ×1,1 : <b>confirmée</b> (art. D.241-10 III, Légifrance) — la documentation Sage évoquait sa suppression (état antérieur du projet de réforme)."
];

/* Taux de cotisations par défaut — secteur AGRI (E = salarial, G = patronal) */
const RATES_AGRI = {
  maladieSal: 5.5,        // E62 (si attestation fiscale = OUI)
  compIIDT1Sal: 0.5,      // E63
  compIIDT1Pat: 0.5,      // G63
  nonCsgT1Pat: 0,         // G64 (ligne absente du classeur agri)
  compIIDT2Sal: 0.3366,   // E65
  compIIDT2Pat: 0.2473,   // G65
  nonCsgT2Sal: 0,         // E66 (ligne absente)
  nonCsgT2Pat: 0,         // G66 (ligne absente)
  mutuelleSal: 0,         // E67 — % du plafond (D107)
  mutuellePat: 0,         // G67
  atPat: 2.2,             // G68
  ssPlafSal: 6.9,         // E69
  ssPlafPat: 8.55,        // G69
  ssDeplafSal: 0.4,       // E70
  ssDeplafPat: 2.02,      // G70
  compT1Sal: 4.01,        // E71
  compT1Pat: 6.01,        // G71
  compT2Sal: 9.72,        // E72
  compT2Pat: 14.57,       // G72
  cetSal: 0.14,           // E73
  cetPat: 0.14,           // G73
  chomagePat: 4.3,        // G75
  redSalHSup: 11.31,      // E76
  autresSal: 0.01,        // E77
  autresPat: 0.3 + 0.016 + 0.1 + 0.55 + 0.68 + 1 + 0.42 + 0.05 + 0.01 + 0.04 + 0.2, // G77
  statutairesPat: 0,      // G78
  csgDedSal: 6.8,         // E79 (si attestation fiscale = NON)
  csgNonDedSal: 2.9,      // E80
  csgNonDedHSSal: 9.7,    // E81
  redPatHSupParH: -1.5    // G82 (€ par heure sup)
};

/* Taux 2026 vérifiés multi-sources (Légifrance / Unédic / LégiSocial concordants,
 * 19/08/2026) — DÉFAUTS de l'interface. Les taux de branche/prévoyance et le taux
 * AT restent « à personnaliser » (spécifiques à l'entreprise). */
const RATES_2026_AGRI = Object.assign({}, RATES_AGRI, {
  atPat: 2.08,            // taux AT-MP net moyen national 2026 (arrêté 30/12/2025) — À PERSONNALISER
  ssDeplafPat: 2.11,      // vieillesse déplafonnée patronale (décret 2025-1446 ; classeur : 2,02)
  cetPat: 0.21,           // CET patronal réel (classeur : 0,14)
  chomagePat: 4.03,       // chômage 4,00 (Unédic, depuis 01/05/2025) + AGS ETT 0,03 (classeur : 4,3)
  autresPat: 0.30 + 0.10 + 0.016 + 1.30 + 0.68 + 0.42
  // CSA 0,30 + FNAL <50 0,10 + dialogue social 0,016 + formation ETT 1,30 + apprentissage 0,68 + SST MSA 0,42 — À PERSONNALISER
});

/* Taux — secteur TARIFAIRE 11/2024 */
const RATES_TARIFAIRE = Object.assign({}, RATES_AGRI, {
  compIIDT1Sal: 0.554,    // E63
  compIIDT1Pat: 0.492,    // G63
  nonCsgT1Pat: 0.144,     // G64 (Comp. IID NON CSG T1, patronale)
  compIIDT2Sal: 0.469,    // E65
  compIIDT2Pat: 0.408,    // G65
  nonCsgT2Sal: 0,         // E66 (vide dans le classeur)
  nonCsgT2Pat: 0.133,     // G66
  mutuelleSal: 0.0661,    // E67 — € PAR HEURE (base D24)
  mutuellePat: 0.0661,    // G67
  atPat: 3,               // G68
  chomagePat: 4.08,       // G75
  autresSal: 0,           // E77 absent du classeur tarifaire
  autresPat: 3.766,       // G77
  statutairesPat: 0.15    // G78
});

const RATES_2026_TARIFAIRE = Object.assign({}, RATES_TARIFAIRE, {
  atPat: 2.08,            // moyenne nationale 2026 — À PERSONNALISER
  ssDeplafPat: 2.11,      // décret 2025-1446 (classeur : 2,02)
  cetPat: 0.21,           // classeur : 0,14
  chomagePat: 4.03,       // 4,00 + AGS ETT 0,03 (classeur : 4,08 = 4,05 + 0,03)
  mutuelleSal: 0.0874,    // Intérimaires Santé, tarif 01/01/2026 (€/h ; classeur : 0,0661)
  mutuellePat: 0.0874,
  autresPat: 0.30 + 0.10 + 0.016 + 1.30 + 0.68
  // CSA + FNAL <50 + dialogue social + formation ETT + apprentissage — À PERSONNALISER (classeur : 3,766)
});

/* ===== Minima BTP officiels — ouvriers, grilles régionales (IDCC 1596 / 1597) =====
 * Source : code.travail.gouv.fr (Code du travail numérique, ministère du Travail),
 * pages « Quel est le salaire minimum ? » des CC 1596 (≤ 10 salariés) et 1597 (> 10),
 * relevées le 20/08/2026 — site « Mis à jour le 01/06/2026 ».
 * Montants MENSUELS bruts base 35 h ; horaire = mensuel ÷ 151,6667.
 * Le site applique déjà le plancher SMIC mensuel (astérisque) sur les bas coefficients. */
var BTP_MINIMA = {
  sources: ["https://code.travail.gouv.fr/contribution/1596-quel-est-le-salaire-minimum",
            "https://code.travail.gouv.fr/contribution/1597-quel-est-le-salaire-minimum"],
  releveLe: "2026-08-20", siteMajLe: "01/06/2026", diviseurHoraire: 151.6667,
  accords: {
    BRETAGNE: "accord du 3/12/2024 (au 1/1/2025)", GRANDEST: "accord du 16/1/2025 (au 1/3/2025)",
    HAUTSDEFRANCE: "accord du 25/11/2024", ILEDEFRANCE: "accord du 7/11/2024",
    PAYSDELALOIRE: "accord du 10/10/2023", PROVENCEALPESCOTEDAZUR: "accord du 30/9/2024 (au 1/11/2024)",
    NOUVELLEAQUITAINE: "accord régional du 22/10/2025"
  },
  regions: {
    AUVERGNERHONEALPES:    { cc1596: {150:1867.02,170:1867.02,185:1909,   210:2099.14,230:2277.47,250:2449.27,270:2597.13},
                             cc1597: {150:1867.02,170:1867.02,185:1909,   210:2099.14,230:2277.47,250:2449.27,270:2597.13} },
    BOURGOGNEFRANCHECOMTE: { cc1596: {150:1867.02,170:1867.02,185:1874,   210:2051,   230:2193,   250:2335,   270:2477},
                             cc1597: {150:1867.02,170:1867.02,185:1874,   210:2051,   230:2193,   250:2335,   270:2477} },
    BRETAGNE:              { cc1596: {150:1867.02,170:1868.17,185:1917.7, 210:2064.78,230:2234.67,250:2404.54,270:2574.41},
                             cc1597: {150:1867.02,170:1868.17,185:1917.7, 210:2064.78,230:2234.67,250:2404.54,270:2574.41} },
    CENTREVALDELOIRE:      { cc1596: {150:1867.02,170:1867.02,185:1907,   210:2056,   230:2175,   250:2293,   270:2412},
                             cc1597: {150:1867.02,170:1867.02,185:1898,   210:2045,   230:2165,   250:2283,   270:2400} },
    CORSE:                 { cc1596: {150:1867.02,170:1867.02,185:1932.59,210:2100.92,230:2274.76,250:2448.6, 270:2622.44},
                             cc1597: {150:1867.02,170:1867.02,185:1932.59,210:2100.92,230:2274.76,250:2448.6, 270:2622.44} },
    GRANDEST:              { cc1596: {150:1867.02,170:1867.02,185:1896.79,210:2101.77,230:2237.79,250:2394.78,270:2578.38},
                             cc1597: {150:1867.02,170:1867.02,185:1896.79,210:2101.77,230:2237.79,250:2394.78,270:2578.38} },
    HAUTSDEFRANCE:         { cc1596: {150:1867.02,170:1867.02,185:1955,   210:2111,   230:2269,   250:2469,   270:2650},
                             cc1597: {150:1867.02,170:1867.02,185:1955,   210:2111,   230:2269,   250:2469,   270:2650} },
    ILEDEFRANCE:           { cc1596: {150:1867.02,170:1867.02,185:1899,   210:2038,   230:2164,   250:2292,   270:2510},
                             cc1597: {150:1867.02,170:1867.02,185:1899,   210:2038,   230:2164,   250:2292,   270:2510} },
    NORMANDIE:             { cc1596: {150:1867.02,170:1867.02,185:1884.22,210:2065.63,230:2210.88,250:2380.23,270:2527.04},
                             cc1597: {150:1867.02,170:1867.02,185:1884.22,210:2065.63,230:2210.88,250:2380.23,270:2527.04} },
    NOUVELLEAQUITAINE:     { cc1596: {150:1867.02,170:1867.02,185:1912.56,210:2073.33,230:2229.55,250:2399.42,270:2560.19},
                             cc1597: {150:1867.02,170:1867.02,185:1912.56,210:2073.33,230:2229.55,250:2399.42,270:2560.19} },
    OCCITANIE:             { cc1596: {150:1867.02,170:1867.02,185:1902.53,210:2084.9, 230:2248.73,250:2380.1, 270:2547.01},
                             cc1597: {150:1867.02,170:1867.02,185:1902.53,210:2084.9, 230:2248.73,250:2380.1, 270:2547.01} },
    PAYSDELALOIRE:         { cc1596: {150:1867.02,170:1867.02,185:1867.02,210:2064.23,230:2244.72,250:2425.2, 270:2607.21},
                             cc1597: {150:1867.02,170:1867.02,185:1867.02,210:2064.23,230:2244.72,250:2425.2, 270:2607.21} },
    PROVENCEALPESCOTEDAZUR:{ cc1596: {150:1867.02,170:1868.43,185:1975.12,210:2170.8, 230:2340.59,250:2510.38,270:2680.18},
                             cc1597: {150:1867.02,170:1868.43,185:1975.12,210:2170.8, 230:2340.59,250:2510.38,270:2680.18} }
  }
};
var NIVEAU_COEF_BTP = { N1P1: 150, N1P2: 170, N2: 185, N3P1: 210, N3P2: 230, N4P1: 250, N4P2: 270 };
function normRegionBTP(s) {
  return (s || "").split("/")[0].normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z]/g, "");
}
function btpMinimaRegion(label) { return BTP_MINIMA.regions[normRegionBTP(label)] || null; }
function btpMinimaHoraire(label, niveau, cc) {
  const r = btpMinimaRegion(label), coef = NIVEAU_COEF_BTP[niveau];
  const m = r && coef ? (r[cc || "cc1596"] || {})[coef] : null;
  return m ? Math.round(m / BTP_MINIMA.diviseurHoraire * 100) / 100 : null;
}

/* Configuration par secteur */
const SECTORS = {
  agri: {
    label: "Agricole — MSA · TO-DE",
    rates: RATES_2026_AGRI,
    ratesClasseur: RATES_AGRI,
    plafondSSMois: 3925,        // D107 = 3925/30*jours
    retenueJour: 55,            // F43
    dfsFactor: 0.8,             // D101 = brut × 0,8 (abattement DFS 20 %)
    dfsOnMain: false,           // D62 SIMULATOR = F42 (abattement sur feuille cachée seulement)
    exo: "tode",                // H83
    mutuelleMode: "pctPlafond", // F67 = D107 × taux/100
    ifmMode: "input",           // D32 = saisie (feuille cachée uniquement)
    iccpMode: "rows",           // D33 = somme des lignes de paie
    ifmMainToggle: false,       // pas de ligne IFM sur SIMULATOR
    netSubT2Main: true,         // F89 SIMULATOR soustrait F65+F72+F73 (+F77)
    o52Mode: "flat",            // O52 SIMULATOR = M52 ; caché = 0
    logementMode: "hebdo",      // F92 = coût hebdo
    targetCell: "O66",          // M14 = O66 − L14 (taux hors logement)
    baremePD: 7.4, baremeGD: 21.1,
    f77Cross: true,             // caché F77 = SIMULATOR!F77
    hiddenLinkedRates: ["compIIDT1Sal", "compIIDT1Pat", "compIIDT2Sal", "compIIDT2Pat",
                        "mutuelleSal", "mutuellePat", "atPat", "chomagePat", "autresSal", "autresPat"],
    modes: ["SIMULATEUR MSA", "SIMULATEUR AGRICOLE", "SIMULATEUR INDUSTRIE",
            "SIMULATEUR BTP GRAND D", "SIMULATEUR BTP PETIT D"]
  },
  tarifaire: {
    label: "Tarifaire — Industrie · BTP",
    rates: RATES_2026_TARIFAIRE,
    ratesClasseur: RATES_TARIFAIRE,
    plafondSSMois: 3864,        // D107 = 3864/30*jours (2024)
    retenueJour: 54,            // F43
    dfsFactor: 0.9,             // D101 = brut × 0,9 (abattement DFS 10 %)
    dfsOnMain: true,            // D62 = IF(INDUSTRIE, F42, max(D101, D102)) sur les DEUX feuilles
    exo: "fillon",              // H83 = IF(BTP GD, MIN(D105,E105), D104)
    mutuelleMode: "perHour",    // F67 = D24 × taux (€/h, sans /100)
    ifmMode: "rows",            // D32 = Σ lignes de paie (SIMULATOR sans F30, caché avec F30)
    iccpMode: "ifm",            // D33 = D32 + F32
    ifmMainToggle: true,        // F11 = choix utilisateur sur SIMULATOR
    netSubT2Main: false,        // F89 ne soustrait ni F65/F72/F73 ni F77
    o52Mode: "hours",           // O52 = L52 × M52, L52 = IF(logement, min(D17,35), 0)
    logementMode: "horaire",    // F92 = coût €/h × heures logement (43 dans le classeur)
    targetCell: "O62",          // M14 = O62 − L14 (taux global avec logement)
    baremePD: 7.3, baremeGD: 20.7,
    f77Cross: false,            // pas de F77 dans ce classeur
    hiddenLinkedRates: [],      // tous les taux de la feuille cachée sont des littéraux
    modes: ["SIMULATEUR INDUSTRIE", "SIMULATEUR BTP GRAND D", "SIMULATEUR BTP PETIT D"]
  }
};

/* Valeurs par défaut des entrées = état de chaque classeur */
function defaultInputs(DB, sector) {
  sector = sector || "agri";
  const cfg = SECTORS[sector];
  const common = {
    sector: sector,
    client: "",
    dept: "",
    thBrut: BAKED_OFFICIAL.smic.value,  // D11 — prérempli au SMIC en vigueur, PLANCHER automatique (jamais en dessous)
    attestation: true,          // F13
    logement: true,             // H11
    redevanceClient: 0,         // H21
    baremeRepasPD: BAKED_OFFICIAL.repasLieuTravail.value, // H13 — 2026 (classeur : 7,40/7,30)
    baremeRepasGD: BAKED_OFFICIAL.repasRestaurant.value,  // I13 — 2026 (classeur : 21,10/20,70)
    jours: 0,                   // D16 — zéro à l'ouverture
    hNuit: 0, hDim: 0, hFerie: 0,
    anRepasConsomme: false,     // D21
    zonePD: "PAS DE TRANSPORT PD",
    repasClient: 0, transpClient: 0, anRepasClient: 0,
    majoFerieLabel: "MAJO FERIE 100 %",
    majoNuitLabel: "MAJO DE NUIT 10%",
    hSupLabel: "HEURES SUPPLEMENTAIRES 25%",
    majoNormQty: 0,
    ticketsQty: 0, ticketsVal: 0,
    indemDecoucheRate: 0,       // E50
    participationChoice: "PARTICIPATION LIBRE",
    retraitANRepas: false,      // M54
    remisePct: 0,               // M63
    recrutTarifH: 0,            // prestataire externe de recrutement — € HT par heure travaillée (0,50-1,30 constatés ; 0 = aucun)
    participationHorsPaie: false, // true = participation logement par PRÉLÈVEMENT BANCAIRE : net de paie non réduit, coût logement toujours amorti
    agence: "",                 // agence PALMA sélectionnée (fixe le taux AT par défaut ; portée dans l'étude de prix)
    cetCoutsReels: false,       // intégrer les coûts CET maison (abondement + causeries) dans la marge
    cetAbondPct: 5,             // abondement % versé à chaque déblocage (politique maison : 5 %)
    cetDebloc: 3,               // déblocages CET par an (fonctionnement normal : 3)
    cetCauserieH: 1.5,          // heures de causerie par déblocage, payées NON facturées (contrat : 1 h 50)
    refactDim: true, refactFerie: true, refactNuit: true,
    annualisation: false,
    heuresFactNormal: null,     // L24 — null = auto min(35 ; heures)
    cibleMargePct: 0,           // L17 — 0 : le pilotage affiche le seuil de rentabilité
    logementHeures: 43,         // multiplicateur F92 (classeur tarifaire : ×43 en dur)
    exoFormule: "rgdu",         // RGDU 2026 (le Fillon du classeur ne sert plus qu'au mode « constantes du classeur »)
    gdDuree: 0,                 // référence GD : 0 = 3 premiers mois, 1 = 4ᵉ-24ᵉ (−15 %), 2 = au-delà (−30 %)
    gdLieu: "province",         // référence GD : "province" ou "paris" (92/93/94)
    rgdu: { smicRef: RGDU_DEFAULTS.smicRef, fnal050: false, interim: true },
    smicClasseur: BAKED_OFFICIAL.smic.value, // SMIC des formules (Fillon, TO-DE, assiette mini) — défaut = droit courant ; classeur : 11,88
    plafondSSMois: BAKED_OFFICIAL.pss.value, // plafond SS mensuel (D107) — défaut = droit courant ; classeur : 3925/3864
    todeSeuilTot: 1.25,         // seuil TO-DE exonération intégrale (× SMIC)
    todeSeuilMax: 1.6,          // seuil TO-DE maximal (× SMIC)
    todeRates: TODE_RATES_2026, // panier de cotisations exonérées TO-DE
    /* taux réduits maladie 7 % / famille 3,45 % : supprimés au 01/01/2026 (RGDU),
     * mais maintenus « à titre résiduel » pour les contrats TO-DE (agri) */
    tauxReduits: sector === "agri",
    pasMode: "grille",          // retenue à la source : grille BOFiP 2026 ("classeur" = formule linéaire du classeur)
    pasContratCourt: true,      // abattement contrats courts 766 €/mois (missions ≤ 2 mois)
    gdAvanceAuto: false,        // conversion classeur avance -> repas GD/transport refacturés : désactivée (true = Excel)
    adrDomicile: "",            // adresse domicile / siège social (UI : distance orthodromique)
    adrChantier: "",            // adresse du chantier (BTP uniquement)
    distAller: 0,               // km aller simple à vol d'oiseau (zones BTP)
    distReelAR: 0,              // km RÉELS routiers aller-retour (tranche URSSAF transport)
    rates: Object.assign({}, cfg.rates),
    ratesBase: Object.assign({}, cfg.rates) // littéraux de la feuille cachée (non liés aux éditions)
  };
  if (sector === "agri") {
    return Object.assign(common, {
      mode: "SIMULATEUR MSA",   // D3
      netAttendu: null,         // D12 — vide à l'ouverture
      ifm: false,               // (pas de ligne IFM sur SIMULATOR agri)
      iccp: true,               // F12
      logementHebdo: 0,         // H12 (€ / semaine) — défaut 0 : pas de logement tant que rien n'est saisi
      logementHoraire: 0,
      heures: 0,                // D17 — zéro à l'ouverture
      coeff: 0,                 // H16 — zéro à l'ouverture (seuil de rentabilité affiché en aide)
      coeffHDN: 1.4,            // N27
      majoDimLabel: "MAJO DIMANCHE 10 %",
      majoNormLabel: "MAJO NORMALES 40 %",
      baseIFM: 0,               // D32 (saisie, scénario IFM)
      /* fc = coefficient de facturation par ligne : null/"coef" = coefficient de la
       * mission (via le réglage global « primes refacturées »), 0 = non facturée,
       * toute autre valeur = coefficient spécifique. Indemnités : défaut 1. */
      primes: [ {q:0, r:0, name:"Prime 1", fc:null}, {q:0, r:0, name:"Prime 2", fc:null}, {q:0, r:0, name:"Prime 3", fc:null},
                {q:0, r:0, name:"Prime 4", fc:null}, {q:0, r:0, name:"Prime 5", fc:null} ],
      indemnites: [ {q:0, r:0, name:"Indemnité 1", fc:0}, {q:0, r:0, name:"Indemnité 2", fc:0},   // défaut 0 (23/08/2026) : pratique maison —
                    {q:0, r:0, name:"Indemnité 3", fc:0}, {q:0, r:0, name:"Indemnité 4", fc:0} ], // les indemnités d'ajustement du net ne sont pas refacturées
      participationLibre: 0,    // F19 — défaut 0 (aucune retenue)
      coutLogementFacture: 0,   // M52 (€ / semaine) — défaut 0
      refactPrimes: true,       // L18
      cibleTauxFact: 0          // L14 — zéro à l'ouverture
    });
  }
  return Object.assign(common, {
    mode: "SIMULATEUR INDUSTRIE", // D3
    branche: "industrie",       // UI : "btp" | "industrie" (affiliation CPAM, RGDU pour les deux)
    niveauQualif: "N1P1",       // référence grille BTP (niveau de qualification affiché)
    netAttendu: null,           // D12 — vide à l'ouverture
    ifm: false,                 // F11
    iccp: false,                // F12
    logementHebdo: 0,
    logementHoraire: 0,         // I12/H12 (€ / heure) — défaut 0 ; le département préremplit sur sélection
    heures: 0,                  // D17 — zéro à l'ouverture
    coeff: 0,                   // H16 — zéro à l'ouverture (seuil de rentabilité affiché en aide)
    coeffHDN: 1.9,              // N27
    majoDimLabel: "MAJO DIMANCHE 80 %",
    majoNormLabel: "MAJO NORMALES 50 %",
    baseIFM: 0,
    primes: [ {q:0, r:0, name:"Prime 1", fc:null}, {q:0, r:0, name:"Prime 2", fc:null}, {q:0, r:0, name:"Prime 3", fc:null},
              {q:0, r:0, name:"Prime 4", fc:null}, {q:0, r:0, name:"Prime 5", fc:null} ],
    indemnites: [ {q:0, r:0, name:"Indemnité 1", fc:0}, {q:0, r:0, name:"Indemnité 2", fc:0},   // défaut 0 (23/08/2026) : pratique maison —
                  {q:0, r:0, name:"Indemnité 3", fc:0}, {q:0, r:0, name:"Indemnité 4", fc:0} ], // les indemnités d'ajustement du net ne sont pas refacturées
    participationLibre: 0,      // F19 — défaut 0 (aucune retenue)
    coutLogementFacture: 0,     // M52 (€ / heure facturé)
    refactPrimes: true,         // L18
    cibleTauxFact: 0            // L14 — zéro à l'ouverture
  });
}

function lookupMult(table, label) {
  const row = table.find(r => r.label === label);
  return row ? (row.mult != null ? row.mult : row.raw) : 0;
}
function lookupValue(table, label) {
  const row = table.find(r => r.label === label);
  return row ? row.value : 0;
}

/* TO-DE (exonération travailleurs occasionnels / demandeurs d'emploi — agri)
 * seuils 1,25 / 1,6 SMIC (OpenFisca : agricole.tode.plafond_exoneration_integrale / plafond) */
function computeTODE(hours, brut, brutHorsHS, smic, seuilTot, seuilMax, basket) {
  const B1 = smic || CONST.SMIC, B2 = hours;
  const B3 = B1 * B2 * (seuilTot || 1.25);
  const B4 = B1 * B2 * (seuilMax || 1.6);
  const B8 = brutHorsHS < B3 ? "TOTALE" : (brutHorsHS > B3 && brutHorsHS < B4 ? "PARTIELLE" : "NON");
  const bk = basket || TODE_RATES_2026;
  const msa = bk.msa.reduce((s, t) => s + brut * t / 100, 0);
  const retraite = bk.retraite.reduce((s, t) => s + brut * t / 100, 0);
  let B21 = 0, B22 = 0, B23 = 0, B24 = 0;
  if (B8 === "TOTALE") { B21 = msa; B22 = retraite; }
  if (B8 === "PARTIELLE") {
    const k = (1.6 * B2 * B1 / brutHorsHS) - 1;
    B23 = (1.25 * msa / 0.35) * k;
    B24 = (1.25 * retraite / 0.35) * k;
  }
  return { seuilTotale: B3, seuilMax: B4, eligibilite: B8, msa, retraite,
           B21, B22, B23, B24, total: B21 + B22 + B23 + B24 };
}

/* Calcule une feuille complète.
 * variant: 'main' (SIMULATOR) ou 'hidden' (feuille cachée, IFM+ICCP forcés).
 * hiddenAvance: {F55,F56} de la feuille cachée (pour F49/F51 de la principale).
 * f77Override: secteur agri — le caché reprend F77 de la principale. */
function computeSheet(i, variant, hiddenAvance, f77Override) {
  const cfg = SECTORS[i.sector || "agri"];
  const R = i.rates, S = {};
  const isMain = variant === "main";
  const mode = i.mode;
  const netNull = (i.netAttendu == null);

  /* --- Heures et majorations (lignes 24-31) --- */
  S.D24 = (i.heures <= 35) ? i.heures : 35;
  S.E24 = i.thBrut;
  S.F24 = S.D24 * S.E24;
  S.D25 = i.hDim;   S.E25 = i.thBrut * lookupMult(DB.majoDimanche, i.majoDimLabel);   S.F25 = S.D25 * S.E25;
  S.D26 = i.hFerie; S.E26 = i.thBrut * lookupMult(DB.majoFerie, i.majoFerieLabel);    S.F26 = S.D26 * S.E26;
  S.D27 = i.hNuit;  S.E27 = i.thBrut * lookupMult(DB.majoNuit, i.majoNuitLabel);      S.F27 = S.D27 * S.E27;
  S.D28 = (i.heures >= 36) ? (i.heures < 44 ? i.heures - 35 : 8) : 0;
  S.E28 = i.thBrut * lookupMult(DB.heuresSup, i.hSupLabel);
  S.F28 = S.D28 * S.E28;
  S.D29 = (i.heures >= 44) ? (i.heures < 48 ? i.heures - 43 : i.heures - S.D28 - S.D24) : 0;
  S.E29 = S.E24 * 1.5;
  S.F29 = S.D29 * S.E29;
  S.D30 = i.majoNormQty; S.E30 = i.thBrut * lookupMult(DB.majoNormales, i.majoNormLabel); S.F30 = S.D30 * S.E30;
  S.D31 = i.heures;

  /* --- Barème zone km / repas --- */
  S.H18 = lookupValue(DB.zonesKmPD, i.zonePD);
  S.E45 = (i.transpClient < S.H18) ? i.transpClient : S.H18;
  S.E46 = (i.repasClient > i.baremeRepasPD) ? i.baremeRepasPD : i.repasClient;
  S.D45 = i.jours; S.F45 = S.D45 * S.E45;
  S.D46 = i.jours; S.F46 = S.D46 * S.E46;

  /* --- Primes au-delà des plafonds & AN repas (lignes 34-36) --- */
  S.D34 = S.D46; S.E34 = i.repasClient - S.E46;  S.F34 = S.D34 * S.E34;
  S.D35 = S.D45; S.E35 = i.transpClient - S.E45; S.F35 = S.D35 * S.E35;
  S.D36 = i.jours; S.E36 = i.anRepasClient;      S.F36 = S.D36 * S.E36;

  /* --- Primes 1-5 (lignes 37-41) --- */
  for (let k = 0; k < 5; k++) {
    S["F" + (37 + k)] = i.primes[k].q * i.primes[k].r;
  }

  /* --- IFM (ligne 32) & ICCP (ligne 33) --- */
  const rowsSum = S.F24 + S.F25 + S.F26 + S.F27 + S.F28 + S.F29 + S.F30 +
                  S.F34 + S.F35 + S.F36 + S.F37 + S.F38 + S.F39 + S.F40 + S.F41;
  if (cfg.ifmMode === "input") {
    S.D32 = i.baseIFM || 0;                       // agri : saisie
  } else {
    // tarifaire : SIMULATOR = Σ lignes SANS F30 ; caché = Σ lignes AVEC F30
    S.D32 = rowsSum - (isMain ? S.F30 : 0);
  }
  const ifmOn = isMain ? (cfg.ifmMainToggle ? i.ifm : false) : true;  // caché : F11='OUI'
  S.F32 = ifmOn ? S.D32 * CONST.IFM_TAUX : 0;
  S.D33 = (cfg.iccpMode === "ifm") ? S.D32 + S.F32 : rowsSum;
  const iccpOn = isMain ? i.iccp : true;          // caché : F12='OUI'
  S.F33 = iccpOn ? S.D33 * CONST.ICCP_TAUX : 0;

  /* --- TOTAL BRUT (F42 = SUM F24:F41) --- */
  S.F42 = rowsSum + S.F32 + S.F33;

  /* --- Plafonds (lignes 107-109) --- */
  const SMIC_C = i.smicClasseur || CONST.SMIC;   // SMIC des formules du classeur
  S.D107 = (i.plafondSSMois || cfg.plafondSSMois) / 30 * i.jours;
  S.D108 = CONST.SMIC_FIGE * S.D31 * 2.5;
  S.D109 = CONST.SMIC_FIGE * S.D31 * 3.5;

  /* --- Assiette de cotisations (D62) --- */
  S.D101 = S.F42 * cfg.dfsFactor;
  S.D102 = (S.D24 * SMIC_C) + (S.D29 * SMIC_C * 1.5) +
           (S.D28 * SMIC_C * (S.E24 ? S.E28 / S.E24 : 0)) + S.F32 + S.F33;
  const dfsApplies = isMain ? cfg.dfsOnMain : true;
  if (!dfsApplies) {
    S.D62 = S.F42;
  } else {
    S.D62 = (mode === "SIMULATEUR INDUSTRIE") ? S.F42 : Math.max(S.D101, S.D102);
  }

  /* --- Cotisations (lignes 62-82) : F = salarial, H = patronal --- */
  const att = i.attestation; // F13
  S.F62 = att ? S.D62 * R.maladieSal / 100 : 0;
  /* maladie patronale : taux réduit 7 % supprimé au 01/01/2026 (RGDU) sauf
   * résiduel TO-DE — piloté par i.tauxReduits (classeur : seuil 2,5 SMIC figé) */
  S.G62 = (i.tauxReduits === false) ? 13 : ((S.D62 <= S.D108) ? 7 : 13);
  S.H62 = S.D62 * S.G62 / 100;
  S.D63 = Math.min(S.D62, S.D107);
  S.F63 = S.D63 * R.compIIDT1Sal / 100;  S.H63 = S.D63 * R.compIIDT1Pat / 100;
  S.D64 = S.D63;                                        // ligne 64 (tarifaire) : patronale seule
  S.H64 = S.D64 * R.nonCsgT1Pat / 100;
  S.D65 = S.D62 - S.D63;
  S.F65 = S.D65 * R.compIIDT2Sal / 100;  S.H65 = S.D65 * R.compIIDT2Pat / 100;
  S.D66 = S.D65;                                        // ligne 66 (tarifaire)
  S.F66 = S.D66 * R.nonCsgT2Sal / 100;   S.H66 = S.D66 * R.nonCsgT2Pat / 100;
  if (cfg.mutuelleMode === "pctPlafond") {
    S.D67 = S.D107;
    S.F67 = S.D67 * R.mutuelleSal / 100;   S.H67 = S.D67 * R.mutuellePat / 100;
  } else {
    S.D67 = S.D24;                                      // tarifaire : € par heure normale
    S.F67 = S.D67 * R.mutuelleSal;         S.H67 = S.D67 * R.mutuellePat;
  }
  S.H68 = S.D62 * R.atPat / 100;
  /* ligne 69 : base D63 (plafonnée) sur SIMULATOR, D62 (non plafonnée) sur la feuille cachée */
  S.D69 = isMain ? S.D63 : S.D62;
  S.F69 = S.D69 * R.ssPlafSal / 100;     S.H69 = S.D69 * R.ssPlafPat / 100;
  S.F70 = S.D62 * R.ssDeplafSal / 100;   S.H70 = S.D62 * R.ssDeplafPat / 100;
  S.F71 = S.D63 * R.compT1Sal / 100;     S.H71 = S.D63 * R.compT1Pat / 100;
  S.D72 = S.D62 - S.D63;
  S.F72 = S.D72 * R.compT2Sal / 100;     S.H72 = S.D72 * R.compT2Pat / 100;
  S.D73 = (S.D72 > 0) ? S.D62 : 0;
  S.F73 = S.D73 * R.cetSal / 100;        S.H73 = S.D73 * R.cetPat / 100;
  S.G74 = (i.tauxReduits === false) ? 5.25 : ((S.D62 <= S.D109) ? 3.45 : 5.25);
  S.H74 = S.D62 * S.G74 / 100;
  S.H75 = S.D62 * R.chomagePat / 100;
  S.D76 = S.F42 ? (S.F28 + S.F29) * (S.D62 / S.F42) : 0;
  S.F76 = -S.D76 * R.redSalHSup / 100;
  S.F77 = (f77Override != null) ? f77Override : S.D62 * R.autresSal / 100;
  S.H77 = S.D62 * R.autresPat / 100;
  S.H78 = S.D62 * R.statutairesPat / 100;
  S.D79 = ((S.F42 - S.F29 - S.F28) * 0.9825) + S.H67 + S.H63 + S.H65;
  S.F79 = att ? 0 : S.D79 * R.csgDedSal / 100;
  S.F80 = att ? 0 : S.D79 * R.csgNonDedSal / 100;
  S.D81 = (S.F28 + S.F29) * 0.9825;
  S.F81 = att ? 0 : S.D81 * R.csgNonDedHSSal / 100;
  S.D82 = S.D28 + S.D29;
  S.H82 = S.D82 * R.redPatHSupParH;

  /* --- Tickets restaurant (ligne 44) --- */
  S.F44 = -(i.ticketsQty * i.ticketsVal * 0.4);
  S.H44 = i.ticketsQty * i.ticketsVal * 0.6;

  /* --- Fillon (lignes 97-105) --- */
  S.D98 = S.F42 ? (CONST.FILLON_T / 0.6) * ((1.6 * (SMIC_C * S.D31) / S.F42) - 1) : 0;
  S.D99 = Math.min(S.D98, CONST.FILLON_T);
  S.D100 = Math.max(S.D99, 0);
  S.E98 = S.D62 ? (CONST.FILLON_T / 0.6) * ((1.6 * (SMIC_C * S.D31) / S.D62) - 1) : 0;
  S.E99 = Math.min(S.E98, CONST.FILLON_T);
  S.E100 = Math.max(S.E99, 0);
  S.D104 = (S.D100 * S.F42) * 1.1;
  S.E104 = (S.E100 * S.D62) * 1.1;
  S.D105 = S.D104 * 1.3;
  S.E105 = S.E104;

  /* --- RGDU 2026 (calculée dans tous les cas, à titre de comparaison) ---
   * Proratisation hebdomadaire cohérente avec la convention Fillon du classeur :
   * paramètre SMIC = SMIC réf × heures travaillées (D31, heures sup incluses). */
  {
    const rg = i.rgdu || {};
    const smicParam = (rg.smicRef || RGDU_DEFAULTS.smicRef) * S.D31;
    const tdelta = rg.fnal050 ? (rg.tdeltaGrande || RGDU_DEFAULTS.tdeltaGrande)
                              : (rg.tdeltaPetite || RGDU_DEFAULTS.tdeltaPetite);
    const tmin = (rg.tmin != null) ? rg.tmin : RGDU_DEFAULTS.tmin;
    const p = rg.p || RGDU_DEFAULTS.p;
    const plaf = rg.plafondSmic || RGDU_DEFAULTS.plafondSmic;
    let coeff = 0;
    if (S.F42 > 0 && S.F42 < plaf * smicParam) {
      const t = Math.min(1, 0.5 * (plaf * smicParam / S.F42 - 1));
      coeff = tmin + tdelta * Math.pow(t, p);
      coeff = Math.round(Math.min(coeff, tmin + tdelta) * 10000) / 10000;
    }
    S.rgduCoeff = coeff;
    S.rgduAmount = coeff * S.F42 * (rg.interim === false ? 1 : RGDU_DEFAULTS.interimMajoration);
  }

  /* --- Exonération (H83) : TO-DE (agri) ou allègement Fillon / RGDU (tarifaire) --- */
  S.tode = computeTODE(S.D24, S.F42, S.F42 - S.F28 - S.F29, SMIC_C, i.todeSeuilTot, i.todeSeuilMax, i.todeRates);
  if (cfg.exo === "tode") {
    S.H83 = S.tode.total;
  } else {
    S.H83_fillon = (mode === "SIMULATEUR BTP GRAND D") ? Math.min(S.D105, S.E105) : S.D104;
    /* RGDU : l'imputation est PLAFONNÉE aux cotisations dues du panier éligible
     * (imputation ligne à ligne — BOSS ; décret 2025-1446 : part AT imputable
     * 0,49 % en 2026 ; FNAL 0,10/0,50 % ; CSA 0,30 %). Sans ce plafond, la
     * majoration intérim ×1,1 « sur-réduisait » près du SMIC (réduction
     * supérieure aux cotisations réellement dues). */
    S.rgduPanier = S.H62 + S.H69 + S.H70 + S.H71 + S.H74 + S.H75 +
                   S.D62 * (0.0049 + 0.003 + ((i.rgdu && i.rgdu.fnal050) ? 0.005 : 0.001));
    S.H83 = (i.exoFormule === "rgdu") ? Math.min(S.rgduAmount, S.rgduPanier) : S.H83_fillon;
  }

  /* --- Provision CET (ligne 85) --- */
  S.D85 = (S.F32 + S.F33) > 0 ? 0 : S.D32 * 0.21;
  S.H85 = S.D85 * 0.45;
  /* Coûts CET réels (politique maison, OPTION — décochée = classeur d'origine) :
     abondement versé à chaque déblocage (régime permanent : X % du flux hebdo provisionné,
     le nombre de déblocages ne change pas le total d'abondement, seulement les causeries)
     + causeries payées NON FACTURÉES (nbDéblocages × heures × taux brut, ramenées à la semaine).
     Les deux sont chargés au taux des charges décalées du classeur (H85/D85 = 45 %). */
  S.cetAbondCout = 0; S.cetCauserieCout = 0;
  if (i.cetCoutsReels && S.D85 > 0) {
    S.cetAbondCout = (i.cetAbondPct || 0) / 100 * S.D85 * 1.45;
    S.cetCauserieCout = ((i.cetDebloc || 0) * (i.cetCauserieH || 0) / 52) * i.thBrut * 1.45;
  }
  S.cetCoutReel = S.cetAbondCout + S.cetCauserieCout;

  /* --- Totaux cotisations (ligne 88) ---
   * agri : F88 inclut F77 ; tarifaire : pas de F77 (taux 0 → terme nul). */
  S.F88 = S.F62 + S.F63 + S.F67 + S.F69 + S.F70 + S.F71 + S.F76 +
          S.F79 + S.F80 + S.F81 + S.F65 + S.F66 + S.F72 + S.F73 + S.F77;
  S.H88 = (S.H62 + S.H63 + S.H64 + S.H65 + S.H66 + S.H67 + S.H68 + S.H69 + S.H70 + S.H71 +
           S.H72 + S.H73 + S.H74 + S.H75 + S.H77 + S.H78 + S.H82) - S.H83 + S.H44;

  /* --- Net imposable & retenue à la source (F14, F43) --- */
  S.F14 = S.F42 + S.H67 + S.F80 + S.F81 - S.F88 - S.F28 - S.F29;
  /* Retenue à la source — DEUX régimes selon la résidence fiscale (case attestation) :
   * - "classeur" : formule linéaire du classeur ((F14 × 0,9) − retenueJour × j) × 12 % pour tous ;
   * - sinon, NON-RÉSIDENT (attestation = OUI) : barème 182 A CGI 2026 par tranches
   *   (0 / 12 / 20 %) sur F14 × 0,9, seuils annuels proratisés par jour travaillé ;
   * - RÉSIDENT français (attestation = NON) : grille du taux neutre PAS BOFiP
   *   (mensuel × 12/52), abattement contrats courts optionnel. */
  if (i.pasMode === "classeur") {
    S.F43 = ((S.F14 * 0.9) - (cfg.retenueJour * i.jours)) * 0.12;
    S.pasHorsGrille = false;
    S.pasRegime = "classeur";
  } else if (att) {
    const base = Math.max(0, S.F14 * 0.9);
    const l1 = RASNR_2026.t1Annuel / RASNR_2026.joursAnnee * i.jours;
    const l2 = RASNR_2026.t2Annuel / RASNR_2026.joursAnnee * i.jours;
    S.F43 = Math.max(0, Math.min(base, l2) - l1) * RASNR_2026.tauxMid +
            Math.max(0, base - l2) * RASNR_2026.tauxHaut;
    S.pasHorsGrille = false;
    S.pasRegime = "182A";
  } else {
    const w = 12 / 52;
    const base = Math.max(0, S.F14 - (i.pasContratCourt === false ? 0 : PAS_ABAT_CONTRAT_COURT * w));
    let rate = PAS_GRILLE_2026[PAS_GRILLE_2026.length - 1][1];
    S.pasHorsGrille = true;
    for (const [lim, r] of PAS_GRILLE_2026) {
      if (base < lim * w) { rate = r; S.pasHorsGrille = false; break; }
    }
    S.F43 = base * rate / 100;
    S.pasRegime = "pas";
  }

  /* --- Indemnités (lignes 47-51) --- */
  /* indemnités non soumises : lignes 1-2 = F47/F48 du classeur ; les lignes 3-4
   * (extension web) suivent le modèle de la ligne 48 dans tous les totaux */
  S.FI = i.indemnites.map(p => p.q * p.r);
  S.F47 = S.FI[0]; S.F48 = S.FI[1];
  S.FIextra = (S.FI[2] || 0) + (S.FI[3] || 0);
  S.D49 = (mode === "SIMULATEUR BTP GRAND D") ? i.jours : 0;
  S.D50 = (mode === "SIMULATEUR BTP GRAND D") ? i.jours - 1 : 0;
  S.F50 = S.D50 * i.indemDecoucheRate;
  S.D51 = (mode === "SIMULATEUR INDUSTRIE") ? i.jours : 0;

  /* --- Logement (F92) --- */
  if (cfg.logementMode === "hebdo") {
    S.H12 = i.logementHebdo;
    S.F92 = i.logement ? S.H12 : 0;
  } else {
    S.H12 = i.logementHoraire;                    // € / heure (LOGEMT)
    S.F92 = i.logement ? S.H12 * i.logementHeures : 0;   // classeur : × 43 en dur
  }

  /* --- Participation (F52-F54) --- */
  const partMap = {
    "PARTICIPATION FORFAIT": -25,
    "PARTICIPATION FACTURE": -S.F92,
    "PARTICIPATION ANNULATION GD": -S.F50,
    "PARTICIPATION LIBRE": i.participationLibre
  };
  S.F52 = partMap[i.participationChoice] != null ? partMap[i.participationChoice] : 0;
  S.F53 = (S.F52 === 0) ? -i.redevanceClient : 0;
  S.F54 = i.anRepasConsomme ? -S.F36 : 0;

  /* --- Net attendu (D13, F22) --- */
  S.D13 = netNull ? null : i.netAttendu * S.D31;
  S.F22 = netNull ? 0 : (i.netAttendu * i.heures) + (S.F27 * 0.85);

  /* --- TOTAL NET AVANT REGUL (F89) — sans F49/F51 ---
   * agri SIMULATOR : soustrait aussi F65+F72+F73 et F77 ; caché : F77 seul.
   * tarifaire : aucune de ces soustractions. */
  /* participation hors paie (prélèvement bancaire) : F52 sort de la chaîne du NET
     mais reste dans le coût total F93 (la rentabilité est identique dans les deux modes) */
  S.F89 = S.F42 - S.F43 + S.F45 + S.F46 + S.F47 + S.F48 + S.FIextra + (i.participationHorsPaie ? 0 : S.F52) -
          S.F62 - S.F63 - S.F67 - S.F69 - S.F70 - S.F71 - S.F76 -
          S.F79 - S.F80 - S.F81 + S.F53 + S.F54 + S.F50 + S.F44 -
          (cfg.f77Cross ? S.F77 : 0) -
          (isMain && cfg.netSubT2Main ? (S.F65 + S.F72 + S.F73) : 0);

  /* --- Avances sur salaire (F55/F56) --- */
  S.F55 = netNull ? 0 : Math.max(0, S.D13 - S.F89);
  S.F56 = (!netNull && S.F22 > S.D13 && S.F89 < S.F22) ? S.F22 - S.F89 : 0;

  /* --- F49 / F51 (la feuille principale utilise les avances du caché) ---
   * Mécanisme du classeur : l'avance vers le net attendu est convertie en indemnités
   * « repas GD » (BTP GD, F49 — refacturées au client en O49) ou « transport »
   * (industrie, F51). SUPPRIMÉ par défaut le 20/08/2026 à la demande de l'utilisateur
   * (la participation logement faisait grimper le CA via cette conversion) : les
   * avances sont financées par le CET, rien n'est refacturé. gdAvanceAuto=true
   * (goldens/classeur) rétablit le comportement Excel à l'identique. */
  const av = isMain ? hiddenAvance : { F55: S.F55, F56: S.F56 };
  const maxAv = i.gdAvanceAuto === true ? Math.max(av.F55, av.F56) : 0;
  S.F49 = (maxAv > i.baremeRepasGD * S.D49) ? i.baremeRepasGD * S.D49 : maxAv;
  S.E49 = S.D49 === 0 ? 0 : S.F49 / S.D49;
  S.F51 = (maxAv > S.H18 * S.D51) ? S.H18 * S.D51 : maxAv;

  /* --- F90, F57/F58, F91 ---
   * SIMULATOR!F90 n'inclut PAS F44 (tickets restaurant) alors que F89 l'inclut ;
   * la feuille cachée conserve F44 dans les deux (vrai dans les deux classeurs). */
  S.F90 = S.F89 + S.F51 + S.F49 - (isMain ? S.F44 : 0);
  /* les deux lectures du net, quel que soit le mode de participation :
     F90ApresLog = net une fois le logement payé ; F90HorsLog = net sans la participation */
  S.F90ApresLog = S.F90 + (i.participationHorsPaie ? S.F52 : 0);
  S.F90HorsLog = S.F90 - (i.participationHorsPaie ? 0 : S.F52);
  S.F57 = netNull ? 0 : Math.max(0, S.D13 - S.F90);
  S.F58 = (!netNull && S.F22 > S.D13 && S.F90 < S.F22) ? S.F22 - S.F90 : 0;
  S.F91 = S.F90 + Math.max(S.F57, S.F58);
  S.G55 = (S.F57 >= 0) ? 0 : S.F55;
  S.G56 = (S.F58 >= 0) ? 0 : S.F56;
  S.G57 = (S.F58 > S.F57) ? 0 : S.F57;
  S.G58 = (S.F58 > 0) ? S.F58 : 0;

  /* --- TOTAL NET (F59) & coûts globaux (F93/F94) --- */
  S.F59 = S.F44 + S.F45 + S.F46 + S.F47 + S.F48 + S.FIextra + S.F49 + S.F50 + S.F51 + S.F52 + S.F53 + S.F54;
  S.F93 = S.F42 + S.H88 + S.F45 + S.F46 + S.F47 + S.F48 + S.FIextra + S.F92 + S.F52 +
          S.D85 + S.H85 + S.F53 + S.F54 + S.F51 + S.F49 + S.F50 + S.F44;
  S.F94 = S.F93 + S.G55 + S.G56 + S.G57 + S.G58;

  /* --- Nets par heure (D14/D15) --- */
  S.D14 = S.F89 / S.D31;
  S.D15 = S.F91 / S.D31;

  /* --- FACTURATION (colonnes K-P) --- */
  S.H16 = i.coeff;
  S.H14 = i.thBrut * i.coeff;
  S.L24 = i.heuresFactNormal == null ? Math.min(35, i.heures || 0) : i.heuresFactNormal;
  S.O24 = S.L24 * S.H14;                          P(S, 24);
  S.L25 = i.refactDim ? S.D25 : 0;   S.O25 = S.L25 * S.E25 * i.coeff;  P(S, 25);
  S.L26 = i.refactFerie ? S.D26 : 0; S.O26 = S.L26 * S.E26 * i.coeff;  P(S, 26);
  S.L27 = i.refactNuit ? S.D27 : 0;
  S.O27 = S.L27 * S.E27 * i.coeff;
  S.P27 = S.L27 * S.E27 * i.coeffHDN;
  /* L29 : IFS(D17<44→0 ; D17=L24→0 ; L24>=43→D17-L24 ; L24<43→D17-43) */
  S.L29 = (i.heures < 44) ? 0 : (i.heures === S.L24 ? 0 : (S.L24 >= 43 ? i.heures - S.L24 : i.heures - 43));
  S.L28 = i.annualisation ? 0 : (i.heures > S.L24 ? i.heures - S.L24 - S.L29 : 0);
  S.O28 = S.L28 * S.E28 * i.coeff;  P(S, 28);
  S.O29 = S.L29 * S.E29 * i.coeff;  P(S, 29);
  S.L30 = S.D30;  S.O30 = S.L30 * S.E30 * i.coeff;  P(S, 30);
  S.M34 = i.refactPrimes ? i.coeff : 0;
  S.L34 = S.F34; S.O34 = S.L34 * S.M34; P(S, 34);
  S.L35 = S.F35; S.O35 = S.L35 * S.M34; P(S, 35);
  S.L36 = S.F36; S.O36 = S.L36 * S.M34; P(S, 36);
  /* primes 1-5 : coefficient de facturation par ligne (null/"coef" = M34) */
  const fcPrime = fc => (fc == null || fc === "" || fc === "coef" || isNaN(Number(fc))) ? S.M34 : Number(fc);
  const fcIndem = fc => (fc == null || fc === "" || isNaN(Number(fc))) ? 1 : Number(fc);
  for (let k = 0; k < 5; k++) {
    const r = 37 + k;
    S["L" + r] = S["F" + r];
    S["O" + r] = S["F" + r] * fcPrime(i.primes[k].fc);
    P(S, r);
  }
  S.O45 = S.F45 * 1;              P(S, 45);
  S.O46 = S.F46 * 1;              P(S, 46);
  S.O47 = S.F47 * fcIndem(i.indemnites[0].fc); P(S, 47);
  S.O48 = S.F48 * fcIndem(i.indemnites[1].fc); P(S, 48);
  S.OI3 = (S.FI[2] || 0) * fcIndem(i.indemnites[2] ? i.indemnites[2].fc : 1); S.PI3 = S.OI3;
  S.OI4 = (S.FI[3] || 0) * fcIndem(i.indemnites[3] ? i.indemnites[3].fc : 1); S.PI4 = S.OI4;
  S.O49 = S.F49 * 1;              P(S, 49);
  S.O50 = S.F50 * 1;              P(S, 50);
  if (cfg.o52Mode === "flat") {
    S.L52 = 0;
    S.O52 = isMain ? i.coutLogementFacture : 0;   // agri : M52 € / semaine (caché : 0)
  } else {
    S.L52 = i.logement ? Math.min(i.heures, 35) : 0;   // tarifaire : heures × € / h
    S.O52 = S.L52 * i.coutLogementFacture;
  }
  S.P52 = S.O52;
  S.O54 = i.retraitANRepas ? S.F54 : 0;  P(S, 54);

  const oRows = [24, 25, 26, 27, 28, 29, 30, 34, 35, 36, 37, 38, 39, 40, 41];
  S.O42 = oRows.reduce((s, r) => s + S["O" + r], 0);
  S.P42 = oRows.reduce((s, r) => s + S["P" + r], 0);
  const extra = [45, 46, 47, 48, 49, 50, 52, 54];
  S.O60 = S.O42 + extra.reduce((s, r) => s + S["O" + r], 0) + S.OI3 + S.OI4;
  S.P60 = S.P42 + extra.reduce((s, r) => s + S["P" + r], 0) + S.PI3 + S.PI4;
  S.O58 = S.O60 - S.O52;
  S.P58 = S.P60 - S.P52;
  /* Prestataire externe de recrutement : € HT × heures travaillées, en déduction directe de la marge
     (coût interne agence — n'apparaît jamais dans l'étude de prix client). */
  S.recrutCout = (i.recrutTarifH || 0) * (i.heures || 0);
  S.O61 = S.O60 - S.F93 - S.recrutCout - (S.cetCoutReel || 0);
  S.P61 = S.P60 - S.F93 - S.recrutCout - (S.cetCoutReel || 0);
  S.O62 = i.heures ? S.O60 / i.heures : 0;
  S.P62 = i.heures ? S.P60 / i.heures : 0;
  S.O63 = S.O60 - (S.O42 * i.remisePct / 100);
  S.P63 = S.P60 - (S.P42 * i.remisePct / 100);
  S.O64 = S.O61 - (S.O42 * i.remisePct / 100);
  S.P64 = S.P61 - (i.remisePct * S.P42 / 100);
  if (isMain) {
    S.O65 = S.O60 ? S.F92 / S.O60 : 0;
    S.P65 = S.P60 ? S.F92 / S.P60 : 0;
  } else {
    const g = S.G55 + S.G56 + S.G57 + S.G58;
    S.O65 = S.O64 - g;
    S.P65 = S.P64 - g;
  }
  S.O66 = i.heures ? S.O58 / i.heures : 0;
  S.P66 = i.heures ? S.P58 / i.heures : 0;
  S.H17 = S.O60 ? S.O64 / S.O60 * 100 : 0;
  S.H22 = S.P60 ? S.P64 / S.P60 * 100 : 0;
  return S;
}

function P(S, row) { S["P" + row] = S["O" + row]; }

/* Calcul complet : feuille cachée d'abord, puis feuille principale. */
function compute(i) {
  const cfg = SECTORS[i.sector || "agri"];
  const pre = computeSheet(i, "main", { F55: 0, F56: 0 });
  // littéraux de la feuille cachée : millésime des défauts (ratesBase), pas les éditions utilisateur
  const hiddenRates = Object.assign({}, i.ratesBase || cfg.rates);
  for (const k of cfg.hiddenLinkedRates) hiddenRates[k] = i.rates[k];
  const hidden = computeSheet(Object.assign({}, i, { rates: hiddenRates }), "hidden", null,
                              cfg.f77Cross ? pre.F77 : null);
  const main = computeSheet(i, "main", { F55: hidden.F55, F56: hidden.F56 });
  main.D15 = hidden.F91 / hidden.D31;   // SIMULATOR!D15 = caché D15
  main.E15 = hidden.F89 / hidden.D31;   // SIMULATOR!E15 = caché D14
  // Excel : F15 = E15 − D12 donne #VALEUR! quand D12 = "pas de net attendu" → null ici
  main.F15 = (i.netAttendu == null) ? null : main.E15 - i.netAttendu;
  hidden.I17 = hidden.O60 ? hidden.O65 / hidden.O60 * 100 : 0;
  hidden.I22 = hidden.P60 ? hidden.P65 / hidden.P60 * 100 : 0;
  main.I17 = hidden.I17;
  main.I22 = hidden.I22;
  main.I57 = hidden.G55 + hidden.G56 + hidden.G57 + hidden.G58;
  main.M14 = (cfg.targetCell === "O62" ? main.O62 : main.O66) - i.cibleTauxFact;
  main.M17 = main.H17 - i.cibleMargePct;
  return { main, hidden };
}

/* --- Recherche de coefficient (résolution directe, amélioration vs Excel) --- */
function solveCoeff(i, evalFn, target, lo, hi) {
  lo = lo == null ? 0.01 : lo; hi = hi == null ? 10 : hi;
  const f = c => evalFn(compute(Object.assign({}, i, { coeff: c }))) - target;
  let flo = f(lo), fhi = f(hi);
  if (isNaN(flo) || isNaN(fhi) || flo * fhi > 0) return null;
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2, fm = f(mid);
    if (Math.abs(fm) < 1e-10) return mid;
    if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}
function coeffPourTauxFact(i, tauxCible)  { return solveCoeff(i, r => r.main.O66, tauxCible); }
function coeffPourTauxFactAvecLogement(i, tauxCible) { return solveCoeff(i, r => r.main.O62, tauxCible); }
function coeffPourMarge(i, margeCiblePct) { return solveCoeff(i, r => r.main.H17, margeCiblePct); }
/* cible de taux du secteur : O66 (agri, hors logement) ou O62 (tarifaire, global) */
function coeffPourTauxSecteur(i, tauxCible) {
  return SECTORS[i.sector || "agri"].targetCell === "O62"
    ? coeffPourTauxFactAvecLogement(i, tauxCible) : coeffPourTauxFact(i, tauxCible);
}

if (typeof module !== "undefined") {
  module.exports = { compute, computeSheet, computeTODE, defaultInputs, SECTORS, CONST, RGDU_DEFAULTS, BAKED_OFFICIAL,
                     RATES_2026_AGRI, RATES_2026_TARIFAIRE, TODE_RATES_CLASSEUR, TODE_RATES_2026,
                     PAS_GRILLE_2026, PAS_ABAT_CONTRAT_COURT, RASNR_2026, BAKED_CONTRADICTIONS,
                     RATES_AGRI, RATES_TARIFAIRE,
                     coeffPourTauxFact, coeffPourMarge, coeffPourTauxFactAvecLogement,
                     coeffPourTauxSecteur, solveCoeff };
}
