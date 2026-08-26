# Déploiement du portail sécurisé AB2Pro (Cloudflare Workers + D1 + Resend)

Ce dossier contient TOUT le système : Worker (`src/worker.js`), base (`schema.sql`),
pages (`assets/`), config (`wrangler.toml`). Les applications protégées sont copiées
par le build dans `assets/app/`.

## Ce que VOUS devez faire (une seule fois, ~15 minutes)

### 1. Compte Cloudflare (gratuit)
- https://dash.cloudflare.com/sign-up — créer le compte (e-mail admin), vérifier l'e-mail.

### 2. Compte Resend (gratuit, e-mails)
- https://resend.com/signup — créer le compte.
- Dans « API Keys » : créer une clé (Full access) et la garder sous la main (étape 5).
- (Plus tard, recommandé : « Domains » → ajouter votre domaine pour envoyer depuis
  acces@votredomaine.fr au lieu de onboarding@resend.dev.)

### 3. Outils sur ce poste (terminal PowerShell)
```
winget install OpenJS.NodeJS.LTS
npm install -g wrangler
wrangler login        # ouvre le navigateur, autoriser
```

### 4. Base de données
Dans le dossier `src/auth` du dépôt :
```
wrangler d1 create ab2pro-auth
```
→ copier le `database_id` affiché dans `wrangler.toml` (ligne REMPLACER_PAR_ID_D1), puis :
```
wrangler d1 execute ab2pro-auth --remote --file=schema.sql
```

### 5. Clé Resend (secret — c'est vous qui la collez, jamais Claude)
```
wrangler secret put RESEND_API_KEY
```
(coller la clé au prompt)

### 6. Déploiement
```
wrangler deploy
```
→ l'URL s'affiche : https://ab2pro-outils.<votre-sous-domaine>.workers.dev

### 7. Première connexion
- Ouvrir l'URL → se connecter avec l'e-mail admin + le mot de passe TEMPORAIRE
  (transmis par Claude en session — à changer immédiatement, l'écran l'impose).
- Vérifier : /admin (panneau), demander un accès depuis un navigateur privé pour tester
  l'e-mail aux admins, approuver, définir le mot de passe via le lien reçu.

### 8. Après la mise en service — dire à Claude « le portail Cloudflare est en ligne »
Claude fera alors :
- neutralisation des pages publiques GitHub (remplacées par une redirection vers le portail) ;
- mise à jour des tâches planifiées (déploiement des nouvelles fiches via `wrangler deploy`) ;
- mise à jour des liens donnés aux utilisateurs.

## Vie courante
- Nouvel utilisateur : il clique « Demander un accès » sur la page de connexion →
  les 2 admins reçoivent l'e-mail → approbation dans /admin → il reçoit son lien (72 h).
- Promouvoir/rétrograder un admin, désactiver un compte, réinviter : boutons dans /admin.
- Journal : /admin, section « Journal d'activité » (connexions, pages, études de prix,
  solveur, recherches, échecs de connexion, IP).
- Redéployer après modification des fiches/apps : `python src/build_single.py` puis
  `wrangler deploy` depuis `src/auth`.
