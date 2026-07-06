#!/usr/bin/env node
/**
 * CHRONOS — Collecteur de la Veille
 * ---------------------------------
 * Récupère chaque jour les actualités (science · tech · politique · IA)
 * depuis des flux RSS/Atom publics, les nettoie, en sélectionne les
 * meilleures, et écrit un fichier `veille.json` que la page lit.
 *
 * Aucune dépendance : Node 18+ suffit (fetch intégré).
 *   node veille.mjs            → génère veille.json
 *   node veille.mjs --selftest → teste l'analyseur sans réseau
 *
 * Pour ajouter une source : ajoute simplement son URL de flux dans FEEDS.
 * Si un flux tombe en panne, le script l'ignore et continue.
 */

// ————————————————————————————————————————————————————————————
// 1. SOURCES  (vérifiées en 2026 — ajoute/retire librement)
//    Le socle « Google News » est le plus stable : il agrège des
//    dizaines de médias et ne casse presque jamais.
// ————————————————————————————————————————————————————————————
const G = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=fr&gl=FR&ceid=FR:fr`;

const FEEDS = {
  sciences: [
    "https://www.futura-sciences.com/rss/actualites.xml",
    "https://www.sciencesetavenir.fr/rss.xml",
    "https://www.lemonde.fr/sciences/rss_full.xml",
    G("découverte scientifique OR recherche"),
  ],
  tech: [
    "https://www.numerama.com/feed/",
    "https://www.lesnumeriques.com/rss.xml",
    G("technologie innovation"),
  ],
  politique: [
    "https://www.lemonde.fr/international/rss_full.xml",
    "https://www.francetvinfo.fr/titres.rss",
    G("politique monde géopolitique"),
  ],
  ia: [
    "https://www.numerama.com/tag/intelligence-artificielle/feed/",
    "https://www.lemondeinformatique.fr/flux-rss/intelligence-artificielle/rss.xml",
    "https://www.lesnumeriques.com/intelligence-artificielle/rss.xml",
    G("intelligence artificielle IA"),
  ],
};

const PER_CATEGORY = 6;       // nombre d'articles retenus par rubrique
const SUMMARY_MAX = 300;      // longueur max d'un résumé
const FETCH_TIMEOUT = 12000;  // ms

// ————————————————————————————————————————————————————————————
// 2. ANALYSEUR RSS / ATOM  (minimal, sans dépendance)
// ————————————————————————————————————————————————————————————
function decodeEntities(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
function stripTags(s = "") {
  return decodeEntities(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
function pick(block, tags) {
  for (const t of tags) {
    const m = block.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i"));
    if (m) return decodeEntities(m[1]).trim();
  }
  return "";
}
function pickLink(block) {
  // RSS : <link>url</link>  |  Atom : <link href="url" .../>
  const rss = block.match(/<link>([\s\S]*?)<\/link>/i);
  if (rss && rss[1].trim()) return decodeEntities(rss[1]).trim();
  const atom = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  return atom ? decodeEntities(atom[1]).trim() : "";
}

/** Transforme un XML de flux en liste d'articles normalisés. */
function parseFeed(xml, sourceName = "") {
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1)
    .concat(xml.split(/<entry[\s>]/i).slice(1)); // RSS + Atom
  for (const raw of blocks) {
    const block = "<x " + raw; // rétablit le tag coupé pour les regex
    const title = stripTags(pick(block, ["title"]));
    if (!title) continue;
    const url = pickLink(block);
    const rawSummary = pick(block, ["description", "summary", "content"]);
    let summary = stripTags(rawSummary);
    if (summary.length > SUMMARY_MAX) summary = summary.slice(0, SUMMARY_MAX - 1).trimEnd() + "…";
    const date = pick(block, ["pubDate", "updated", "published", "dc:date"]);
    items.push({ title, url, summary, date, source: sourceName, ts: Date.parse(date) || 0 });
  }
  return items;
}

// ————————————————————————————————————————————————————————————
// 3. RÉCUPÉRATION + CURATION
// ————————————————————————————————————————————————————————————
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }

async function fetchFeed(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "CHRONOS-Veille/1.0 (+https://exemple.org)" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const xml = await res.text();
    return parseFeed(xml, hostOf(url));
  } catch (e) {
    console.warn(`  ⚠︎  flux ignoré (${hostOf(url)}) : ${e.message}`);
    return [];
  } finally { clearTimeout(to); }
}

function normalizeTitle(t) {
  return t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
}

async function collectCategory(name, urls) {
  console.log(`▸ ${name}`);
  const all = (await Promise.all(urls.map(fetchFeed))).flat();
  const seen = new Set();
  const unique = [];
  for (const it of all.sort((a, b) => b.ts - a.ts)) {
    const key = normalizeTitle(it.title).slice(0, 60);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(it);
    if (unique.length >= PER_CATEGORY) break;
  }
  console.log(`  → ${unique.length} article(s) retenu(s) sur ${all.length} collecté(s)`);
  return unique;
}

// ————————————————————————————————————————————————————————————
// 4. AUTO-TEST (sans réseau)
// ————————————————————————————————————————————————————————————
function selftest() {
  const sampleRSS = `<?xml version="1.0"?><rss><channel>
    <item><title>Découverte d'une exoplanète tempérée</title>
      <link>https://exemple.org/a</link>
      <description><![CDATA[Une <b>superterre</b> dans la zone habitable &amp; potentiellement humide.]]></description>
      <pubDate>Mon, 06 Jul 2026 08:00:00 GMT</pubDate></item>
    <item><title>Nouveau théorème en topologie</title>
      <link>https://exemple.org/b</link>
      <description>Résumé court.</description>
      <pubDate>Sun, 05 Jul 2026 08:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const sampleAtom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>Modèle d'IA open-source publié</title>
      <link href="https://exemple.org/c" rel="alternate"/>
      <summary>Un laboratoire dévoile un modèle &#233;valu&#233; sur plusieurs t&#226;ches.</summary>
      <updated>2026-07-06T09:30:00Z</updated></entry>
  </feed>`;

  let ok = 0, fail = 0;
  const check = (cond, label) => { cond ? (ok++, console.log("  ✓ " + label)) : (fail++, console.error("  ✗ " + label)); };

  const rss = parseFeed(sampleRSS, "exemple.org");
  check(rss.length === 2, "RSS : 2 items extraits");
  check(rss[0].title === "Découverte d'une exoplanète tempérée", "RSS : titre décodé");
  check(rss[0].url === "https://exemple.org/a", "RSS : lien <link>");
  check(rss[0].summary.includes("superterre") && !rss[0].summary.includes("<b>"), "RSS : HTML nettoyé");
  check(rss[0].summary.includes("&") && !rss[0].summary.includes("&amp;"), "RSS : entités décodées");
  check(rss[0].ts > rss[1].ts, "RSS : dates comparables");

  const atom = parseFeed(sampleAtom, "exemple.org");
  check(atom.length === 1, "Atom : 1 entry extraite");
  check(atom[0].url === "https://exemple.org/c", "Atom : lien href");
  check(atom[0].summary.includes("évalué") && atom[0].summary.includes("tâches"), "Atom : entités numériques décodées");

  console.log(`\n${fail === 0 ? "✅ TOUS LES TESTS PASSENT" : "❌ " + fail + " test(s) en échec"} (${ok}/${ok + fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

// ————————————————————————————————————————————————————————————
// 5. MAIN
// ————————————————————————————————————————————————————————————
async function main() {
  if (process.argv.includes("--selftest")) return selftest();

  console.log("CHRONOS · Veille — collecte du " + new Date().toISOString().slice(0, 10) + "\n");
  const categories = {};
  for (const [name, urls] of Object.entries(FEEDS)) {
    categories[name] = await collectCategory(name, urls);
  }

  const now = new Date();
  const out = {
    generated: now.toISOString(),
    dateLabel: now.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
    demo: false,
    categories,
  };

  const fs = await import("node:fs/promises");
  await fs.writeFile("veille.json", JSON.stringify(out, null, 2), "utf8");
  const total = Object.values(categories).reduce((n, a) => n + a.length, 0);
  console.log(`\n✅ veille.json écrit — ${total} article(s) au total.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
