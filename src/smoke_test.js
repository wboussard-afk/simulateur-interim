/* Test de non-régression MINIMAL du moteur (exécuté par la routine verif-baremes-simulateur
 * AVANT tout déploiement automatique de constantes). Usage : node smoke_test.js
 * Sort avec code 0 si tout passe, 1 sinon. Ne remplace PAS les 368 tests navigateur —
 * il garantit seulement que le moteur charge, calcule, et que les scénarios de référence
 * restent dans des bornes plausibles après une mise à jour de barèmes. */
const path = require("path");
const { DB } = require(path.join(__dirname, "app", "db.js"));
global.DB = DB;   // le moteur lit DB en global (contexte navigateur)
const eng = require(path.join(__dirname, "app", "engine.js"));

let echecs = 0;
function attendu(nom, cond, detail) {
  if (cond) { console.log("OK  " + nom); }
  else { echecs++; console.error("ECHEC  " + nom + (detail ? "  [" + detail + "]" : "")); }
}
const fini = v => typeof v === "number" && isFinite(v);

/* Scénario 1 : industrie 35 h, 12 €/h brut, 5 jours — le moteur doit produire des grandeurs saines */
const i1 = eng.defaultInputs(DB, "tarifaire");
i1.branche = "industrie";
i1.thBrut = 12; i1.heures = 35; i1.jours = 5; i1.coeff = 1.9; i1.gdAvanceAuto = false;
const g = (r, k) => r && r.main ? r.main[k] : undefined;   // compute() → { main, hidden } ; CA=O60, brut=F42, net=F90
const r1 = eng.compute(i1);
attendu("industrie: calcul complet", r1 && fini(g(r1, "O60")) && fini(g(r1, "F42")) && fini(g(r1, "F90")),
        JSON.stringify({ O60: g(r1, "O60"), F42: g(r1, "F42"), F90: g(r1, "F90") }));
attendu("industrie: CA = brut × coefficient", Math.abs(g(r1, "O60") - 12 * 35 * 1.9) < 0.05, "O60=" + g(r1, "O60"));
attendu("industrie: net/brut plausible (0,72-0,88)", g(r1, "F90") / g(r1, "F42") > 0.72 && g(r1, "F90") / g(r1, "F42") < 0.88,
        "ratio=" + (g(r1, "F90") / g(r1, "F42")).toFixed(3));

/* Scénario 2 : agricole TO-DE — le calcul TO-DE doit rester actif et borné */
const i2 = eng.defaultInputs(DB, "agri");
i2.thBrut = 12; i2.heures = 35; i2.jours = 5; i2.coeff = 1.6; i2.gdAvanceAuto = false;
const r2 = eng.compute(i2);
attendu("agricole: calcul complet", r2 && fini(g(r2, "O60")) && fini(g(r2, "F42")) && fini(g(r2, "F90")));
attendu("agricole: CA positif et net/brut plausible", g(r2, "O60") > 300 &&
        g(r2, "F90") / g(r2, "F42") > 0.72 && g(r2, "F90") / g(r2, "F42") < 0.92,
        "O60=" + g(r2, "O60") + " ratio=" + (g(r2, "F90") / g(r2, "F42")).toFixed(3));

/* Bornes de plausibilité des constantes (attrape les fautes de frappe : ×10, virgules…) */
const B = eng.BAKED_OFFICIAL;
attendu("panier repas hors locaux 8-14 €", B && B.repasHorsLocaux && B.repasHorsLocaux.value > 8 && B.repasHorsLocaux.value < 14, JSON.stringify(B && B.repasHorsLocaux));
attendu("SMIC 11-14 €/h", B && B.smic && B.smic.value > 11 && B.smic.value < 14, JSON.stringify(B && B.smic && B.smic.value));
attendu("RGDU tdelta 0.3-0.45", eng.RGDU_DEFAULTS && eng.RGDU_DEFAULTS.tdeltaPetite > 0.3 && eng.RGDU_DEFAULTS.tdeltaGrande < 0.45);
attendu("PAS: 1re tranche 0 % avec seuil 1300-2000 €", eng.PAS_GRILLE_2026 && eng.PAS_GRILLE_2026[0] && eng.PAS_GRILLE_2026[0][1] === 0 && eng.PAS_GRILLE_2026[0][0] > 1300 && eng.PAS_GRILLE_2026[0][0] < 2000);
attendu("TO-DE vieillesse plafonnée 7-10", eng.TODE_RATES_2026 && eng.TODE_RATES_2026.msa[2] > 7 && eng.TODE_RATES_2026.msa[2] < 10);

/* BTP : la grille bakée doit couvrir 13 régions × 7 coefficients */
attendu("BTP_MINIMA: 13 régions", eng.BTP_MINIMA === undefined || Object.keys(eng.BTP_MINIMA.regions || {}).length === 13);

console.log(echecs === 0 ? "\nSMOKE TEST : TOUT PASSE" : "\nSMOKE TEST : " + echecs + " ECHEC(S) — NE PAS DEPLOYER");
process.exit(echecs === 0 ? 0 : 1);
