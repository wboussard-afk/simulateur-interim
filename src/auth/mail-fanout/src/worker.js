/* Email Worker « fanout » — transfert des e-mails entrants du domaine vers TOUS les
 * super-admins (une règle Email Routing classique n'accepte qu'UNE destination ;
 * la doc officielle prévoit ce worker comme voie multi-destinataires :
 * message.forward() appelé plusieurs fois vers des adresses VÉRIFIÉES).
 *
 * IMPORTANT : chaque adresse ci-dessous doit être ajoutée ET vérifiée dans
 * Email Routing > Destination Addresses avant d'être servie (sinon forward rejette).
 * Liste gérée par la direction — la modifier ici puis `wrangler deploy`. */
const DESTINATAIRES = [
  "wboussard@gmail.com",
  "urgens.martinez@ab2pro.com",
];

/* ===== Routage des réponses de logeurs (décision direction 02/09/2026) =====
 * Une demande de réservation part avec l'adresse de réponse logements+u<id>@… :
 * quand le logeur répond, ce worker retrouve l'utilisateur <id> en D1 et relaie la
 * réponse à son e-mail perso + aux boîtes génériques de ses agences AB Service —
 * via /api/notifier du portail (Resend), car message.forward() n'accepte que des
 * adresses préalablement vérifiées dans Email Routing.
 * Le transfert aux super-admins (boîte générique) est conservé dans tous les cas. */
const NOTIFIER_URL = "https://ab2pro-simulateur.com/api/notifier";
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

/* extrait un aperçu texte lisible du MIME brut (best effort : partie text/plain,
 * décodage quoted-printable sommaire ; jamais bloquant) */
function apercuTexte(brut) {
  try {
    let corps = brut;
    const mBound = brut.match(/boundary="?([^";\r\n]+)"?/i);
    if (mBound) {
      const parties = brut.split("--" + mBound[1]);
      const txt = parties.find(x => /content-type:\s*text\/plain/i.test(x));
      if (txt) corps = txt;
    }
    const idx = corps.indexOf("\r\n\r\n");
    let t = idx >= 0 ? corps.slice(idx + 4) : corps;
    if (/quoted-printable/i.test(corps.slice(0, idx > 0 ? idx : 500))) {
      t = t.replace(/=\r\n/g, "").replace(/(?:=[0-9A-F]{2})+/gi, m => { try { return decodeURIComponent(m.replace(/=/g, "%")); } catch (e) { return " "; } });
    }
    return t.replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").trim().slice(0, 2500);
  } catch (e) { return "(aperçu indisponible — consulter la boîte générique)"; }
}

/* ===== Capture des réponses de MAIRIES aux demandes CADA (décision direction 03/09) =====
 * La réponse (liste des meublés, souvent en pièce jointe PDF/XLSX) est enregistrée en D1
 * (table cada_reponses) pour la routine quotidienne « cada-absorber » qui l'intègre à la
 * base du portail. Détection : réponse adressée/citant info+u<id>@ ET sujet/corps évoquant
 * le registre des meublés, la CADA ou l'article L.311-1. Découpage MIME best-effort. */
const CADA_MARQUEURS = /meubl[eé]s?\s+de\s+tourisme|registre\s+des\s+meubl|\bcada\b|l\.\s?311-1|commission\s+d.acc[eè]s/i;
function decouperMime(brut) {
  const parties = [];
  const walk = (bloc, prof) => {
    const sep = bloc.indexOf("\r\n\r\n");
    const entete = sep >= 0 ? bloc.slice(0, sep) : bloc, corps = sep >= 0 ? bloc.slice(sep + 4) : "";
    const ct = (/content-type:\s*([^;\r\n]+)/i.exec(entete) || [])[1] || "text/plain";
    const mb = /boundary="?([^";\r\n]+)"?/i.exec(entete);
    if (/^multipart\//i.test(ct) && mb && prof < 4) {
      corps.split("--" + mb[1]).slice(1).forEach(x => { if (!/^--/.test(x.trim())) walk(x.replace(/^\r\n/, ""), prof + 1); });
      return;
    }
    const cte = ((/content-transfer-encoding:\s*([^\r\n]+)/i.exec(entete) || [])[1] || "").trim().toLowerCase();
    const nom = ((/filename\*?="?([^";\r\n]+)"?/i.exec(entete) || /name="?([^";\r\n]+)"?/i.exec(entete) || [])[1] || "").trim();
    parties.push({ ct: ct.trim().toLowerCase(), cte, nom, corps: corps.trim() });
  };
  walk(brut, 0);
  return parties;
}
function texteDe(parties) {
  const p = parties.find(x => x.ct.startsWith("text/plain") && !x.nom) || parties.find(x => x.ct.startsWith("text/html") && !x.nom);
  if (!p) return "";
  let t = p.corps;
  if (p.cte === "quoted-printable") t = t.replace(/=\r\n/g, "").replace(/(?:=[0-9A-F]{2})+/gi, m => { try { return decodeURIComponent(m.replace(/=/g, "%")); } catch (e) { return " "; } });
  else if (p.cte === "base64") { try { t = new TextDecoder().decode(Uint8Array.from(atob(t.replace(/\s+/g, "")), c => c.charCodeAt(0))); } catch (e) {} }
  return t.replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").trim().slice(0, 20000);
}
function piecesDe(parties) {
  return parties.filter(x => x.nom || (!x.ct.startsWith("text/") && !x.ct.startsWith("multipart/"))).slice(0, 10).map(x => {
    const b64 = x.cte === "base64" ? x.corps.replace(/\s+/g, "") : btoa(unescape(encodeURIComponent(x.corps)));
    const taille = Math.floor(b64.length * 3 / 4);
    return { nom: x.nom || "piece", type: x.ct, taille, b64: taille <= 700 * 1024 ? b64 : "" };
  });
}

