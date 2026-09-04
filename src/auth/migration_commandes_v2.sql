-- 05/09/2026 : commandes classées par semaine, brouillon → publication, chargé de recrutement
ALTER TABLE commandes ADD COLUMN semaine TEXT;
ALTER TABLE commandes ADD COLUMN publiee INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commandes ADD COLUMN publiee_le TEXT;
ALTER TABLE commandes ADD COLUMN charge TEXT NOT NULL DEFAULT '';
ALTER TABLE commandes ADD COLUMN maj_le TEXT;
CREATE INDEX IF NOT EXISTS idx_commandes_semaine ON commandes(semaine, statut);
-- une ligne par (numéro, semaine) : reconduction = copie dans la nouvelle semaine, archive intacte
CREATE UNIQUE INDEX IF NOT EXISTS idx_commandes_num_sem ON commandes(numero, semaine);
-- lignes antérieures à la migration : rattachées à la semaine courante lors du déploiement (05/09/2026 = 2026-W36)
UPDATE commandes SET semaine = '2026-W36', publiee = (statut = 'ouverte'), publiee_le = cree_le, maj_le = datetime('now') WHERE semaine IS NULL;
