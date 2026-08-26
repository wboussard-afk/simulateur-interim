# Sources — Simulateur Intérim / Veille Paie / Veille Conventions (AB2Pro)

Atelier complet de build des 3 applications. Sauvegardé ici pour survivre au nettoyage
du dossier temporaire de session Claude. Toute session Claude future peut repartir de ce dossier.

## Contenu
- `app/` : sources des 3 applications (`app.html` simulateur, `paie.html`, `conventions.html`)
  + modules partagés `db.js`, `engine.js`, `geo.js` + `tests.html` (368 tests) + `serve.py` (serveur local :8757).
- `fiche_ml_*.json` : une fiche résumée par IDCC (thèmes structurés : cleValeur/points/detail/dateCourte/source/fiabilite).
- `fiches_mainloop.json` : agrégat des fiches + table de remplacements ancien→nouveau IDCC (32 codes vérifiés).
- `merge_fiches.py` : fusionne les `fiche_ml_*.json` dans `fiches_mainloop.json`.
- `inject_fiches2.py` : injecte fiches + remplacements dans `conventions.html` (remplace le bloc balisé).
- `build_single.py` : assemble les 6 fichiers finaux (3 autonomes + 3 variantes artifact).

## Mise à jour d'une fiche (procédure)
1. Éditer le `fiche_ml_<idcc>.json` concerné (ou `fiches_mainloop.json` pour 7028/remplacements).
2. `python merge_fiches.py` puis `python inject_fiches2.py` puis `python build_single.py`.
3. Déployer `veille-conventions.html` vers : Bureau (« Veille Conventions.html »), `conventions.html`
   de ce dépôt (commit+push), artifact claude.ai 📜 (40da5163-3702-4587-aa7a-04fbe57d72cd).
   Simulateur : `simulateur-agri.html` → « Simulateur Intérim.html » + `index.html` + artifact 🌾 ;
   Veille Paie : `veille-paie.html` → « Veille Paie.html » + `paie.html` + artifact 🧾.

NB : les chemins absolus en tête des scripts pointent vers le scratchpad de la session d'origine —
les adapter si l'atelier est rematérialisé ailleurs.

Constitué le 26/08/2026 — fiches contre-vérifiées sur sources officielles (CDTN, Légifrance, JO) ;
thèmes non recoupés marqués `aConfirmer`, comblés au fil de la veille hebdomadaire.
