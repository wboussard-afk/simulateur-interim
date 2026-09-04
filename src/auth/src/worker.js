/* ===== AB2Pro — Worker d'authentification, rôles et journal d'activité =====
 * Protège les 4 applications (simulateur, Veille Paie, Veille Conventions, Salaires Europe & Maghreb) + portail,
 * avec accès PAR SECTION choisi par les admins (utilisateurs.sections, NULL = tout).
 * D1 : utilisateurs, sessions, demandes_acces, activites (voir schema.sql).
 * E-mails immédiats aux admins via Resend (secret RESEND_API_KEY).
 * Les fichiers statiques (assets/) ne sont servis qu'après session valide. */

const ADMINS = ["wboussard@gmail.com", "urgens.martinez@ab2pro.com"];
/* Hiérarchie : super_admin (les 2 fondateurs, intouchables) > admin > user.
 * admin : gère les utilisateurs simples et les demandes d'accès (rôle user).
 * super_admin seul : promouvoir/rétrograder un admin, désactiver un admin, approuver en admin,
 * réinviter un admin/super_admin. Un super_admin ne peut JAMAIS être rétrogradé ni désactivé. */
const estAdmin = x => !!x && (x.role === "admin" || x.role === "super_admin");
const estSuper = x => !!x && x.role === "super_admin";

/* Accès par section : l'admin choisit les applications visibles par chaque utilisateur.
 * utilisateurs.sections = NULL → accès à tout (héritage) ; sinon tableau JSON de slugs.
 * Les admins et super admins voient toujours tout. */
const SECTIONS_APPS = ["simulateur", "paie", "conventions", "salaires-europe", "logements", "prestataires"];

/* Adresse de réponse des communications EXTERNES d'AB Service (réservations
 * DATAtourisme, etc.) — domaine dédié actif depuis le 03/09/2026 (Email Routing
 * + catch-all vers ab2pro-mail-fanout configurés par la direction). */
const EMAIL_EXTERNE = "info@abservice-logement.com";

/* ===== Entités & agences (décision direction 02/09/2026) =====
 * AB2Pro et AB Service sont deux entités séparées : chaque utilisateur choisit son
 * entité à l'inscription ; côté AB Service il se rattache à une ou plusieurs agences
 * (modifiables ensuite via son profil). Les réponses des logeurs sont routées vers
 * son e-mail perso + les boîtes génériques de ses agences (worker mail-fanout). */
const ENTITES = ["ab2pro", "abservice", "prestataire"];   /* prestataire = recruteur partenaire externe */
const LANGUES = ["fr", "en", "ro", "hu"];                 /* langue de l'espace (choisie à l'inscription, modifiable dans le profil) */
/* sections ouvertes PAR DÉFAUT selon l'entité (décision direction 04/09) — un admin peut en ajouter ensuite */
const SECTIONS_DEFAUT = { ab2pro: ["simulateur", "paie", "conventions", "salaires-europe"], abservice: ["logements"], prestataire: ["prestataires"] };
const AGENCES_ABSERVICE = {
  "rennes": "rennes@abservicefrance.com",
  "paris": "paris@abservicefrance.com",
  "bordeaux": "bordeaux@abservicefrance.com",
  "aix-en-provence": "aix-en-provence@abservicefrance.com",
  "lyon": "lyon@abservicefrance.com",
  "strasbourg": "strasbourg@abservicefrance.com",
  "angers": "angers@abservicefrance.com",
  "rouen": "rouen@abservicefrance.com",
  "nantes": "nantes@abservicefrance.com",
  "toulouse": "toulouse@abservicefrance.com",
  "lille": "lille@abservicefrance.com",
};
/* Centrales de réservation groupes des chaînes de résidences — relevées sur les sites
 * officiels le 03/09/2026 (recherche en mode dégradé, 1 agent) : seules ces adresses
 * peuvent recevoir une demande via /api/chaines/contact. */
const CHAINES_EMAILS = {
  "goelia": "info@goelia.com",
  "lagrange": "groupes@groupe-lagrange.com",
  "vvf": "groupes@vvf.fr",
  "azureva": "groupes@azureva-vacances.com",
};
const entiteDe = x => (x && ENTITES.includes(x.entite)) ? x.entite : "ab2pro";
function agencesDe(x) {
  if (!x || !x.agences) return [];
  try { const l = JSON.parse(x.agences); return Array.isArray(l) ? l.filter(a => AGENCES_ABSERVICE[a]) : []; }
  catch (e) { return []; }
}
const validerAgences = l => Array.isArray(l) ? JSON.stringify(l.map(String).filter(a => AGENCES_ABSERVICE[a]).slice(0, 11)) : null;
/* Adresse de réponse par utilisateur (sous-adressage info+u<id>@ → le worker
 * mail-fanout relaie la réponse du logeur à l'e-mail perso du demandeur + aux
 * boîtes génériques de ses agences). ACTIF depuis le 03/09/2026 : la règle
 * CATCH-ALL d'abservice-logement.com pointe sur ab2pro-mail-fanout. */
const SOUS_ADRESSAGE_REPONSES = true;
function adresseReponse(u2) {
  if (!SOUS_ADRESSAGE_REPONSES || !u2 || !u2.id) return EMAIL_EXTERNE;
  const [loc, dom] = EMAIL_EXTERNE.split("@");
  return loc + "+u" + u2.id + "@" + dom;
}
function sectionsDe(x) {
  if (!x) return [];
  if (estAdmin(x)) return SECTIONS_APPS;
  /* pas de liste explicite : défaut de l'entité (comptes historiques AB2PRO sans entité = outils internes) */
  if (x.sections == null || x.sections === "") return SECTIONS_DEFAUT[entiteDe(x)] || SECTIONS_DEFAUT.ab2pro;
  try {
    const l = JSON.parse(x.sections);
    return Array.isArray(l) ? l.filter(s => SECTIONS_APPS.includes(s)) : SECTIONS_APPS;
  } catch (e) { return SECTIONS_APPS; }
}
const SESSION_MS = 12 * 3600 * 1000;       // 12 h glissantes
const INVITE_MS = 72 * 3600 * 1000;        // lien d'invitation 72 h
const PBKDF2_ITER = 100000;

/* ---------- utilitaires ---------- */
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = s => new Uint8Array(s.match(/../g).map(x => parseInt(x, 16)));
const alea = n => hex(crypto.getRandomValues(new Uint8Array(n)));

