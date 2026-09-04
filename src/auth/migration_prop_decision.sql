-- 05/09/2026 : décision sur une équipe → horodatage + « vu » par le prestataire (bandeau dans son espace)
ALTER TABLE propositions ADD COLUMN decision_le TEXT;
ALTER TABLE propositions ADD COLUMN vu INTEGER NOT NULL DEFAULT 1;
