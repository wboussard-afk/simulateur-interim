-- ===== 03/09/2026 : capture des réponses des mairies aux demandes CADA =====
-- Alimentée par le worker mail-fanout (réponse adressée à info+u<id>@ ou citant cette adresse,
-- dont le sujet/corps évoque le registre des meublés). Lue par la routine quotidienne
-- « cada-absorber » qui intègre les listes de meublés dans la base du portail.
CREATE TABLE IF NOT EXISTS cada_reponses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recu_le TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  de TEXT NOT NULL DEFAULT '',
  sujet TEXT NOT NULL DEFAULT '',
  texte TEXT NOT NULL DEFAULT '',          -- aperçu texte (≤ 20 000 caractères)
  pieces TEXT NOT NULL DEFAULT '[]',       -- JSON [{nom, type, taille, b64}] (b64 vide si > 700 Ko)
  statut TEXT NOT NULL DEFAULT 'a_traiter' CHECK (statut IN ('a_traiter','traitee','ignoree')),
  traite_le TEXT,
  notes TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_cada_reponses_statut ON cada_reponses(statut);
