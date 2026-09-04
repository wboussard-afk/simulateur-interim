-- 04/09/2026 (soir) : matricule sur la déclaration mensuelle, agence + métier libre sur les propositions hebdo,
-- factures déposées par les recruteurs (fichier stocké dans fichiers/fichiers_blocs, visible par le recruteur et les admins)
ALTER TABLE declarations ADD COLUMN matricule TEXT;
ALTER TABLE propositions ADD COLUMN agence TEXT;
CREATE TABLE IF NOT EXISTS factures_prest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prestataire_id INTEGER NOT NULL REFERENCES prestataires(id),
  mois TEXT NOT NULL,                    -- AAAA-MM facturé
  numero TEXT NOT NULL DEFAULT '',
  montant REAL,
  fichier TEXT NOT NULL,                 -- chemin dans fichiers (CODE/factures/...)
  statut TEXT NOT NULL DEFAULT 'recue',  -- recue / payee / rejetee
  commentaire TEXT NOT NULL DEFAULT '',
  cree_le TEXT NOT NULL DEFAULT (datetime('now')),
  cree_par TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_factures_prest ON factures_prest(prestataire_id, mois);
