/* ============================================================================================
   Grille Construction — construction des lignes par le MOTEUR du simulateur (phase 2, v3 du 12/09/2026).
   Module partagé : inliné dans grille-btp.html par build_single.py (après db.js et engine.js),
   chargé tel quel dans node pour les tests. Aucune dépendance au DOM.

   Logique métier (direction, 11/09/2026) :
   - le NET PROMIS d'une ligne est le net horaire VERSÉ : salaire net (IFM + ICCP inclus quand ils sont payés)
     + indemnités non soumises (IGD, repas, transport) − participation logement retenue, divisé par les
     heures payées ; l'indemnité de TRAJET BTP est soumise à cotisations (prime, dans le brut) ;
   - une ligne est LOGÉE (grand déplacement, logement AB Service, participation) seulement si elle porte une IGD ;
   - l'AJUSTEMENT se fait par la PARTICIPATION logement (mode « participation ») ou par l'IGD (mode « igd »),
     calculé automatiquement pour tenir exactement le NET PROMIS de la ligne (de 11 à 16,50 € par pas de 0,50) :
     il dépend du net promis et des heures (35 h, 39 h, 43 h) ; l'OBJECTIF DE MARGE BRUTE sert de contrôle
     (marge obtenue au tarif du niveau, tarif nécessaire pour l'objectif) ;
   - l'offre BTP facture TOUTES les heures au tarif horaire (pas de majoration facturée jusqu'à 43 h) ;
   - le client GRAND COMPTE (IGD réduite de la ligne) se simule comme une grille à part entière ;
   - le taux AT-MP suit l'agence PALMA qui porte la région ; le versement mobilité est une moyenne paramétrable.
   ============================================================================================ */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    const path = require("path"); const dbm = require(path.join(__dirname, "db.js")); if (typeof global.DB === "undefined") global.DB = dbm.DB;
    module.exports = factory(require(path.join(__dirname, "engine.js")), dbm.DB);
  } else root.GrilleMoteur = factory({ compute, defaultInputs, coeffPourMarge, solveCoeff, SECTORS, BAKED_OFFICIAL: (typeof BAKED_OFFICIAL !== "undefined" ? BAKED_OFFICIAL : null) }, DB);
})(typeof self !== "undefined" ? self : this, function (E, DB) {
  "use strict";
  const HEURES = [35, 39, 43];
  const BLOCS = ["etranger_loge", "etranger_non_loge", "fr_loge", "fr_non_loge"];
  const PROFILS = ["Aide métier", "Ouvrier", "Profil supérieur"];
  const LOGE = b => b === "etranger_loge" || b === "fr_loge";
  const ETRANGER = b => String(b).indexOf("etranger") === 0;
  const r2 = v => Math.round(v * 100) / 100;
  const num = (v, d) => (v === "" || v == null || !isFinite(+v)) ? d : +v;
  const q = (n, d) => (n != null && +n > 0) ? +n : d;
  /* DFS BTP : sortie progressive (BOSS frais professionnels) — 9 % 2024, 8 % 2025, 7 % 2026, 6 % 2027 … 1,5 % 2031, 0 ensuite */
  const DFS_BTP = { 2024: 9, 2025: 8, 2026: 7, 2027: 6, 2028: 5, 2029: 4, 2030: 3, 2031: 1.5 };
  const dfsPour = annee => { const a = +annee; if (!a) return 7; if (a < 2024) return 10; if (a > 2031) return 0; return DFS_BTP[a]; };
  const SMIC = (E.BAKED_OFFICIAL && E.BAKED_OFFICIAL.smic && E.BAKED_OFFICIAL.smic.value) || 12.31;
  const REPAS_CHANTIER = (E.BAKED_OFFICIAL && E.BAKED_OFFICIAL.repasHorsLocaux && E.BAKED_OFFICIAL.repasHorsLocaux.value) || 10.40;
  const ZONES_PD = (DB.zonesKmPD || []).filter(z => z.value > 0).map(z => ({ label: z.label, value: +z.value })).sort((a, b) => a.value - b.value);
  /* agences PALMA : taux AT-MP notifié (simulateur, 09/2026) ; région portée par défaut */
  const AGENCES = {
    "PALMA ILE DE FRANCE": { at: 1.25, regions: ["ILE-DE-FRANCE"] },
    "PALMA AQUITAINE": { at: 1.92, regions: ["NOUVELLE-AQUITAINE"] },
    "PALMA RHONE ALPES": { at: 2.00, regions: ["AUVERGNE-RHONE-ALPES"] },
    "PALMA OCCITANIE": { at: 2.78, regions: ["OCCITANIE"] },
    "PALMA NORMANDIE": { at: 2.78, regions: ["NORMANDIE"] },
    "PALMA ALSACE": { at: 1.21, regions: ["GRAND EST", "BOURGOGNE-FRANCHE-COMTE"] },
    "PALMA HAUTS DE FRANCE": { at: 2.20, regions: ["HAUTS-DE-FRANCE"] },
    "PALMA BRETAGNE": { at: 1.25, regions: ["BRETAGNE"] },
    "PALMA ATLANTIQUE": { at: 0.63, regions: ["PAYS DE LA LOIRE"] },
    "PALMA ANJOU": { at: 2.22, regions: ["CENTRE-VAL DE LOIRE"] },
    "PALMA PROVENCE": { at: 2.78, regions: ["PACA", "CORSE"] }
  };
  const AT_DEFAUT = 2.08;
  function agencePour(P, region) {
    if (P.agence && AGENCES[P.agence]) return P.agence;
    for (const a of Object.keys(AGENCES)) if (AGENCES[a].regions.indexOf(region) >= 0) return a;
    return "";
  }
  function atPour(P, region) { if (P.at_pct != null) return P.at_pct; const a = agencePour(P, region); return a ? AGENCES[a].at : AT_DEFAUT; }
  const estLoge = l => LOGE(l.bloc) && ((l.igd != null && +l.igd > 0) || (l.igd_gc != null && +l.igd_gc > 0));

  /* Paramètres de construction (params.construction de la grille ; tout est modifiable par la direction). */
  const PARAMS_DEFAUT = {
    mode: "participation",         // "participation" : indemnités fixées, participation logement ajustée ; "igd" : participation fixée, IGD ajustée
    client: "standard",            // "gc" : simulation grand compte (IGD réduite de la ligne)
    marge_cible: 20,               // objectif de marge brute (%)
    tarifs_profils: { "Aide métier": 31.5, "Ouvrier": 33.5, "Profil supérieur": 35.5 },   // € HT / heure travaillée, tout inclus, par niveau
    tarifs_paliers: [{ netMin: 0, netMax: 12, tarif: 31.5 }, { netMin: 12, netMax: 15, tarif: 33.5 }, { netMin: 15, netMax: 99, tarif: 35.5 }],   // secours si profil inconnu
    majoration_logement: { montant: 2.5, actif: false },   // + € HT / h facturés en secteur majoré (lignes logées)
    logement: 180,                 // coût hebdomadaire du logement AB Service (€ / semaine)
    participation_fixe: null,      // mode igd : participation retenue (€ / semaine) ; null = coût du logement
    igd_max: 42.80,                // plafond d'exonération de l'IGD ajustée (€ / jour) : 2 repas URSSAF 21,40 pour un salarié logé par l'entreprise
    ifm_iccp_direct: true,         // IFM + ICCP payés à chaque paie (dans le net promis) ; false = placés au CET
    effectif: "50plus",
    agence: "",                    // "" = agence PALMA de la région ; sinon nom de l'agence (taux AT)
    at_pct: null,                  // taux AT-MP forcé (%) ; null = celui de l'agence
    vm_pct: 1.35,                  // versement mobilité moyen (%)
    pas_mode: "grille",            // retenue à la source des résidents français : barème BOFiP ("grille") ou formule du classeur 2026 ("classeur")
    dfs_pct: null,                 // DFS BTP (%) ; null = barème de l'année de la grille
    heures: HEURES,                // scénarios horaires : 35 h (base de la grille), 39 h, 43 h
    tolerance_net: 0.10            // € / h : écart admis entre le net atteint et le net promis
  };
  function paramsComplets(P, annee) {
    P = P || {}; const D = PARAMS_DEFAUT; const p = Object.assign({}, D, P);
    p.mode = (P.mode === "igd" || +P.mode === 2) ? "igd" : "participation";
    p.client = P.client === "gc" ? "gc" : "standard";
    p.marge_cible = num(p.marge_cible, D.marge_cible);
    p.tarifs_profils = Object.assign({}, D.tarifs_profils, P.tarifs_profils || {}); for (const k of Object.keys(p.tarifs_profils)) p.tarifs_profils[k] = num(p.tarifs_profils[k], D.tarifs_profils[k] || 0);
    p.tarifs_paliers = (P.tarifs_paliers && P.tarifs_paliers.length ? P.tarifs_paliers : D.tarifs_paliers).map(x => ({ netMin: num(x.netMin, 0), netMax: num(x.netMax, 99), tarif: num(x.tarif, 0) })).filter(x => x.tarif > 0).sort((a, b) => a.netMin - b.netMin);
    if (!p.tarifs_paliers.length) p.tarifs_paliers = D.tarifs_paliers.slice();
    const M = P.majoration_logement || {}; p.majoration_logement = { montant: num(M.montant, 2.5), actif: M.actif === true || M.actif === "1" || (Array.isArray(M.regions) && M.regions.length > 0) };
    p.logement = (P.logement && typeof P.logement === "object") ? num(P.logement.defaut, 180) : num(P.logement, 180);
    p.participation_fixe = (P.participation_fixe === "" || P.participation_fixe == null || !isFinite(+P.participation_fixe) || +P.participation_fixe < 0) ? (P.participation_mode2 != null && isFinite(+P.participation_mode2) && +P.participation_mode2 >= 0 ? +P.participation_mode2 : null) : +P.participation_fixe;
    p.igd_max = num(p.igd_max, D.igd_max);
    p.ifm_iccp_direct = p.ifm_iccp_direct !== false && p.ifm_iccp_direct !== "0" && p.ifm_iccp_direct !== 0;
    p.effectif = ["moins11", "11-19", "20-49", "50plus"].indexOf(p.effectif) >= 0 ? p.effectif : "50plus";
    p.agence = (P.agence && AGENCES[P.agence]) ? P.agence : "";
    p.at_pct = (P.at_pct === "" || P.at_pct == null || !isFinite(+P.at_pct)) ? ((P.at && typeof P.at === "object" && isFinite(+P.at.defaut) && +P.at.defaut !== AT_DEFAUT) ? +P.at.defaut : null) : +P.at_pct;
    p.vm_pct = (P.vm && typeof P.vm === "object") ? num(P.vm.defaut, 1.35) : num(P.vm_pct, 1.35);
    p.pas_mode = p.pas_mode === "classeur" ? "classeur" : "grille";
    p.dfs_pct = (P.dfs_pct === "" || P.dfs_pct == null || !isFinite(+P.dfs_pct)) ? dfsPour(annee) : Math.max(0, +P.dfs_pct);
    p.heures = (Array.isArray(P.heures) && P.heures.length ? P.heures : HEURES).map(Number).filter(h => h >= 35 && h <= 48); if (!p.heures.length) p.heures = HEURES.slice();
    if (p.heures.indexOf(35) < 0) p.heures.unshift(35); p.heures = [...new Set(p.heures)].sort((a, b) => a - b);
    p.tolerance_net = Math.max(0, num(p.tolerance_net, D.tolerance_net));
    return p;
  }
  function palierPour(P, net) { let x = null; for (const y of P.tarifs_paliers) if (net >= y.netMin) x = y; return x || P.tarifs_paliers[0]; }
  function tarifPour(P, l) {
    let t = P.tarifs_profils[l.profil]; if (!(t > 0)) t = palierPour(P, +l.net).tarif;
    if (estLoge(l) && P.majoration_logement.actif && P.majoration_logement.montant > 0) t += P.majoration_logement.montant;
    return r2(t);
  }
  const igdDe = (P, l) => (P.client === "gc" && l.igd_gc != null && +l.igd_gc > 0) ? +l.igd_gc : (l.igd != null ? +l.igd : 0);
  function indemnitesTexte(P, l) {
    const p = []; const f = v => (+v).toFixed(2).replace(".", ",");
    const igd = igdDe(P, l);
    if (igd > 0) p.push("IGD " + f(igd) + " × " + q(l.igd_nb, 5) + (P.client === "gc" && l.igd_gc > 0 ? " (grand compte)" : (l.igd_gc > 0 ? " · grand compte " + f(l.igd_gc) : "")));
    if (l.repas_midi > 0) p.push("repas midi " + f(l.repas_midi) + " × " + q(l.repas_midi_nb, 5));
    if (l.repas_soir > 0) p.push("repas soir " + f(l.repas_soir) + " × " + q(l.repas_soir_nb, 5));
    if (l.transport > 0) p.push("transport " + f(l.transport) + " × " + q(l.transport_nb, 5));
    if (l.trajet > 0) p.push("trajet " + f(l.trajet) + " × " + q(l.trajet_nb, 5) + " (soumis)");
    return p.length ? p.join(" · ") : "aucune";
  }
  /* 4 lignes d'indemnités NON SOUMISES : IGD, repas midi, repas soir, transport (fc 0 = non refacturées, tarif tout inclus) */
  function indemnitesDe(l, igd, igdNb) {
    return [
      { q: igd > 0 ? (igdNb || q(l.igd_nb, 5)) : 0, r: igd > 0 ? igd : 0, name: "IGD", fc: 0 },
      { q: l.repas_midi > 0 ? q(l.repas_midi_nb, 5) : 0, r: l.repas_midi > 0 ? +l.repas_midi : 0, name: "Repas midi", fc: 0 },
      { q: l.repas_soir > 0 ? q(l.repas_soir_nb, 5) : 0, r: l.repas_soir > 0 ? +l.repas_soir : 0, name: "Repas soir", fc: 0 },
      { q: l.transport > 0 ? q(l.transport_nb, 5) : 0, r: l.transport > 0 ? +l.transport : 0, name: "Transport", fc: 0 }
    ];
  }
  /* l'indemnité de TRAJET BTP est SOUMISE : prime (dans le brut), non refacturée */
  function primesDe(base, l) { const p = base.primes.map(x => Object.assign({}, x, { q: 0, r: 0 })); if (l.trajet > 0) p[0] = { q: q(l.trajet_nb, 5), r: +l.trajet, name: "Trajet", fc: 0 }; return p; }
  /* Entrées du moteur pour une ligne, un nombre d'heures et des valeurs de levier. */
  function entrees(P, l, heures, opts) {
    opts = opts || {}; const base = E.defaultInputs(DB, "tarifaire");
    const loge = estLoge(l), etr = ETRANGER(l.bloc); const brut = +l.brut;
    const tarif = opts.tarif || tarifPour(P, l);
    const igd = opts.igd != null ? +opts.igd : igdDe(P, l);
    const la = Object.assign({}, l); ["repas_midi", "repas_midi_nb", "repas_soir", "repas_soir_nb", "transport", "transport_nb"].forEach(k => { if (opts[k] !== undefined) la[k] = opts[k]; });
    return Object.assign({}, base, {
      mode: loge ? "SIMULATEUR BTP GRAND D" : "SIMULATEUR BTP PETIT D", branche: "btp", client: "Grille " + l.region,
      thBrut: brut, netAttendu: null, heures: +heures, jours: 5, attestation: etr,
      ifm: P.ifm_iccp_direct, iccp: P.ifm_iccp_direct, pasMode: P.pas_mode, dfsFactor: 1 - P.dfs_pct / 100,
      heuresFactNormal: +heures,                        // offre BTP : toutes les heures facturées au tarif jusqu'à 43 h
      logement: true, logementHeures: 43, logementHoraire: (loge ? P.logement : 0) / 43, coutLogementFacture: 0,
      coeff: tarif / brut, effectif: P.effectif, vmPct: P.vm_pct,
      indemnites: indemnitesDe(la, igd, opts.igd_nb), primes: primesDe(base, l), participationLibre: -(opts.participation > 0 ? +opts.participation : 0),
      rates: Object.assign({}, base.rates, { atPat: atPour(P, l.region) })
    });
  }
  const calc = i => E.compute(i).main;
  const netH = r => r.D31 ? r.F90 / r.D31 : 0;
  const mesure = r => ({ net: r2(netH(r)), marge_pct: r2(r.H17), ca: r2(r.O60), cout: r2(r.O60 - r.O64), net_semaine: r2(r.F90), pas: r2(r.F43 || 0) });
  /* Levier linéaire : le net de la semaine est affine en x (x = participation retenue, ou x = IGD par jour) ; le CA n'en dépend pas.
     Deux évaluations donnent la pente ; le levier qui tient le NET PROMIS (net × heures) est recalculé au point retenu,
     puis une itération de sécurité corrige toute non-linéarité résiduelle. Le tarif nécessaire pour l'objectif de marge est calculé à ce point. */
  function levier(P, l, h, mode, participationFixe, nb) {
    const at = x => mode === "igd" ? { participation: participationFixe, igd: x, igd_nb: nb } : { participation: x };
    const x1 = mode === "igd" ? 10 : 100;
    const r0 = calc(entrees(P, l, h, at(0))), r1 = calc(entrees(P, l, h, at(x1)));
    const n0 = r0.F90, pn = (r1.F90 - n0) / x1;
    const xMax = mode === "igd" ? P.igd_max : Infinity;
    const borne = x => Math.max(0, Math.min(xMax, x));
    let xN = pn !== 0 ? (l.net * h - n0) / pn : 0; let xn = borne(xN); let opts = at(xn); let rn = calc(entrees(P, l, h, opts));
    for (let k = 0; k < 3 && xn === xN && Math.abs(rn.F90 - l.net * h) > 0.01; k++) { xN = xn + (l.net * h - rn.F90) / pn; xn = borne(xN); opts = at(xn); rn = calc(entrees(P, l, h, opts)); }
    const reduit = {};
    if (mode === "igd" && xN < -1e-9) {
      /* IGD déjà à zéro et net encore au-dessus du promis : on réduit les repas (soir puis midi), jamais de net au-dessus du net promis */
      for (const k of ["repas_soir", "repas_midi"]) {
        const exces = rn.F90 - l.net * h; if (exces <= 0.01) break;
        const nbk = q(l[k + "_nb"], 5), v = l[k] > 0 ? +l[k] : 0; if (!(v > 0)) continue;
        const nv = Math.max(0, r2(v - exces / nbk)); opts = Object.assign({}, opts, { [k]: nv, [k + "_nb"]: nbk }); reduit[k] = nv; rn = calc(entrees(P, l, h, opts));
      }
    }
    const m = mesure(rn);
    return Object.assign({ heures: h, levier: r2(xn), plafonne: xN > xMax + 1e-9, nul: xN < -1e-9, reduit, ecart: r2(m.net - l.net), tarif_marge_cible: tarifPourMarge(entrees(P, l, h, opts), P.marge_cible, +l.brut) }, m);
  }
  /* Ligne NON LOGÉE : les indemnités sont le levier — panier de chantier (≤ plafond URSSAF) puis transport petit déplacement par tranche
     kilométrique, dimensionnés pour tenir le net promis SANS JAMAIS le dépasser ; le reste (déficit) est signalé. */
  function ajusterNonLoge(P, l, h) {
    const nb = 5; const r0 = calc(entrees(P, l, h, { repas_midi: 0, repas_midi_nb: nb, transport: 0, transport_nb: nb }));
    const besoin = l.net * h - r0.F90;                                   // € / semaine à apporter par les indemnités
    let repas = 0, transport = 0, trop = false, deficit = 0;
    if (besoin > 0.005) {
      const rr = calc(entrees(P, l, h, { repas_midi: 1, repas_midi_nb: nb, transport: 0, transport_nb: nb })); const pente = (rr.F90 - r0.F90) / nb;   // net apporté par 1 € / jour d'indemnité (non soumise : ≈ 1)
      const parJour = besoin / nb / (pente || 1);
      repas = r2(Math.min(REPAS_CHANTIER, parJour));
      const resteJour = parJour - repas;
      if (resteJour > 0.005) { const z = ZONES_PD.filter(z => z.value <= resteJour + 1e-9).pop(); transport = z ? z.value : 0; }
    } else trop = true;
    const rn = calc(entrees(P, l, h, { repas_midi: repas, repas_midi_nb: nb, transport, transport_nb: nb })); const m = mesure(rn);
    deficit = r2(Math.max(0, l.net * h - rn.F90));
    return Object.assign({ heures: h, repas_midi: repas, repas_midi_nb: nb, transport, transport_nb: nb, trop, deficit, ecart: r2(m.net - l.net), tarif_marge_cible: tarifPourMarge(entrees(P, l, h, { repas_midi: repas, repas_midi_nb: nb, transport, transport_nb: nb }), P.marge_cible, +l.brut) }, m);
  }
  /* Ligne non logée sous le net promis : indemnités exonérées aux plafonds URSSAF (panier de chantier, puis transport par tranche km), par jour et par semaine de 5 jours. */
  function proposer(P, l, h) {
    const nb = 5; const prop = { lignes: [] }; let lp = Object.assign({}, l);
    if (!(lp.repas_midi > 0)) { lp.repas_midi = REPAS_CHANTIER; lp.repas_midi_nb = nb; prop.lignes.push({ libelle: "panier de chantier (plafond URSSAF repas hors locaux)", jour: REPAS_CHANTIER, nb, semaine: r2(REPAS_CHANTIER * nb) }); }
    let r = calc(entrees(P, lp, h));
    if (netH(r) < l.net - P.tolerance_net) {
      const cur = lp.transport > 0 ? +lp.transport : 0; let choisi = null;
      for (const z of ZONES_PD) { if (z.value <= cur) continue; const lt = Object.assign({}, lp, { transport: z.value, transport_nb: nb }); const rt = calc(entrees(P, lt, h)); choisi = { z, lt, rt }; if (netH(rt) >= l.net - P.tolerance_net) break; }
      if (choisi) { lp = choisi.lt; r = choisi.rt; prop.lignes.push({ libelle: "transport petit déplacement " + choisi.z.label + (cur > 0 ? " (au lieu de " + cur.toFixed(2) + " €)" : ""), jour: choisi.z.value, nb, semaine: r2(choisi.z.value * nb) }); }
    }
    if (!prop.lignes.length) return null;
    prop.net = r2(netH(r)); prop.marge_pct = r2(r.H17); prop.atteint = prop.net >= l.net - P.tolerance_net;
    prop.texte = "Proposition aux plafonds URSSAF : " + prop.lignes.map(x => x.libelle + " " + x.jour.toFixed(2) + " € × " + x.nb + " j = " + x.semaine.toFixed(2) + " € / semaine").join(" + ") + " → net " + prop.net.toFixed(2) + " € / h" + (prop.atteint ? "" : " (encore insuffisant)") + ", marge " + prop.marge_pct.toFixed(1) + " %";
    return prop;
  }
  function tarifPourMarge(i, margePct, brut) {
    if (!(margePct < 100)) return null;
    const a = calc(Object.assign({}, i, { coeff: 1 })), b = calc(Object.assign({}, i, { coeff: 2 })); const pente = b.O60 - a.O60; if (!(pente > 0)) return null;
    const v = (1 + ((a.O60 - a.O64) / (1 - margePct / 100) - a.O60) / pente) * brut; return isFinite(v) && v > 0 ? r2(v) : null;
  }
  const al = (res, type, texte, niveau) => res.alertes.push({ type, texte, niveau: niveau || "alerte" });
  const eur = v => (+v).toFixed(2).replace(".", ",");
  /* Construction d'une ligne : scénarios horaires avec, pour les lignes logées, le levier ajusté pour l'objectif de marge et le levier qui tient le net promis. */
  function construireLigne(P0, l, minima, annee) {
    const P = paramsComplets(P0, annee); const loge = estLoge(l); const brut = +l.brut; const nb = q(l.igd_nb, l.bloc === "fr_loge" ? 4 : 5);
    const res = { region: l.region, bloc: l.bloc, profil: l.profil, net: +l.net, brut, coefficient: l.coefficient, loge, mode: loge ? P.mode : "verif", client: P.client,
                  tarif: tarifPour(P, l), agence: agencePour(P, l.region), at_pct: atPour(P, l.region), logement: loge ? P.logement : 0, igd_ligne: loge ? igdDe(P, l) : null, igd_nb: loge ? nb : null,
                  indemnites: indemnitesTexte(P, l), participation_fixe: (loge && P.mode === "igd") ? (P.participation_fixe != null ? P.participation_fixe : P.logement) : null,
                  alertes: [], scenarios: [] };
    if (!(brut > 0) || !(l.net > 0)) { al(res, "donnees", "brut ou net manquant : ligne non calculée"); return res; }
    if (brut < SMIC - 0.001) al(res, "smic", "brut " + eur(brut) + " < SMIC " + eur(SMIC));
    if (!(P.tarifs_profils[l.profil] > 0)) al(res, "tarif", "profil « " + l.profil + " » sans tarif : palier de net de secours (" + eur(res.tarif) + " € / h)", "info");
    if (LOGE(l.bloc) && !loge) al(res, "info", "ligne sans IGD dans un bloc logé : traitée comme non logée (pas de logement, pas de participation)", "info");
    if (minima && l.coefficient) { const m = ((minima[l.region] || {}).taux || {})[l.coefficient]; if (m != null && brut < m - 0.001) al(res, "minima", "brut " + eur(brut) + " < minimum conventionnel du niveau " + l.coefficient + " (" + eur(m) + ")"); }
    if (loge) {
      for (const h of P.heures) res.scenarios.push(levier(P, l, h, P.mode, res.participation_fixe, nb));
      const s35 = res.scenarios.find(s => s.heures === 35) || res.scenarios[0];
      res.retenu = { participation: P.mode === "igd" ? res.participation_fixe : s35.levier, igd: P.mode === "igd" ? s35.levier : res.igd_ligne, igd_nb: nb, net: s35.net, marge_pct: s35.marge_pct, base: "net" };
      res.net_atteint = s35.net; res.ecart = s35.ecart; res.marge_pct = s35.marge_pct; res.ca = s35.ca; res.tarif_marge_cible = s35.tarif_marge_cible;
      const lib = P.mode === "igd" ? "IGD" : "participation", unite = P.mode === "igd" ? " € / jour" : " € / semaine";
      if (s35.plafonne) al(res, "igd", "net promis inatteignable sous le plafond d'IGD " + eur(P.igd_max) + " € / jour : net " + eur(s35.net) + " au lieu de " + eur(res.net));
      else if (s35.nul && P.mode === "igd") { const rd = Object.keys(s35.reduit || {}); if (rd.length) al(res, "net", "IGD à zéro : repas réduits pour ne pas dépasser le net promis (" + rd.map(k => (k === "repas_soir" ? "repas soir " : "repas midi ") + eur(s35.reduit[k]) + " €").join(", ") + ")", "info"); if (s35.ecart > P.tolerance_net) al(res, "net", "net " + eur(s35.net) + " > net promis même sans IGD ni repas : brut trop élevé pour ce net promis"); }
      else if (s35.nul) al(res, "net", "net " + eur(s35.net) + " > net promis même sans participation : brut ou indemnités trop élevés pour ce net promis");
      if (s35.marge_pct < P.marge_cible - 0.05) al(res, "marge", "marge " + s35.marge_pct.toFixed(1) + " % < objectif " + P.marge_cible + " % avec " + lib + " " + eur(s35.levier) + unite + " (tarif nécessaire " + (s35.tarif_marge_cible != null ? eur(s35.tarif_marge_cible) + " € / h" : "—") + ")");
      if (P.mode === "participation" && s35.levier > P.logement + 0.005) al(res, "participation", "participation " + eur(s35.levier) + " € > coût du logement " + eur(P.logement) + " €", "info");
    } else {
      for (const h of P.heures) res.scenarios.push(ajusterNonLoge(P, l, h));
      const s35 = res.scenarios.find(s => s.heures === 35) || res.scenarios[0];
      res.net_atteint = s35.net; res.ecart = s35.ecart; res.marge_pct = s35.marge_pct; res.ca = s35.ca; res.tarif_marge_cible = s35.tarif_marge_cible;
      res.retenu = { participation: null, igd: null, repas_midi: s35.repas_midi, repas_midi_nb: s35.repas_midi_nb, transport: s35.transport, transport_nb: s35.transport_nb, net: s35.net, marge_pct: s35.marge_pct, base: "indemnites" };
      const ind = "panier " + eur(s35.repas_midi) + " € × 5" + (s35.transport > 0 ? " + transport " + eur(s35.transport) + " € × 5" : "");
      if (s35.trop) al(res, "net", "net " + eur(s35.net) + " > net promis même sans aucune indemnité : brut trop élevé pour ce net promis (minimum conventionnel)");
      else if (s35.deficit > 0.5) al(res, "net", "indemnités au maximum (" + ind + ") : il manque encore " + eur(s35.deficit) + " € / semaine pour le net promis");
      else if (Math.abs(s35.ecart) > 0.005) al(res, "info", "indemnités ajustées sur le net promis : " + ind + " (tranche de transport inférieure au besoin, écart " + eur(s35.ecart) + " € / h)", "info");
      if (s35.marge_pct < P.marge_cible - 0.05) al(res, "marge", "marge " + s35.marge_pct.toFixed(1) + " % < objectif " + P.marge_cible + " % (tarif nécessaire " + (s35.tarif_marge_cible != null ? eur(s35.tarif_marge_cible) + " € / h" : "—") + ")");
    }
    return res;
  }
  function construire(P, lignes, minima, annee, onLigne) { const out = []; for (let k = 0; k < lignes.length; k++) { const res = construireLigne(P, lignes[k], minima, annee); out.push(res); if (onLigne) onLigne(res, k, lignes.length); } return out; }
  function hypotheses(P) { P = paramsComplets(P); return { mode: P.mode, client: P.client, marge_cible: P.marge_cible, ifm_iccp_direct: P.ifm_iccp_direct, effectif: P.effectif, agence: P.agence, at_pct: P.at_pct, vm_pct: P.vm_pct, pas_mode: P.pas_mode, dfs_pct: P.dfs_pct, igd_max: P.igd_max, tarifs_profils: P.tarifs_profils, majoration_logement: P.majoration_logement, logement: P.logement, participation_fixe: P.participation_fixe, heures: P.heures }; }
  /* Champs repris dans une ligne de grille en brouillon (null = ligne non reprise : données manquantes ou simulation grand compte). */
  function versLigne(res, P) {
    if (res.alertes.some(a => a.type === "donnees") || res.client === "gc") return null;
    const loge = !!res.loge; const r = res.retenu || {};
    const s35 = res.scenarios.find(s => s.heures === 35) || res.scenarios[0] || {}; const rd = s35.reduit || {};
    return { participation: loge ? r.participation : null, marge_pct: r.marge_pct,
             igd: (loge && res.mode === "igd" && r.igd != null) ? r.igd : undefined, igd_nb: (loge && res.mode === "igd" && r.igd_nb != null) ? r.igd_nb : undefined,
             repas_midi: !loge ? r.repas_midi : (rd.repas_midi !== undefined ? rd.repas_midi : undefined), repas_midi_nb: !loge ? r.repas_midi_nb : undefined,
             transport: !loge ? r.transport : undefined, transport_nb: !loge ? r.transport_nb : undefined, repas_soir: rd.repas_soir !== undefined ? rd.repas_soir : undefined,
             calcul: { mode: res.mode, loge, client: res.client, tarif: res.tarif, agence: res.agence, at_pct: res.at_pct, logement: res.logement, retenu: r, net_atteint: res.net_atteint, ecart: res.ecart, tarif_marge_cible: res.tarif_marge_cible,
                       scenarios: res.scenarios, alertes: res.alertes, proposition: res.proposition || null, hypotheses: P ? hypotheses(P) : null } };
  }
  return { HEURES, BLOCS, PROFILS, LOGE, ETRANGER, estLoge, AGENCES, AT_DEFAUT, agencePour, atPour, PARAMS_DEFAUT, DFS_BTP, dfsPour, SMIC, REPAS_CHANTIER, ZONES_PD,
           paramsComplets, palierPour, tarifPour, indemnitesTexte, indemnitesDe, primesDe, entrees, levier, ajusterNonLoge, proposer, tarifPourMarge, construireLigne, construire, versLigne, hypotheses };
});
