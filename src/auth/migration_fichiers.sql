-- 04/09/2026 : documents prestataires téléversés depuis le navigateur (stockés en base par blocs de 512 Ko ;
-- servis par le worker sous /app/data/prestataires/<chemin> avec le même contrôle d'accès que les fichiers statiques)
CREATE TABLE IF NOT EXISTS fichiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chemin TEXT NOT NULL UNIQUE,          -- ex. commun/consignes-2026.pdf ou ROTPEAK01/contrat.pdf
  type TEXT NOT NULL,                   -- MIME
  taille INTEGER NOT NULL,
  cree_le TEXT NOT NULL DEFAULT (datetime('now')),
  cree_par TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS fichiers_blocs (
  fichier_id INTEGER NOT NULL REFERENCES fichiers(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (fichier_id, seq)
);
