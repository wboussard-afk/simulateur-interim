/* ============================================================================================
   Grille Construction — construction des lignes par le MOTEUR du simulateur (phase 2).
   Module partagé : inliné dans grille-btp.html par build_single.py (après db.js et engine.js),
   chargé tel quel dans node pour les tests. Aucune dépendance au DOM.

   Logique métier (rétro-ingénierie du classeur 2026 vérifiée le 11/09/2026 avec le moteur) :
   - le NET CIBLE d'une ligne est le net horaire VERSÉ : salaire net (IFM + ICCP en paiement direct)
     + indemnités non soumises (IGD, repas, transport) − participation logement retenue, divisé par
     les heures payées ; l'indemnité de TRAJET BTP est soumise à cotisations (prime, dans le brut) ;
   - blocs NON LOGÉS : pas de participation ; le net dépend du brut, du coefficient et des indemnités ;
   - blocs LOGÉS : le brut reste au minimum du niveau, la PARTICIPATION LOGEMENT est l'outil de
     régulation (mode 1 : indemnités fixées → participation résolue) ; en mode 2 la participation est
     fixée (coût du logement par défaut) et c'est l'IGD qui est résolue, sous plafond d'exonération ;
   - les nets des résidents français du classeur 2026 embarquent la retenue à la source « classeur »
     (formule linéaire 12 %) : le paramètre pas_mode permet de la reproduire ou d'appliquer le barème BOFiP ;
     les nets des résidents étrangers sont reproduits à ±0,3 €/h quel que soit le réglage ;
   - la marge brute est celle du moteur (CA facturé au tarif de la grille de facturation − coût complet).
   ============================================================================================ */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    const path = require("path"); const dbm = require(path.join(__dirname, "db.js")); if (typeof global.DB === "undefined") global.DB = dbm.DB;
    module.exports = factory(require(path.join(__dirname, "engine.js")), dbm.DB);
  } else root.GrilleMoteur = factory({ compute, defaultInputs, coeffPourMarge, solveCoeff, SECTORS, BAKED_OFFICIAL: (typeof BAKED_OFFICIAL !== "undefined" ? BAKED_OFFICIAL : null) }, DB);
})(typeof self !== "undefined" ? self : this, function (E, DB) {
  "use strict";
  const HEURES = [35, 36, 37, 38, 39, 40, 41, 42, 43];
  const BLOCS = ["etranger_loge", "etranger_non_loge", "fr_loge", "fr_non_loge"];
  const LOGE = b => b === "etranger_loge" || b === "fr_loge";
  const ETRANGER = b => String(b).indexOf("etranger") === 0;
  const r2 = v => Math.round(v * 100) / 100;
  const num = (v, d) => (v === "" || v == null || !isFinite(+v)) ? d : +v;
  /* DFS BTP (déduction forfaitaire spécifique) : sortie progressive — BOSS frais professionnels (9 % en 2024, −1 pt par an, 1,5 % en 2031, 0 ensuite) */
  const DFS_BTP = { 2024: 9, 2025: 8, 2026: 7, 2027: 6, 2028: 5, 2029: 4, 2030: 3, 2031: 1.5 };
  const dfsPour = annee => { const a = +annee; if (!a) return 7; if (a < 2024) return 10; if (a > 2031) return 0; return DFS_BTP[a]; };
  const SMIC = (E.BAKED_OFFICIAL && E.BAKED_OFFICIAL.smic && E.BAKED_OFFICIAL.smic.value) || 12.31;

  /* Paramètres de construction (stockés dans params.construction de la grille ; tout est modifiable par la direction). */
  const PARAMS_DEFAUT = {
    mode: 1,                                   // 1 = indemnités fixées → participation résolue ; 2 = participation fixée → IGD résolue
    marge_cible: 20,                           // % de marge brute visé (= params.marge_cible de la grille)
    /* grille de facturation BTP (offre « taux horaire tout inclus », version 11-2025) : tarif par palier de net promis.
       hors_grille = extension au-delà de la grille (nets < 12 ou > 16 : quotation direction) */
    tarifs_paliers: [
      { netMin: 0, netMax: 12, tarif: 31.5, libelle: "Sous la grille (extension du palier Ouvrier BTP)", hors_grille: true },
      { netMin: 12, netMax: 14.5, tarif: 31.5, libelle: "Ouvrier BTP" },
      { netMin: 14.5, netMax: 16, tarif: 33.5, libelle: "Profil supérieur" },
      { netMin: 16, netMax: 99, tarif: 35.5, libelle: "Au-delà de 16 € (palier catégorie 2 métiers industriels)", hors_grille: true }
    ],
    majoration_logement: { montant: 2.5, regions: [] },   // + € HT / h facturés quand l'intérimaire est logé sur un secteur majoré (régions cochées)
    logement: { defaut: 180, regions: {} },    // coût hebdomadaire du logement AB Service (€ / semaine), par région
    participation_mode2: null,                 // € / semaine retenus en mode 2 (null = coût du logement de la région)
    igd_max: 42.80,                            // plafond d'exonération de l'IGD résolue (€ / jour) : 2 repas URSSAF 21,40 pour un salarié logé par l'entreprise
    ifm_iccp_direct: true,                     // IFM + ICCP payés chaque paie (le classeur raisonne ainsi) ; false = mise en CET
    effectif: "50plus",                        // bande d'effectif de l'ETT (intérimaires comptés — BOSS)
    at: { defaut: 2.08, regions: {} },         // taux AT-MP patronal (%) : moyenne nationale 2026 ; taux notifié par agence PALMA (0,63 à 2,78)
    vm: { defaut: 1.35, regions: {} },         // versement mobilité (%) : moyenne France pondérée ; par région si renseigné (IDF ≈ 3,20)
    pas_mode: "grille",                        // retenue à la source des résidents français : "grille" = barème BOFiP taux neutre (droit) ; "classeur" = formule linéaire du classeur 2026
    dfs_pct: null,                             // DFS BTP en % (null = barème de l'année de la grille : 7 % en 2026)
    hs_facturees_majorees: true,               // scénarios > 35 h : heures sup facturées majorées (moteur) ; false = toutes les heures au tarif (grille « par heure travaillée »)
    heures: HEURES,                            // scénarios horaires comparés
    tolerance_net: 0.10,                       // € / h : déficit de net admis (alerte au-delà)
    tolerance_exces: 0.60                      // € / h : excédent de net signalé en information au-delà
  };
  function paramsComplets(P, annee) {
    P = P || {}; const D = PARAMS_DEFAUT; const p = Object.assign({}, D, P);
    p.mode = +p.mode === 2 ? 2 : 1;
    p.marge_cible = num(p.marge_cible, D.marge_cible);
    p.tarifs_paliers = (P.tarifs_paliers && P.tarifs_paliers.length ? P.tarifs_paliers : D.tarifs_paliers)
      .map(x => ({ netMin: num(x.netMin, 0), netMax: num(x.netMax, 99), tarif: num(x.tarif, 0), libelle: x.libelle || "", hors_grille: !!x.hors_grille }))
      .filter(x => x.tarif > 0).sort((a, b) => a.netMin - b.netMin);
    if (!p.tarifs_paliers.length) p.tarifs_paliers = D.tarifs_paliers.slice();
    p.majoration_logement = Object.assign({ montant: 2.5, regions: [] }, P.majoration_logement || {}); p.majoration_logement.montant = num(p.majoration_logement.montant, 0); p.majoration_logement.regions = Array.isArray(p.majoration_logement.regions) ? p.majoration_logement.regions : [];
    p.logement = Object.assign({ defaut: 180, regions: {} }, P.logement || {}); p.logement.defaut = num(p.logement.defaut, 180); p.logement.regions = p.logement.regions || {};
    p.at = Object.assign({ defaut: 2.08, regions: {} }, P.at || {}); p.at.defaut = num(p.at.defaut, 2.08); p.at.regions = p.at.regions || {};
    p.vm = Object.assign({ defaut: 1.35, regions: {} }, P.vm || {}); p.vm.defaut = num(p.vm.defaut, 1.35); p.vm.regions = p.vm.regions || {};
    if (P.at_pct != null && P.at == null) p.at.defaut = num(P.at_pct, p.at.defaut);     // anciens paramètres scalaires
    if (P.vm_pct != null && P.vm == null) p.vm.defaut = num(P.vm_pct, p.vm.defaut);
    p.participation_mode2 = (P.participation_mode2 === "" || P.participation_mode2 == null || !isFinite(+P.participation_mode2) || +P.participation_mode2 < 0) ? null : +P.participation_mode2;
    p.igd_max = num(p.igd_max, D.igd_max);
    p.ifm_iccp_direct = p.ifm_iccp_direct !== false && p.ifm_iccp_direct !== "0" && p.ifm_iccp_direct !== 0;
    p.effectif = ["moins11", "11-19", "20-49", "50plus"].indexOf(p.effectif) >= 0 ? p.effectif : "50plus";
    p.pas_mode = p.pas_mode === "classeur" ? "classeur" : "grille";
    p.dfs_pct = (P.dfs_pct === "" || P.dfs_pct == null || !isFinite(+P.dfs_pct)) ? dfsPour(annee) : Math.max(0, +P.dfs_pct);
    p.hs_facturees_majorees = p.hs_facturees_majorees !== false && p.hs_facturees_majorees !== "0" && p.hs_facturees_majorees !== 0;
    p.heures = (Array.isArray(p.heures) && p.heures.length ? p.heures : HEURES).map(Number).filter(h => h >= 35 && h <= 48); if (!p.heures.length) p.heures = HEURES.slice();
    p.tolerance_net = Math.max(0, num(p.tolerance_net, D.tolerance_net)); p.tolerance_exces = Math.max(0, num(p.tolerance_exces, D.tolerance_exces));
    return p;
  }
  /* tarif de la grille de facturation pour un net promis : palier de plus grand netMin ≤ net (trous et dernier palier couverts),
     + majoration logement si l'intérimaire est logé dans une région à secteur majoré. */
  function palierPour(P, net) {
    const pal = P.tarifs_paliers; let x = null;
    for (const y of pal) if (net >= y.netMin) x = y;
    return x || pal[0];
  }
  function tarifPour(P, l) {
    const x = palierPour(P, +l.net); let t = x.tarif;
    const M = P.majoration_logement || {};
    if (LOGE(l.bloc) && M.montant > 0 && (M.regions || []).indexOf(l.region) >= 0) t += +M.montant;
    return r2(t);
  }
  const parRegion = (o, region) => { const v = (o.regions || {})[region]; return (v != null && v !== "" && isFinite(+v)) ? +v : +o.defaut; };
  const logementPour = (P, region) => parRegion(P.logement, region);
  const q = (n, d) => (n != null && +n > 0) ? +n : d;
  /* Les 4 lignes d'indemnités NON SOUMISES du moteur : IGD, repas midi, repas soir, transport. fc = 0 : non refacturées (tarif tout compris). */
  function indemnitesDe(l, igdValeur, igdNb) {
    const igd = igdValeur != null ? +igdValeur : (l.igd != null ? +l.igd : 0);
    return [
      { q: igd > 0 ? (igdNb || q(l.igd_nb, 5)) : 0, r: igd > 0 ? igd : 0, name: "IGD", fc: 0 },
      { q: l.repas_midi > 0 ? q(l.repas_midi_nb, 5) : 0, r: l.repas_midi > 0 ? +l.repas_midi : 0, name: "Repas midi", fc: 0 },
      { q: l.repas_soir > 0 ? q(l.repas_soir_nb, 5) : 0, r: l.repas_soir > 0 ? +l.repas_soir : 0, name: "Repas soir", fc: 0 },
      { q: l.transport > 0 ? q(l.transport_nb, 5) : 0, r: l.transport > 0 ? +l.transport : 0, name: "Transport", fc: 0 }
    ];
  }
  /* L'indemnité de TRAJET BTP est SOUMISE à cotisations : ligne de prime (dans le brut), non refacturée. */
  function primesDe(base, l) {
    const p = base.primes.map(x => Object.assign({}, x, { q: 0, r: 0 }));
    if (l.trajet > 0) p[0] = { q: q(l.trajet_nb, 5), r: +l.trajet, name: "Trajet", fc: 0 };
    return p;
  }
  const heuresBase = l => (l.heures != null && +l.heures >= 35 && +l.heures <= 48) ? +l.heures : 35;
  /* Entrées du moteur pour une ligne de grille et un nombre d'heures. */
  function entrees(P, l, heures, opts) {
    opts = opts || {}; const base = E.defaultInputs(DB, "tarifaire");
    const loge = LOGE(l.bloc), etr = ETRANGER(l.bloc); const brut = +l.brut;
    const tarif = opts.tarif || tarifPour(P, l);
    const logHebdo = loge ? logementPour(P, l.region) : 0;
    return Object.assign({}, base, {
      mode: loge ? "SIMULATEUR BTP GRAND D" : "SIMULATEUR BTP PETIT D", branche: "btp", client: "Grille " + l.region,
      thBrut: brut, netAttendu: null, heures: +heures, jours: 5, attestation: etr,
      ifm: P.ifm_iccp_direct, iccp: P.ifm_iccp_direct, pasMode: P.pas_mode, dfsFactor: 1 - P.dfs_pct / 100,
      heuresFactNormal: P.hs_facturees_majorees ? null : +heures,
      logement: true, logementHeures: 43, logementHoraire: logHebdo / 43, coutLogementFacture: 0,
      coeff: tarif / brut, effectif: P.effectif, vmPct: parRegion(P.vm, l.region),
      indemnites: indemnitesDe(l, opts.igd, opts.igd_nb), primes: primesDe(base, l), participationLibre: -(opts.participation > 0 ? +opts.participation : 0),
      rates: Object.assign({}, base.rates, { atPat: parRegion(P.at, l.region) })
    });
  }
  const netH = r => r.D31 ? r.F90 / r.D31 : 0;
  const calc = i => E.compute(i).main;
  /* participation (€ / semaine, ≥ 0) telle que le net versé = net cible ; F90 est linéaire en participation, une
     itération de sécurité corrige toute non-linéarité résiduelle. */
  function resoudreParticipation(P, l, h, opts) {
    opts = opts || {}; let part = 0, r = calc(entrees(P, l, h, Object.assign({}, opts, { participation: 0 })));
    for (let k = 0; k < 6; k++) {
      const delta = r.F90 - l.net * r.D31;          // excédent de net sur la cible (semaine)
      const np = Math.max(0, part + delta);
      if (Math.abs(np - part) < 0.005 && k > 0) break;
      part = np; r = calc(entrees(P, l, h, Object.assign({}, opts, { participation: part })));
      if (part === 0 && delta < 0) break;            // net inatteignable par la participation (déjà nulle)
    }
    return { participation: r2(part), r };
  }
  /* IGD (€ / jour) telle que le net versé = net cible, participation fixée (mode 2), plafonnée à igd_max. */
  function resoudreIGD(P, l, h, participation, nb) {
    let igd = l.igd != null ? +l.igd : 0, r = calc(entrees(P, l, h, { participation, igd, igd_nb: nb })), plafonne = false;
    for (let k = 0; k < 6; k++) {
      const delta = l.net * r.D31 - r.F90;           // manque de net (semaine) → à couvrir par l'IGD
      let ni = Math.max(0, igd + delta / nb);
      if (ni > P.igd_max) { ni = P.igd_max; plafonne = true; }
      if (Math.abs(ni - igd) < 0.005 && k > 0) break;
      igd = ni; r = calc(entrees(P, l, h, { participation, igd, igd_nb: nb }));
      if ((igd === 0 && delta < 0) || plafonne) break;
    }
    return { igd: r2(igd), r, plafonne };
  }
  /* tarif horaire nécessaire pour la marge cible : le CA est linéaire en coefficient (2 évaluations), le coût n'en dépend pas. */
  function tarifPourMarge(i, margePct, brut) {
    if (!(margePct < 100)) return null;
    const a = calc(Object.assign({}, i, { coeff: 1 })), b = calc(Object.assign({}, i, { coeff: 2 }));
    const pente = b.O60 - a.O60; if (!(pente > 0)) return null;
    const cout = a.O60 - a.O64; const caCible = cout / (1 - margePct / 100);
    const v = (1 + (caCible - a.O60) / pente) * brut;
    return isFinite(v) && v > 0 ? r2(v) : null;
  }
  const al = (res, type, texte, niveau) => res.alertes.push({ type, texte, niveau: niveau || "alerte" });
  /* Construction d'une ligne : résolution à la base horaire de la ligne (35 h), puis scénarios à participation / IGD figées. */
  function construireLigne(P0, l, minima, annee) {
    const P = paramsComplets(P0, annee); const loge = LOGE(l.bloc); const brut = +l.brut; const hb = heuresBase(l);
    const res = { region: l.region, bloc: l.bloc, profil: l.profil, net: +l.net, brut, coefficient: l.coefficient, heures: hb, mode: loge ? P.mode : "verif",
                  tarif: tarifPour(P, l), palier: palierPour(P, +l.net), logement: loge ? logementPour(P, l.region) : 0, participation: loge ? 0 : null,
                  igd: l.igd != null ? +l.igd : null, igd_nb: l.igd_nb != null ? +l.igd_nb : null, alertes: [], scenarios: [] };
    if (!(brut > 0) || !(l.net > 0)) { al(res, "donnees", "brut ou net manquant : ligne non calculée"); return res; }
    if (brut < SMIC - 0.001) al(res, "smic", "brut " + brut.toFixed(2) + " < SMIC " + SMIC.toFixed(2));
    if (res.palier.hors_grille) al(res, "tarif", "net " + (+l.net).toFixed(2) + " hors grille de facturation (tarif " + res.tarif.toFixed(2) + " € / h par extension : quotation direction)", "info");
    let base, r;
    if (P.mode === 2 && loge) {
      const part = P.participation_mode2 != null ? P.participation_mode2 : res.logement;
      const nb = q(l.igd_nb, l.bloc === "fr_loge" ? 4 : 5);
      const s = resoudreIGD(P, l, hb, part, nb); res.participation = r2(part); res.igd = s.igd; res.igd_nb = nb; r = s.r; base = { participation: part, igd: s.igd, igd_nb: nb };
      if (s.plafonne) al(res, "igd", "IGD plafonnée à " + P.igd_max.toFixed(2) + " € / jour (exonération) : net non atteint par l'IGD seule");
      else if (l.igd == null) al(res, "igd", "IGD créée " + s.igd.toFixed(2) + " € / jour × " + nb + " : la ligne n'avait pas d'IGD", "info");
      else if (Math.abs(s.igd - +l.igd) > 0.5) al(res, "igd", "IGD résolue " + s.igd.toFixed(2) + " € / jour (ligne : " + (+l.igd).toFixed(2) + ")", "info");
    } else if (loge) {
      const s = resoudreParticipation(P, l, hb); res.participation = s.participation; r = s.r; base = { participation: s.participation };
      if (res.participation > res.logement + 0.005) al(res, "participation", "participation " + res.participation.toFixed(2) + " € > coût du logement " + res.logement.toFixed(2) + " € (+" + (res.participation - res.logement).toFixed(2) + ")", "info");
    } else {
      r = calc(entrees(P, l, hb)); base = {};
      if (P.mode === 2) al(res, "info", "bloc non logé : ni participation ni IGD à résoudre, net vérifié seulement", "info");
    }
    res.net_atteint = r2(netH(r)); res.ecart = r2(res.net_atteint - res.net);
    if (res.ecart < -P.tolerance_net) {
      res.ajustement = r2(-res.ecart * r.D31);
      al(res, "net", "net atteint " + res.net_atteint.toFixed(2) + " < cible : il manque " + res.ajustement.toFixed(2) + " € / semaine (indemnité d'ajustement à prévoir)");
    } else if (res.ecart > P.tolerance_exces) al(res, "net", "net atteint " + res.net_atteint.toFixed(2) + " > cible de " + res.ecart.toFixed(2) + " € / h", "info");
    res.marge_pct = r2(r.H17); res.ca = r2(r.O60); res.cout = r2(r.O60 - r.O64); res.brut_semaine = r2(r.F42); res.net_semaine = r2(r.F90); res.pas = r2(r.F43 || 0);
    res.tarif_marge_cible = tarifPourMarge(entrees(P, l, hb, base), P.marge_cible, brut);
    if (res.marge_pct < P.marge_cible - 0.05) al(res, "marge", "marge " + res.marge_pct.toFixed(1) + " % < objectif " + P.marge_cible + " % (tarif nécessaire " + (res.tarif_marge_cible != null ? res.tarif_marge_cible.toFixed(2) + " € / h" : "—") + ")");
    if (minima && l.coefficient) {
      const m = ((minima[l.region] || {}).taux || {})[l.coefficient];
      if (m != null && brut < m - 0.001) al(res, "minima", "brut " + brut.toFixed(2) + " < minimum conventionnel du niveau " + l.coefficient + " (" + (+m).toFixed(2) + ")");
    }
    /* Grand Compte (IGD réduite) : (a) à participation identique → net du salarié plus bas ; (b) participation re-résolue pour tenir le net → marge plus basse */
    if (loge && l.igd_gc != null && +l.igd_gc > 0) {
      const igdNb = base.igd_nb || q(l.igd_nb, 5);
      const ra = calc(entrees(P, l, hb, { participation: res.participation, igd: +l.igd_gc, igd_nb: igdNb }));
      const gc = { igd: +l.igd_gc, net_meme_participation: r2(netH(ra)), marge_meme_participation: r2(ra.H17) };
      const sb = resoudreParticipation(P, l, hb, { igd: +l.igd_gc, igd_nb: igdNb }); gc.participation_pour_net = sb.participation; gc.marge_pour_net = r2(sb.r.H17); gc.net_pour_net = r2(netH(sb.r));
      res.grand_compte = gc;
    }
    /* scénarios horaires : participation (ou IGD) figée à la valeur résolue à la base */
    for (const h of P.heures) {
      const rh = h === hb ? r : calc(entrees(P, l, h, base));
      res.scenarios.push({ heures: h, heures_facturees: r2(res.tarif > 0 ? rh.O60 / res.tarif : 0) /* équivalent heures au tarif : 45 pour 43 h si les heures sup sont facturées majorées */, net: r2(netH(rh)), marge_pct: r2(rh.H17), ca: r2(rh.O60), cout: r2(rh.O60 - rh.O64), net_semaine: r2(rh.F90) });
    }
    return res;
  }
  /* Construction de plusieurs lignes ; onLigne(res, k, n) permet d'afficher la progression. */
  function construire(P, lignes, minima, annee, onLigne) {
    const out = [];
    for (let k = 0; k < lignes.length; k++) { const res = construireLigne(P, lignes[k], minima, annee); out.push(res); if (onLigne) onLigne(res, k, lignes.length); }
    return out;
  }
  /* Hypothèses effectivement utilisées, telles qu'écrites dans calcul (traçabilité). */
  function hypotheses(P) {
    return { mode: P.mode, marge_cible: P.marge_cible, ifm_iccp_direct: P.ifm_iccp_direct, effectif: P.effectif, pas_mode: P.pas_mode, dfs_pct: P.dfs_pct, hs_facturees_majorees: P.hs_facturees_majorees, igd_max: P.igd_max,
             tarifs_paliers: P.tarifs_paliers, majoration_logement: P.majoration_logement, logement: P.logement, at: P.at, vm: P.vm, participation_mode2: P.participation_mode2 };
  }
  /* Champs à reprendre dans une ligne de grille en brouillon (null = ligne non calculée). */
  function versLigne(res, P) {
    if (res.alertes.some(a => a.type === "donnees")) return null;
    const loge = LOGE(res.bloc);
    return { participation: loge ? res.participation : null, marge_pct: res.marge_pct,
             igd: (loge && res.mode === 2 && res.igd != null) ? res.igd : undefined, igd_nb: (loge && res.mode === 2 && res.igd_nb != null) ? res.igd_nb : undefined,
             calcul: { mode: res.mode, tarif: res.tarif, logement: res.logement, heures: res.heures, net_atteint: res.net_atteint, ecart: res.ecart, ajustement: res.ajustement || 0, pas: res.pas,
                       ca: res.ca, cout: res.cout, tarif_marge_cible: res.tarif_marge_cible, grand_compte: res.grand_compte || null, scenarios: res.scenarios, alertes: res.alertes,
                       hypotheses: P ? hypotheses(paramsComplets(P)) : null } };
  }
  return { HEURES, BLOCS, LOGE, ETRANGER, PARAMS_DEFAUT, DFS_BTP, dfsPour, SMIC, paramsComplets, palierPour, tarifPour, logementPour, parRegion, indemnitesDe, primesDe, entrees,
           construireLigne, construire, versLigne, hypotheses, tarifPourMarge, resoudreParticipation, resoudreIGD };
});
