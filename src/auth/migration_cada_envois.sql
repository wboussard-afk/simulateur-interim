-- ===== 03/09/2026 : suivi SERVEUR des demandes CADA réellement envoyées =====
-- Remplace le suivi localStorage du navigateur (faux « déjà demandées » signalés par la
-- direction : marques héritées de l'ancien générateur de lettres, jamais envoyées).
CREATE TABLE IF NOT EXISTS cada_envois (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  dep TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  envoye_le TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cada_envois_commune ON cada_envois(nom, dep);
