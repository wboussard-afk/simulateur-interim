-- ===== AB2Pro — schéma D1 (authentification, rôles, demandes d'accès, journal d'activité) =====
CREATE TABLE IF NOT EXISTS utilisateurs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nom TEXT NOT NULL DEFAULT '',
  sel TEXT NOT NULL,             -- hex 16 octets
  hash TEXT NOT NULL,            -- PBKDF2-SHA256 100000 itérations, hex
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  actif INTEGER NOT NULL DEFAULT 1,
  doit_changer_mdp INTEGER NOT NULL DEFAULT 0,
  echecs INTEGER NOT NULL DEFAULT 0,
  verrou_jusqua INTEGER NOT NULL DEFAULT 0,  -- epoch ms
  invite_token TEXT,             -- lien « définir mon mot de passe » (72 h)
  invite_expire INTEGER,
  cree_le TEXT NOT NULL DEFAULT (datetime('now')),
  cree_par TEXT NOT NULL DEFAULT 'seed'
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,        -- hex 32 octets
  user_id INTEGER NOT NULL REFERENCES utilisateurs(id),
  expire_le INTEGER NOT NULL     -- epoch ms
);

CREATE TABLE IF NOT EXISTS demandes_acces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  motif TEXT NOT NULL DEFAULT '',
  statut TEXT NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('en_attente','approuvee','refusee')),
  cree_le TEXT NOT NULL DEFAULT (datetime('now')),
  traite_par TEXT,
  traite_le TEXT
);

CREATE TABLE IF NOT EXISTS activites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  email TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,            -- connexion, deconnexion, page, simulation_pdf, solveur, fiche_idcc, recherche_entreprise, minima_btp, demande_acces, admin_*
  details TEXT NOT NULL DEFAULT '',
  page TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activites_ts ON activites(ts);
CREATE INDEX IF NOT EXISTS idx_activites_email ON activites(email);

-- ===== Amorçage : les 2 admins (mot de passe TEMPORAIRE, changement forcé à la 1re connexion) =====
INSERT OR IGNORE INTO utilisateurs (email, nom, sel, hash, role, doit_changer_mdp, cree_par) VALUES
 ('wboussard@gmail.com', 'Willy Boussard', '8fd2810ee6bf347735d8b6bd0d7fd789', '90b607f499f855e0058ff08b4c8edffb849f1066ae74ca60533fdbec7ec70e9c', 'admin', 1, 'seed'),
 ('urgensv@gmail.com',   'Admin 2',        '70754e8f96363eb9d4dc454c98d35974', '2a713db1932dd17e605ff4f2c7d22ffef7631caca0d33da6b7f06fb92f296c2c', 'admin', 1, 'seed');
