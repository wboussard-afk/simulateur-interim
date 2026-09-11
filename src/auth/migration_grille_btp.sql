-- 11/09/2026 : grille de rémunération Construction — sections « grille-btp » (Direction : construction, contrôle,
-- validation, historique) et « paie-btp » (gestionnaires : mini-simulateur en lecture seule des grilles validées).
CREATE TABLE IF NOT EXISTS grilles_btp (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  annee INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  libelle TEXT NOT NULL DEFAULT '',
  statut TEXT NOT NULL DEFAULT 'brouillon' CHECK (statut IN ('brouillon','validee','archivee')),
  application_du TEXT,                  -- YYYY-MM-DD : date d'entrée en vigueur (jamais rétroactive sur une autre grille)
  params TEXT NOT NULL DEFAULT '{}',    -- JSON : marge cible, tarifs de facturation, coût logement, rubriques de paie, sources
  cree_le TEXT NOT NULL DEFAULT (datetime('now')),
  cree_par TEXT NOT NULL DEFAULT '',
  validee_le TEXT,
  validee_par TEXT,
  UNIQUE (annee, version)
);
CREATE TABLE IF NOT EXISTS grilles_btp_lignes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grille_id INTEGER NOT NULL REFERENCES grilles_btp(id) ON DELETE CASCADE,
  region TEXT NOT NULL,
  bloc TEXT NOT NULL CHECK (bloc IN ('etranger_loge','etranger_non_loge','fr_loge','fr_non_loge')),
  profil TEXT NOT NULL,                 -- Aide métier | Ouvrier | Profil supérieur (extensible)
  net REAL NOT NULL,                    -- taux horaire net cible
  heures REAL NOT NULL DEFAULT 35,
  brut REAL,
  coefficient INTEGER,                  -- niveau BTP : 150, 170, 185, 210, 230, 250, 270
  igd REAL, igd_gc REAL, igd_nb REAL,   -- IGD standard, IGD Grand Compte (NULL = pas de valeur spécifique), jours
  repas_midi REAL, repas_midi_nb REAL,
  repas_soir REAL, repas_soir_nb REAL,
  transport REAL, transport_nb REAL,
  trajet REAL, trajet_nb REAL,
  participation REAL,                   -- participation logement retenue (€ / semaine), NULL = non définie
  marge_pct REAL,                       -- marge obtenue par le moteur (Direction seulement)
  calcul TEXT,                          -- JSON : hypothèses et résultat du moteur (phase 2)
  UNIQUE (grille_id, region, bloc, profil, net)
);
CREATE INDEX IF NOT EXISTS idx_gbl_grille ON grilles_btp_lignes(grille_id, region, bloc);
CREATE TABLE IF NOT EXISTS grilles_btp_regions (
  region TEXT PRIMARY KEY,
  departements TEXT NOT NULL            -- codes séparés par des virgules, ex. 44,49,53,72,85
);
CREATE TABLE IF NOT EXISTS grands_comptes_btp (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  actif INTEGER NOT NULL DEFAULT 1
);
