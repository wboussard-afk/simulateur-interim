/* ============================================================================================
   Grille Construction — construction des lignes par le MOTEUR du simulateur (phase 2).
   Module partagé : inliné dans grille-btp.html par build_single.py (après db.js et engine.js),
   chargé tel quel dans node pour les tests. Aucune dépendance au DOM.

   Logique métier (retro-ingénierie du classeur 2026 validée le 11/09/2026 avec le moteur) :
   - le NET CIBLE d'une ligne est le net horaire VERSÉ : salaire net (IFM + ICCP en paiement direct)
     + indemnités non soumises (IGD, repas, transport, trajet) − participation logement retenue,
     le tout divisé par les heures payées ;
   - blocs NON LOGÉS : pas de participation ; le net dépend du brut, du coefficient et des indemnités ;
   - blocs LOGÉS : le brut reste au minimum du niveau, la PARTICIPATION LOGEMENT est l'outil de
     régulation (mode 1 : indemnités fixées → participation résolue) ; en mode 2 la participation est
     fixée (coût du logement par défaut) et c'est l'IGD qui est résolue ;
   - la marge brute est celle du moteur (CA facturé au tarif de la grille de facturation − coût complet).
   ============================================================================================ */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    const path = require("path"); const dbm = require(path.join(__dirname, "db.js")); if (typeof global.DB === "undefined") global.DB = dbm.DB;
    module.exports = factory(require(path.join(__dirname, "engine.js")), dbm.DB);
  } else root.GrilleMoteur = factory({ compute, defaultInputs, coeffPourMarge, solveCoeff, SECTORS }, DB);
})(typeof self !== "undefined" ? self : this, function (E, DB) {
  "use strict";
  const HEURES = [35, 36, 37, 38, 39, 40, 41, 42, 43];
  const BLOCS = ["etranger_loge", "etranger_non_loge", "fr_loge", "fr_non_loge"];
  const LOGE = b => b === "etranger_loge" || b === "fr_loge";
  const ETRANGER = b => String(b).indexOf("etranger") === 0;
  const r2 = v => Math.round(v * 100) / 100;

  /* Paramètres de construction (stockés dans params.construction de la grille ; tout est modifiable par la direction). */
  const PARAMS_DEFAUT = {
    mode: 1,                                   // 1 = indemnités fixées → participation résolue ; 2 = participation fixée → IGD résolue
    marge_cible: 20,                           // % de marge brute visé (paramètre direction)
    /* grille de facturation BTP (offre « taux horaire tout inclus », version 11-2025) : tarif par palier de net promis */
    tarifs_paliers: [
      { netMin: 0, netMax: 14.5, tarif: 31.5, libelle: "Ouvrier BTP" },
      { netMin: 14.5, netMax: 16, tarif: 33.5, libelle: "Profil supérieur" },
      { netMin: 16, netMax: 99, tarif: 35.5, libelle: "Profil supérieur (au-delà de 16 € : palier catégorie 2)" }
    ],
    majoration_logement: { montant: 2.5, regions: [] },   // + € HT / h facturés quand l'intérimaire est logé sur un secteur majoré (régions cochées)
    logement: { defaut: 180, regions: {} },    // coût hebdomadaire du logement AB Service (€ / semaine), par région
    logement_heures: 43,                       // base horaire du coût de logement dans le moteur (classeur : 43 h)
    participation_mode2: null,                 // € / semaine retenus en mode 2 (null = coût du logement de la région)
    ifm_iccp_direct: true,                     // IFM + ICCP payés chaque paie (le classeur raisonne ainsi) ; false = mise en CET
    effectif: "50plus",                        // bande d'effectif de l'ETT (intérimaires comptés — BOSS)
    vm_pct: 1.35,                              // versement mobilité moyen (grille nationale : moyenne France pondérée)
    heures: HEURES,                            // scénarios horaires comparés
    tolerance_net: 0.10                        // € / h : écart admis entre le net atteint et le net cible (arrondis du classeur)
  };
  function paramsComplets(P) {
    const p = Object.assign({}, PARAMS_DEFAUT, P || {});
    p.tarifs_paliers = (P && P.tarifs_paliers && P.tarifs_paliers.length) ? P.tarifs_paliers.map(x => ({ netMin: +x.netMin || 0, netMax: +x.netMax || 99, tarif: +x.tarif || 0, libelle: x.libelle || "" })).filter(x => x.tarif > 0) : PARAMS_DEFAUT.tarifs_paliers.slice();
    p.majoration_logement = Object.assign({ montant: 2.5, regions: [] }, (P && P.majoration_logement) || {});
    p.logement = Object.assign({ defaut: 180, regions: {} }, (P && P.logement) || {});
    p.heures = (p.heures && p.heures.length) ? p.heures.map(Number).filter(h => h >= 35 && h <= 48) : HEURES.slice();
    return p;
  }
  /* tarif de la grille de facturation pour un net promis (palier netMin ≤ net < netMax ; dernier palier inclusif),
     + majoration logement si l'intérimaire est logé dans une région à secteur majoré. */
  function tarifPour(P, l) {
    const pal = P.tarifs_paliers; const net = +l.net; let t = null;
    for (const x of pal) if (net >= x.netMin && (net < x.netMax || x === pal[pal.length - 1])) { t = x.tarif; break; }
    if (t == null) t = net < pal[0].netMin ? pal[0].tarif : pal[pal.length - 1].tarif;
    const M = P.majoration_logement || {};
    if (LOGE(l.bloc) && M.montant > 0 && (M.regions || []).indexOf(l.region) >= 0) t += +M.montant;
    return r2(t);
  }
  function logementPour(P, region) {
    const v = (P.logement.regions || {})[region];
    return (v != null && v !== "" && isFinite(+v)) ? +v : (P.logement.defaut != null ? +P.logement.defaut : 180);
  }
  /* Les 4 lignes d'indemnités du moteur : IGD, repas midi, repas soir, transport (+ trajet, cumulé sur la même ligne).
     fc = 0 : non refacturées (le tarif horaire de la grille est un prix tout compris). */
  function indemnitesDe(l, igdValeur) {
    const q = (n, d) => (n != null && +n > 0) ? +n : d;
    const igd = igdValeur != null ? +igdValeur : (l.igd != null ? +l.igd : 0);
    const transportSem = (l.transport ? +l.transport * q(l.transport_nb, 5) : 0) + (l.trajet ? +l.trajet * q(l.trajet_nb, 5) : 0);
    return [
      { q: igd > 0 ? q(l.igd_nb, 5) : 0, r: igd > 0 ? igd : 0, name: "IGD", fc: 0 },
      { q: l.repas_midi > 0 ? q(l.repas_midi_nb, 5) : 0, r: l.repas_midi > 0 ? +l.repas_midi : 0, name: "Repas midi", fc: 0 },
      { q: l.repas_soir > 0 ? q(l.repas_soir_nb, 5) : 0, r: l.repas_soir > 0 ? +l.repas_soir : 0, name: "Repas soir", fc: 0 },
      { q: transportSem > 0 ? 1 : 0, r: r2(transportSem), name: "Transport / trajet", fc: 0 }
    ];
  }
  /* Entrées du moteur pour une ligne de grille et un nombre d'heures. */
  function entrees(P, l, heures, opts) {
    const base = E.defaultInputs(DB, "tarifaire");
    const loge = LOGE(l.bloc), etr = ETRANGER(l.bloc); const brut = +l.brut;
    const tarif = (opts && opts.tarif) || tarifPour(P, l);
    const logHebdo = loge ? logementPour(P, l.region) : 0; const lh = +P.logement_heures || 43;
    return Object.assign({}, base, {
      mode: loge ? "SIMULATEUR BTP GRAND D" : "SIMULATEUR BTP PETIT D", branche: "btp", client: "Grille " + l.region,
      thBrut: brut, netAttendu: null, heures: +heures, jours: 5, attestation: etr,
      ifm: P.ifm_iccp_direct !== false, iccp: P.ifm_iccp_direct !== false,
      logement: true, logementHeures: lh, logementHoraire: logHebdo / lh, coutLogementFacture: 0,
      coeff: tarif / brut, effectif: P.effectif || "50plus", vmPct: +P.vm_pct || 0,
      indemnites: indemnitesDe(l, opts && opts.igd), participationLibre: -(opts && opts.participation > 0 ? +opts.participation : 0)
    });
  }
  const netH = r => r.D31 ? r.F90 / r.D31 : 0;
  const calc = i => E.compute(i).main;
  /* participation (€ / semaine, ≥ 0) telle que le net versé = net cible ; F90 est linéaire en participation, une
     itération de sécurité corrige toute non-linéarité résiduelle (retenue à la source, plafonds). */
  function resoudreParticipation(P, l, opts) {
    let part = 0, r = calc(entrees(P, l, 35, Object.assign({}, opts, { participation: 0 })));
    for (let k = 0; k < 6; k++) {
      const delta = r.F90 - l.net * r.D31;          // excédent de net sur la cible (semaine)
      const np = Math.max(0, part + delta);
      if (Math.abs(np - part) < 0.005 && k > 0) break;
      part = np; r = calc(entrees(P, l, 35, Object.assign({}, opts, { participation: part })));
      if (part === 0 && delta < 0) break;            // net inatteignable par la participation (déjà nulle)
    }
    return { participation: r2(part), r };
  }
  /* IGD (€ / jour, nb jours de la ligne) telle que le net versé = net cible, participation fixée (mode 2). */
  function resoudreIGD(P, l, participation, opts) {
    const nb = (l.igd_nb != null && +l.igd_nb > 0) ? +l.igd_nb : 5;
    let igd = l.igd != null ? +l.igd : 0, r = calc(entrees(P, l, 35, Object.assign({}, opts, { participation, igd })));
    for (let k = 0; k < 6; k++) {
      const delta = l.net * r.D31 - r.F90;           // manque de net (semaine) → à couvrir par l'IGD
      const ni = Math.max(0, igd + delta / nb);
      if (Math.abs(ni - igd) < 0.005 && k > 0) break;
      igd = ni; r = calc(entrees(P, l, 35, Object.assign({}, opts, { participation, igd })));
      if (igd === 0 && delta < 0) break;
    }
    return { igd: r2(igd), r };
  }
  /* tarif horaire nécessaire pour la marge cible : le CA est linéaire en coefficient (2 évaluations), le coût n'en dépend pas. */
  function tarifPourMarge(i, margePct, brut) {
    const a = calc(Object.assign({}, i, { coeff: 1 })), b = calc(Object.assign({}, i, { coeff: 2 }));
    const pente = b.O60 - a.O60; if (!(pente > 0) || margePct >= 100) return null;
    const cout = a.O60 - a.O64;                      // coût complet (indépendant du coefficient)
    const caCible = cout / (1 - margePct / 100);
    const c = 1 + (caCible - a.O60) / pente; const v = c * brut;
    return isFinite(v) && v > 0 ? r2(v) : null;
  }
  /* Construction d'une ligne : résolution à 35 h, puis scénarios horaires à participation / IGD figées. */
  function construireLigne(P0, l, minima) {
    const P = paramsComplets(P0); const loge = LOGE(l.bloc); const brut = +l.brut;
    const res = { region: l.region, bloc: l.bloc, profil: l.profil, net: +l.net, brut, coefficient: l.coefficient, mode: P.mode, tarif: tarifPour(P, l),
                  logement: loge ? logementPour(P, l.region) : 0, participation: 0, igd: l.igd != null ? +l.igd : null, alertes: [], scenarios: [] };
    if (!(brut > 0) || !(l.net > 0)) { res.alertes.push({ type: "donnees", texte: "brut ou net manquant" }); return res; }
    let base, r;
    if (P.mode === 2 && loge) {
      const part = P.participation_mode2 != null && P.participation_mode2 !== "" ? +P.participation_mode2 : res.logement;
      const s = resoudreIGD(P, l, part); res.participation = r2(part); res.igd = s.igd; r = s.r; base = { participation: part, igd: s.igd };
      if (l.igd != null && Math.abs(s.igd - +l.igd) > 0.5) res.alertes.push({ type: "igd", texte: "IGD résolue " + s.igd.toFixed(2) + " € / jour (classeur : " + (+l.igd).toFixed(2) + ")" });
    } else if (loge) {
      const s = resoudreParticipation(P, l); res.participation = s.participation; r = s.r; base = { participation: s.participation };
      if (res.participation > res.logement + 0.005) res.alertes.push({ type: "participation", texte: "participation " + res.participation.toFixed(2) + " € > coût du logement " + res.logement.toFixed(2) + " € (+" + (res.participation - res.logement).toFixed(2) + ")" });
    } else {
      r = calc(entrees(P, l, 35)); base = {};
    }
    res.net_atteint = r2(netH(r)); res.ecart = r2(res.net_atteint - res.net);
    if (Math.abs(res.ecart) > P.tolerance_net) {
      if (res.ecart < 0) {
        /* net inatteignable avec les indemnités de la ligne : indemnité d'ajustement nécessaire (non soumise, non facturée) */
        res.ajustement = r2(-res.ecart * r.D31);
        res.alertes.push({ type: "net", texte: "net atteint " + res.net_atteint.toFixed(2) + " < cible : il manque " + res.ajustement.toFixed(2) + " € / semaine (ajustement ou indemnité à ajouter)" });
      } else res.alertes.push({ type: "net", texte: "net atteint " + res.net_atteint.toFixed(2) + " > cible de " + res.ecart.toFixed(2) + " € / h (indemnités au-delà du besoin)" });
    }
    res.marge_pct = r2(r.H17); res.ca = r2(r.O60); res.cout = r2(r.O60 - r.O64); res.brut_semaine = r2(r.F42); res.net_semaine = r2(r.F90);
    res.tarif_marge_cible = tarifPourMarge(entrees(P, l, 35, base), P.marge_cible, brut);
    if (res.marge_pct < P.marge_cible - 0.05) res.alertes.push({ type: "marge", texte: "marge " + res.marge_pct.toFixed(1) + " % < cible " + P.marge_cible + " % (tarif nécessaire " + (res.tarif_marge_cible != null ? res.tarif_marge_cible.toFixed(2) + " € / h" : "—") + ")" });
    if (minima && l.coefficient) {
      const m = ((minima[l.region] || {}).taux || {})[l.coefficient];
      if (m != null && brut < m - 0.001) res.alertes.push({ type: "minima", texte: "brut " + brut.toFixed(2) + " < minimum conventionnel du niveau " + l.coefficient + " (" + (+m).toFixed(2) + ")" });
    }
    /* Grand Compte : IGD réduite à participation identique → net et marge du client grand compte */
    if (loge && l.igd_gc != null && +l.igd_gc > 0 && P.mode !== 2) {
      const rg = calc(entrees(P, l, 35, { participation: res.participation, igd: +l.igd_gc }));
      res.grand_compte = { igd: +l.igd_gc, net_atteint: r2(netH(rg)), marge_pct: r2(rg.H17) };
    }
    /* scénarios horaires : participation (ou IGD) figée à la valeur résolue à 35 h */
    for (const h of P.heures) {
      const rh = h === 35 ? r : calc(entrees(P, l, h, base));
      res.scenarios.push({ heures: h, net: r2(netH(rh)), marge_pct: r2(rh.H17), ca: r2(rh.O60), cout: r2(rh.O60 - rh.O64), net_semaine: r2(rh.F90) });
    }
    return res;
  }
  /* Construction de plusieurs lignes ; onLigne(res, k, n) permet d'afficher la progression. */
  function construire(P, lignes, minima, onLigne) {
    const out = [];
    for (let k = 0; k < lignes.length; k++) { const res = construireLigne(P, lignes[k], minima); out.push(res); if (onLigne) onLigne(res, k, lignes.length); }
    return out;
  }
  /* Champs à reprendre dans une ligne de grille en brouillon. */
  function versLigne(res) {
    return { participation: res.participation, marge_pct: res.marge_pct, igd: res.mode === 2 && res.igd != null ? res.igd : undefined,
             calcul: { mode: res.mode, tarif: res.tarif, logement: res.logement, net_atteint: res.net_atteint, ecart: res.ecart, ajustement: res.ajustement || 0,
                       ca: res.ca, cout: res.cout, tarif_marge_cible: res.tarif_marge_cible, grand_compte: res.grand_compte || null, scenarios: res.scenarios, alertes: res.alertes } };
  }
  return { HEURES, BLOCS, LOGE, ETRANGER, PARAMS_DEFAUT, paramsComplets, tarifPour, logementPour, indemnitesDe, entrees, construireLigne, construire, versLigne, tarifPourMarge, resoudreParticipation, resoudreIGD };
});
