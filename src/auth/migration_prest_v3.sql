-- 05/09/2026 : prestataires.langue accepte 'en' (le CHECK d'origine ne listait que fr/ro/hu ; SQLite ne modifie pas un CHECK)
PRAGMA defer_foreign_keys = true;
CREATE TABLE prestataires_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  societe TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  contact TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  telephone TEXT NOT NULL DEFAULT '',
  pays TEXT NOT NULL DEFAULT '',
  langue TEXT NOT NULL DEFAULT 'fr' CHECK (langue IN ('fr','en','ro','hu')),
  tarif_q REAL NOT NULL DEFAULT 0.70,
  tarif_nq REAL NOT NULL DEFAULT 0.50,
  paliers TEXT,
  actif INTEGER NOT NULL DEFAULT 1,
  cree_le TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO prestataires_new (id, societe, code, contact, email, telephone, pays, langue, tarif_q, tarif_nq, paliers, actif, cree_le)
  SELECT id, societe, code, contact, email, telephone, pays, langue, tarif_q, tarif_nq, paliers, actif, cree_le FROM prestataires;
DROP TABLE prestataires;
ALTER TABLE prestataires_new RENAME TO prestataires;