async function pbkdf2(motdepasse, selHex) {
  const cle = await crypto.subtle.importKey("raw", new TextEncoder().encode(motdepasse), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: unhex(selHex), iterations: PBKDF2_ITER, hash: "SHA-256" }, cle, 256);
  return hex(bits);
}
function egaliteConstante(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const json = (o, status = 200, entetes = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", ...entetes } });
const cookieSession = (token, maxAge) =>
  `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

/* Envoi INDIVIDUEL par destinataire : un refus (ex. mode test Resend limité au titulaire
 * du compte) ne bloque pas les autres ; chaque échec est journalisé et visible dans /admin.
 * opts.from : expéditeur (défaut env.EMAIL_FROM) — doit appartenir à un domaine vérifié
 * chez Resend ; opts.replyTo : adresse de réponse (ex. adresse taguée info+u<id>@…). */
async function envoyerEmail(env, dest, sujet, texte, journalCtx, opts) {
  const dests = Array.isArray(dest) ? dest : [dest];
  const resultats = [];
  for (const d of dests) {
    if (!env.RESEND_API_KEY) { resultats.push({ dest: d, ok: false, status: 0, corps: "RESEND_API_KEY absent" }); continue; }
    try {
      const charge = { from: (opts && opts.from) || env.EMAIL_FROM || "AB2Pro <onboarding@resend.dev>",
                       to: [d], subject: sujet, text: texte };
      if (opts && opts.replyTo) charge.reply_to = opts.replyTo;
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify(charge),
      });
      const corps = await r.text().catch(() => "");
      resultats.push({ dest: d, ok: r.ok, status: r.status, corps: corps.slice(0, 300) });
    } catch (e) { resultats.push({ dest: d, ok: false, status: -1, corps: String(e).slice(0, 200) }); }
  }
  if (journalCtx) {
    for (const r of resultats) {
      if (!r.ok) await journal(journalCtx.env, journalCtx.req, null, "email_echec",
        r.dest + " [" + r.status + "] " + r.corps, sujet.slice(0, 80));
    }
  }
  return resultats;
}

/* Expéditeur des courriers externes AB Service. NB : Resend n'accepte que des domaines
 * VÉRIFIÉS — abservice-logement.com ne l'est pas encore, on émet donc depuis le domaine
 * du portail (vérifié) au NOM d'AB Service, avec l'adresse taguée en Reply-To : la
 * réponse revient bien sur le circuit AB Service (utilisateur + agences + générique). */
const FROM_ABSERVICE = "AB Service <logements@ab2pro-simulateur.com>";

/* signature des courriers sortants, complétée depuis le compte (plus de champ à remplir) */
/* stockage d'un fichier téléversé (multipart) en base : table fichiers + blocs de 512 Ko (pas de R2).
   dossier = commun | CODE | CODE/factures — le contrôle d'accès se fait sur le préfixe du chemin.
   Retourne { chemin, taille, type, sansExt } ou { erreur }. */
const TYPES_FICHIERS = { pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };
async function enregistrerFichier(env, u, dossier, f, extAutorisees, maxOctets, prefixe) {
  if (!f || typeof f === "string" || !f.size) return { erreur: "fichier_manquant" };
  if (f.size > maxOctets) return { erreur: "fichier_trop_gros" };
  const ext = ((f.name || "").match(/\.([a-z0-9]{2,5})$/i) || [0, ""])[1].toLowerCase();
  if (!extAutorisees.includes(ext) || !TYPES_FICHIERS[ext]) return { erreur: "type_non_autorise" };
  const sansExt = (f.name || "document").replace(/\.[^.]+$/, "");
  const base = ((prefixe || "") + sansExt).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "document";
  let chemin = dossier + "/" + base + "." + ext, k = 1;
  while (await env.DB.prepare("SELECT id FROM fichiers WHERE chemin = ?").bind(chemin).first()) chemin = dossier + "/" + base + "-" + (++k) + "." + ext;
  const buf = new Uint8Array(await f.arrayBuffer());
  const ins = await env.DB.prepare("INSERT INTO fichiers (chemin, type, taille, cree_par) VALUES (?,?,?,?)").bind(chemin, TYPES_FICHIERS[ext], buf.length, u.email).run();
  const fid = ins.meta && ins.meta.last_row_id;
  const BLOC = 512 * 1024;
  for (let i = 0, seq = 0; i < buf.length; i += BLOC, seq++)
    await env.DB.prepare("INSERT INTO fichiers_blocs (fichier_id, seq, data) VALUES (?,?,?)").bind(fid, seq, buf.slice(i, i + BLOC).buffer).run();
  return { chemin, taille: buf.length, type: TYPES_FICHIERS[ext], sansExt };
}

/* nom complet « Prénom Nom » ; les comptes antérieurs au 04/09/2026 ont le nom complet dans nom (prenom NULL) */
const nomComplet = x => [x && x.prenom, x && x.nom].map(v => String(v || "").trim()).filter(Boolean).join(" ");
function signatureDe(u2) {
  const ags = agencesDe(u2);
  return (nomComplet(u2) || u2.email) + (u2.fonction ? " — " + u2.fonction : "") +
    "\nAB Service" + (ags.length ? " — agence" + (ags.length > 1 ? "s" : "") + " de " +
      ags.map(a => a.split("-").map(x => x.charAt(0).toUpperCase() + x.slice(1)).join("-")).join(", ") : "") +
    "\nE-mail : " + adresseReponse(u2);
}
const normCle = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

async function journal(env, req, u, type, details = "", page = "") {
  try {
    await env.DB.prepare(
      "INSERT INTO activites (user_id, email, type, details, page, ip) VALUES (?,?,?,?,?,?)")
      .bind(u ? u.id : null, u ? u.email : "", type,
            String(details).slice(0, type === "etude_prix" ? 8000 : 500), String(page).slice(0, 200),
            req.headers.get("cf-connecting-ip") || "").run();
  } catch (e) { /* le journal ne doit jamais casser une requête */ }
}

async function utilisateurDeSession(env, req) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)session=([0-9a-f]{64})/);
  if (!m) return null;
  const r = await env.DB.prepare(
    "SELECT u.id, u.email, u.nom, u.prenom, u.role, u.actif, u.doit_changer_mdp, u.sections, u.entite, u.agences, u.fonction, u.prestataire_id, u.langue, s.token, s.expire_le " +
    "FROM sessions s JOIN utilisateurs u ON u.id = s.user_id WHERE s.token = ?").bind(m[1]).first();
  if (!r || !r.actif || r.expire_le < Date.now()) return null;
  if (r.expire_le < Date.now() + SESSION_MS / 2)   // prolongation glissante
    await env.DB.prepare("UPDATE sessions SET expire_le = ? WHERE token = ?").bind(Date.now() + SESSION_MS, r.token).run();
  return r;
}

/* ---------- point d'entrée ---------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    /* adresse canonique : www → racine (les cookies de session ne se partagent pas entre les deux hôtes) */
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    const p = url.pathname;
    const u = await utilisateurDeSession(env, req);

    /* --- API --- */
    if (p.startsWith("/api/")) return api(req, env, url, u);

    /* --- pages publiques : connexion / demande d'accès / définir mot de passe --- */
    if (p === "/" || p === "/index.html") {
      if (u && !u.doit_changer_mdp) return Response.redirect(url.origin + "/app/", 302);
      return env.ASSETS.fetch(new Request(url.origin + "/index.html", req));
    }
    if (p === "/motdepasse.html")
      return env.ASSETS.fetch(new Request(url.origin + "/motdepasse.html", req));

    /* --- panneau admin --- */
    if (p === "/admin" || p === "/admin.html") {
      if (!u) return Response.redirect(url.origin + "/", 302);
      if (!estAdmin(u)) return new Response("Accès réservé aux administrateurs.", { status: 403 });
      return env.ASSETS.fetch(new Request(url.origin + "/admin.html", req));
    }

    /* --- applications protégées --- */
    if (p === "/app" || p.startsWith("/app/")) {
      if (!u) return Response.redirect(url.origin + "/?suite=" + encodeURIComponent(p), 302);
      if (u.doit_changer_mdp) return Response.redirect(url.origin + "/motdepasse.html", 302);
      /* prestataire : l'espace dédié est sa page d'accueil (pas le portail des outils internes) */
      if (u.entite === "prestataire" && (p === "/app" || p === "/app/" || p === "/app/index.html") && sectionsDe(u).length === 1)
        return Response.redirect(url.origin + "/app/prestataires.html", 302);
      const cible = (p === "/app" || p === "/app/") ? "/app/index.html" : p;
      /* documents des prestataires : commun/ pour tous les prestataires + admins, <code>/ pour le seul intéressé */
      if (cible.startsWith("/app/data/prestataires/")) {
        /* chemin décodé puis validé : commun/<fichier>, <CODE>/<fichier> ou <CODE>/factures/<fichier> — rien d'autre */
        let cheminFi; try { cheminFi = decodeURIComponent(cible.slice("/app/data/prestataires/".length)); } catch (e) { return new Response("Chemin invalide.", { status: 400 }); }
        if (!/^(commun|[A-Z0-9]{3,20})(\/factures)?\/[^\/]+$/.test(cheminFi)) return new Response("Chemin invalide.", { status: 400 });
        let ok = estAdmin(u);
        if (!ok && u.entite === "prestataire" && u.prestataire_id) {
          const pr = await env.DB.prepare("SELECT code FROM prestataires WHERE id = ?").bind(u.prestataire_id).first();
          ok = cheminFi.startsWith("commun/") || (pr && cheminFi.startsWith(pr.code + "/"));
        }
        if (!ok) { await journal(env, req, u, "acces_refuse_section", "prestataires", cible); return new Response("Accès refusé.", { status: 403 }); }
        /* fichier téléversé (table fichiers, blocs de 512 Ko) : servi depuis la base ;
           sinon on retombe sur les fichiers statiques déployés avec le worker */
        const fi = await env.DB.prepare("SELECT id, type, taille FROM fichiers WHERE chemin = ?").bind(cheminFi).first();
        if (fi) {
          const blocs = (await env.DB.prepare("SELECT data FROM fichiers_blocs WHERE fichier_id = ? ORDER BY seq").bind(fi.id).all()).results;
          const out = new Uint8Array(fi.taille); let o = 0;
          for (const b of blocs) { const a = new Uint8Array(b.data); out.set(a, o); o += a.length; }
          await journal(env, req, u, "prest_document_lu", cheminFi);
          return new Response(out.subarray(0, o), { headers: { "content-type": fi.type, "content-length": String(o),
            "content-disposition": "inline; filename=\"" + cheminFi.split("/").pop().replace(/[^\w.\-]/g, "_") + "\"", "cache-control": "private, no-store" } });
        }
      }
      const mSec = cible.match(/^\/app\/([a-z][a-z-]*)\.html$/);
      if (mSec && SECTIONS_APPS.includes(mSec[1]) && !sectionsDe(u).includes(mSec[1])) {
        await journal(env, req, u, "acces_refuse_section", mSec[1], cible);
        return new Response(PAGE_SECTION_REFUSEE, { status: 403, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      /* données personnelles bailleurs : réservées aux utilisateurs de la section logements */
      if ((cible === "/app/data/bailleurs.json" || cible === "/app/data/meubles-mairies.json") && !sectionsDe(u).includes("logements")) {
        await journal(env, req, u, "acces_refuse_section", "logements", cible);
        return new Response("{}", { status: 403, headers: { "content-type": "application/json" } });
      }
      const rep = await env.ASSETS.fetch(new Request(url.origin + cible, req));
      const ct = rep.headers.get("content-type") || "";
      if (rep.ok && ct.includes("text/html")) {
        await journal(env, req, u, "page", "", cible);
        let html = await rep.text();
        html = html.replace("</head>", "<script>window.AB_SECTIONS=" + JSON.stringify(sectionsDe(u)) + ";</script></head>");
        html = html.replace("</body>", BALISE_ACTIVITE + "</body>");
        return new Response(html, { headers: rep.headers });
      }
      return rep;
    }

    return Response.redirect(url.origin + "/", 302);
  },
};

/* ---------- API ---------- */
async function api(req, env, url, u) {
  const p = url.pathname;
  const ctReq = req.headers.get("content-type") || "";
  const corps = req.method === "POST" && !/^multipart\/form-data/i.test(ctReq) ? await req.json().catch(() => ({})) : {};

  /* ===== DATAtourisme LIVE (proxy — la clé API reste un SECRET serveur : la page
     n'appelle jamais api.datatourisme.fr en direct, sinon la clé fuirait côté client).
     Secret : wrangler secret put DATATOURISME_API_KEY (dossier src/auth). ===== */
  if (p === "/api/dt/ping")
    return json({ configuree: !!env.DATATOURISME_API_KEY });
  if (p === "/api/dt/catalog") {
    if (!u) return json({ erreur: "non_connecte" }, 401);
    if (!sectionsDe(u).includes("logements")) return json({ erreur: "section" }, 403);
    if (!env.DATATOURISME_API_KEY) return json({ configuree: false }, 503);
    const cible = new URL("https://api.datatourisme.fr/v1/catalog");
    for (const k of ["geo_distance", "type", "fields", "page", "page_size", "search", "sort"]) {
      const v = url.searchParams.get(k);
      if (v) cible.searchParams.set(k, v);
    }
    const rep = await fetch(cible, { headers: { "X-API-Key": env.DATATOURISME_API_KEY } });
    return new Response(rep.body, { status: rep.status, headers: { "content-type": "application/json; charset=utf-8" } });
  }
  if (p.startsWith("/api/dt/contact/") && req.method === "POST") {
    /* demande de RÉSERVATION à l'hôte via l'endpoint officiel (target booking) —
       un clic = un envoi, réponse sur logements@ ; journalisé (pas d'envoi en masse) */
    if (!u) return json({ erreur: "non_connecte" }, 401);
    if (!sectionsDe(u).includes("logements")) return json({ erreur: "section" }, 403);
    if (!env.DATATOURISME_API_KEY) return json({ configuree: false }, 503);
    const uuid = p.slice("/api/dt/contact/".length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid))
      return json({ erreur: "uuid" }, 400);
    const message = String(corps.message || "").slice(0, 5000);
    if (message.length < 20) return json({ erreur: "message_trop_court" }, 400);
    /* AB Service est une entité à part : AUCUNE mention du groupe parent dans les
       communications externes (décision direction 02/09). L'adresse de réponse
       basculera sur info@abservice-logement.com dès que le domaine sera actif. */
    const charge = {
      name: (u.nom || "AB Service").slice(0, 255),
      email: adresseReponse(u),
      message,
      subject: String(corps.subject || "Demande de location — équipes en mission (AB Service)").slice(0, 255),
      target: "booking",
    };
    const rep = await fetch("https://api.datatourisme.fr/v1/catalog/" + uuid + "/contact", {
      method: "POST",
      headers: { "X-API-Key": env.DATATOURISME_API_KEY, "content-type": "application/json" },
      body: JSON.stringify(charge),
    });
    await journal(env, req, u, "dt_contact", uuid, "statut " + rep.status);
    if (rep.status === 422) return json({ erreur: "pas_email_reservation" }, 422);
    /* copie de la demande à l'expéditeur (DATAtourisme n'en envoie pas) */
    if (rep.ok)
      await envoyerEmail(env, u.email,
        "Copie — votre demande de réservation à « " + String(corps.nom || "l'hébergement").slice(0, 120) + " »",
        "Votre demande est partie via DATAtourisme :\n\n" + message,
        { env, req }, { from: FROM_ABSERVICE, replyTo: adresseReponse(u) });
    return json({ ok: rep.ok, statut: rep.status }, rep.ok ? 200 : rep.status);
  }

  /* ===== envoi AUTOMATIQUE des demandes CADA aux mairies (un clic — décision 03/09) =====
   * L'e-mail de chaque mairie vient de l'Annuaire de l'administration (DILA,
   * data/mairies.json, 35 264 communes). Un e-mail PAR mairie, expéditeur AB Service,
   * réponse sur l'adresse taguée de l'utilisateur (circuit utilisateur+agences+générique).
   * Max 25 communes par appel (limite de sous-requêtes Workers + douceur Resend) —
   * le portail enchaîne les lots. corps.verifier=true : résolution seule, AUCUN envoi. */
  /* -- suivi SERVEUR des demandes CADA : communes réellement envoyées (toutes agences) -- */
  if (p === "/api/cada/faites") {
    if (!u) return json({ erreur: "non_connecte" }, 401);
    const r = await env.DB.prepare("SELECT nom, dep, MAX(envoye_le) AS envoye_le FROM cada_envois GROUP BY nom, dep").all();
    return json({ faites: r.results });
  }

  /* -- réservation auprès d'une CHAÎNE de résidences (Atout France sans fiche DATAtourisme) :
   * e-mail de la centrale groupes résolu côté serveur depuis la liste blanche (contacts relevés
   * sur les sites officiels le 03/09/2026) — jamais d'adresse libre venant du client -- */
  if (p === "/api/chaines/contact" && req.method === "POST") {
    if (!u) return json({ erreur: "non_connecte" }, 401);
    if (!sectionsDe(u).includes("logements")) return json({ erreur: "section" }, 403);
    const jeton = String(corps.jeton || "").toLowerCase().slice(0, 30);
    const dest = CHAINES_EMAILS[jeton];
    if (!dest) return json({ erreur: "chaine_inconnue" }, 400);
    const nomHeb = String(corps.nom || "l'établissement").slice(0, 120);
    const message = String(corps.message || "").slice(0, 5000);
    if (message.length < 20) return json({ erreur: "message_trop_court" }, 400);
    const res = await envoyerEmail(env, dest, "Demande de location — équipes en mission (AB Service) — " + nomHeb,
      message, { env, req }, { from: FROM_ABSERVICE, replyTo: adresseReponse(u) });
    if (res[0] && res[0].ok)
      await envoyerEmail(env, u.email, "Copie — votre demande de réservation à « " + nomHeb + " »",
        "Votre demande est partie à la centrale " + jeton + " (" + dest + ") :\n\n" + message,
        { env, req }, { from: FROM_ABSERVICE, replyTo: adresseReponse(u) });
    await journal(env, req, u, "chaine_contact", jeton + " " + dest, "statut " + (res[0] ? res[0].status : "?"));
    return json({ ok: !!(res[0] && res[0].ok) }, res[0] && res[0].ok ? 200 : 502);
  }

  if (p === "/api/cada/envoyer" && req.method === "POST") {
    if (!u) return json({ erreur: "non_connecte" }, 401);
    if (!sectionsDe(u).includes("logements")) return json({ erreur: "section" }, 403);
    const communes = (Array.isArray(corps.communes) ? corps.communes : []).slice(0, 25)
      .map(c => ({ nom: String(c.nom || "").slice(0, 60), dep: String(c.dep || "").slice(0, 3) }))
      .filter(c => c.nom && /^(\d{2}|2A|2B)$/.test(c.dep));
    if (!communes.length) return json({ erreur: "communes_requises" }, 400);
    let annuaire = {};
    try {
      const ra = await env.ASSETS.fetch(new Request("https://interne/app/data/mairies.json"));
      annuaire = (await ra.json()).m || {};
    } catch (e) { return json({ erreur: "annuaire_indisponible" }, 503); }
    const auj = new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" });
    const reponse = adresseReponse(u);
    const envoyees = [], sansEmail = [], echecs = [];
    for (const c of communes) {
      const email = annuaire[normCle(c.nom) + "|" + c.dep];
      if (!email) { sansEmail.push(c); continue; }
      if (corps.verifier) { envoyees.push({ ...c, email }); continue; }
      const texte =
        "Madame, Monsieur,\n\n" +
        "En application de l'article L.311-1 du code des relations entre le public et l'administration, " +
        "je vous prie de bien vouloir me communiquer la liste des meublés de tourisme déclarés auprès de votre commune " +
        "(déclarations prévues à l'article L.324-1-1 du code du tourisme), en indiquant pour chaque meublé : " +
        "l'adresse du bien, le nombre de pièces et de lits, les périodes prévisionnelles de location et, le cas échéant, " +
        "le niveau de classement et le numéro d'enregistrement.\n\n" +
        "Conformément à la doctrine de la Commission d'accès aux documents administratifs (avis n° 20131539 du 4 novembre 2013), " +
        "cette liste est communicable à toute personne qui en fait la demande, sous réserve de l'occultation préalable des " +
        "mentions relevant de la vie privée des déclarants (identité, coordonnées personnelles), que vous voudrez bien opérer.\n\n" +
        "La communication peut se faire par simple retour de ce courriel (adresse " + reponse + "), " +
        "ou selon les modalités prévues à l'article L.311-9 du même code.\n\n" +
        "Contexte de la demande : notre société, AB Service, recherche des logements pour héberger ses salariés en mission " +
        "sur des chantiers proches de votre commune, et souhaite adresser ses propositions de location aux adresses des meublés concernés.\n\n" +
        "Je vous remercie par avance et vous prie d'agréer, Madame, Monsieur, l'expression de mes salutations distinguées.\n\n" +
        "Fait le " + auj + "\n" + signatureDe(u);
      const res = await envoyerEmail(env, email,
        "Demande de communication de la liste des meublés de tourisme déclarés — commune de " + c.nom,
        texte, { env, req }, { from: FROM_ABSERVICE, replyTo: reponse });
      if (res[0] && res[0].ok) envoyees.push({ ...c, email }); else echecs.push({ ...c, email });
      if (res[0] && res[0].ok) await env.DB.prepare("INSERT INTO cada_envois (nom, dep, email, user_id) VALUES (?,?,?,?)").bind(c.nom, c.dep, email, u.id).run();
      await new Promise(rr => setTimeout(rr, 150));   /* douceur API Resend */
    }
    if (!corps.verifier) {
      await journal(env, req, u, "cada_envoi", envoyees.length + " envoyées (" +
        envoyees.map(c => c.nom).join(", ").slice(0, 300) + "), " + sansEmail.length + " sans e-mail, " + echecs.length + " échecs");
      /* RÉCAPITULATIF à l'expéditeur + ses agences : trace de ce qui est parti
         (demande direction 03/09 — « j'ai fait un test mais rien reçu ») */
      if (envoyees.length) {
        /* CADA : la boîte générique (admins) est AUSSI destinataire — la réponse de la mairie
           doit être absorbée dans la base (routine quotidienne), contrairement aux réservations */
        const copies = [u.email, ...agencesDe(u).map(a => AGENCES_ABSERVICE[a]).filter(Boolean), EMAIL_EXTERNE];
        await envoyerEmail(env, copies,
          "Copie — " + envoyees.length + " demande(s) de registre des meublés envoyée(s) aux mairies",
          "Vos demandes CADA (registre des meublés de tourisme) sont parties, une par mairie :\n\n" +
          envoyees.map(c => "  • " + c.nom + " (" + c.dep + ") — " + c.email).join("\n") +
          (sansEmail.length ? "\n\nSans e-mail dans l'annuaire officiel (à contacter manuellement) : " +
            sansEmail.map(c => c.nom).join(", ") : "") +
          "\n\nLes réponses des mairies arriveront sur votre e-mail, ceux de vos agences et la boîte générique (" + reponse + ").\n\n" +
          "— Texte type envoyé —\n\nMadame, Monsieur,\n\nEn application de l'article L.311-1 du CRPA, demande de communication de la " +
          "liste des meublés de tourisme déclarés (art. L.324-1-1 du code du tourisme)…\n\nFait le " + auj + "\n" + signatureDe(u),
          { env, req }, { from: FROM_ABSERVICE, replyTo: reponse });
      }
    }
    return json({ ok: true, verifier: !!corps.verifier, envoyees, sans_email: sansEmail, echecs });
  }

  /* ===== réservation d'un hébergement officiel par e-mail DIRECT (fiches DATAtourisme
   * avec e-mail mais sans uuid de contact API, et croisements Atout France) =====
   * Anti-abus : l'e-mail destinataire doit exister dans les fiches du département servies
   * par le portail (data/dt/<dep>.json, champ e-mail). Copie envoyée à l'expéditeur. */
  if (p === "/api/heberg/contact" && req.method === "POST") {
    if (!u) return json({ erreur: "non_connecte" }, 401);
    if (!sectionsDe(u).includes("logements")) return json({ erreur: "section" }, 403);
    const dep = String(corps.dep || "").slice(0, 3);
    const dest = String(corps.email || "").trim().toLowerCase().slice(0, 200);
    const nomHeb = String(corps.nom || "l'hébergement").slice(0, 120);
    const message = String(corps.message || "").slice(0, 5000);
    if (!/^(\d{2}|2A|2B)$/.test(dep)) return json({ erreur: "dep_invalide" }, 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dest)) return json({ erreur: "email_invalide" }, 400);
    if (message.length < 20) return json({ erreur: "message_trop_court" }, 400);
    let connu = false;
    try {
      const rd = await env.ASSETS.fetch(new Request("https://interne/app/data/dt/" + dep + ".json"));
      const base = await rd.json();
      connu = (base.h || []).some(h => (h[8] || "").trim().toLowerCase() === dest);
    } catch (e) { return json({ erreur: "base_indisponible" }, 503); }
    if (!connu) return json({ erreur: "hebergement_inconnu" }, 400);
    const res = await envoyerEmail(env, dest,
      "Demande de location — équipes en mission (AB Service)",
      message, { env, req }, { from: FROM_ABSERVICE, replyTo: adresseReponse(u) });
    if (res[0] && res[0].ok)
      await envoyerEmail(env, u.email, "Copie — votre demande de réservation à « " + nomHeb + " »",
        "Votre demande est partie à " + dest + " :\n\n" + message,
        { env, req }, { from: FROM_ABSERVICE, replyTo: adresseReponse(u) });
    await journal(env, req, u, "heberg_contact", dest, "statut " + (res[0] ? res[0].status : "?"));
    return json({ ok: !!(res[0] && res[0].ok) }, res[0] && res[0].ok ? 200 : 502);
  }

  /* ===== réservation auprès d'un bailleur connu (bouton Réserver, comme DATAtourisme) =====
   * Anti-abus : l'e-mail destinataire doit exister dans la base bailleurs servie par le
   * portail — impossible d'utiliser l'endpoint comme relais vers une adresse arbitraire. */
  if (p === "/api/bailleurs/contact" && req.method === "POST") {
    if (!u) return json({ erreur: "non_connecte" }, 401);
    if (!sectionsDe(u).includes("logements")) return json({ erreur: "section" }, 403);
    const dest = String(corps.email || "").trim().toLowerCase().slice(0, 200);
    const message = String(corps.message || "").slice(0, 5000);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dest)) return json({ erreur: "email_invalide" }, 400);
    if (message.length < 20) return json({ erreur: "message_trop_court" }, 400);
    let connu = false;
    try {
      const rb = await env.ASSETS.fetch(new Request("https://interne/app/data/bailleurs.json"));
      const base = await rb.json();
      connu = (base.bailleurs || []).some(b => (b.e || "").trim().toLowerCase() === dest);
    } catch (e) { return json({ erreur: "base_indisponible" }, 503); }
    if (!connu) return json({ erreur: "bailleur_inconnu" }, 400);
    const res = await envoyerEmail(env, dest,
      "Demande de location — équipes en mission (AB Service)",
      message + "\n\n" + signatureDe(u), { env, req },
      { from: FROM_ABSERVICE, replyTo: adresseReponse(u) });
    if (res[0] && res[0].ok)
      await envoyerEmail(env, u.email, "Copie — votre demande de réservation (bailleur)",
        "Votre demande est partie à " + dest + " :\n\n" + message + "\n\n" + signatureDe(u),
        { env, req }, { from: FROM_ABSERVICE, replyTo: adresseReponse(u) });
    await journal(env, req, u, "bailleur_contact", dest, "statut " + (res[0] ? res[0].status : "?"));
    return json({ ok: !!(res[0] && res[0].ok) }, res[0] && res[0].ok ? 200 : 502);
  }

  /* -- session -- */
  if (p === "/api/moi")
    return u ? json({ email: u.email, nom: u.nom, prenom: u.prenom || "", nom_complet: nomComplet(u), fonction: u.fonction || "", role: u.role, doit_changer_mdp: !!u.doit_changer_mdp, sections: sectionsDe(u),
                      prestataire_id: u.prestataire_id || null, langue: LANGUES.includes(u.langue) ? u.langue : "fr", langues: LANGUES,
                      entite: entiteDe(u), agences: agencesDe(u), agences_disponibles: Object.keys(AGENCES_ABSERVICE),
                      adresse_reponse: adresseReponse(u), signature: signatureDe(u) })
             : json({ erreur: "non_connecte" }, 401);

  /* -- profil : l'utilisateur AB Service change lui-même ses agences de rattachement -- */
  if (p === "/api/profil" && req.method === "POST") {
    if (!u) return json({ erreur: "non_connecte" }, 401);
    const maj = [], vals = [];
    /* langue de l'espace (FR/EN/RO/HU) et fonction : modifiables par tout utilisateur */
    if (corps.langue !== undefined) { if (!LANGUES.includes(corps.langue)) return json({ erreur: "langue_invalide" }, 400); maj.push("langue = ?"); vals.push(corps.langue); }
    if (corps.fonction !== undefined) { maj.push("fonction = ?"); vals.push(String(corps.fonction || "").trim().slice(0, 120) || null); }
    /* nom affiché (signatures, en-têtes) */
    if (corps.nom !== undefined) { const nom = String(corps.nom || "").trim().slice(0, 120); if (!nom) return json({ erreur: "nom_requis" }, 400); maj.push("nom = ?"); vals.push(nom); }
    if (corps.prenom !== undefined) { maj.push("prenom = ?"); vals.push(String(corps.prenom || "").trim().slice(0, 80) || null); }
    /* e-mail de connexion : format, unicité (insensible à la casse) ; les deux adresses sont prévenues du changement */
    let nouvelEmail = null;
    if (corps.email !== undefined) {
      const em = String(corps.email || "").trim().toLowerCase().slice(0, 160);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) return json({ erreur: "email_invalide" }, 400);
      if (em !== String(u.email).toLowerCase()) {
        const deja = await env.DB.prepare("SELECT id FROM utilisateurs WHERE email = ? COLLATE NOCASE AND id <> ?").bind(em, u.id).first();
        if (deja) return json({ erreur: "email_deja_utilise" }, 409);
        maj.push("email = ?"); vals.push(em); nouvelEmail = em;
      }
    }
    /* agences de rattachement : AB Service seulement, au moins une */
    if (corps.agences !== undefined) {
      if (entiteDe(u) !== "abservice") return json({ erreur: "reserve_abservice" }, 403);
      const ag = validerAgences(corps.agences);
      if (ag === null || JSON.parse(ag).length === 0) return json({ erreur: "agences_invalides" }, 400);
      maj.push("agences = ?"); vals.push(ag);
    }
    if (!maj.length) return json({ erreur: "rien_a_modifier" }, 400);
    await env.DB.prepare("UPDATE utilisateurs SET " + maj.join(", ") + " WHERE id = ?").bind(...vals, u.id).run();
    await journal(env, req, u, "profil_maj", maj.join(", ") + (nouvelEmail ? " (" + u.email + " -> " + nouvelEmail + ")" : ""));
    if (nouvelEmail) {
      /* fiche prestataire liée : même adresse de contact */
      if (u.prestataire_id) await env.DB.prepare("UPDATE prestataires SET email = ? WHERE id = ? AND lower(email) = lower(?)").bind(nouvelEmail, u.prestataire_id, u.email).run();
      const txt = `Bonjour ${nomComplet(u)},

L'adresse e-mail de connexion de votre compte AB2Pro vient d'être modifiée :
  ancienne : ${u.email}
  nouvelle : ${nouvelEmail}

Connectez-vous désormais avec la nouvelle adresse (mot de passe inchangé). Les réponses des logeurs et les notifications arrivent maintenant sur cette adresse.

Si vous n'êtes pas à l'origine de ce changement, répondez immédiatement à ce message.

— AB2Pro · ${url.origin}`;
      await envoyerEmail(env, [u.email, nouvelEmail], "AB2Pro — adresse de connexion modifiée", txt, { env, req });
    }
    return json({ ok: true, email: nouvelEmail || u.email });
  }

  if (p === "/api/login" && req.method === "POST") {
    const email = String(corps.email || "").trim().toLowerCase();
    const mdp = String(corps.motdepasse || "");
    if (!email || !mdp) return json({ erreur: "champs_manquants" }, 400);
    const cpt = await env.DB.prepare("SELECT * FROM utilisateurs WHERE email = ?").bind(email).first();
    if (!cpt || !cpt.actif) { await journal(env, req, null, "connexion_echec", email); return json({ erreur: "identifiants" }, 401); }
    if (cpt.verrou_jusqua > Date.now()) return json({ erreur: "verrouille", minutes: Math.ceil((cpt.verrou_jusqua - Date.now()) / 60000) }, 429);
    const h = await pbkdf2(mdp, cpt.sel);
    if (!egaliteConstante(h, cpt.hash)) {
      const echecs = (cpt.echecs || 0) + 1;
      const verrou = echecs >= 5 ? Date.now() + 15 * 60000 : 0;
      await env.DB.prepare("UPDATE utilisateurs SET echecs = ?, verrou_jusqua = ? WHERE id = ?").bind(echecs, verrou, cpt.id).run();
      await journal(env, req, null, "connexion_echec", email);
      return json({ erreur: "identifiants" }, 401);
    }
    await env.DB.prepare("UPDATE utilisateurs SET echecs = 0, verrou_jusqua = 0 WHERE id = ?").bind(cpt.id).run();
    const token = alea(32);
    await env.DB.prepare("INSERT INTO sessions (token, user_id, expire_le) VALUES (?,?,?)").bind(token, cpt.id, Date.now() + SESSION_MS).run();
    await journal(env, req, { id: cpt.id, email: cpt.email }, "connexion");
    return json({ ok: true, doit_changer_mdp: !!cpt.doit_changer_mdp, role: cpt.role },
                200, { "set-cookie": cookieSession(token, SESSION_MS / 1000) });
  }

  if (p === "/api/logout" && req.method === "POST") {
    const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)session=([0-9a-f]{64})/);
    if (m) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(m[1]).run();
    if (u) await journal(env, req, u, "deconnexion");
    return json({ ok: true }, 200, { "set-cookie": cookieSession("x", 0) });
  }

  /* -- changement / définition de mot de passe -- */
  if (p === "/api/motdepasse" && req.method === "POST") {
    const nouveau = String(corps.nouveau || "");
    if (nouveau.length < 10) return json({ erreur: "mot_de_passe_trop_court" }, 400);
    let cible = null;
    if (corps.invite) {   // via lien d'invitation
      cible = await env.DB.prepare("SELECT * FROM utilisateurs WHERE invite_token = ? AND invite_expire > ?")
        .bind(String(corps.invite), Date.now()).first();
      if (!cible) return json({ erreur: "invitation_invalide" }, 400);
    } else if (u) {
      cible = await env.DB.prepare("SELECT * FROM utilisateurs WHERE id = ?").bind(u.id).first();
      const ancien = String(corps.ancien || "");
      if (!egaliteConstante(await pbkdf2(ancien, cible.sel), cible.hash)) return json({ erreur: "ancien_incorrect" }, 401);
    } else return json({ erreur: "non_connecte" }, 401);
    const sel = alea(16);
    const h = await pbkdf2(nouveau, sel);
    await env.DB.prepare("UPDATE utilisateurs SET sel = ?, hash = ?, doit_changer_mdp = 0, invite_token = NULL, invite_expire = NULL WHERE id = ?")
      .bind(sel, h, cible.id).run();
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(cible.id).run(); // révoque les anciennes sessions
    const token = alea(32);
    await env.DB.prepare("INSERT INTO sessions (token, user_id, expire_le) VALUES (?,?,?)").bind(token, cible.id, Date.now() + SESSION_MS).run();
    await journal(env, req, { id: cible.id, email: cible.email }, "motdepasse_defini");
    return json({ ok: true }, 200, { "set-cookie": cookieSession(token, SESSION_MS / 1000) });
  }

  /* -- demande d'accès (publique) → e-mail immédiat aux 2 admins -- */
  if (p === "/api/demande-acces" && req.method === "POST") {
    const nom = String(corps.nom || "").trim().slice(0, 120);
    const prenom = String(corps.prenom || "").trim().slice(0, 80);      /* ligne séparée depuis le 04/09 */
    const email = String(corps.email || "").trim().toLowerCase().slice(0, 200);
    const motif = String(corps.motif || "").trim().slice(0, 500);
    /* fonction (poste) : remplace le motif dans le formulaire — sert la signature
       automatique des courriers externes (lettres CADA, réservations) */
    const fonction = String(corps.fonction || "").trim().slice(0, 120);
    /* entité obligatoire ; agences obligatoires (≥1) si AB Service */
    const entite = ENTITES.includes(corps.entite) ? corps.entite : null;
    const agences = entite === "abservice" ? validerAgences(corps.agences) : null;
    if (!nom || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ erreur: "champs_invalides" }, 400);
    if (!entite) return json({ erreur: "entite_requise" }, 400);
    if (entite === "abservice" && (!agences || JSON.parse(agences).length === 0)) return json({ erreur: "agence_requise" }, 400);
    const existant = await env.DB.prepare("SELECT id FROM utilisateurs WHERE email = ?").bind(email).first();
    if (existant) return json({ erreur: "deja_utilisateur" }, 400);
    const attente = await env.DB.prepare("SELECT id FROM demandes_acces WHERE email = ? AND statut = 'en_attente'").bind(email).first();
    if (attente) return json({ ok: true, deja: true });
    /* langue de l'espace (tous) ; prestataire externe : société obligatoire, téléphone, pays de sourcing */
    const langue = LANGUES.includes(corps.langue) ? corps.langue : "fr";
    const societe = String(corps.societe || "").trim().slice(0, 120);
    const telephone = String(corps.telephone || "").trim().slice(0, 40);
    const pays = String(corps.pays || "").trim().slice(0, 40);
    if (entite === "prestataire" && !societe) return json({ erreur: "societe_requise" }, 400);
    await env.DB.prepare("INSERT INTO demandes_acces (nom, prenom, email, motif, entite, agences, fonction, societe, telephone, langue, pays) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(nom, prenom || null, email, motif, entite, agences, fonction || null, societe || null, telephone || null, langue, pays || null).run();
    await journal(env, req, null, "demande_acces", email + " (" + entite + (agences ? " " + agences : "") + ")");
    await envoyerEmail(env, ADMINS, (entite === "abservice" ? "AB Service" : "AB2Pro") + " — demande d'accès de " + (prenom ? prenom + " " : "") + nom,
      `Nouvelle demande d'accès au portail :\n\nNom : ${prenom ? prenom + " " : ""}${nom}\nE-mail : ${email}\n` +
      `Fonction : ${fonction || "(non précisée)"}\n` +
      `Entité : ${entite === "abservice" ? "AB SERVICE" : entite === "prestataire" ? "PRESTATAIRE (recruteur externe) — " + societe + " · " + pays + " · " + telephone : "AB2PRO"} · langue ${langue}\n` +
      (agences ? `Agences de rattachement : ${JSON.parse(agences).join(", ")}\n` : "") +
      `Approuver ou refuser : ${url.origin}/admin (onglet Demandes).`, { env, req });
    return json({ ok: true });
  }

  /* -- demande de fiche IDCC (utilisateur connecté) → base + e-mail immédiat aux admins -- */
  if (p === "/api/demande-fiche" && req.method === "POST") {
    if (!u) return json({ erreur: "non_connecte" }, 401);
    const idcc = String(corps.idcc || "").trim();
    if (!/^\d{2,4}$/.test(idcc)) return json({ erreur: "idcc_invalide" }, 400);
    const attente = await env.DB.prepare("SELECT id FROM demandes_fiches WHERE idcc = ? AND statut = 'en_attente'").bind(idcc).first();
    if (attente) return json({ ok: true, deja: true });
    await env.DB.prepare("INSERT INTO demandes_fiches (idcc, demandeur_email, demandeur_nom) VALUES (?,?,?)")
      .bind(idcc, u.email, nomComplet(u)).run();
    await journal(env, req, u, "demande_fiche", idcc);
    await envoyerEmail(env, ADMINS, "AB2Pro — demande de fiche IDCC " + idcc,
      `${nomComplet(u) || u.email} (${u.email}) demande l'ajout de la fiche de la convention IDCC ${idcc} dans Veille Conventions.\n\n` +
      `Traitement automatique : sous ~30 minutes, la fiche est constituée sur sources officielles, déployée, et le demandeur est prévenu par e-mail.\n` +
      `Pour la créer immédiatement : demandez-le à Claude.`, { env, req });
    return json({ ok: true });
  }

  /* -- point d'envoi des routines (clé secrète NOTIFY_KEY) : expéditeur du domaine, destinataires =
   *    tous les admins ACTIFS de la base (dynamique), ou une liste explicite via "dest" -- */
  if (p === "/api/notifier" && req.method === "POST") {
    const cle = req.headers.get("x-notify-key") || "";
    if (!env.NOTIFY_KEY || !egaliteConstante(cle, env.NOTIFY_KEY)) return json({ erreur: "cle_invalide" }, 403);
    const sujet = String(corps.sujet || "").slice(0, 200);
    const texte = String(corps.texte || "").slice(0, 20000);
    if (!sujet || !texte) return json({ erreur: "champs_manquants" }, 400);
    let dests = Array.isArray(corps.dest) && corps.dest.length
      ? corps.dest.map(d => String(d).trim().toLowerCase()).filter(d => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d)).slice(0, 20)
      : (await env.DB.prepare("SELECT email FROM utilisateurs WHERE role IN ('admin','super_admin') AND actif = 1").all()).results.map(r => r.email);
    const res = await envoyerEmail(env, dests, sujet, texte, { env, req });
    await journal(env, req, null, "notifier", sujet.slice(0, 120) + " → " + dests.join(","));
    return json({ resultats: res.map(r => ({ destinataire: r.dest, ok: r.ok, status: r.status })) });
  }


  /* ===== ESPACE PRESTATAIRES (recruteurs partenaires externes — décision direction 04/09/2026) =====
   * Un prestataire ne voit que ses données ; les admins voient tout. Règles contractuelles (annexe 1) :
   * commission uniquement sur les heures travaillées ET facturées, 0,70 €/h qualifié · 0,50 €/h autre
   * (ou paliers par prestataire), tableau du mois validé avec les heures avant le 12. */
  if (p.startsWith("/api/prest/")) {
    if (!u) return json({ erreur: "non_connecte" }, 401);
    const admin = estAdmin(u);
    const estPrest = u.entite === "prestataire" && !!u.prestataire_id;
    if (!admin && !estPrest) return json({ erreur: "reserve_prestataires" }, 403);
    const moi = estPrest ? await env.DB.prepare("SELECT * FROM prestataires WHERE id = ? AND actif = 1").bind(u.prestataire_id).first() : null;
    if (estPrest && !moi) return json({ erreur: "prestataire_inactif" }, 403);
    const pid = estPrest ? moi.id : (parseInt(url.searchParams.get("prestataire_id") || corps.prestataire_id || "0", 10) || null);
    const semaineISO = d => { const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const j = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() + 4 - j); const a = new Date(Date.UTC(x.getUTCFullYear(), 0, 1)); return x.getUTCFullYear() + "-W" + String(Math.ceil(((x - a) / 86400000 + 1) / 7)).padStart(2, "0"); };
    /* horloge Paris : la « semaine courante » est la même pour toutes les routes (moi, propositions, commandes) */
    const parisNow = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" }));
    const semaineCourante = () => semaineISO(parisNow());
    const semaineDe = str => /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(str || "") ? str : null;
    const lundiDe = sem => { const [y, w] = sem.split("-W").map(Number); const j4 = new Date(Date.UTC(y, 0, 4)); const lundi = new Date(j4); lundi.setUTCDate(j4.getUTCDate() - ((j4.getUTCDay() || 7) - 1) + (w - 1) * 7); return lundi; };
    const dateFR = iso => /^\d{4}-\d{2}-\d{2}$/.test(iso || "") ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : (iso || "");
    const periodeDe = sem => { const lu = lundiDe(sem), ve = new Date(lu.getTime() + 4 * 86400000); return dateFR(lu.toISOString().slice(0, 10)) + " – " + dateFR(ve.toISOString().slice(0, 10)); };
    const libSemaine = sem => "semaine " + String(parseInt(sem.slice(6), 10)) + " (" + periodeDe(sem) + ")";
    const majNom = x => String(x || "").trim().toUpperCase().slice(0, 60);
    const majPrenom = x => String(x || "").trim().toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).slice(0, 60);
    const tauxDe = (pr, qualifie, nbTT) => {
      try { const pal = pr.paliers ? JSON.parse(pr.paliers) : null;
        if (Array.isArray(pal) && pal.length) { for (const s of pal) if (s.jusqua == null || nbTT <= s.jusqua) return +s.taux; return +pal[pal.length - 1].taux; }
      } catch (e) {}
      return qualifie ? +pr.tarif_q : +pr.tarif_nq;
    };
    /* --- profil + documents --- */
    if (p === "/api/prest/moi") {
      const docs = (await env.DB.prepare("SELECT id, prestataire_id, titre, fichier, langue FROM documents WHERE prestataire_id IS NULL" + (pid ? " OR prestataire_id = ?" : "") + " ORDER BY prestataire_id IS NULL DESC, id").bind(...(pid ? [pid] : [])).all()).results;
      /* décisions (équipes retenues / refusées) pas encore vues par le prestataire → bandeau à l'ouverture */
      const decisions = moi ? (await env.DB.prepare("SELECT p.semaine, p.equipe, p.statut, COUNT(*) AS n, MAX(p.decision_le) AS decision_le, MAX(c.numero) AS numero, MAX(p.commande_ref) AS commande_ref, MAX(p.agence) AS agence FROM propositions p LEFT JOIN commandes c ON c.id = p.commande_id WHERE p.prestataire_id = ? AND p.vu = 0 AND p.statut <> 'proposee' GROUP BY p.semaine, p.equipe, p.statut ORDER BY p.decision_le DESC LIMIT 30").bind(moi.id).all()).results : [];
      return json({ admin, decisions, prestataire: moi ? { id: moi.id, societe: moi.societe, code: moi.code, contact: moi.contact, langue: moi.langue, tarif_q: moi.tarif_q, tarif_nq: moi.tarif_nq, paliers: moi.paliers } : null,
                    langue: u.langue || (moi && moi.langue) || "fr", semaine: semaineCourante(), mois: parisNow().toISOString().slice(0, 7),
                    documents: docs.map(d => ({ id: d.id, titre: d.titre, langue: d.langue, url: "/app/data/prestataires/" + d.fichier, commun: d.prestataire_id == null })) });
    }
    if (p === "/api/prest/decisions/vu" && req.method === "POST") {
      if (!estPrest) return json({ erreur: "reserve_prestataires" }, 403);
      await env.DB.prepare("UPDATE propositions SET vu = 1 WHERE prestataire_id = ? AND vu = 0 AND statut <> 'proposee'").bind(moi.id).run();
      return json({ ok: true });
    }
    /* --- commandes classées par semaine : import (brouillon) → publication (visible des prestataires) → archive après le vendredi.
       UNE LIGNE PAR (numéro, semaine) : une commande reconduite est recopiée dans la nouvelle semaine, l'archive de la précédente reste intacte. --- */
    /* archivée = semaine passée, ou semaine courante à partir du samedi (modifiable « jusqu'au vendredi ») */
    const estArchivee = sem => { const now = semaineCourante(); return sem < now || (sem === now && [0, 6].includes(parisNow().getDay())); };
    const semaineSuivante = sem => semaineISO(new Date(lundiDe(sem).getTime() + 7 * 86400000));
    const libCmd = c => c.titre + (c.lieu && !String(c.titre).toUpperCase().endsWith(String(c.lieu).toUpperCase()) ? " · " + c.lieu : "") + " · " + c.agence + " · n° " + c.numero + (c.date_debut ? " · début " + dateFR(c.date_debut) : "");
    /* nombre de postes : colonne dédiée, sinon le nombre en tête du titre (« 2/3 POSEURS » → 3, « 2 x 2 CHARPENTIERS » → 4) */
    const nbPostesDe = (titre, nb) => { if (nb > 0) return nb; const m = String(titre).match(/^(\d{1,2})(?:\s*([\/x×])\s*(\d{1,2}))?\s/i); if (!m) return 1; const a = +m[1], b = +(m[3] || 0); return m[2] && /[x×]/i.test(m[2]) ? a * b : Math.max(a, b); };
    if (p === "/api/prest/commandes") {
      if (admin) {
        const cour = semaineCourante();
        const sem = semaineDe(url.searchParams.get("semaine")) || (estArchivee(cour) ? semaineSuivante(cour) : cour);
        const rows = (await env.DB.prepare("SELECT * FROM commandes WHERE semaine = ? ORDER BY statut = 'ouverte' DESC, agence, numero").bind(sem).all()).results;
        const semaines = (await env.DB.prepare("SELECT semaine, COUNT(*) AS n, SUM(publiee = 1 AND statut = 'ouverte') AS publiees, SUM(statut = 'ouverte') AS ouvertes FROM commandes WHERE semaine IS NOT NULL GROUP BY semaine ORDER BY semaine DESC LIMIT 80").all()).results;
        return json({ semaine: sem, periode: periodeDe(sem), semaine_courante: cour, archivee: estArchivee(sem), commandes: rows, semaines });
      }
      /* prestataire : uniquement les commandes publiées, ouvertes, de la semaine courante et des suivantes (le chargé reste interne) */
      const r = await env.DB.prepare("SELECT id, numero, date_debut, nb_postes, titre, agence, lieu, statut, semaine FROM commandes WHERE publiee = 1 AND statut = 'ouverte' AND semaine >= ? ORDER BY semaine, agence, numero").bind(semaineCourante()).all();
      return json({ semaine_courante: semaineCourante(), commandes: r.results });
    }
    if (p === "/api/prest/admin/commandes" && req.method === "POST") {
      if (!admin) return json({ erreur: "reserve_admin" }, 403);
      const sem = semaineDe(corps.semaine) || semaineCourante();
      if (estArchivee(sem)) return json({ erreur: "semaine_archivee" }, 409);
      const lignes = Array.isArray(corps.lignes) ? corps.lignes.slice(0, 300) : [];
      const numeros = []; let nouvelles = 0, modifiees = 0;
      for (const l of lignes) {
        const num = String(l.numero || "").trim().slice(0, 20); if (!num || numeros.includes(num)) continue;
        numeros.push(num);
        const titre = String(l.titre || "").trim().slice(0, 120); if (!titre) continue;
        const nb = nbPostesDe(titre, parseInt(l.nb_postes, 10) || 0);
        const dIso = /^\d{4}-\d{2}-\d{2}$/.test(String(l.date_debut || "").trim()) ? String(l.date_debut).trim() : "";
        const v = [dIso, nb, titre, String(l.agence || "").trim().toUpperCase().slice(0, 60), String(l.lieu || "").trim().toUpperCase().slice(0, 80), String(l.charge || "").trim().slice(0, 80)];
        const ex = await env.DB.prepare("SELECT id FROM commandes WHERE numero = ? AND semaine = ? ORDER BY id DESC LIMIT 1").bind(num, sem).first();
        /* même semaine : mise à jour (une commande déjà publiée reste visible avec ses nouvelles valeurs) ; sinon nouvelle ligne en brouillon */
        if (ex) { await env.DB.prepare("UPDATE commandes SET date_debut = ?, nb_postes = ?, titre = ?, agence = ?, lieu = ?, charge = ?, statut = 'ouverte', maj_le = datetime('now') WHERE id = ?").bind(...v, ex.id).run(); modifiees++; }
        else { await env.DB.prepare("INSERT INTO commandes (numero, date_debut, nb_postes, titre, agence, lieu, charge, semaine, publiee, maj_le) VALUES (?,?,?,?,?,?,?,?,0,datetime('now'))").bind(num, ...v, sem).run(); nouvelles++; }
      }
      let fermees = 0;
      if (corps.fermer_absentes && numeros.length) {
        const r = await env.DB.prepare("UPDATE commandes SET statut = 'fermee', maj_le = datetime('now') WHERE semaine = ? AND statut = 'ouverte' AND numero NOT IN (SELECT value FROM json_each(?))").bind(sem, JSON.stringify(numeros)).run();
        fermees = (r.meta && r.meta.changes) || 0;
      }
      await journal(env, req, u, "prest_commandes_import", sem + " : " + nouvelles + " nouvelle(s), " + modifiees + " mise(s) à jour, " + fermees + " fermée(s)");
      return json({ ok: true, n: nouvelles + modifiees, nouvelles, modifiees, fermees, semaine: sem });
    }
    if (p === "/api/prest/admin/commande" && req.method === "POST") {
      if (!admin) return json({ erreur: "reserve_admin" }, 403);
      const c = await env.DB.prepare("SELECT * FROM commandes WHERE id = ?").bind(corps.id | 0).first();
      if (!c) return json({ erreur: "commande_introuvable" }, 404);
      if (c.semaine && estArchivee(c.semaine)) return json({ erreur: "semaine_archivee" }, 409);
      const champs = [], vals = [];
      if (corps.numero != null) { const n = String(corps.numero).trim().slice(0, 20); if (!n) return json({ erreur: "numero_requis" }, 400); champs.push("numero = ?"); vals.push(n); }
      if (corps.date_debut != null) { const d = String(corps.date_debut).trim(); if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return json({ erreur: "date_invalide" }, 400); champs.push("date_debut = ?"); vals.push(d); }
      if (corps.nb_postes != null) { champs.push("nb_postes = ?"); vals.push(Math.max(1, parseInt(corps.nb_postes, 10) || 1)); }
      if (corps.titre != null) { const t = String(corps.titre).trim().slice(0, 120); if (!t) return json({ erreur: "titre_requis" }, 400); champs.push("titre = ?"); vals.push(t); }
      if (corps.agence != null) { champs.push("agence = ?"); vals.push(String(corps.agence).trim().toUpperCase().slice(0, 60)); }
      if (corps.lieu != null) { champs.push("lieu = ?"); vals.push(String(corps.lieu).trim().toUpperCase().slice(0, 80)); }
      if (corps.charge != null) { champs.push("charge = ?"); vals.push(String(corps.charge).trim().slice(0, 80)); }
      if (corps.statut != null) { if (!["ouverte", "pourvue", "fermee"].includes(corps.statut)) return json({ erreur: "statut_invalide" }, 400); champs.push("statut = ?"); vals.push(corps.statut); }
      if (corps.semaine != null) { const sm = semaineDe(corps.semaine); if (!sm || estArchivee(sm)) return json({ erreur: "semaine_invalide" }, 400); champs.push("semaine = ?"); vals.push(sm); }
      if (!champs.length) return json({ erreur: "rien_a_modifier" }, 400);
      champs.push("maj_le = datetime('now')");
      try { await env.DB.prepare("UPDATE commandes SET " + champs.join(", ") + " WHERE id = ?").bind(...vals, c.id).run(); }
      catch (e) { return json({ erreur: /UNIQUE/i.test(String(e)) ? "numero_deja_dans_semaine" : "serveur" }, 409); }
      await journal(env, req, u, "prest_commande_maj", c.numero + " : " + champs.map(x => x.split(" =")[0]).join(", "));
      return json({ ok: true });
    }
    /* publication : les commandes ouvertes de la semaine deviennent visibles ; e-mail aux prestataires actifs (dans leur langue) sur demande */
    if (p === "/api/prest/admin/publier" && req.method === "POST") {
      if (!admin) return json({ erreur: "reserve_admin" }, 403);
      const sem = semaineDe(corps.semaine); if (!sem) return json({ erreur: "semaine_invalide" }, 400);
      if (estArchivee(sem)) return json({ erreur: "semaine_archivee" }, 409);
      await env.DB.prepare("UPDATE commandes SET publiee = 1, publiee_le = CASE WHEN publiee = 0 THEN datetime('now') ELSE publiee_le END WHERE semaine = ? AND statut = 'ouverte'").bind(sem).run();
      const rows = (await env.DB.prepare("SELECT numero, date_debut, nb_postes, titre, agence, lieu FROM commandes WHERE semaine = ? AND statut = 'ouverte' ORDER BY agence, numero").bind(sem).all()).results;
      let prevenus = 0, echecs = 0;
      if (corps.prevenir && rows.length) {
        const lignes = rows.map(c => "• " + libCmd(c)).join("\n");
        const lien = url.origin + "/app/prestataires.html", per = periodeDe(sem), no = String(parseInt(sem.slice(6), 10));
        const M = {
          fr: { s: "AB2PRO — commandes de la semaine " + no + " (" + per + ") : " + rows.length, b: "Bonjour,\n\nAB2PRO vient de publier les commandes de la semaine " + no + " (" + per + ") sur le portail :\n\n" + lignes + "\n\nProposez vos candidats dans l'onglet « Proposer une équipe » : " + lien + "\n\n— AB2PRO" },
          en: { s: "AB2PRO — job orders for week " + no + " (" + per + "): " + rows.length, b: "Hello,\n\nAB2PRO has just published the job orders for week " + no + " (" + per + ") on the portal:\n\n" + lignes + "\n\nPropose your candidates in the “Propose a team” tab: " + lien + "\n\n— AB2PRO" },
          ro: { s: "AB2PRO — comenzile săptămânii " + no + " (" + per + "): " + rows.length, b: "Bună ziua,\n\nAB2PRO a publicat comenzile săptămânii " + no + " (" + per + ") pe portal:\n\n" + lignes + "\n\nPropuneți candidații în fila „Propuneți o echipă”: " + lien + "\n\n— AB2PRO" },
          hu: { s: "AB2PRO — a " + no + ". hét megrendelései (" + per + "): " + rows.length, b: "Tisztelt Partnerünk!\n\nAz AB2PRO közzétette a " + no + ". hét (" + per + ") megrendeléseit a portálon:\n\n" + lignes + "\n\nJelöltjeit a „Csapat javaslása” fülön ajánlhatja: " + lien + "\n\n— AB2PRO" },
        };
        const prs = (await env.DB.prepare("SELECT email, langue FROM prestataires WHERE actif = 1 AND email <> ''").all()).results;
        for (const pr of prs) { const m = M[LANGUES.includes(pr.langue) ? pr.langue : "fr"]; const res = await envoyerEmail(env, pr.email, m.s, m.b, { env, req }); if (res.some(x => x.ok)) prevenus++; else echecs++; }
      }
      await journal(env, req, u, "prest_commandes_publiees", sem + " : " + rows.length + " commande(s)" + (prevenus ? ", " + prevenus + " prestataire(s) prévenu(s)" : "") + (echecs ? ", " + echecs + " e-mail(s) en échec" : ""));
      return json({ ok: true, n: rows.length, prevenus, echecs, semaine: sem, periode: periodeDe(sem) });
    }
    /* --- propositions d'équipes (hebdo) --- */
    if (p === "/api/prest/propositions" && req.method === "GET") {
      const sem = url.searchParams.get("semaine") || "";
      const q = "SELECT p.*, c.numero, c.titre AS commande_titre, c.lieu AS commande_lieu, c.agence AS commande_agence, pr.societe, pr.code FROM propositions p LEFT JOIN commandes c ON c.id = p.commande_id JOIN prestataires pr ON pr.id = p.prestataire_id WHERE " +
        (pid ? "p.prestataire_id = ? AND " : "") + (sem ? "p.semaine = ? " : "1=1 ") + "ORDER BY p.semaine DESC, p.prestataire_id, p.equipe, p.id LIMIT 500";
      const args = []; if (pid) args.push(pid); if (sem) args.push(sem);
      return json({ propositions: (await env.DB.prepare(q).bind(...args).all()).results });
    }
    if (p === "/api/prest/propositions" && req.method === "POST") {
      if (!estPrest) return json({ erreur: "reserve_prestataires" }, 403);
      const semCour = semaineCourante();
      /* semaine visée par le prestataire : de la semaine courante à +8 semaines (une équipe rattachée à une commande suit la semaine de la commande) */
      let sem = semaineDe(corps.semaine) || semCour; if (sem < semCour) sem = semCour;
      const semMax = semaineISO(new Date(lundiDe(semCour).getTime() + 8 * 7 * 86400000)); if (sem > semMax) sem = semMax;
      const lignes = Array.isArray(corps.lignes) ? corps.lignes.slice(0, 100) : [];
      /* commande : id choisi dans la liste OU n° saisi — mêmes critères que la liste vue par le prestataire (publiée, ouverte, à venir) */
      const cmdDe = async (id, ref) => id
        ? env.DB.prepare("SELECT id, numero, titre, lieu, agence, semaine FROM commandes WHERE id = ? AND publiee = 1 AND statut = 'ouverte' AND semaine >= ?").bind(id, semCour).first()
        : ref ? env.DB.prepare("SELECT id, numero, titre, lieu, agence, semaine FROM commandes WHERE numero = ? AND publiee = 1 AND statut = 'ouverte' AND semaine >= ? ORDER BY semaine, id DESC LIMIT 1").bind(ref, semCour).first() : null;
      /* 1) regroupement par équipe locale et validation complète AVANT toute insertion */
      const locales = new Map();
      for (const l of lignes) { const k = Math.min(20, Math.max(1, parseInt(l.equipe, 10) || 1)); if (!locales.has(k)) locales.set(k, []); locales.get(k).push(l); }
      const equipes = [];
      for (const [k, ls] of [...locales.entries()].sort((a, b) => a[0] - b[0])) {
        const membres = ls.map(l => ({ nom: majNom(l.nom), prenom: majPrenom(l.prenom), metier: String(l.metier || "").toUpperCase().slice(0, 40), vehicule: l.vehicule ? 1 : 0,
          salaire_net: String(l.salaire_net || "").slice(0, 20), telephone: String(l.telephone || "").slice(0, 30), remarques: String(l.remarques || "").slice(0, 300) }))
          .filter(m => m.nom && m.prenom && m.metier).slice(0, 5);
        if (!membres.length) continue;
        const l0 = ls[0], id = parseInt(l0.commande_id, 10) || 0, ref = String(l0.commande_ref || "").trim().slice(0, 20);
        const cmd = await cmdDe(id, ref);
        if (id && !cmd) return json({ erreur: "commande_invalide", equipe: k }, 400);   /* fermée ou dépubliée depuis l'ouverture de la page */
        const agence = String(l0.agence || "").toUpperCase().trim().slice(0, 60) || (cmd && cmd.agence) || "";
        equipes.push({ local: k, cmd, ref: cmd ? "" : ref, agence, semaine: (cmd && cmd.semaine) || sem, membres, num: 0 });
      }
      if (!equipes.length) return json({ erreur: "aucune_equipe" }, 400);
      /* 2) numérotation continue PAR semaine cible (une proposition du week-end pour une commande de la semaine suivante y est classée) */
      const bases = {};
      const prochainNum = async sm => { if (!(sm in bases)) { const d = await env.DB.prepare("SELECT COALESCE(MAX(equipe), 0) AS m FROM propositions WHERE prestataire_id = ? AND semaine = ?").bind(moi.id, sm).first(); bases[sm] = (d && d.m) || 0; } return ++bases[sm]; };
      let n = 0;
      for (const e of equipes) {
        e.num = await prochainNum(e.semaine);
        for (const m of e.membres) {
          await env.DB.prepare("INSERT INTO propositions (prestataire_id, user_id, commande_id, commande_ref, semaine, equipe, nom, prenom, metier, vehicule, salaire_net, telephone, remarques, agence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(moi.id, u.id, e.cmd ? e.cmd.id : null, e.ref || null, e.semaine, e.num, m.nom, m.prenom, m.metier, m.vehicule, m.salaire_net, m.telephone, m.remarques, e.agence).run();
          n++;
        }
      }
      await journal(env, req, u, "prest_proposition", moi.code + " : " + equipes.map(e => libSemaine(e.semaine) + " équipe " + e.num + " (" + e.membres.length + ")").join(", "));
      const detail = equipes.map(e => "Équipe " + e.num + " — " + libSemaine(e.semaine) + (e.cmd ? " — commande n° " + e.cmd.numero + " · " + e.cmd.titre + (e.cmd.lieu ? " · " + e.cmd.lieu : "") : e.ref ? " — commande n° " + e.ref + " (n° saisi, non trouvée dans les commandes publiées)" : "") +
        (e.agence ? " — " + e.agence : "") + " (" + e.membres.length + ") :\n" +
        e.membres.map(m => "    • " + m.nom + " " + m.prenom + " — " + m.metier + (m.vehicule ? " · véhicule" : "") + (m.salaire_net ? " · " + m.salaire_net + " €" : "") + (m.telephone ? " · " + m.telephone : "")).join("\n")).join("\n\n");
      await envoyerEmail(env, ADMINS, "Prestataire " + moi.societe + " — " + equipes.length + " équipe(s) proposée(s) (" + n + " candidat(s))",
        "Nouvelle proposition déposée sur le portail par " + moi.societe + " (" + moi.code + ") : " + equipes.length + " équipe(s), " + n + " candidat(s).\n\n" + detail +
        "\n\nRetenir ou refuser chaque équipe : " + url.origin + "/app/prestataires.html (onglet Propositions)", { env, req });
      return json({ ok: true, n, equipes: equipes.map(e => ({ num: e.num, semaine: e.semaine, n: e.membres.length })) });
    }
    /* information du prestataire à chaque décision : bandeau dans son espace (decision_le / vu) + e-mail dans sa langue */
    const informerDecision = async (pid, sem, eq, st) => {
      const pr = await env.DB.prepare("SELECT * FROM prestataires WHERE id = ?").bind(pid).first(); if (!pr) return 0;
      const membres = (await env.DB.prepare("SELECT p.nom, p.prenom, p.metier, p.agence, p.commande_ref, c.numero, c.titre, c.lieu FROM propositions p LEFT JOIN commandes c ON c.id = p.commande_id WHERE p.prestataire_id = ? AND p.semaine = ? AND p.equipe = ? ORDER BY p.id").bind(pid, sem, eq).all()).results;
      if (!membres.length) return 0;
      const m0 = membres[0], cmd = m0.numero ? "n° " + m0.numero + " · " + m0.titre + (m0.lieu ? " · " + m0.lieu : "") : m0.commande_ref ? "n° " + m0.commande_ref : "";
      const noms = membres.map(m => m.nom + " " + m.prenom + " (" + m.metier + ")").join(", ");
      const lien = url.origin + "/app/prestataires.html", lg = LANGUES.includes(pr.langue) ? pr.langue : "fr", no = String(parseInt(sem.slice(6), 10)), per = periodeDe(sem);
      const M = {
        fr: { s: "AB2PRO — équipe " + eq + " " + (st === "retenue" ? "RETENUE" : st === "refusee" ? "refusée" : "remise en attente") + " (semaine " + no + ")",
              b: "Bonjour,\n\nVotre équipe " + eq + " — semaine " + no + " (" + per + ")" + (cmd ? " — commande " + cmd : "") + (m0.agence ? " — " + m0.agence : "") + "\n" + noms + "\n\n" + (st === "retenue" ? "est RETENUE : l'agence vous contacte pour organiser la suite (dates, logement, documents)." : st === "refusee" ? "n'a pas été retenue." : "est remise en attente.") + "\n\nSuivi dans votre espace : " + lien + "\n\n— AB2PRO" },
        en: { s: "AB2PRO — team " + eq + " " + (st === "retenue" ? "SELECTED" : st === "refusee" ? "declined" : "back to pending") + " (week " + no + ")",
              b: "Hello,\n\nYour team " + eq + " — week " + no + " (" + per + ")" + (cmd ? " — job order " + cmd : "") + (m0.agence ? " — " + m0.agence : "") + "\n" + noms + "\n\n" + (st === "retenue" ? "is SELECTED: the agency will contact you to organise the next steps (dates, housing, documents)." : st === "refusee" ? "was not selected." : "is back to pending.") + "\n\nFollow-up in your space: " + lien + "\n\n— AB2PRO" },
        ro: { s: "AB2PRO — echipa " + eq + " " + (st === "retenue" ? "REȚINUTĂ" : st === "refusee" ? "refuzată" : "repusă în așteptare") + " (săptămâna " + no + ")",
              b: "Bună ziua,\n\nEchipa dvs. " + eq + " — săptămâna " + no + " (" + per + ")" + (cmd ? " — comanda " + cmd : "") + (m0.agence ? " — " + m0.agence : "") + "\n" + noms + "\n\n" + (st === "retenue" ? "este REȚINUTĂ: agenția vă va contacta pentru pașii următori (date, cazare, documente)." : st === "refusee" ? "nu a fost reținută." : "este repusă în așteptare.") + "\n\nUrmărire în spațiul dvs.: " + lien + "\n\n— AB2PRO" },
        hu: { s: "AB2PRO — " + eq + ". csapat " + (st === "retenue" ? "KIVÁLASZTVA" : st === "refusee" ? "elutasítva" : "újra függőben") + " (" + no + ". hét)",
              b: "Tisztelt Partnerünk!\n\nAz Ön " + eq + ". csapata — " + no + ". hét (" + per + ")" + (cmd ? " — megrendelés " + cmd : "") + (m0.agence ? " — " + m0.agence : "") + "\n" + noms + "\n\n" + (st === "retenue" ? "KIVÁLASZTVA: az iroda felveszi Önnel a kapcsolatot a következő lépésekhez (időpontok, szállás, dokumentumok)." : st === "refusee" ? "nem került kiválasztásra." : "újra függőben van.") + "\n\nNyomon követés a felületén: " + lien + "\n\n— AB2PRO" },
      }[lg];
      const dests = new Set([pr.email].filter(Boolean));
      (await env.DB.prepare("SELECT email FROM utilisateurs WHERE prestataire_id = ? AND actif = 1").bind(pid).all()).results.forEach(x => dests.add(x.email));
      let ok = 0; for (const d of dests) { const r = await envoyerEmail(env, d, M.s, M.b, { env, req }); if (r.some(x => x.ok)) ok++; }
      return ok;
    };
    if (p === "/api/prest/admin/proposition" && req.method === "POST") {
      if (!admin) return json({ erreur: "reserve_admin" }, 403);
      const st = ["proposee", "retenue", "refusee"].includes(corps.statut) ? corps.statut : "proposee";
      const row = await env.DB.prepare("SELECT prestataire_id, semaine, equipe FROM propositions WHERE id = ?").bind(corps.id | 0).first();
      await env.DB.prepare("UPDATE propositions SET statut = ?, decision_le = datetime('now'), vu = 0 WHERE id = ?").bind(st, corps.id | 0).run();
      const prevenus = row ? await informerDecision(row.prestataire_id, row.semaine, row.equipe, st) : 0;
      return json({ ok: true, prevenus });
    }
    /* décision par ÉQUIPE : les agences acceptent ou refusent une équipe entière */
    if (p === "/api/prest/admin/equipe" && req.method === "POST") {
      if (!admin) return json({ erreur: "reserve_admin" }, 403);
      const st = ["proposee", "retenue", "refusee"].includes(corps.statut) ? corps.statut : null;
      if (!st || !semaineDe(corps.semaine)) return json({ erreur: "parametres_invalides" }, 400);
      const r = await env.DB.prepare("UPDATE propositions SET statut = ?, decision_le = datetime('now'), vu = 0 WHERE prestataire_id = ? AND semaine = ? AND equipe = ?").bind(st, corps.prestataire_id | 0, corps.semaine, corps.equipe | 0).run();
      const prevenus = await informerDecision(corps.prestataire_id | 0, corps.semaine, corps.equipe | 0, st);
      await journal(env, req, u, "prest_equipe_statut", (corps.prestataire_id | 0) + " " + corps.semaine + " équipe " + (corps.equipe | 0) + " → " + st + " (" + ((r.meta && r.meta.changes) || 0) + " candidat(s), " + prevenus + " e-mail(s))");
      return json({ ok: true, n: (r.meta && r.meta.changes) || 0, prevenus });
    }
    /* --- déclaration mensuelle des candidats placés + heures (admin) --- */
    if (p === "/api/prest/declarations" && req.method === "GET") {
      const mois = url.searchParams.get("mois") || "";
      const q = "SELECT d.*, pr.societe, pr.code FROM declarations d JOIN prestataires pr ON pr.id = d.prestataire_id WHERE " +
        (pid ? "d.prestataire_id = ? AND " : "") + (mois ? "d.mois = ? " : "1=1 ") + "ORDER BY d.mois DESC, d.prestataire_id, d.nom, d.prenom LIMIT 800";
      const args = []; if (pid) args.push(pid); if (mois) args.push(mois);
      return json({ declarations: (await env.DB.prepare(q).bind(...args).all()).results });
    }
    if (p === "/api/prest/declarations" && req.method === "POST") {
      if (!estPrest) return json({ erreur: "reserve_prestataires" }, 403);
      const mois = /^\d{4}-(0[1-9]|1[0-2])$/.test(corps.mois || "") ? corps.mois : new Date().toISOString().slice(0, 7);
      const lignes = Array.isArray(corps.lignes) ? corps.lignes.slice(0, 200) : [];
      let n = 0, ignorees = 0;
      for (const l of lignes) {
        const nom = majNom(l.nom), prenom = majPrenom(l.prenom), metier = String(l.metier || "").toUpperCase().slice(0, 40);
        if (!nom || !prenom || !metier) continue;
        const doublon = await env.DB.prepare("SELECT id FROM declarations WHERE prestataire_id = ? AND mois = ? AND nom = ? AND prenom = ?").bind(moi.id, mois, nom, prenom).first();
        if (doublon) { ignorees++; continue; }
        await env.DB.prepare("INSERT INTO declarations (prestataire_id, user_id, mois, nom, prenom, metier, agence, qualifie, commentaire, matricule) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .bind(moi.id, u.id, mois, nom, prenom, metier, String(l.agence || "").toUpperCase().trim().slice(0, 60), l.qualifie ? 1 : 0, String(l.commentaire || "").slice(0, 200),
                String(l.matricule || "").toUpperCase().trim().slice(0, 30) || null).run();
        n++;
      }
      await journal(env, req, u, "prest_declaration", moi.code + " " + mois + " : " + n + " ligne(s)");
      if (n) await envoyerEmail(env, ADMINS, "Prestataire " + moi.societe + " — déclaration " + mois + " (" + n + " candidat(s))",
        moi.societe + " (" + moi.code + ") a déclaré " + n + " candidat(s) placé(s) pour " + mois + ". Heures à renseigner et à valider avant le 12 : " + url.origin + "/app/prestataires.html", { env, req });
      return json({ ok: true, n, ignorees, mois });
    }
    if (p === "/api/prest/declaration" && req.method === "POST") {   /* suppression par le prestataire (tant que non validée) */
      if (!estPrest) return json({ erreur: "reserve_prestataires" }, 403);
      await env.DB.prepare("DELETE FROM declarations WHERE id = ? AND prestataire_id = ? AND statut = 'declaree'").bind(corps.id | 0, moi.id).run();
      return json({ ok: true });
    }
    if (p === "/api/prest/admin/declaration" && req.method === "POST") {
      if (!admin) return json({ erreur: "reserve_admin" }, 403);
      const st = ["declaree", "validee", "rejetee"].includes(corps.statut) ? corps.statut : null;
      const h = corps.heures == null || corps.heures === "" ? null : Math.max(0, parseFloat(String(corps.heures).replace(",", ".")) || 0);
      await env.DB.prepare("UPDATE declarations SET heures = ?, qualifie = COALESCE(?, qualifie), statut = COALESCE(?, statut), valide_le = CASE WHEN ? = 'validee' THEN datetime('now') ELSE valide_le END, commentaire = COALESCE(?, commentaire), matricule = NULLIF(COALESCE(?, matricule), '') WHERE id = ?")
        .bind(h, corps.qualifie == null ? null : (corps.qualifie ? 1 : 0), st, st, corps.commentaire == null ? null : String(corps.commentaire).slice(0, 200),
              corps.matricule == null ? null : String(corps.matricule).toUpperCase().trim().slice(0, 30), corps.id | 0).run();
      return json({ ok: true });
    }
    /* --- facturation du mois (calcul contractuel) --- */
    if (p === "/api/prest/facture") {
      const mois = url.searchParams.get("mois") || new Date().toISOString().slice(0, 7);
      if (!pid) return json({ erreur: "prestataire_id_requis" }, 400);
      const pr = moi || await env.DB.prepare("SELECT * FROM prestataires WHERE id = ?").bind(pid).first();
      if (!pr) return json({ erreur: "prestataire_introuvable" }, 404);
      const lignes = (await env.DB.prepare("SELECT * FROM declarations WHERE prestataire_id = ? AND mois = ? ORDER BY nom, prenom").bind(pid, mois).all()).results;
      const nbTT = new Set(lignes.filter(l => l.statut === "validee" && l.heures > 0).map(l => l.nom + "|" + l.prenom)).size;
      let total = 0;
      const out = lignes.map(l => {
        const taux = tauxDe(pr, l.qualifie, nbTT);
        const montant = (l.statut === "validee" && l.heures > 0) ? Math.round(l.heures * taux * 100) / 100 : 0;
        total += montant;
        return { id: l.id, matricule: l.matricule, nom: l.nom, prenom: l.prenom, metier: l.metier, agence: l.agence, qualifie: l.qualifie, heures: l.heures, statut: l.statut, taux, montant, commentaire: l.commentaire };
      });
      return json({ mois, prestataire: { societe: pr.societe, code: pr.code }, nb_tt: nbTT, lignes: out, total: Math.round(total * 100) / 100,
                    regle: pr.paliers ? "paliers" : pr.tarif_q + "/" + pr.tarif_nq });
    }
    /* --- factures déposées par le recruteur : fichier sous CODE/factures/ (visible par lui et les admins seulement) --- */
    if (p === "/api/prest/factures") {
      const mois = url.searchParams.get("mois") || "";
      const q = "SELECT f.*, pr.societe, pr.code FROM factures_prest f JOIN prestataires pr ON pr.id = f.prestataire_id WHERE " +
        (pid ? "f.prestataire_id = ? AND " : "") + (mois ? "f.mois = ? " : "1=1 ") + "ORDER BY f.mois DESC, f.id DESC LIMIT 300";
      const args = []; if (pid) args.push(pid); if (mois) args.push(mois);
      const rows = (await env.DB.prepare(q).bind(...args).all()).results;
      return json({ factures: rows.map(r => ({ id: r.id, mois: r.mois, numero: r.numero, montant: r.montant, statut: r.statut, commentaire: r.commentaire, cree_le: r.cree_le,
                                              societe: r.societe, code: r.code, url: "/app/data/prestataires/" + r.fichier })) });
    }
    if (p === "/api/prest/facture/upload" && req.method === "POST") {
      if (!estPrest) return json({ erreur: "reserve_prestataires" }, 403);
      let fd; try { fd = await req.formData(); } catch (e) { return json({ erreur: "formulaire_invalide" }, 400); }
      const mois = /^\d{4}-(0[1-9]|1[0-2])$/.test(fd.get("mois") || "") ? fd.get("mois") : new Date().toISOString().slice(0, 7);
      const numero = String(fd.get("numero") || "").trim().slice(0, 40);
      const montantS = String(fd.get("montant") || "").replace(/\s/g, "").replace(",", ".");
      const vMont = Number(montantS);
      if (montantS && (!Number.isFinite(vMont) || vMont < 0)) return json({ erreur: "montant_invalide" }, 400);
      const montant = montantS ? Math.round(vMont * 100) / 100 : null;
      const deja = await env.DB.prepare("SELECT COUNT(*) AS n FROM factures_prest WHERE prestataire_id = ? AND mois = ?").bind(moi.id, mois).first();
      if (deja && deja.n >= 5) return json({ erreur: "trop_de_factures" }, 429);
      const st = await enregistrerFichier(env, u, moi.code + "/factures", fd.get("fichier"), ["pdf", "png", "jpg", "jpeg"], 10 * 1024 * 1024, mois + "-facture-");
      if (st.erreur) return json({ erreur: st.erreur }, st.erreur === "fichier_trop_gros" ? 413 : 400);
      const ins = await env.DB.prepare("INSERT INTO factures_prest (prestataire_id, mois, numero, montant, fichier, cree_par) VALUES (?,?,?,?,?,?)").bind(moi.id, mois, numero, montant, st.chemin, u.email).run();
      await journal(env, req, u, "prest_facture_depot", moi.code + " " + mois + " " + numero + (montant == null ? "" : " " + montant + " €"));
      await envoyerEmail(env, ADMINS, "Prestataire " + moi.societe + " — facture " + mois + (numero ? " n° " + numero : "") + (montant == null ? "" : " (" + montant + " € HT)"),
        "Une facture a été déposée sur le portail par " + moi.societe + " (" + moi.code + ") pour " + mois + ".\n" + (numero ? "N° " + numero + "\n" : "") + (montant == null ? "" : "Montant HT : " + montant + " €\n") +
        "\nÀ rapprocher du tableau validé du mois (onglet Déclarations & heures, bloc Factures reçues) : " + url.origin + "/app/prestataires.html\nFichier : " + url.origin + "/app/data/prestataires/" + st.chemin, { env, req });
      return json({ ok: true, id: ins.meta && ins.meta.last_row_id, taille: st.taille });
    }
    if (p === "/api/prest/admin/facture" && req.method === "POST") {
      if (!admin) return json({ erreur: "reserve_admin" }, 403);
      const st = ["recue", "payee", "rejetee"].includes(corps.statut) ? corps.statut : null;
      if (!st) return json({ erreur: "statut_invalide" }, 400);
      await env.DB.prepare("UPDATE factures_prest SET statut = ?, commentaire = COALESCE(?, commentaire) WHERE id = ?")
        .bind(st, corps.commentaire == null ? null : String(corps.commentaire).slice(0, 200), corps.id | 0).run();
      await journal(env, req, u, "prest_facture_statut", (corps.id | 0) + " → " + st);
      return json({ ok: true });
    }
    /* --- administration des prestataires --- */
    if (p === "/api/prest/admin/liste") {
      if (!admin) return json({ erreur: "reserve_admin" }, 403);
      return json({ prestataires: (await env.DB.prepare("SELECT * FROM prestataires ORDER BY societe").all()).results });
    }
    if (p === "/api/prest/admin/prestataire" && req.method === "POST") {
      if (!admin) return json({ erreur: "reserve_admin" }, 403);
      const id = corps.id | 0;
      const champs = [], vals = [];
      if (corps.tarif_q != null) { champs.push("tarif_q = ?"); vals.push(parseFloat(corps.tarif_q) || 0); }
      if (corps.tarif_nq != null) { champs.push("tarif_nq = ?"); vals.push(parseFloat(corps.tarif_nq) || 0); }
      if (corps.paliers !== undefined) { champs.push("paliers = ?"); vals.push(corps.paliers ? JSON.stringify(corps.paliers) : null); }
      if (corps.langue) { champs.push("langue = ?"); vals.push(LANGUES.includes(corps.langue) ? corps.langue : "fr"); }
      if (corps.actif != null) { champs.push("actif = ?"); vals.push(corps.actif ? 1 : 0); }
      if (corps.code != null) {
        const code = String(corps.code).trim().toUpperCase();
        if (!/^[A-Z0-9]{3,20}$/.test(code) || code === "COMMUN") return json({ erreur: "code_invalide" }, 400);
        const actuel = await env.DB.prepare("SELECT code FROM prestataires WHERE id = ?").bind(id).first();
        if (actuel && actuel.code !== code) {
          /* le code est aussi le dossier des fichiers : on refuse le renommage tant que des fichiers y sont rangés */
          const lie = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM fichiers WHERE chemin LIKE ? || '/%') + (SELECT COUNT(*) FROM documents WHERE fichier LIKE ? || '/%') + (SELECT COUNT(*) FROM factures_prest WHERE fichier LIKE ? || '/%') AS n").bind(actuel.code, actuel.code, actuel.code).first();
          if (lie && lie.n > 0) return json({ erreur: "code_fichiers_lies" }, 409);
        }
        corps.code = code;
      }
      for (const k of ["societe", "contact", "telephone", "pays", "code"]) if (corps[k] != null) { champs.push(k + " = ?"); vals.push(String(corps[k]).slice(0, 120)); }
      if (!champs.length) return json({ erreur: "rien_a_modifier" }, 400);
      await env.DB.prepare("UPDATE prestataires SET " + champs.join(", ") + " WHERE id = ?").bind(...vals, id).run();
      await journal(env, req, u, "prest_admin_maj", "prestataire " + id + " : " + champs.join(", "));
      return json({ ok: true });
    }
    /* téléversement depuis l'ordinateur de l'admin (multipart/form-data : fichier, titre, prestataire_id, langue).
       Stockage en base par blocs de 512 Ko (pas de dépendance R2), 20 Mo max, types bureautiques/PDF/images. */
    if (p === "/api/prest/admin/upload" && req.method === "POST") {
      if (!admin) return json({ erreur: "reserve_admin" }, 403);
      let fd; try { fd = await req.formData(); } catch (e) { return json({ erreur: "formulaire_invalide" }, 400); }
      const langue = LANGUES.includes(fd.get("langue")) ? fd.get("langue") : "fr";
      const pidDoc = parseInt(fd.get("prestataire_id") || "0", 10) || null;
      let dossier = "commun";
      if (pidDoc) { const pr = await env.DB.prepare("SELECT code FROM prestataires WHERE id = ?").bind(pidDoc).first(); if (!pr) return json({ erreur: "prestataire_introuvable" }, 404); dossier = pr.code; }
      const st = await enregistrerFichier(env, u, dossier, fd.get("fichier"), ["pdf", "doc", "docx", "xls", "xlsx", "png", "jpg", "jpeg"], 20 * 1024 * 1024, "");
      if (st.erreur) return json({ erreur: st.erreur }, st.erreur === "fichier_trop_gros" ? 413 : 400);
      const titre = String(fd.get("titre") || "").trim().slice(0, 160) || st.sansExt;
      const insD = await env.DB.prepare("INSERT INTO documents (prestataire_id, titre, fichier, langue) VALUES (?,?,?,?)").bind(pidDoc, titre, st.chemin, langue).run();
      await journal(env, req, u, "prest_document_upload", st.chemin + " (" + st.taille + " o, " + (pidDoc ? dossier : "commun") + ")");
      return json({ ok: true, id: insD.meta && insD.meta.last_row_id, chemin: st.chemin, taille: st.taille });
    }
    if (p === "/api/prest/admin/document" && req.method === "POST") {
      if (!admin) return json({ erreur: "reserve_admin" }, 403);
      if (corps.supprimer) {
        /* retrait de la liste + suppression du fichier stocké en base s'il n'est plus référencé (les fichiers statiques restent) */
        const doc = await env.DB.prepare("SELECT fichier FROM documents WHERE id = ?").bind(corps.id | 0).first();
        await env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(corps.id | 0).run();
        if (doc) {
          const encore = await env.DB.prepare("SELECT id FROM documents WHERE fichier = ?").bind(doc.fichier).first();
          if (!encore) {
            const fi = await env.DB.prepare("SELECT id FROM fichiers WHERE chemin = ?").bind(doc.fichier).first();
            if (fi) { await env.DB.prepare("DELETE FROM fichiers_blocs WHERE fichier_id = ?").bind(fi.id).run(); await env.DB.prepare("DELETE FROM fichiers WHERE id = ?").bind(fi.id).run(); }
          }
          await journal(env, req, u, "prest_document_retire", doc.fichier);
        }
        return json({ ok: true });
      }
      const fichier = String(corps.fichier || "").replace(/^\/+/, "").slice(0, 200);
      if (!/^(commun|[A-Z0-9]+)\/[^\/]+\.(pdf|png|jpg|jpeg|docx?|xlsx?)$/i.test(fichier)) return json({ erreur: "fichier_invalide" }, 400);
      await env.DB.prepare("INSERT INTO documents (prestataire_id, titre, fichier, langue) VALUES (?,?,?,?)")
        .bind(corps.prestataire_id ? (corps.prestataire_id | 0) : null, String(corps.titre || fichier).slice(0, 120), fichier, LANGUES.includes(corps.langue) ? corps.langue : "fr").run();
      return json({ ok: true });
    }
    if (p === "/api/prest/admin/export") {
      if (!admin) return json({ erreur: "reserve_admin" }, 403);
      const mois = url.searchParams.get("mois") || new Date().toISOString().slice(0, 7);
      const rows = (await env.DB.prepare("SELECT d.*, pr.societe, pr.code, pr.tarif_q, pr.tarif_nq, pr.paliers FROM declarations d JOIN prestataires pr ON pr.id = d.prestataire_id WHERE d.mois = ?" + (pid ? " AND d.prestataire_id = ?" : "") + " ORDER BY pr.societe, d.nom, d.prenom").bind(...(pid ? [mois, pid] : [mois])).all()).results;
      const parPrest = {}; rows.forEach(r => { if (r.statut === "validee" && r.heures > 0) (parPrest[r.prestataire_id] = parPrest[r.prestataire_id] || new Set()).add(r.nom + "|" + r.prenom); });
      const csv = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
      const lignes = ["PRESTATAIRE;CODE;MATRICULE;NOM;PRENOM;METIER;AGENCE;QUALIFIE;HEURES;TAUX;MONTANT HT;STATUT;COMMENTAIRE"];
      rows.forEach(r => { const taux = tauxDe(r, r.qualifie, (parPrest[r.prestataire_id] || new Set()).size);
        const montant = (r.statut === "validee" && r.heures > 0) ? Math.round(r.heures * taux * 100) / 100 : 0;
        lignes.push([r.societe, r.code, r.matricule, r.nom, r.prenom, r.metier, r.agence, r.qualifie ? "Q" : "NQ", r.heures == null ? "" : String(r.heures).replace(".", ","), String(taux).replace(".", ","), String(montant).replace(".", ","), r.statut, r.commentaire].map(csv).join(";")); });
      return new Response("﻿" + lignes.join("\r\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=facturation-prestataires-" + mois + ".csv" } });
    }
    return json({ erreur: "inconnu" }, 404);
  }

  /* -- journal d'activité (balise des apps) -- */
  if (p === "/api/activite" && req.method === "POST") {
    if (!u) return json({ erreur: "non_connecte" }, 401);
    await journal(env, req, u, String(corps.type || "action").slice(0, 60), corps.details || "", corps.page || "");
    return json({ ok: true });
  }

  /* -- administration -- */
  if (p.startsWith("/api/admin/")) {
    if (!u) return json({ erreur: "non_connecte" }, 401);
    if (!estAdmin(u)) return json({ erreur: "reserve_admin" }, 403);

    if (p === "/api/admin/apercu") {
      const dem = await env.DB.prepare("SELECT * FROM demandes_acces WHERE statut = 'en_attente' ORDER BY id DESC").all();
      const usr = await env.DB.prepare("SELECT id, email, nom, prenom, role, actif, doit_changer_mdp, cree_le, cree_par, sections, entite, agences, fonction, langue, prestataire_id FROM utilisateurs ORDER BY id").all();
      return json({ demandes: dem.results, utilisateurs: usr.results, sections_apps: SECTIONS_APPS, agences_abservice: Object.keys(AGENCES_ABSERVICE) });
    }

    if (p === "/api/admin/test-email") {
      const res = await envoyerEmail(env, ADMINS, "AB2Pro — test e-mail du portail",
        "Test de la messagerie demandé par " + u.email + ". Si vous lisez ceci, l'envoi vers votre adresse fonctionne.",
        { env, req });
      return json({ resultats: res.map(r => ({ destinataire: r.dest, ok: r.ok, status: r.status, reponse: r.corps })) });
    }

    if (p === "/api/admin/logs") {
      const email = url.searchParams.get("email") || "";
      const type = url.searchParams.get("type") || "";
      let q = "SELECT ts, email, type, details, page, ip FROM activites";
      const cond = [], args = [];
      if (email) { cond.push("email LIKE ?"); args.push("%" + email + "%"); }
      if (type) { cond.push("type = ?"); args.push(type); }
      if (cond.length) q += " WHERE " + cond.join(" AND ");
      q += " ORDER BY id DESC LIMIT 500";
      const r = await env.DB.prepare(q).bind(...args).all();
      return json({ logs: r.results });
    }

    if (p === "/api/admin/approuver" && req.method === "POST") {
      if (corps.role === "admin" && !estSuper(u)) return json({ erreur: "reserve_super_admin" }, 403);
      const d = await env.DB.prepare("SELECT * FROM demandes_acces WHERE id = ? AND statut = 'en_attente'").bind(corps.id | 0).first();
      if (!d) return json({ erreur: "demande_introuvable" }, 404);
      const invite = alea(24);
      const sel = alea(16), hprov = await pbkdf2(alea(16), sel); // mot de passe provisoire inutilisable : passage obligé par le lien
      /* sections choisies par l'admin à l'approbation (rôle user seulement ; absence = accès à tout) */
      const secsApprob = (corps.role !== "admin")
        ? JSON.stringify(Array.isArray(corps.sections)
            ? corps.sections.map(String).filter(s => SECTIONS_APPS.includes(s))
            : (SECTIONS_DEFAUT[d.entite] || SECTIONS_DEFAUT.ab2pro))
        : null;
      /* l'entité, les agences et la fonction choisies à l'inscription suivent la demande */
      await env.DB.prepare(
        "INSERT INTO utilisateurs (email, nom, prenom, sel, hash, role, doit_changer_mdp, invite_token, invite_expire, cree_par, sections, entite, agences, fonction) VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,?)")
        .bind(d.email, d.nom, d.prenom || null, sel, hprov, corps.role === "admin" ? "admin" : "user", invite, Date.now() + INVITE_MS, u.email, secsApprob,
              d.entite || null, d.agences || null, d.fonction || null).run();
      await env.DB.prepare("UPDATE utilisateurs SET langue = ? WHERE email = ?").bind(LANGUES.includes(d.langue) ? d.langue : "fr", d.email).run();
      if (d.entite === "prestataire") {
        /* fiche prestataire : code recruteur = pays (2 lettres) + TPE + 2 lettres de la société + n° (ex. ROTPEAK01),
           tarifs contractuels par défaut (annexe 1 : 0,70 € qualifié / 0,50 € autre) */
        /* fiche déjà créée par un admin (contrat signé avant l'ouverture du compte) : on la réutilise si l'e-mail
           ou la raison sociale correspondent — sinon nouvelle fiche */
        const soc0 = String(d.societe || nomComplet(d)).trim();
        const exist = await env.DB.prepare("SELECT id FROM prestataires WHERE (email <> '' AND lower(email) = lower(?)) OR upper(trim(societe)) = upper(?) ORDER BY id LIMIT 1")
          .bind(d.email, soc0).first();
        let pid = exist && exist.id;
        if (pid) {
          await env.DB.prepare("UPDATE prestataires SET email = CASE WHEN email = '' THEN ? ELSE email END, telephone = CASE WHEN telephone = '' THEN ? ELSE telephone END, langue = ? WHERE id = ?")
            .bind(d.email, d.telephone || "", LANGUES.includes(d.langue) ? d.langue : "fr", pid).run();
        } else {
          const pays2 = ({ "Roumanie": "RO", "Hongrie": "HU", "Bulgarie": "BU", "Moldavie": "MD" })[d.pays] || "XX";
          const soc = soc0.toUpperCase().replace(/[^A-Z]/g, "");
          const racine = pays2 + "TPE" + (soc.slice(0, 2) || "XX");
          const deja = (await env.DB.prepare("SELECT COUNT(*) AS n FROM prestataires WHERE code LIKE ?").bind(racine + "%").first()).n;
          const code = racine + String(deja + 1).padStart(2, "0");
          const ins = await env.DB.prepare("INSERT INTO prestataires (societe, code, contact, email, telephone, pays, langue) VALUES (?,?,?,?,?,?,?)")
            .bind(soc0, code, nomComplet(d), d.email, d.telephone || "", d.pays || "", LANGUES.includes(d.langue) ? d.langue : "fr").run();
          pid = ins.meta && ins.meta.last_row_id;
        }
        await env.DB.prepare("UPDATE utilisateurs SET prestataire_id = ? WHERE email = ?").bind(pid, d.email).run();
      }
      await env.DB.prepare("UPDATE demandes_acces SET statut = 'approuvee', traite_par = ?, traite_le = datetime('now') WHERE id = ?").bind(u.email, d.id).run();
      const lg = LANGUES.includes(d.langue) ? d.langue : "fr";
      const lien = url.origin + "/motdepasse.html?invite=" + invite + (lg !== "fr" ? "&l=" + lg : "");
      const marque = d.entite === "abservice" ? "AB Service" : "AB2Pro";
      /* le demandeur reçoit l'approbation dans SA langue (recruteurs RO/HU) — la page mot de passe suit via ?l= */
      const APPROB = {
        fr: { s: "votre accès est ouvert", b: `Bonjour ${nomComplet(d)},\n\nVotre accès au portail ${marque} a été approuvé.\nDéfinissez votre mot de passe (lien valable 72 h) :\n${lien}\n\nPortail : ${url.origin}/app/` },
        en: { s: "your access is open", b: `Hello ${nomComplet(d)},\n\nYour access to the ${marque} portal has been approved.\nSet your password (link valid 72 h):\n${lien}\n\nPortal: ${url.origin}/app/` },
        ro: { s: "accesul dvs. este deschis", b: `Bună ziua ${nomComplet(d)},\n\nAccesul dvs. la portalul ${marque} a fost aprobat.\nSetați parola (link valabil 72 h):\n${lien}\n\nPortal: ${url.origin}/app/` },
        hu: { s: "hozzáférése megnyílt", b: `Tisztelt ${nomComplet(d)}!\n\nAz Ön hozzáférését a(z) ${marque} portálhoz jóváhagytuk.\nÁllítsa be jelszavát (a link 72 óráig érvényes):\n${lien}\n\nPortál: ${url.origin}/app/` },
      }[lg];
      await envoyerEmail(env, d.email, marque + " — " + APPROB.s, APPROB.b, { env, req });
      await journal(env, req, u, "admin_approbation", d.email);
      return json({ ok: true, lien });
    }

    if (p === "/api/admin/refuser" && req.method === "POST") {
      await env.DB.prepare("UPDATE demandes_acces SET statut = 'refusee', traite_par = ?, traite_le = datetime('now') WHERE id = ? AND statut = 'en_attente'")
        .bind(u.email, corps.id | 0).run();
      await journal(env, req, u, "admin_refus", String(corps.id));
      return json({ ok: true });
    }

    /* fiche utilisateur : TOUTES les informations sont modifiables par un admin (décision 04/09) ;
       cibles admin / super admin réservées aux super admins (même échelle que rôle/actif), soi-même toujours */
    if (p === "/api/admin/utilisateur" && req.method === "POST") {
      const cible = await env.DB.prepare("SELECT * FROM utilisateurs WHERE id = ?").bind(corps.id | 0).first();
      if (!cible) return json({ erreur: "utilisateur_introuvable" }, 404);
      if ((cible.role === "super_admin" || cible.role === "admin") && !estSuper(u) && cible.id !== u.id) return json({ erreur: "reserve_super_admin" }, 403);
      const nom = String(corps.nom !== undefined ? corps.nom : cible.nom || "").trim().slice(0, 120);
      const prenom = String(corps.prenom !== undefined ? corps.prenom : cible.prenom || "").trim().slice(0, 80) || null;
      const email = String(corps.email !== undefined ? corps.email : cible.email).trim().toLowerCase().slice(0, 160);
      const fonction = String(corps.fonction !== undefined ? corps.fonction : cible.fonction || "").trim().slice(0, 120) || null;
      const entite = corps.entite === undefined ? entiteDe(cible) : (ENTITES.includes(corps.entite) ? corps.entite : null);
      const langue = corps.langue === undefined ? (LANGUES.includes(cible.langue) ? cible.langue : "fr") : (LANGUES.includes(corps.langue) ? corps.langue : null);
      if (!nom) return json({ erreur: "nom_requis" }, 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ erreur: "email_invalide" }, 400);
      if (!entite) return json({ erreur: "entite_invalide" }, 400);
      if (!langue) return json({ erreur: "langue_invalide" }, 400);
      let agences = null;
      if (entite === "abservice") {
        agences = validerAgences(corps.agences === undefined ? agencesDe(cible) : corps.agences);
        if (agences === null || JSON.parse(agences).length === 0) return json({ erreur: "agences_invalides" }, 400);
      }
      const emailChange = email !== String(cible.email).toLowerCase();
      if (emailChange) {
        const deja = await env.DB.prepare("SELECT id FROM utilisateurs WHERE email = ? COLLATE NOCASE AND id <> ?").bind(email, cible.id).first();
        if (deja) return json({ erreur: "email_deja_utilise" }, 409);
      }
      await env.DB.prepare("UPDATE utilisateurs SET nom = ?, prenom = ?, email = ?, fonction = ?, entite = ?, agences = ?, langue = ? WHERE id = ?")
        .bind(nom, prenom, email, fonction, entite, agences, langue, cible.id).run();
      if (cible.prestataire_id && emailChange)
        await env.DB.prepare("UPDATE prestataires SET email = ? WHERE id = ? AND lower(email) = lower(?)").bind(email, cible.prestataire_id, cible.email).run();
      const diff = [["nom", cible.nom, nom], ["prénom", cible.prenom, prenom], ["e-mail", cible.email, email], ["fonction", cible.fonction, fonction],
                    ["entité", cible.entite, entite], ["agences", cible.agences, agences], ["langue", cible.langue, langue]]
        .filter(([, a, b]) => String(a || "") !== String(b || "")).map(([k, a, b]) => k + " : " + (a || "—") + " → " + (b || "—"));
      await journal(env, req, u, "admin_utilisateur", cible.email + (diff.length ? " — " + diff.join(" ; ") : " — aucun changement"));
      if (emailChange)
        await envoyerEmail(env, [cible.email, email], "AB2Pro — adresse de connexion modifiée",
          `Bonjour ${nomComplet({ prenom, nom })},\n\nUn administrateur (${u.email}) a modifié l'adresse e-mail de connexion de votre compte AB2Pro :\n  ancienne : ${cible.email}\n  nouvelle : ${email}\n\nConnectez-vous désormais avec la nouvelle adresse (mot de passe inchangé).\n\n— AB2Pro · ${url.origin}`, { env, req });
      return json({ ok: true, modifications: diff });
    }

    if (p === "/api/admin/role" && req.method === "POST") {
      if (!estSuper(u)) return json({ erreur: "reserve_super_admin" }, 403);   // seuls les super admins promeuvent/rétrogradent
      const cible = await env.DB.prepare("SELECT * FROM utilisateurs WHERE id = ?").bind(corps.id | 0).first();
      if (!cible) return json({ erreur: "utilisateur_introuvable" }, 404);
      if (cible.role === "super_admin") return json({ erreur: "intouchable" }, 403);  // un super admin ne se rétrograde JAMAIS
      if (cible.email === u.email) return json({ erreur: "pas_soi_meme" }, 400);
      const role = corps.role === "admin" ? "admin" : "user";
      await env.DB.prepare("UPDATE utilisateurs SET role = ? WHERE id = ?").bind(role, cible.id).run();
      await journal(env, req, u, "admin_role", cible.email + " → " + role);
      return json({ ok: true });
    }

    if (p === "/api/admin/actif" && req.method === "POST") {
      const cible = await env.DB.prepare("SELECT * FROM utilisateurs WHERE id = ?").bind(corps.id | 0).first();
      if (!cible) return json({ erreur: "utilisateur_introuvable" }, 404);
      if (cible.role === "super_admin") return json({ erreur: "intouchable" }, 403); // un super admin ne se désactive JAMAIS
      if (cible.role === "admin" && !estSuper(u)) return json({ erreur: "reserve_super_admin" }, 403);
      if (cible.email === u.email) return json({ erreur: "pas_soi_meme" }, 400);
      const actif = corps.actif ? 1 : 0;
      await env.DB.prepare("UPDATE utilisateurs SET actif = ? WHERE id = ?").bind(actif, cible.id).run();
      if (!actif) await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(cible.id).run();
      await journal(env, req, u, "admin_actif", cible.email + " → " + (actif ? "réactivé" : "désactivé"));
      return json({ ok: true });
    }

    if (p === "/api/admin/sections" && req.method === "POST") {
      const cible = await env.DB.prepare("SELECT * FROM utilisateurs WHERE id = ?").bind(corps.id | 0).first();
      if (!cible) return json({ erreur: "utilisateur_introuvable" }, 404);
      if (cible.role !== "user") return json({ erreur: "admins_acces_total" }, 400); // un admin voit toujours tout
      const secs = Array.isArray(corps.sections) ? corps.sections.map(String).filter(s => SECTIONS_APPS.includes(s)) : null;
      if (secs === null) return json({ erreur: "sections_invalides" }, 400);
      await env.DB.prepare("UPDATE utilisateurs SET sections = ? WHERE id = ?").bind(JSON.stringify(secs), cible.id).run();
      await journal(env, req, u, "admin_sections", cible.email + " → " + (secs.length ? secs.join(",") : "(aucune)"));
      return json({ ok: true, sections: secs });
    }

    if (p === "/api/admin/reinviter" && req.method === "POST") {
      const cible = await env.DB.prepare("SELECT * FROM utilisateurs WHERE id = ?").bind(corps.id | 0).first();
      if (!cible) return json({ erreur: "utilisateur_introuvable" }, 404);
      if ((cible.role === "admin" || cible.role === "super_admin") && !estSuper(u))
        return json({ erreur: "reserve_super_admin" }, 403); // réinitialiser l'accès d'un admin = pouvoir sensible
      const invite = alea(24);
      await env.DB.prepare("UPDATE utilisateurs SET invite_token = ?, invite_expire = ?, doit_changer_mdp = 1 WHERE id = ?")
        .bind(invite, Date.now() + INVITE_MS, cible.id).run();
      const lien = url.origin + "/motdepasse.html?invite=" + invite;
      await envoyerEmail(env, cible.email, "AB2Pro — réinitialisation de votre mot de passe",
        `Bonjour,\n\nDéfinissez un nouveau mot de passe (lien valable 72 h) :\n${lien}`, { env, req });
      await journal(env, req, u, "admin_reinvitation", cible.email);
      return json({ ok: true, lien });
    }
  }

  return json({ erreur: "inconnu" }, 404);
}

