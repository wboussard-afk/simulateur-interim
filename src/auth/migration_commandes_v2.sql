-- 05/09/2026 : commandes classées par semaine, brouillon → publication, chargé de recrutement
ALTER TABLE commandes ADD COLUMN semaine TEXT;
ALTER TABLE commandes ADD COLUMN publiee INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commandes ADD COLUMN publiee_le TEXT;
ALTER TABLE commandes ADD COLUMN charge TEXT NOT NULL DEFAULT '';
ALTER TABLE commandes ADD COLUMN maj_le TEXT;
CREATE INDEX IF NOT EXISTS idx_commandes_semaine ON commandes(semaine, statut);
