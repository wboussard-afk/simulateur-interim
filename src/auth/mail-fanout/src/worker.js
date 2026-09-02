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
      t = t.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => {
        try { return decodeURIComponent("%" + h); } catch (e) { return " "; }
      });
    }
    return t.replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").trim().slice(0, 2500);
  } catch (e) { return "(aperçu indisponible — consulter la boîte générique)"; }
}

export default {
  async email(message, env, ctx) {
    /* 1) réponse de logeur adressée à logements+u<id>@… → relais e-mail perso + agences */
    try {
      /* les deux domaines : logements+u<id>@ab2pro-simulateur.com (historique)
         et info+u<id>@abservice-logement.com (domaine dédié AB Service) */
      const mPlus = /^(?:logements|info)\+u(\d+)@/i.exec(message.to || "");
      if (mPlus && env.DB && env.NOTIFY_KEY) {
        const usr = await env.DB.prepare("SELECT id, email, nom, entite, agences FROM utilisateurs WHERE id = ? AND actif = 1")
          .bind(parseInt(mPlus[1], 10)).first();
        if (usr) {
          let ags = [];
          try { ags = (JSON.parse(usr.agences || "[]") || []).map(a => AGENCES_ABSERVICE[a]).filter(Boolean); } catch (e) {}
          const dest = [usr.email, ...ags];
          const brut = await new Response(message.raw).text();
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