/* ---------- page renvoyée quand la section n'est pas autorisée pour l'utilisateur ---------- */
const PAGE_SECTION_REFUSEE = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>AB2Pro — Accès non autorisé</title>
<style>body{margin:0;font:15px/1.6 "Segoe UI",system-ui,sans-serif;background:#f4f4f5;color:#29293b;
display:flex;align-items:center;justify-content:center;min-height:100vh}
.c{background:#fff;border:1px solid #d9d9e0;border-radius:12px;box-shadow:0 4px 14px rgba(60,50,20,.07);
padding:30px 34px;max-width:460px;text-align:center}
h1{font:22px Cambria,Georgia,serif;margin:0 0 8px}b{color:#db303f}
a{display:inline-block;margin-top:16px;background:#db303f;color:#fff;text-decoration:none;
padding:9px 20px;border-radius:18px;font-weight:600}p{color:#5f5f74;margin:6px 0}</style></head><body>
<div class="c"><h1><b>Accès</b> non autorisé</h1>
<p>Votre compte n'a pas accès à cette section du portail AB2Pro.</p>
<p>Si vous en avez besoin, demandez à un administrateur de vous l'ouvrir.</p>
<a href="/app/">⌂ Retour au portail</a></div></body></html>`;

/* ---------- balise d'activité injectée dans chaque application servie ---------- */
const BALISE_ACTIVITE = `<script>
(function () {
  window.abLog = function (type, details) {
    try {
      navigator.sendBeacon("/api/activite", new Blob([JSON.stringify({
        type: type, details: String(details || "").slice(0, 8000), page: location.pathname
      })], { type: "application/json" }));
    } catch (e) {}
  };
  /* traceurs génériques : impression (= étude de prix / PDF) et clics sur les boutons principaux */
  window.addEventListener("beforeprint", function () { abLog("impression_pdf"); });
  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("button[id]") : null;
    if (!b) return;
    /* btn-etude retiré : le simulateur envoie lui-même un etude_prix ENRICHI (résumé + lien de restauration) */
    var ids = { "btn-npilote": "solveur_net", "btn-go": "recherche", "btn-dist": "calcul_distance" };
    if (ids[b.id]) abLog(ids[b.id], (document.getElementById("in-q") || {}).value || "");
  }, true);

  /* barre de navigation du portail : retour accueil, admin (si admin), déconnexion */
  (async function () {
    try {
      var r = await fetch("/api/moi", { cache: "no-store" });
      if (!r.ok) return;
      var moi = await r.json();
      var barre = document.createElement("div");
      barre.style.cssText = "position:fixed;bottom:14px;right:12px;z-index:2147483000;display:flex;gap:6px;" +
        "font:12.5px 'Segoe UI',system-ui,sans-serif;print-color-adjust:exact";
      barre.className = "barre-portail";
      var st = document.createElement("style");
      st.textContent = "@media print { .barre-portail { display:none !important; } }";
      document.head.appendChild(st);
      function btn(txt, href, fond) {
        var a = document.createElement("a");
        a.textContent = txt; a.href = href;
        a.style.cssText = "background:" + fond + ";color:#fff;padding:7px 13px;border-radius:17px;" +
          "text-decoration:none;font-weight:600;box-shadow:0 2px 10px rgba(0,0,0,.3);white-space:nowrap";
        return a;
      }
      var p = location.pathname;
      var estPortail = (p === "/app" || p === "/app/" || p === "/app/index.html");
      if (!estPortail) barre.appendChild(btn("⌂ Portail", "/app/", "#db303f"));
      if (moi.role === "admin" || moi.role === "super_admin") barre.appendChild(btn("🛡 Admin", "/admin", "#29293b"));
      var dec = btn("Quitter", "#", "#5f5f74");
      dec.addEventListener("click", async function (e) {
        e.preventDefault();
        try { await fetch("/api/logout", { method: "POST" }); } catch (err) {}
        location.href = "/";
      });
      barre.appendChild(dec);
      document.body.appendChild(barre);
    } catch (e) {}
  })();
})();
</script>`;
