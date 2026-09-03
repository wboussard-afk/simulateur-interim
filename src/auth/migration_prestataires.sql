-- ===== 04/09/2026 : section PRESTATAIRES (recruteurs externes, apporteurs de candidats) =====
-- Entité 'prestataire' : chaque prestataire a son compte, ne voit que ses propres données.
CREATE TABLE IF NOT EXISTS prestataires (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  societe TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,            -- code recruteur (ex. ROTPEAK01), aussi dossier documents
  contact TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  telephone TEXT NOT NULL DEFAULT '',
  pays TEXT NOT NULL DEFAULT '',        -- pays de sourcing (Roumanie, Hongrie, Bulgarie…)
  langue TEXT NOT NULL DEFAULT 'fr' CHECK (langue IN ('fr','ro','hu')),
  tarif_q REAL NOT NULL DEFAULT 0.70,   -- € HT / heure travaillée et facturée, profil qualifié
  tarif_nq REAL NOT NULL DEFAULT 0.50,  -- autre profil
  paliers TEXT,                         -- JSON optionnel [{"jusqua":50,"taux":0.5},{"jusqua":100,"taux":0.6},{"taux":0.7}] (par nb de TT du mois)
  actif INTEGER NOT NULL DEFAULT 1,
  cree_le TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS commandes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT NOT NULL,                 -- n° CRM
  date_debut TEXT NOT NULL,             -- YYYY-MM-DD
  nb_postes INTEGER NOT NULL DEFAULT 1,
  titre TEXT NOT NULL,
  agence TEXT NOT NULL DEFAULT '',
  lieu TEXT NOT NULL DEFAULT '',
  statut TEXT NOT NULL DEFAULT 'ouverte' CHECK (statut IN ('ouverte','pourvue','fermee')),
  cree_le TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS propositions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prestataire_id INTEGER NOT NULL REFERENCES prestataires(id),
  user_id INTEGER,
  commande_id INTEGER REFERENCES commandes(id),
  semaine TEXT NOT NULL,                -- YYYY-Www
  equipe INTEGER NOT NULL DEFAULT 1,
  nom TEXT NOT NULL, prenom TEXT NOT NULL, metier TEXT NOT NULL,
  vehicule INTEGER NOT NULL DEFAULT 0,
  salaire_net TEXT NOT NULL DEFAULT '',
  telephone TEXT NOT NULL DEFAULT '',
  remarques TEXT NOT NULL DEFAULT '',
  statut TEXT NOT NULL DEFAULT 'proposee' CHECK (statut IN ('proposee','retenue','refusee')),
  cree_le TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS declarations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prestataire_id INTEGER NOT NULL REFERENCES prestataires(id),
  user_id INTEGER,
  mois TEXT NOT NULL,                   -- YYYY-MM (mois travaillé)
  nom TEXT NOT NULL, prenom TEXT NOT NULL, metier TEXT NOT NULL,
  agence TEXT NOT NULL DEFAULT '',
  qualifie INTEGER NOT NULL DEFAULT 0,  -- 1 = profil qualifié (tarif Q)
  heures REAL,                          -- renseignées par AB2PRO (heures travaillées ET facturées)
  commentaire TEXT NOT NULL DEFAULT '',
  statut TEXT NOT NULL DEFAULT 'declaree' CHECK (statut IN ('declaree','validee','rejetee')),
  cree_le TEXT NOT NULL DEFAULT (datetime('now')),
  valide_le TEXT
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prestataire_id INTEGER,               -- NULL = document commun à tous les prestataires
  titre TEXT NOT NULL,
  fichier TEXT NOT NULL,                -- chemin sous /app/data/prestataires/ (commun/… ou <code>/…)
  langue TEXT NOT NULL DEFAULT 'fr',
  cree_le TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prop_prest ON propositions(prestataire_id, semaine);
CREATE INDEX IF NOT EXISTS idx_decl_prest ON declarations(prestataire_id, mois);
ALTER TABLE utilisateurs ADD COLUMN prestataire_id INTEGER;
ALTER TABLE utilisateurs ADD COLUMN langue TEXT;
ALTER TABLE demandes_acces ADD COLUMN societe TEXT;
ALTER TABLE demandes_acces ADD COLUMN telephone TEXT;
ALTER TABLE demandes_acces ADD COLUMN langue TEXT;
ALTER TABLE demandes_acces ADD COLUMN pays TEXT;