export default {
  async email(message, env, ctx) {
    /* 1) réponse de logeur → relais e-mail perso + agences. L'identifiant du demandeur
       vient (a) de l'adresse destinataire personnalisée logements|info+u<id>@ (les deux
       domaines), ou (b) EN FILET DE SÉCURITÉ, du corps du message : un logeur qui écrit
       à la boîte générique cite presque toujours notre message d'origine, lequel contient
       l'adresse personnalisée en clair. */
    try {
      let brut = null;
      let mPlus = /^(?:logements|info)\+u(\d+)@/i.exec(message.to || "");
      if (!mPlus && /^(?:logements|info)@/i.test(message.to || "") && env.DB && env.NOTIFY_KEY) {
        brut = await new Response(message.raw).text();
        mPlus = /(?:logements|info)\+u(\d+)@/i.exec(brut);
      }
      if (mPlus && env.DB && env.NOTIFY_KEY) {
        const usr = await env.DB.prepare("SELECT id, email, nom, entite, agences FROM utilisateurs WHERE id = ? AND actif = 1")
          .bind(parseInt(mPlus[1], 10)).first();
        if (usr) {
          let ags = [];
          try { ags = (JSON.parse(usr.agences || "[]") || []).map(a => AGENCES_ABSERVICE[a]).filter(Boolean); } catch (e) {}
          const dest = [usr.email, ...ags];
          if (brut === null) brut = await new Response(message.raw).text();
          /* capture CADA : réponse de mairie → D1 pour la routine quotidienne */
          try {
            const sujet = message.headers.get("subject") || "";
            if (CADA_MARQUEURS.test(sujet) || CADA_MARQUEURS.test(brut.slice(0, 20000))) {
              const parties = decouperMime(brut);
              await env.DB.prepare("INSERT INTO cada_reponses (user_id, de, sujet, texte, pieces) VALUES (?,?,?,?,?)")
                .bind(usr.id, String(message.from || "").slice(0, 200), sujet.slice(0, 300),
                      texteDe(parties), JSON.stringify(piecesDe(parties)).slice(0, 3900000)).run();
            }
          } catch (e) { /* la capture ne doit jamais bloquer le relais */ }
          const texte =
            "Réponse d'un logeur à une demande de réservation AB Service.\n\n" +
            "De : " + (message.from || "?") + "\n" +
            "Pour : " + (usr.nom || usr.email) + " (demandeur) et ses agences de rattachement\n" +
            "Sujet : " + (message.headers.get("subject") || "(sans sujet)") + "\n\n" +
            "----- Aperçu du message -----\n" + apercuTexte(brut) +
            "\n\n(Message complet sur la boîte générique du service logement.)";
          await fetch(NOTIFIER_URL, {
            method: "POST",
            headers: { "content-type": "application/json", "x-notify-key": env.NOTIFY_KEY },
            body: JSON.stringify({ sujet: "Réponse logeur — " + (message.headers.get("subject") || "réservation").slice(0, 150), texte, dest }),
          });
        }
      }
    } catch (e) { /* le relais enrichi ne doit JAMAIS empêcher le transfert de base */ }

    /* 2) transfert de base vers les super-admins (toujours) */
    const resultats = await Promise.allSettled(
      DESTINATAIRES.map(adresse => message.forward(adresse))
    );
    // si TOUT échoue (adresses non vérifiées ?), rejeter proprement pour que
    // l'expéditeur reçoive un bounce plutôt qu'un silence
    if (resultats.every(r => r.status === "rejected")) {
      message.setReject("Transfert indisponible — réessayer plus tard.");
    }
  },
};
