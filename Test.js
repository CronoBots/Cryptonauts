// Récupération des propriétaires alignée EXACTEMENT sur le panel « Snapshot » v3.9.8
// d'index.html. Owner resolution via :
//   Phase B  — assets(collectionId) paginé (pages en parallèle)
//   Phase C  — eventHistory(naturesIn:['transferred']) : owner courant par ÉDITION
//   Phase C-fallback — editions(assetId:) BATCHÉES en aliasing (1 HTTP = N requêtes)
//                      → ~10× moins de requêtes = plus de 429
//   Secondary — editionEvents(editionId) pour les NFT retirés (withdrawn)
//   Phase E  — agrégation : 1 count / édition, holder keyé par uuid||username
// Plus de limiteur de débit global : on s'appuie sur la concurrence bornée +
// retry/backoff, comme le fait le snapshot dans le navigateur (IP résidentielle).
const axios = require('axios');
const fs = require('fs');
const { keccak256 } = require('js-sha3'); // namehash ENS (résolution inverse .cro)

// Liste des identifiants de collections avec option process, usePagination, noms et images
const collections = [
  { id: 'aabff17f9874020416137984b9d2b8db', name: 'Legendary Cryptonauts V2', process: true, usePagination: false, image: 'https://media.nft.crypto.com/58a7e1a7-392b-4589-8fb1-39ede948877f/original.jpg?d=lg-logo' },
  { id: '0a9144ea31f81338454f87a1eaf101c1', name: 'OG Cryptonauts', process: true, usePagination: false, image: 'https://media.nft.crypto.com/ed44387d-7a86-4f00-aaf4-bdc48170f5ab/original.jpg?d=lg-logo' },
  { id: 'a870c453ec57dc8e706e999b3f37a859', name: 'Time Travel Cryptonauts II', process: true, usePagination: false, image: 'https://media.nft.crypto.com/d2ed798c-06b3-415c-bedf-2eb7e85696a2/original.jpg?d=lg-logo' },
  { id: 'c220b3299c59deccf1340251036ac4ac', name: 'Legendary Cryptonauts', process: true, usePagination: false, image: 'https://media.nft.crypto.com/a4473840-5dce-4b64-ae66-1e265d41efce/original.jpg?d=lg-logo' },
  { id: '98d9a2bfd53bd130fc267c9c92ed3236', name: 'TIME TRAVEL Cryptonauts', process: true, usePagination: true, image: 'https://media.nft.crypto.com/3f03eae4-d4db-4ec8-96cd-ff53a95403d0/original.jpg?d=lg-logo5' },
  { id: '89d7138226413ae153f306dd5cfabf33', name: 'Quantum Cryptonauts V2', process: true, usePagination: true, image: 'https://media.nft.crypto.com/c19a171b-0418-4eb2-b3c1-1dcb84616c52/original.jpg?d=lg-logo' },
  { id: 'bbcd969a80642cf8934d33061be8a194', name: 'Quantum Cryptonauts', process: true, usePagination: true, image: 'https://media.nft.crypto.com/395953dd-72fe-49ba-acb0-f638166b87ae/original.jpg?d=lg-logo' },
  { id: '10615ea6d69edfc24975c419941304e3', name: 'Cryptonauts 2024', process: true, usePagination: true, image: 'https://media.nft.crypto.com/84f5f042-7cb0-404f-88d2-43d07a6d2a46/original.jpg?d=lg-logo' },
  { id: 'f1d242e1c49e009427b38fc953ef4e89', name: 'Cryptonauts Golden Crew', process: true, usePagination: false, image: 'https://media.nft.crypto.com/6d6e7a76-35f6-4918-b851-ddebabf94e2c/original.jpg?d=lg-logo' },
  { id: 'da522f33fb5285981f6d154e575fe0a3', name: 'Cryptonauts: The dark side of the dune', process: true, usePagination: true, image: 'https://media.nft.crypto.com/f3bdf36b-403b-4799-a39f-2c21cea5dc99/original.jpg?d=lg-logo' },
  { id: 'c942e9924b01fae996d8f817060611eb', name: 'Cryptonauts', process: true, usePagination: true, image: 'https://media.nft.crypto.com/5057c430-e7f5-4462-a6d2-7bb2bfb68700/original.jpg?d=lg-logo' },
];

// Générer les URLs des collections à traiter (uniquement celles avec process: true).
// SNAP_ONLY=<id> (ou nom partiel) permet de ne traiter qu'une collection (debug/test).
const _only = (process.env.SNAP_ONLY || '').trim().toLowerCase();
const collectionUrls = collections
  .filter(collection => collection.process)
  .filter(collection => !_only || collection.id.toLowerCase().includes(_only) || collection.name.toLowerCase().includes(_only))
  .map(collection => ({
    url: `https://crypto.com/nft/collection/${collection.id}`,
    usePagination: collection.usePagination
  }));

// Fonction de délai personnalisée
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Fonction pour nettoyer le nom de la collection pour les IDs HTML
function cleanFileName(name) {
  return name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

// Fonction pour assigner les rangs (gold, silver, bronze) aux trois premiers propriétaires
function assignRanks(owners) {
  const sortedOwners = [...owners].sort((a, b) => b[1] - a[1]);
  let currentRank = 1;
  let previousCount = null;
  return sortedOwners.map(([name, count], index) => {
    if (index > 0 && count < previousCount) {
      currentRank += 1;
    }
    previousCount = count;
    let rank = null;
    let rankClass = '';
    if (currentRank === 1) {
      rank = 'gold';
      rankClass = 'rank-1';
    } else if (currentRank === 2) {
      rank = 'silver';
      rankClass = 'rank-2';
    } else if (currentRank === 3) {
      rank = 'bronze';
      rankClass = 'rank-3';
    }
    return { name, url: `https://crypto.com/nft/profile/${name}`, count, rank, rankClass };
  });
}

// Fonction pour charger Owners.json
function loadOwnersJson() {
  try {
    if (fs.existsSync('Owners.json')) {
      const data = fs.readFileSync('Owners.json', 'utf8');
      return JSON.parse(data);
    }
    return {};
  } catch (error) {
    console.error('Error loading Owners.json:', error.message);
    return {};
  }
}

// Fonction pour sauvegarder Owners.json
function saveOwnersJson(ownersData) {
  try {
    fs.writeFileSync('Owners.json', JSON.stringify(ownersData, null, 2), 'utf8');
  } catch (error) {
    console.error('Error saving Owners.json:', error.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL — endpoint + config (alignés sur le panel Snapshot v3.9.8 d'index.html)
// ─────────────────────────────────────────────────────────────────────────────
const GQL_ENDPOINT = 'https://crypto.com/nft-api/graphql';

const HTTP_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
};

// Tunables — calqués sur SNAP_CONF (v3.9.8). Le modèle de coût de l'API plafonne
// à 250/requête, ~17 par alias → 10 alias × first=1 ≈ 170 (sûr), 5 × first=100 ≈ 135.
const SNAP_CONF = {
  ASSET_PAGE_SIZE:                 100,  // assets() page size (max API)
  ASSET_PAGE_CONCURRENCY:            3,  // pages assets() en parallèle
  HISTORY_PAGE_SIZE:               100,  // eventHistory page size (séquentiel)
  HISTORY_MAX_CONSECUTIVE_FAILS:     5,  // abandon après N échecs d'affilée
  RETRY_BASE_MS:                   500,  // backoff exponentiel de base
  RETRY_MAX_ATTEMPTS:                7,  // 0.5,1,2,4,8,16,30s (anti-429 résilient)
  RETRY_MAX_MS:                  30000,  // plafond du backoff
  PHASE_B_EMPTY_WAVE_LIMIT:          3,  // stop pagination spéculative après N vagues vides
  FALLBACK_BATCH_SIZE_SINGLE:       10,  // alias/HTTP pour single-edition (first=1)
  FALLBACK_BATCH_SIZE_MULTI:         5,  // alias/HTTP pour multi-edition  (first=100)
  FALLBACK_BATCH_CONCURRENCY:        2,  // batches de fallback en parallèle
  FALLBACK_INTER_BATCH_DELAY_MS:    50,  // petit délai entre batches
  SECONDARY_FALLBACK_CAP:           50,  // max assets retentés via editionEvents
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Exécute `worker` sur chaque item avec au plus `limit` tâches simultanées.
// Conserve l'ordre des résultats (results[i] correspond à items[i]).
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) break;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

// Découpe un tableau en morceaux de n
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ── Queries (copiées du module Snapshot v3.9.8) ──────────────────────────────
const Q_COLLECTION_INFO = `query GetCollection($collectionId:ID!,$cacheId:ID){
  public(cacheId:$cacheId){collection(id:$collectionId){
    id name verified
    metrics{ items }
  }}}`;

const Q_COLLECTION_METRIC = `query GetCollectionMetric($collectionId:ID!,$cacheId:ID){
  public(cacheId:$cacheId){collectionMetric(id:$collectionId){
    totalSupply totalSalesCount owners totalSalesDecimal minSaleListingPriceDecimal
  }}}`;

const Q_ALL_ASSETS = `query GetCollectionAssets($collectionId:ID,$first:Int!,$skip:Int!,$cacheId:ID){
  public(cacheId:$cacheId){assets(collectionId:$collectionId,first:$first,skip:$skip){
    id name copies copiesInCirculation
    offerableEditionId
    defaultListingV2{ editionId }
    latestPurchasedEdition{ id }
  }}}`;

const Q_HISTORY = `query getCollectionEventHistory($collectionId:ID!,$first:Int!,$after:String,$naturesIn:[String!],$cacheId:ID){
  public(cacheId:$cacheId){collection(id:$collectionId){id eventHistory(first:$first,after:$after,naturesIn:$naturesIn){
    edges{node{nature createdAt
      asset{id}
      edition{index}
      toUser{uuid username displayName verified isCreator}
      user{uuid username displayName verified isCreator}
    }}
    pageInfo{endCursor hasNextPage}
  }}}}`;

const Q_EDITION_EVENTS = `query EditionEvents($editionId:ID!,$cacheId:ID){
  public(cacheId:$cacheId){editionEvents(editionId:$editionId){
    nature createdAt
    toUser{uuid username displayName verified isCreator}
    user{uuid username displayName verified isCreator}
  }}}`;

// Seul 'transferred' est accepté comme filtre naturesIn par l'API (vérifié
// empiriquement). Chaque acquisition produit un event 'transferred' → couvre
// tous les changements de propriétaire. Les mints jamais transférés sont
// récupérés par le fallback editions(assetId:).
const TRANSFER_NATURES = ['transferred'];

const profileQuery = `
    query User($id: ID!, $cacheId: ID) {
        public(cacheId: $cacheId) {
            user(id: $id) {
                username
                twitterUsername
            }
        }
    }
`;

// ── Couche réseau ────────────────────────────────────────────────────────────
const _silentErrorsSeen = new Set();

// POST GraphQL unique avec retry sur erreurs transitoires (réseau / 429 / 403 /
// 5xx). Les erreurs GraphQL *logiques* (errors && !data) ne sont pas retentées.
// Les erreurs partielles (errors && data) sont loggées une fois puis on renvoie data.
async function gql(operationName, variables, query) {
  let lastErr;
  for (let attempt = 0; attempt < SNAP_CONF.RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await axios.post(GQL_ENDPOINT,
        { operationName, variables: variables || {}, query },
        { timeout: 20000, headers: HTTP_HEADERS });
      const json = res.data;
      if (json.errors && !json.data) {
        const e = new Error(json.errors[0]?.message || 'GraphQL error (no data)');
        e.graphqlLogic = true;
        throw e;
      }
      if (json.errors && json.data && !_silentErrorsSeen.has(operationName)) {
        _silentErrorsSeen.add(operationName);
        console.warn(`[gql] ${operationName} partial errors:`, json.errors.slice(0, 3).map(e => e.message).join(' | '));
      }
      return json.data;
    } catch (e) {
      lastErr = e;
      if (e.graphqlLogic) throw e; // non-retryable
      if (attempt < SNAP_CONF.RETRY_MAX_ATTEMPTS - 1) {
        const backoff = Math.min(SNAP_CONF.RETRY_MAX_MS, SNAP_CONF.RETRY_BASE_MS * Math.pow(2, attempt));
        await sleep(backoff + Math.floor(Math.random() * 400));
      }
    }
  }
  throw lastErr;
}

// editions(assetId:) BATCHÉES via fragments aliasés : 1 HTTP = N requêtes.
// Amortit le surcoût de coût (~17/alias) → ~10× moins de round-trips = anti-429.
// Les assetId sont validés en hex avant interpolation (anti-injection).
const HEX_RE = /^[0-9a-fA-F]+$/;
async function gqlBatchEditions(assetIds, opts = {}) {
  const first = opts.first || 1;
  const skip = Number.isInteger(opts.skip) ? opts.skip : 0;
  assetIds.forEach(id => {
    if (typeof id !== 'string' || id.length > 64 || !HEX_RE.test(id)) {
      throw new Error(`Bad assetId in batch: ${id}`);
    }
  });
  const fragments = assetIds.map((id, i) =>
`a${i}: public {
  editions(assetId: "${id}", first: ${first}, skip: ${skip}, isDropLast: false) {
    totalCount
    editions {
      id index
      owner { uuid username displayName verified isCreator }
      ownership { primary }
    }
  }
}`).join('\n');
  const query = `query SnapBatchEditions {\n${fragments}\n}`;

  let lastErr;
  for (let attempt = 0; attempt < SNAP_CONF.RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await axios.post(GQL_ENDPOINT, { operationName: 'SnapBatchEditions', query },
        { timeout: 20000, headers: HTTP_HEADERS });
      const json = res.data;
      if (json.errors && !json.data) throw new Error('GraphQL: ' + (json.errors[0]?.message || 'no data'));
      if (json.errors && json.errors.length && !_silentErrorsSeen.has('SnapBatchEditions')) {
        _silentErrorsSeen.add('SnapBatchEditions');
        console.warn('[gqlBatchEditions] partial errors:', json.errors.slice(0, 3).map(e => e.message).join(' | '));
      }
      const out = {};
      assetIds.forEach((id, i) => { out[id] = json.data?.[`a${i}`]?.editions || null; });
      return out;
    } catch (e) {
      lastErr = e;
      if (attempt < SNAP_CONF.RETRY_MAX_ATTEMPTS - 1) {
        const backoff = Math.min(SNAP_CONF.RETRY_MAX_MS, SNAP_CONF.RETRY_BASE_MS * Math.pow(2, attempt));
        await sleep(backoff + Math.floor(Math.random() * 400));
      }
    }
  }
  throw lastErr;
}

// Fonction pour récupérer le twitterUsername via une requête GraphQL directe
async function getTwitterUsername(username) {
  let twitterUsername = null;
  let retries = 3;
  let delayMs = 1000;
  while (retries > 0 && !twitterUsername) {
    try {
      const response = await axios.post(GQL_ENDPOINT, {
        query: profileQuery,
        variables: { id: username, cacheId: `getUserQuery-Profile-${username}` }
      }, { timeout: 10000, headers: HTTP_HEADERS });
      const result = response.data;
      if (result.errors) throw new Error(`GraphQL Error: ${result.errors.map(e => e.message).join(', ')}`);
      const userData = result.data?.public?.user;
      if (userData?.twitterUsername) twitterUsername = userData.twitterUsername.replace(/^@/, '');
      retries = 0;
    } catch (error) {
      retries--;
      if (retries > 0) { await sleep(delayMs); delayMs *= 2; }
    }
  }
  return twitterUsername ? `https://x.com/${twitterUsername}` : '';
}

// ── Phase C — parcours eventHistory (séquentiel, cursor) ─────────────────────
// Dérive l'owner courant par ÉDITION (asset.id × edition.index). Events en
// newest-first → le 1er event vu pour une édition = état courant.
async function walkOwnersAndDates(collectionId) {
  const currentOwnerKey = {};      // "assetId|index" → déjà vu ?
  const realEditionsPerAsset = {}; // assetId → [{ id, index, owner, ownership }]
  let cursor = null, hasMore = true;
  let eventCount = 0, pages = 0, pageFailures = 0, consecutiveFailures = 0;
  const pageErrorMsgs = [];

  while (hasMore) {
    pages++;
    let data;
    try {
      data = await gql('getCollectionEventHistory',
        { collectionId, first: SNAP_CONF.HISTORY_PAGE_SIZE, after: cursor || null, naturesIn: TRANSFER_NATURES, cacheId: 'snap-hist-' + collectionId + '-' + (cursor || 'head') },
        Q_HISTORY);
      consecutiveFailures = 0;
    } catch (e) {
      pageFailures++;
      consecutiveFailures++;
      if (pageErrorMsgs.length < 3) pageErrorMsgs.push(e.message);
      if (consecutiveFailures >= SNAP_CONF.HISTORY_MAX_CONSECUTIVE_FAILS) {
        throw new Error(`Event history walk aborted: ${consecutiveFailures} consecutive page failures. Last error: ${pageErrorMsgs[0] || 'unknown'}`);
      }
      await sleep(500);
      continue;
    }

    const hist = data?.public?.collection?.eventHistory;
    if (!hist) break;

    hist.edges.forEach(({ node }) => {
      if (!node) return;
      const aid = node.asset?.id;
      if (!aid) return;
      const idx = node.edition?.index ?? 1;
      const key = `${aid}|${idx}`;
      const nature = node.nature || 'unknown';

      let owner = null;
      if (node.toUser?.username) owner = node.toUser;
      else if (nature === 'withdrawn' && node.user?.username) owner = node.user;

      if (!currentOwnerKey[key] && owner) {
        currentOwnerKey[key] = true;
        if (!realEditionsPerAsset[aid]) realEditionsPerAsset[aid] = [];
        realEditionsPerAsset[aid].push({ id: null, index: idx, owner, ownership: { primary: false } });
      }
      eventCount++;
    });

    cursor = hist.pageInfo.endCursor;
    hasMore = hist.pageInfo.hasNextPage;
  }

  return { realEditionsPerAsset, eventCount, pages, pageFailures };
}

// Construit le classement (collections + leaderboard global) et l'écrit dans data.json.
// Test.js ne génère plus index.html : l'index charge data.json en direct via fetch().
// ─────────────────────────────────────────────────────────────────────────────
// Collection externe V3 (Quantum Cryptonauts V3) — Crovia / Cronos on-chain.
// Crovia bloque le scraping (Cloudflare) ; on lit donc les détenteurs DIRECTEMENT
// on-chain via un RPC public Cronos : on parcourt tous les events Transfer du
// contrat ERC-721 et on calcule le propriétaire actuel de chaque tokenId.
// → comptes exacts et auto-actualisés à chaque run. Les pseudos (non on-chain)
// proviennent de la table fixe V3_NAMES ; les autres holders s'affichent en adresse.
// ─────────────────────────────────────────────────────────────────────────────
const V3_CONTRACT = '0x840d5e2df597ab3dcfed4e5fc883c8d87606748d';
const V3_CREATION_BLOCK = 77606321; // bloc de déploiement (fixe) — évite la recherche
const V3_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// Cronos ID (service de noms .cro, fork ENS) — registry pour la résolution inverse adresse→nom.
// Docs : https://docs.cronosid.xyz/fundamentals/smart-contracts
const CROID_REGISTRY = '0x7F4C61116729d5b27E5f180062Fdfbf32E9283E5';
// Marketplace Crovia : event Sale émis à chaque vente secondaire (topic0 ci-dessous).
// data = [nftContract, tokenId, price, fee, royalty, royaltyRecipient] ; topics = [sig, saleId, seller, buyer].
const CROVIA_SALE_TOPIC = '0x1261f893ba16d5623de55d479f6f662eb565a4f6130f271f6777940c312c356d';
// API PUBLIQUE Crovia (crovia.app/api/v1) : source primaire pour holders, ventes (cross-marketplace),
// floor et volume — exacte et rapide, passe Cloudflare depuis une IP résidentielle (runner). Repli
// on-chain (fetchV3Holders) si l'API échoue. Doc : https://crovia.app/developers
const CROVIA_API = 'https://crovia.app/api/v1';

// ── Collections externes Crovia à publier (fiche + Sales Bot : holders, ventes, floor, volume, mints) ──
// Pour AJOUTER un nouveau drop de l'artiste : renseigner son `contract` (déployé au lancement) — le
// reste (données live + ventes/mints dans le bot) devient automatique. `contract` vide = ignorée.
// Ordre = ordre d'affichage (la plus récente en premier).
const CROVIA_COLLECTIONS = [
  { id: 'collection-civilizations', title: 'Cryptonauts Civilizations', contract: '0x721559274c8a739d1e5e35506f91a7ce56868c7f',
    image: 'assets/civilizations-logo.jpg', banner: 'assets/civilizations-banner.jpg',
    alt: 'Cryptonauts Civilizations collection icon', mintTotal: 359, mintPriceCro: 399 },
  { id: 'collection-v3', title: 'Quantum Cryptonauts V3', contract: '0x840d5e2df597ab3dcfed4e5fc883c8d87606748d',
    image: 'assets/v3-logo.jpg?v=2', banner: 'assets/v3-banner.jpg?v=2',
    alt: 'Quantum Cryptonauts V3 COLLECTION ICON', mintTotal: 299, mintPriceCro: 400 },
];
// RPC publics Cronos qui acceptent eth_getLogs sur des fenêtres de ~2000 blocs (archive).
// NB (vérifié 2026-06) : publicnode exige désormais un "personal token" pour l'archive et
// 1rpc.io plafonne getLogs à 50 blocs → tous deux inutilisables ici (faisaient échouer la
// lecture on-chain V3, d'où le repli permanent sur V3_FALLBACK : mint/holders/ventes figés).
const CRONOS_RPCS = ['https://evm.cronos.org', 'https://cronos.drpc.org', 'https://rpc.vvs.finance'];
const RPC_LOG_STEP = 1999; // < limite de 2000 blocs/getLogs des RPC publics

// API Explorer Cronos (Blockscout, compat Etherscan) — clé fournie via secret GitHub
// CRONOS_EXPLORER_API_KEY. Source fiable et indexée des transferts NFT (mints V3) pour le
// Sales Bot, en remplacement du scan RPC (plafonné à 2000 blocs). Clé : https://explorer.cronos.com/register
const CRONOS_EXPLORER_API = 'https://explorer-api.cronos.org/mainnet/api/v1';
const CRONOS_EXPLORER_KEY = process.env.CRONOS_EXPLORER_API_KEY || '';

// Noms des détenteurs V3. Priorité : (1) OVERRIDE manuel ci-dessous, (2) nom .cro résolu
// ON-CHAIN via Cronos ID (comme Crovia), (3) adresse tronquée. Les pseudos manuels ci-dessous
// sont des détenteurs connus SANS nom .cro public (Crovia les affiche en adresse) — on garde
// notre libellé plus lisible ; leurs comptes correspondent exactement à Crovia.
// ⚠ NE PAS remettre les mappings ERRONÉS repérés on-chain : 0x64c15…='JAMUS0' est en fait
// zenoob.cro, et 0xedce…='SNAKE APE' est en fait mikeb.cro → laissés à la résolution .cro.
const V3_NAMES = {
  '0x13550dd892ab9cb22b7a6e48d5eba0d2d181884b': 'SANDIMAN',
  '0x2b8b37dd17fa67833b01e30229502169d1a8ae40': 'MTCH',
  '0xac96bdcd69f708a5f660425af5d1248aa27fc1ee': 'JERAAAMY',
  '0x740cd1001bf468e03a2cef898c4ce880f228da0d': 'CLOUDY',
  '0x183379144e7c8581f24b02b7eedd4e9995bb1048': 'PAULO24',
  '0xe6e7284ddc793fdc15c8cdfbde49a2b7e2b234ed': 'WARNEREVERCHANGE',
  '0x7886acebc8401bd6b1cf397d84b85d01416e4c06': 'PAYSAGISTE00',
};

// Repli si la lecture on-chain échoue (snapshot du 2026-06-26) → data.json garde un V3 cohérent.
const V3_FALLBACK = [
  { addr: '0x13550dd892ab9cb22b7a6e48d5eba0d2d181884b', count: 76 },
  { addr: '0x2b8b37dd17fa67833b01e30229502169d1a8ae40', count: 55 },
  { addr: '0x740cd1001bf468e03a2cef898c4ce880f228da0d', count: 49 },
  { addr: '0xac96bdcd69f708a5f660425af5d1248aa27fc1ee', count: 45 },
  { addr: '0x183379144e7c8581f24b02b7eedd4e9995bb1048', count: 12 },
  { addr: '0xe6e7284ddc793fdc15c8cdfbde49a2b7e2b234ed', count: 10 },
  { addr: '0x7886acebc8401bd6b1cf397d84b85d01416e4c06', count: 6 },
  { addr: '0xedce0151656e82150a0835e9b9cbd1ec53a17eae', count: 5 },
  { addr: '0x64c15f07ea231789bf5d6f9ecc8089caae46b5c2', count: 4 },
  { addr: '0x105f4ed058dc3029c21489f0f1567475e0eeb242', count: 4 },
  { addr: '0x17bb1d83b312ce76eba5ffd43226b8c98652c1f6', count: 4 },
  { addr: '0x478ffba8ea4945fb9327812231dfb1c6cafd2c49', count: 3 },
  { addr: '0x8147d4d7578e661004e25ffd3f9fd7bac1f6fb06', count: 2 },
  { addr: '0x1d9b981b7aba1a747883833fb8a1b5072eac5d8f', count: 2 },
  { addr: '0x965a73574acb12b9b48f3ff43415eea791fd70bd', count: 1 },
  { addr: '0x27ac7493fa8395ad35c260282522b3d9e314cee7', count: 1 },
  { addr: '0x2270cbad5072b7685357ec83ddc959ffde535b27', count: 1 },
  { addr: '0xf7e392c06c7691b44a06a0ec1e723bcc0533febf', count: 1 },
  { addr: '0x8802ebcf0b6bbc97a00fe3495ec0dabf12a0fb2f', count: 1 },
  { addr: '0xc54c922e7431f5fde646bca35f55adb8ff701ff9', count: 1 },
];

let _v3RpcIdx = 0;
async function cronosRpc(method, params) {
  const MAX_ATTEMPTS = 8;
  let lastErr;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      const res = await axios.post(CRONOS_RPCS[_v3RpcIdx], { jsonrpc: '2.0', id: 1, method, params },
        { timeout: 20000, headers: { 'Content-Type': 'application/json' } });
      if (res.data?.error) throw new Error(res.data.error.message);
      return res.data?.result;
    } catch (e) {
      lastErr = e;
      _v3RpcIdx = (_v3RpcIdx + 1) % CRONOS_RPCS.length; // RPC suivant
      // Backoff exponentiel sur 429/503 (les RPC publics limitent le débit), sinon court.
      const status = e.response?.status;
      const backoff = (status === 429 || status === 503 || !e.response)
        ? Math.min(8000, 500 * Math.pow(2, Math.floor(i / CRONOS_RPCS.length)))
        : 300;
      await delay(backoff + Math.floor(Math.random() * 250));
    }
  }
  throw lastErr;
}

// Lit le classement des détenteurs V3 on-chain. Renvoie [{addr,count}] trié desc, ou null si échec.
async function fetchV3Holders() {
  try {
    const latest = parseInt(await cronosRpc('eth_blockNumber', []), 16);
    const windows = [];
    for (let from = V3_CREATION_BLOCK; from <= latest; from += RPC_LOG_STEP + 1) {
      windows.push([from, Math.min(from + RPC_LOG_STEP, latest)]);
    }
    console.log(`V3 on-chain : lecture des Transfer sur ${windows.length} fenêtres (blocs ${V3_CREATION_BLOCK}→${latest})…`);
    const logs = [];
    await mapPool(windows, 3, async ([from, to]) => {
      const res = await cronosRpc('eth_getLogs', [{
        address: V3_CONTRACT, topics: [V3_TRANSFER_TOPIC],
        fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16)
      }]);
      (res || []).forEach(l => logs.push(l));
    });
    // Tri chronologique strict, puis dernier `to` par tokenId = propriétaire actuel.
    logs.sort((a, b) => (parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16)) || (parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16)));
    const ZERO = '0x0000000000000000000000000000000000000000';
    const ownerOf = {};
    const mintsRaw = []; // mints = transferts depuis 0x0 : { t, b, bn }
    const salesRaw = []; // ventes secondaires (from≠0, to≠0) : { t, from, to, bn, tx }
    for (const l of logs) {
      if (!l.topics || l.topics.length !== 4) continue; // ERC-721 (tokenId indexé)
      const to = '0x' + l.topics[2].slice(26).toLowerCase();
      const from = '0x' + l.topics[1].slice(26).toLowerCase();
      const tokenId = BigInt(l.topics[3]).toString();
      ownerOf[tokenId] = to;
      if (from === ZERO) mintsRaw.push({ t: Number(tokenId), b: to, bn: parseInt(l.blockNumber, 16) });
      else if (to !== ZERO) salesRaw.push({ t: Number(tokenId), from, to, bn: parseInt(l.blockNumber, 16), tx: l.transactionHash });
    }
    const counts = {};
    for (const t in ownerOf) { const o = ownerOf[t]; if (o === ZERO) continue; counts[o] = (counts[o] || 0) + 1; }
    const ranking = Object.entries(counts).map(([addr, count]) => ({ addr, count })).sort((a, b) => b.count - a.count);
    if (ranking.length === 0) throw new Error('0 holder résolu');

    // Ventes secondaires : prix réel lu dans l'event Sale du marketplace Crovia (receipt du tx).
    const secSales = await fetchV3SecondarySales(salesRaw);

    // Date des mints ET des ventes (= flux Sales Bot) : timestamp du bloc.
    const uniqBlocks = [...new Set([...mintsRaw.map(m => m.bn), ...secSales.map(s => s.bn)])];
    const blockTs = {};
    await mapPool(uniqBlocks, 3, async (bn) => {
      try {
        const blk = await cronosRpc('eth_getBlockByNumber', ['0x' + bn.toString(16), false]);
        if (blk && blk.timestamp) blockTs[bn] = parseInt(blk.timestamp, 16);
      } catch (e) { /* bloc ignoré */ }
    });
    // Prix de mint forfaitaire (300 CRO) — non disponible dans le log Transfer.
    const mints = mintsRaw
      .map(m => ({ t: m.t, b: m.b, cro: 300, ts: blockTs[m.bn] || 0 }))
      .filter(m => m.ts > 0)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 40);
    // Ventes secondaires : prix vendeur réel (CRO), vendeur (s) + acheteur (b), datées.
    const sales = secSales
      .map(s => ({ t: s.t, b: s.to, s: s.from, cro: s.cro, ts: blockTs[s.bn] || 0 }))
      .filter(s => s.ts > 0)
      .sort((a, b) => b.ts - a.ts);

    console.log(`✅ V3 on-chain : ${ranking.length} détenteurs · ${ranking.reduce((s, r) => s + r.count, 0)} NFT · ${mints.length} mints · ${sales.length} ventes secondaires.`);
    return { ranking, mints, sales };
  } catch (e) {
    console.warn(`⚠ Lecture on-chain V3 échouée (${e.message}) → repli sur le snapshot intégré.`);
    return null;
  }
}

// Ventes secondaires V3 : pour chaque tx de transfert secondaire, lit l'event Sale du marketplace
// Crovia dans le receipt → prix vendeur (CRO), vendeur, acheteur, tokenId. Les transferts sans event
// Sale (cadeaux / transferts simples) sont naturellement ignorés. Renvoie [{t, from, to, cro, bn}].
async function fetchV3SecondarySales(salesRaw) {
  const txs = [...new Set((salesRaw || []).map(s => s.tx))];
  if (!txs.length) return [];
  const out = [];
  await mapPool(txs, 4, async (tx) => {
    try {
      const rc = await cronosRpc('eth_getTransactionReceipt', [tx]);
      if (!rc || !rc.logs) return;
      for (const l of rc.logs) {
        if (!l.topics || l.topics.length < 4 || (l.topics[0] || '').toLowerCase() !== CROVIA_SALE_TOPIC) continue;
        const d = (l.data || '0x').slice(2);
        if (d.length < 192) continue;
        const nft = '0x' + d.slice(24, 64);                      // dataword0 = contrat NFT vendu
        if (nft.toLowerCase() !== V3_CONTRACT) continue;         // autres collections Crovia ignorées
        const t = Number(BigInt('0x' + d.slice(64, 128)));       // dataword1 = tokenId
        const cro = Number(BigInt('0x' + d.slice(128, 192))) / 1e18; // dataword2 = prix vendeur (= prix Crovia)
        const from = '0x' + l.topics[2].slice(26).toLowerCase(); // vendeur
        const to = '0x' + l.topics[3].slice(26).toLowerCase();   // acheteur
        out.push({ t, from, to, cro, bn: parseInt(l.blockNumber, 16) });
      }
    } catch (e) { /* tx ignoré */ }
  });
  return out;
}

// Mints V3 récents via l'API Explorer Cronos (clé). Renvoie [{t,b,cro,ts}] trié du + récent,
// ou null si pas de clé / échec (→ repli sur les mints lus on-chain par fetchV3Holders).
async function fetchV3MintsExplorer(limit = 40) {
  if (!CRONOS_EXPLORER_KEY) { console.log('ℹ Pas de CRONOS_EXPLORER_API_KEY → mints V3 via RPC on-chain.'); return null; }
  const ZERO = '0x0000000000000000000000000000000000000000';
  try {
    const url = `${CRONOS_EXPLORER_API}/account/tokennfttx`;
    const res = await axios.get(url, {
      params: { contractaddress: V3_CONTRACT, page: 1, offset: 200, sort: 'desc', apikey: CRONOS_EXPLORER_KEY },
      timeout: 20000, headers: { 'accept': 'application/json' }
    });
    // Réponses possibles : Etherscan-compat {status,message,result:[…]} ou {items:[…]}/{data:[…]}.
    const d = res.data || {};
    const rows = Array.isArray(d.result) ? d.result : (Array.isArray(d.items) ? d.items : (Array.isArray(d.data) ? d.data : null));
    if (!rows) { console.warn('⚠ Explorer API V3 : forme inattendue →', JSON.stringify(d).slice(0, 200)); return null; }
    const mints = rows
      .filter(r => String(r.from || r.fromAddress || '').toLowerCase() === ZERO)
      .map(r => ({
        t: parseInt(r.tokenID != null ? r.tokenID : (r.tokenId != null ? r.tokenId : r.token_id), 10),
        b: String(r.to || r.toAddress || '').toLowerCase(),
        cro: 300,
        ts: parseInt(r.timeStamp != null ? r.timeStamp : (r.timestamp != null ? r.timestamp : r.time_stamp), 10)
      }))
      .filter(m => Number.isFinite(m.t) && m.ts > 0)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
    console.log(`✅ Explorer API V3 : ${mints.length} mints récents (sur ${rows.length} transferts).`);
    return mints.length ? mints : null;
  } catch (e) {
    console.warn(`⚠ Explorer API V3 échouée (${e.message}) → repli sur les mints RPC on-chain.`);
    return null;
  }
}

// Mints RÉCENTS d'une collection (vente primaire) : scan on-chain BORNÉ des Transfer depuis 0x0
// sur les derniers `spanBlocks` blocs (~2-3 jours). Rapide, sans clé, et LIVE — capte
// automatiquement les mints d'une collection EN COURS de mint (nouveau drop de l'artiste). Renvoie
// [] si aucun mint récent (collection sold-out, cas actuel du V3). [{t,b,cro,ts}] trié récent, max 40.
async function fetchRecentMints(contract, spanBlocks = 400000, mintPriceCro = 300) {
  try {
    const latest = parseInt(await cronosRpc('eth_blockNumber', []), 16);
    const from0 = Math.max(0, latest - spanBlocks);
    const windows = [];
    for (let f = from0; f <= latest; f += RPC_LOG_STEP + 1) windows.push([f, Math.min(f + RPC_LOG_STEP, latest)]);
    const logs = [];
    await mapPool(windows, 5, async ([f, t]) => {
      const res = await cronosRpc('eth_getLogs', [{
        address: contract, topics: [V3_TRANSFER_TOPIC, '0x' + '0'.repeat(64)], // from = 0x0 (mint)
        fromBlock: '0x' + f.toString(16), toBlock: '0x' + t.toString(16)
      }]);
      (res || []).forEach(l => logs.push(l));
    });
    const raw = logs.filter(l => l.topics && l.topics.length === 4)
      .map(l => ({ t: Number(BigInt(l.topics[3])), b: '0x' + l.topics[2].slice(26).toLowerCase(), bn: parseInt(l.blockNumber, 16) }));
    if (!raw.length) { console.log(`ℹ Aucun mint récent (${windows.length} fenêtres) — collection sold-out/inactive.`); return []; }
    const uniqBlocks = [...new Set(raw.map(m => m.bn))];
    const blockTs = {};
    await mapPool(uniqBlocks, 5, async (bn) => {
      try { const blk = await cronosRpc('eth_getBlockByNumber', ['0x' + bn.toString(16), false]); if (blk && blk.timestamp) blockTs[bn] = parseInt(blk.timestamp, 16); } catch (e) { /* bloc ignoré */ }
    });
    const mints = raw.map(m => ({ t: m.t, b: m.b, cro: mintPriceCro, ts: blockTs[m.bn] || 0 }))
      .filter(m => m.ts > 0).sort((a, b) => b.ts - a.ts).slice(0, 40);
    console.log(`✅ Mints récents : ${mints.length} (scan borné ${windows.length} fenêtres).`);
    return mints;
  } catch (e) {
    console.warn(`⚠ Scan mints récents échoué (${e.message}).`);
    return [];
  }
}

// Détenteurs, ventes (cross-marketplace), floor et volume V3 via l'API PUBLIQUE Crovia.
// Renvoie { owners:[{addr,count}], sales:[{t,b,s,cro,ts}], salesCount, volume, floor } ou null si échec.
async function fetchCroviaCollection(contract) {
  const H = {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36', 'Accept': 'application/json', 'Referer': 'https://crovia.app/' },
    timeout: 20000, validateStatus: s => s === 200
  };
  try {
    const [ownR, salesR, floorR] = await Promise.all([
      axios.get(`${CROVIA_API}/collections/${contract}/owners?limit=1000`, H),
      axios.get(`${CROVIA_API}/collections/${contract}/sales?days=3650&limit=200`, H),
      axios.get(`${CROVIA_API}/collections/${contract}/floor`, H),
    ]);
    const arr = r => (r.data && (r.data.data || r.data)) || [];
    const owners = arr(ownR)
      .map(o => ({ addr: String(o.address || '').toLowerCase(), count: Number(o.count) }))
      .filter(o => /^0x[0-9a-f]{40}$/.test(o.addr) && Number.isFinite(o.count))
      .sort((a, b) => b.count - a.count);
    if (!owners.length) throw new Error('0 détenteur via API');
    const sales = arr(salesR)
      .map(s => ({ t: Number(s.tokenId), b: String(s.buyer || '').toLowerCase(), s: String(s.seller || '').toLowerCase(), cro: Number(s.priceCro), ts: Math.floor(new Date(s.soldAt).getTime() / 1000) }))
      .filter(x => Number.isFinite(x.t) && x.ts > 0)
      .sort((a, b) => b.ts - a.ts);
    const volume = Math.round(sales.reduce((a, x) => a + (x.cro || 0), 0));
    const floor = Number((floorR.data && floorR.data.data && floorR.data.data.floor)) || 0;
    console.log(`✅ API Crovia : ${owners.length} détenteurs · ${sales.length} ventes · floor ${floor} CRO · volume ${volume} CRO.`);
    return { owners, sales, salesCount: sales.length, volume, floor };
  } catch (e) {
    console.warn(`⚠ API Crovia échouée (${e.message}) → repli on-chain.`);
    return null;
  }
}

// Construit l'objet collection Crovia (format data.json) depuis sa config + un classement [{addr,count}].
// names = map {adresse(min): nom .cro} résolue on-chain (override manuel V3_NAMES prioritaire).
// stats = { floor, volume, salesCount } (API Crovia) ; 0 si indisponibles (repli on-chain).
function buildCroviaCollection(cfg, ranking, names = {}, stats = {}) {
  const trunc = a => a.slice(0, 6) + '…' + a.slice(-4);
  const owners = ranking.map(({ addr, count }) => ({
    name: V3_NAMES[addr.toLowerCase()] || names[addr.toLowerCase()] || trunc(addr),
    count,
    url: 'https://cronoscan.com/address/' + addr
  }));
  // Total minté (= NFT détenus) : somme des holdings → l'index l'affiche dans « Mint progress ».
  const minted = ranking.reduce((s, r) => s + r.count, 0);
  return {
    id: cfg.id, title: cfg.title,
    image: cfg.image, banner: cfg.banner, alt: cfg.alt,
    ownersCount: owners.length, external: 'crovia', contract: cfg.contract,
    croviaUrl: 'https://crovia.app/collections/' + cfg.contract,
    minted, mintTotal: cfg.mintTotal,
    // floor / volume / sales (en CRO) fournis par l'API Crovia. supply = NFT mintés (agrégat home).
    supply: minted, sales: stats.salesCount || 0, volume: stats.volume || 0, floor: stats.floor || 0,
    owners
  };
}

// Décode une string ABI (retour d'eth_call) : [offset][length][data utf8].
function decodeAbiString(hex) {
  if (!hex || hex === '0x') return '';
  const h = hex.slice(2);
  const off = parseInt(h.slice(0, 64), 16) * 2;
  const len = parseInt(h.slice(off, off + 64), 16) * 2;
  return Buffer.from(h.slice(off + 64, off + 64 + len), 'hex').toString('utf8');
}

// ── Résolution inverse .cro (Cronos ID / fork ENS) : adresse → nom, comme Crovia ──────
// namehash ENS : node = keccak256( node ‖ keccak256(label) ), en partant de 32 octets nuls.
function namehash(name) {
  let node = '00'.repeat(32);
  if (name) {
    const labels = name.split('.');
    for (let i = labels.length - 1; i >= 0; i--) {
      const labelHash = keccak256(Buffer.from(labels[i], 'utf8'));
      node = keccak256(Buffer.from(node + labelHash, 'hex'));
    }
  }
  return '0x' + node;
}
// Nœud inverse d'une adresse : namehash("<addr sans 0x, minuscule>.addr.reverse").
function reverseNode(addr) { return namehash(addr.toLowerCase().replace(/^0x/, '') + '.addr.reverse'); }

// Résout le nom .cro primaire d'une adresse (ou null). registry.resolver(node) → resolver.name(node).
async function resolveCroName(addr) {
  try {
    const node = reverseNode(addr);
    const resolverRaw = await cronosRpc('eth_call', [{ to: CROID_REGISTRY, data: '0x0178b8bf' + node.slice(2) }, 'latest']); // resolver(bytes32)
    if (!resolverRaw || /^0x0*$/.test(resolverRaw)) return null;
    const resolver = '0x' + resolverRaw.slice(-40);
    const name = decodeAbiString(await cronosRpc('eth_call', [{ to: resolver, data: '0x691f3431' + node.slice(2) }, 'latest'])); // name(bytes32)
    return name && name.length ? name : null;
  } catch (e) { return null; }
}

// Résout en parallèle (concurrence bornée) les noms .cro d'une liste d'adresses → map {addr(min): nom}.
async function resolveCroNames(addrs) {
  const uniq = [...new Set(addrs.map(a => a.toLowerCase()))];
  const map = {};
  await mapPool(uniq, 4, async (a) => { const n = await resolveCroName(a); if (n) map[a] = n; });
  console.log(`✅ Noms .cro résolus on-chain : ${Object.keys(map).length}/${uniq.length} détenteurs.`);
  return map;
}

// tokenURI(tokenId) d'un contrat ERC-721 via eth_call on-chain → ipfs://FOLDER/N.json.
async function croviaTokenURI(contract, tokenId) {
  const data = '0xc87b56dd' + BigInt(tokenId).toString(16).padStart(64, '0'); // selector tokenURI(uint256)
  return decodeAbiString(await cronosRpc('eth_call', [{ to: contract, data }, 'latest']));
}

// Métadonnée JSON sur IPFS, avec repli multi-gateway (les passerelles publiques timeout souvent).
const V3_IPFS_GATEWAYS = ['https://gateway.pinata.cloud', 'https://dweb.link', 'https://ipfs.io', 'https://w3s.link', 'https://nftstorage.link'];
async function fetchIpfsJson(pathNoScheme) {
  for (const g of V3_IPFS_GATEWAYS) {
    try {
      const r = await axios.get(g + '/ipfs/' + pathNoScheme, { timeout: 15000 });
      if (r.data) return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    } catch (e) { /* gateway suivante */ }
  }
  return null;
}

// Carte des NFT d'une collection Crovia (tokenId → nom + hash image CDN), pour le Sales Bot
// (vignettes) ET la galerie de la collection sur le site. Source : API Crovia bulk paginée
// (/collections/{c}/nfts). Le hash est l'avant-dernier segment de l'URL image (cdn.crovia.app/
// {contract}/{HASH}/full.webp) — même CDN que le bot Discord, fiable contrairement aux passerelles
// IPFS publiques. Injectée dans data.json (externalAssets) → index.html la rend via croviaImg().
const CROVIA_NFT_H = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36', 'Accept': 'application/json', 'Referer': 'https://crovia.app/' }, timeout: 20000, validateStatus: s => s === 200 };
const croviaHashOf = img => { const p = String(img || '').split('/'); return (p.length >= 2 && /^[0-9a-f]{16,}$/i.test(p[p.length - 2])) ? p[p.length - 2] : ''; };
// Un NFT via l'API par-token (/nfts/{c}/{id}) → { i, n, h } ou null. Fiable, sert de complément
// quand l'endpoint bulk plafonne (voir fetchExternalAssets).
async function fetchOneAsset(contract, tokenId) {
  try {
    const r = await axios.get(`${CROVIA_API}/nfts/${contract}/${tokenId}`, CROVIA_NFT_H);
    const nft = (r.data && r.data.data !== undefined) ? r.data.data : r.data;
    const h = croviaHashOf(nft && nft.image);
    return h ? { i: Number(tokenId), n: (nft && nft.name) || ('#' + tokenId), h } : null;
  } catch (e) { return null; }
}
// Carte NFT d'une collection : bulk /collections/{c}/nfts (⚠ plafonné à 100, offset ignoré) PUIS
// complément par-token pour chaque tokenId du flux Sales Bot non couvert (garantit une vignette pour
// TOUTE vente/mint, même tokenId > 100). `feedIds` = tokenIds à garantir (ventes+mints récents).
async function fetchExternalAssets(contract, feedIds) {
  const map = new Map();
  try {
    const r = await axios.get(`${CROVIA_API}/collections/${contract}/nfts?limit=100`, CROVIA_NFT_H);
    const d = (r.data && r.data.data !== undefined) ? r.data.data : r.data;
    if (Array.isArray(d)) for (const x of d) { const h = croviaHashOf(x.image); const id = Number(x.tokenId); if (h && !map.has(id)) map.set(id, { i: id, n: x.name || ('#' + id), h }); }
  } catch (e) { console.warn(`⚠ assets bulk ${contract} : ${e.message}`); }
  // Complète les tokens du flux non déjà couverts (endpoint bulk plafonné à 100).
  const missing = [...new Set((feedIds || []).map(Number))].filter(id => !map.has(id));
  await mapPool(missing, 4, async (id) => { const a = await fetchOneAsset(contract, id); if (a) map.set(id, a); });
  return [...map.values()].sort((a, b) => a.i - b.i);
}

// Enrichit chaque vente/mint du Sales Bot avec le VRAI NFT : nom (n) + image (c, CID IPFS), résolus via
// tokenURI(id) on-chain (contrat de CHAQUE entrée) → métadonnée IPFS. Best-effort : sans ça, le Sales Bot
// retombe sur le logo de la collection. Chaque entrée doit porter son `contract`.
async function enrichExternalImages(items) {
  if (!items || !items.length) return;
  let ok = 0;
  await mapPool(items, 4, async (m) => {
    try {
      if (!m.contract) return;
      const uri = await croviaTokenURI(m.contract, m.t);
      if (!uri) return;
      const meta = await fetchIpfsJson(uri.replace(/^ipfs:\/\//, ''));
      if (!meta) return;
      if (meta.name) m.n = meta.name;
      const img = String(meta.image || '').replace(/^ipfs:\/\//, '').replace(/^.*\/ipfs\//, '');
      if (img) { m.c = img; ok++; }
    } catch (e) { /* repli logo */ }
  });
  console.log(`✅ Images des ventes/mints externes résolues : ${ok}/${items.length} (tokenURI → IPFS).`);
}

function writeCryptonautsData(collectionsData, globalOwnerNFTs, ownersData, externalCollections, v3Sales, externalAssets) {
  // Prepare collectionsData, including all collections from the collections array
  const allCollectionsData = collections.map(collection => {
    const scrapedData = collectionsData.find(data => data.collectionId === collection.id) || {
      collectionName: collection.name,
      totalSupply: 0,
      owners: 0,
      sales: 0,
      volume: 0,
      floor: 0,
      ownerNFTs: {}
    };
    return {
      id: `collection-${collections.indexOf(collection)}`,
      title: collection.name,
      image: collection.image,
      alt: `${collection.name} COLLECTION ICON`,
      ownersCount: scrapedData.owners,
      supply: scrapedData.totalSupply || 0,   // items (totalSupply live)
      sales: scrapedData.sales || 0,          // ventes secondaires (live)
      volume: scrapedData.volume || 0,        // volume échangé USD (live)
      floor: scrapedData.floor || 0,          // floor USD (live)
      // url reconstruite côté client, rank recalculé côté client, twitter omis si vide → JSON plus léger
      owners: Object.entries(scrapedData.ownerNFTs).map(([name, count]) => {
        const owner = { name, count };
        const tw = ownersData[name]?.twitter;
        if (tw) owner.twitter = tw;
        return owner;
      })
    };
  });

  // Collections externes (Crovia / Cronos) — ajoutées en tête (les plus récentes), dans l'ordre de la
  // config. Données via l'API Crovia (owners en adresses/cronoscan) ; volontairement absentes de
  // globalOwnersData (exclues du leaderboard global basé sur les pseudos crypto.com).
  allCollectionsData.unshift(...(externalCollections || []).filter(Boolean));

  // Prepare globalOwnersData (sans url ni rank : reconstruits/recalculés côté client)
  const globalOwnersData = assignRanks(Object.entries(globalOwnerNFTs)).map(({ name, count }) => {
    const owner = { name, count };
    const tw = ownersData[name]?.twitter;
    if (tw) owner.twitter = tw;
    return owner;
  });

  // Écrit le classement dans data.json (consommé par index.html via fetch).
  // v3Sales = mints V3 récents (on-chain) pour le Sales Bot — remplace l'ancien tableau figé.
  const out = { generatedAt: new Date().toISOString(), collectionsData: allCollectionsData, globalOwnersData, v3Sales: v3Sales || [], externalAssets: externalAssets || {} };
  try {
    fs.writeFileSync('data.json', JSON.stringify(out), 'utf8');
    console.log(`✅ data.json écrit : ${allCollectionsData.length} collections · ${globalOwnersData.length} holders globaux.`);
  } catch (error) {
    console.error('Erreur écriture data.json :', error.message);
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// processCollection — port fidèle du runSnapshot(collectionId) v3.9.8
// ─────────────────────────────────────────────────────────────────────────────
async function processCollection(collectionUrl, usePagination, globalOwnerNFTs, collectionsData, ownersData) {
  const collectionId = collectionUrl.split('/').pop();
  let collectionName = '';

  try {
    // ── PHASE A — Infos collection (nom + métriques officielles) ──────────────
    let officialItems = 0;
    let officialOwners = 0;
    let officialSales = 0;     // ventes secondaires (totalSalesCount)
    let officialVolume = 0;    // volume échangé USD (totalSalesDecimal)
    let officialFloor = 0;     // floor USD (minSaleListingPriceDecimal)
    try {
      const [info, metric] = await Promise.all([
        gql('GetCollection', { collectionId, cacheId: 'snap-col-' + collectionId }, Q_COLLECTION_INFO),
        gql('GetCollectionMetric', { collectionId, cacheId: 'snap-metric-' + collectionId }, Q_COLLECTION_METRIC).catch(() => null)
      ]);
      const c = info?.public?.collection;
      if (c) collectionName = c.name || '';
      const items = Number(c?.metrics?.items) || 0;
      const m = metric?.public?.collectionMetric;
      const totalSupply = Number(m?.totalSupply) || 0;
      officialItems = Math.max(items, totalSupply);
      officialOwners = Number(m?.owners) || 0;
      officialSales = Number(m?.totalSalesCount) || 0;
      officialVolume = Number(m?.totalSalesDecimal) || 0;
      officialFloor = Number(m?.minSaleListingPriceDecimal) || 0;
    } catch (e) {
      console.warn(`Could not fetch collection info: ${e.message}`);
    }
    if (!collectionName) throw new Error(`Failed to retrieve collection name for ${collectionId}`);

    console.log('\nCOLLECTION:');
    console.log(`- ${collectionName}`);
    console.log(`- Total Supply (official): ${officialItems}`);
    console.log(`- Owners (official): ${officialOwners}\n`);

    // ── PHASE B — Tous les assets (pages en parallèle) ────────────────────────
    const allAssets = [];
    {
      console.log('Phase B — Fetching all collection assets…');
      const hint = officialItems;
      if (hint > 0) {
        const pageCount = Math.ceil(hint / SNAP_CONF.ASSET_PAGE_SIZE);
        const pages = Array.from({ length: pageCount }, (_, i) => i);
        await mapPool(pages, SNAP_CONF.ASSET_PAGE_CONCURRENCY, async (i) => {
          const d = await gql('GetCollectionAssets',
            { collectionId, first: SNAP_CONF.ASSET_PAGE_SIZE, skip: i * SNAP_CONF.ASSET_PAGE_SIZE, cacheId: 'snap-assets-' + collectionId + '-' + i },
            Q_ALL_ASSETS);
          (d?.public?.assets || []).forEach(a => allAssets.push(a));
        });
        // Sonde de sécurité : s'il manque des assets, on pagine au-delà.
        let skip = allAssets.length;
        let safety = 0;
        while (allAssets.length < hint && safety < 50) {
          safety++;
          const d = await gql('GetCollectionAssets',
            { collectionId, first: SNAP_CONF.ASSET_PAGE_SIZE, skip, cacheId: 'snap-assets-' + collectionId + '-probe' + safety },
            Q_ALL_ASSETS);
          const batch = d?.public?.assets || [];
          if (batch.length === 0) break;
          batch.forEach(a => allAssets.push(a));
          skip += batch.length;
          if (batch.length < SNAP_CONF.ASSET_PAGE_SIZE) break;
        }
      } else {
        // Pas de hint : pagination spéculative par vagues jusqu'à vagues vides.
        let skip = 0, emptyWaves = 0, ended = false;
        while (!ended && emptyWaves < SNAP_CONF.PHASE_B_EMPTY_WAVE_LIMIT) {
          const wave = Array.from({ length: SNAP_CONF.ASSET_PAGE_CONCURRENCY }, (_, k) => skip + k * SNAP_CONF.ASSET_PAGE_SIZE);
          const before = allAssets.length;
          await mapPool(wave, SNAP_CONF.ASSET_PAGE_CONCURRENCY, async (s) => {
            const d = await gql('GetCollectionAssets',
              { collectionId, first: SNAP_CONF.ASSET_PAGE_SIZE, skip: s, cacheId: 'snap-assets-' + collectionId + '-' + s },
              Q_ALL_ASSETS);
            const batch = d?.public?.assets || [];
            batch.forEach(a => allAssets.push(a));
            if (batch.length < SNAP_CONF.ASSET_PAGE_SIZE) ended = true;
          });
          if (allAssets.length === before) emptyWaves++; else emptyWaves = 0;
          skip += SNAP_CONF.ASSET_PAGE_CONCURRENCY * SNAP_CONF.ASSET_PAGE_SIZE;
        }
      }
      // Dédup (les pages parallèles peuvent se recouvrir sur la sonde)
      const seen = new Set();
      for (let i = allAssets.length - 1; i >= 0; i--) {
        if (seen.has(allAssets[i].id)) allAssets.splice(i, 1);
        else seen.add(allAssets[i].id);
      }
      const minted = allAssets.reduce((s, a) => s + (a.copiesInCirculation != null ? a.copiesInCirculation : (a.copies || 1)), 0);
      console.log(`  ✓ Phase B: ${allAssets.length} assets · ${minted} éditions mintées.`);
    }

    // ── PHASE C — Owner courant par édition via eventHistory ──────────────────
    console.log('Phase C — Walking event history…');
    const phaseC = await walkOwnersAndDates(collectionId);
    const realEditionsPerAsset = phaseC.realEditionsPerAsset;
    console.log(`  ✓ Phase C: ${phaseC.eventCount} events · ${phaseC.pages} pages · ${Object.keys(realEditionsPerAsset).length} assets résolus${phaseC.pageFailures ? ` · ${phaseC.pageFailures} échecs page` : ''}.`);

    // ── PHASE C-fallback — editions(assetId:) batchées pour les manquants ─────
    const phantomAssetIds = new Set();
    {
      const assetsZero = [], assetsPartial = [];
      allAssets.forEach(a => {
        const got = realEditionsPerAsset[a.id]?.length || 0;
        const minted = a.copiesInCirculation != null ? a.copiesInCirculation : (a.copies || 1);
        if (minted === 0) return;
        if (got >= minted) return;
        if (got > 0) assetsPartial.push(a); else assetsZero.push(a);
      });
      const needFallback = [...assetsZero, ...assetsPartial];

      // Fusion par index d'édition (les résultats frais écrasent ceux de Phase C)
      const mergeEditions = (assetId, fresh) => {
        const byIndex = new Map();
        (realEditionsPerAsset[assetId] || []).forEach(ed => { if (ed.index != null) byIndex.set(ed.index, ed); });
        fresh.forEach(ed => { if (ed.index != null) byIndex.set(ed.index, ed); });
        realEditionsPerAsset[assetId] = Array.from(byIndex.values());
      };
      const totalCountPerAsset = {};

      if (needFallback.length > 0) {
        console.log(`Phase C-fallback — ${needFallback.length} assets (${assetsZero.length} zéro · ${assetsPartial.length} partiels). Batched aliased…`);
        const single = needFallback.filter(a => (a.copies || 1) === 1);
        const multi = needFallback.filter(a => (a.copies || 1) > 1);

        const runTier = async (assets, batchSize, first) => {
          const batches = chunk(assets.map(a => a.id), batchSize);
          await mapPool(batches, SNAP_CONF.FALLBACK_BATCH_CONCURRENCY, async (ids) => {
            const result = await gqlBatchEditions(ids, { first });
            ids.forEach(id => {
              const r = result[id];
              if (!r) return;
              totalCountPerAsset[id] = r.totalCount || 0;
              const eds = r.editions || [];
              if ((r.totalCount || 0) > 0 && eds.length === 0) { phantomAssetIds.add(id); return; }
              if (eds.length > 0) {
                mergeEditions(id, eds.map(ed => ({ id: ed.id, index: ed.index, owner: ed.owner, ownership: ed.ownership || { primary: false } })));
              }
            });
            if (SNAP_CONF.FALLBACK_INTER_BATCH_DELAY_MS > 0) await sleep(SNAP_CONF.FALLBACK_INTER_BATCH_DELAY_MS);
          });
        };

        await runTier(single, SNAP_CONF.FALLBACK_BATCH_SIZE_SINGLE, 1);
        await runTier(multi, SNAP_CONF.FALLBACK_BATCH_SIZE_MULTI, 100);

        // Débordement pour les multi-éditions à >100 éditions
        for (const a of multi) {
          const tc = totalCountPerAsset[a.id] || 0;
          if (tc > 100) {
            let skip = 100;
            while (skip < tc && skip < 5000) {
              const r = await gqlBatchEditions([a.id], { first: 100, skip });
              const eds = r[a.id]?.editions || [];
              if (eds.length === 0) break;
              mergeEditions(a.id, eds.map(ed => ({ id: ed.id, index: ed.index, owner: ed.owner, ownership: ed.ownership || { primary: false } })));
              skip += 100;
              await sleep(SNAP_CONF.FALLBACK_INTER_BATCH_DELAY_MS);
            }
          }
        }

        // ── Secondary — editionEvents pour les assets toujours vides (withdrawn) ──
        const stillMissing = needFallback.filter(a => !realEditionsPerAsset[a.id]?.length && !phantomAssetIds.has(a.id));
        if (stillMissing.length > 0 && stillMissing.length <= SNAP_CONF.SECONDARY_FALLBACK_CAP) {
          console.log(`Phase C-fallback (secondary) — ${stillMissing.length} assets via editionEvents…`);
          for (const a of stillMissing) {
            const edId = a.latestPurchasedEdition?.id || a.offerableEditionId || a.defaultListingV2?.editionId;
            if (!edId) continue;
            try {
              const d = await gql('EditionEvents', { editionId: edId, cacheId: 'snap-ee-' + edId }, Q_EDITION_EVENTS);
              const events = d?.public?.editionEvents || [];
              let owner = null;
              for (const ev of events) {
                if (ev.toUser?.username) { owner = ev.toUser; break; }
                else if (ev.nature === 'withdrawn' && ev.user?.username) { owner = ev.user; break; }
              }
              if (owner) realEditionsPerAsset[a.id] = [{ id: edId, index: 1, owner, ownership: { primary: false } }];
              await sleep(80);
            } catch (e) { /* on continue */ }
          }
        }
      }
    }

    // ── Filtre fantômes (totalCount>0 mais editions:[]) ───────────────────────
    if (phantomAssetIds.size > 0) {
      const before = allAssets.length;
      for (let i = allAssets.length - 1; i >= 0; i--) {
        if (phantomAssetIds.has(allAssets[i].id)) allAssets.splice(i, 1);
      }
      console.log(`  ✓ Filtre fantômes : ${phantomAssetIds.size} assets buggés exclus (${before} → ${allAssets.length}).`);
    }

    // ── PHASE E — Agrégation : 1 count / édition, holder keyé par uuid||username ──
    const holderMap = {};
    let totalAttributed = 0;
    const upsertHolder = (own) => {
      if (!own?.username) return;
      const k = own.uuid || own.username;
      if (!holderMap[k]) {
        holderMap[k] = { username: own.username, uuid: k, count: 0 };
      }
      holderMap[k].count += 1;
    };
    allAssets.forEach(a => {
      const eds = realEditionsPerAsset[a.id] || [];
      eds.forEach(ed => {
        if (ed?.owner?.username) { upsertHolder(ed.owner); totalAttributed++; }
      });
    });

    // ── Conversion vers ownerNFTs (username→count) + contribution au global ──
    const ownerNFTs = {};
    Object.values(holderMap).forEach(h => {
      ownerNFTs[h.username] = (ownerNFTs[h.username] || 0) + h.count;
      globalOwnerNFTs[h.username] = (globalOwnerNFTs[h.username] || 0) + h.count;
    });

    // ── Récupérer les liens Twitter/X pour les nouveaux propriétaires ──
    const newOwners = Object.keys(ownerNFTs).filter(o => !(o in ownersData));
    if (newOwners.length > 0) {
      console.log(`Fetching Twitter usernames for ${newOwners.length} new owner${newOwners.length === 1 ? '' : 's'}…`);
      await mapPool(newOwners, 4, async (owner) => {
        const twitterUrl = await getTwitterUsername(owner);
        ownersData[owner] = { username: owner, twitter: twitterUrl };
      });
      saveOwnersJson(ownersData);
    }

    // ── Logs de discrepancy ──
    const scrapedOwnersCount = Object.keys(ownerNFTs).length;
    if (officialItems > 0 && totalAttributed !== officialItems) {
      console.warn(`Discrepancy detected for collection ${collectionName}: Scraped ${totalAttributed} editions, but expected ${officialItems}.`);
    }
    if (officialOwners > 0 && scrapedOwnersCount !== officialOwners) {
      console.warn(`Discrepancy in owner count for collection ${collectionName}: Scraped ${scrapedOwnersCount} owners, but expected ${officialOwners}.`);
    }

    collectionsData.push({
      collectionId,
      collectionName,
      totalSupply: officialItems > 0 ? officialItems : totalAttributed,
      owners: officialOwners > 0 ? officialOwners : scrapedOwnersCount,
      sales: officialSales,      // ventes secondaires (live crypto.com)
      volume: officialVolume,    // volume échangé USD (live crypto.com)
      floor: officialFloor,      // floor USD (live crypto.com)
      ownerNFTs
    });

    console.log(`✅ ${collectionName}: ${scrapedOwnersCount} unique owners · ${totalAttributed} editions counted.`);
    return { collectionName, ownerNFTs, ok: true };

  } catch (error) {
    console.error(`Error scraping collection ${collectionId}:`, error.message);
    collectionsData.push({
      collectionId,
      collectionName: collectionName || 'Error',
      totalSupply: 0,
      owners: 0,
      ownerNFTs: {}
    });
    return { collectionName: collectionName || 'Error', ownerNFTs: {}, ok: false };
  }
}

// Scrape TOUTES les collections crypto.com en repartant d'un état VIDE (anti double-comptage :
// globalOwnerNFTs/collectionsData sont remis à zéro avant chaque passage). Renvoie la liste des URLs en échec.
async function scrapeAllCollections(globalOwnerNFTs, collectionsData, ownersData) {
  for (const k in globalOwnerNFTs) delete globalOwnerNFTs[k];
  collectionsData.length = 0;
  const failed = [];
  for (const { url, usePagination } of collectionUrls) {
    console.log(`\n=== Processing collection: ${url} ===`);
    const r = await processCollection(url, usePagination, globalOwnerNFTs, collectionsData, ownersData);
    if (!r.ok) failed.push(url);
    await delay(3000); // courte pause entre collections (le batching réduit déjà fortement le débit)
  }
  return failed;
}

async function main() {
  try {
    const ownersData = loadOwnersJson();
    const globalOwnerNFTs = {};
    const collectionsData = [];

    // 1er passage. Les 429 de crypto.com arrivent en RAFALES : si une collection échoue,
    // une pause de 90s laisse le rate-limit retomber, puis on refait un passage COMPLET
    // (état réinitialisé → aucun double-comptage). Évite les runs « rouges » sur un 429 ponctuel.
    let failedCollections = await scrapeAllCollections(globalOwnerNFTs, collectionsData, ownersData);
    if (failedCollections.length > 0) {
      console.warn(`\n⏳ ${failedCollections.length}/${collectionUrls.length} collection(s) en échec (429 ?). Pause 90s puis nouveau passage complet…`);
      await delay(90000);
      failedCollections = await scrapeAllCollections(globalOwnerNFTs, collectionsData, ownersData);
    }

    // ── GARDE-FOU n°1 : échec PERSISTANT (même après reprise) ──
    if (failedCollections.length > 0) {
      console.error(`\n❌ ${failedCollections.length}/${collectionUrls.length} collection(s) toujours en échec après reprise (API bloquée / 429 ?). data.json NON modifié pour ne pas publier des données partielles :`);
      failedCollections.forEach(u => console.error(`   - ${u}`));
      process.exitCode = 1;
      return;
    }

    const totalUniqueOwners = Object.keys(globalOwnerNFTs).length;
    const totalCryptonautsAcrossAllCollections = collectionsData.reduce((sum, data) => sum + data.totalSupply, 0);

    console.log('\n=== Global Summary ===');
    console.log(`Total Unique Owners: ${totalUniqueOwners}`);
    console.log(`Total Cryptonauts Across All Collections: ${totalCryptonautsAcrossAllCollections}\n`);

    // ── GARDE-FOU n°2 : aucune donnée du tout ──
    if (totalUniqueOwners === 0) {
      console.error('\n❌ Aucun propriétaire récupéré (API bloquée / 403 ?). data.json NON modifié pour ne pas écraser le classement.');
      process.exitCode = 1;
      return;
    }

    saveOwnersJson(ownersData);

    // ── Collections externes Crovia/Cronos (V3, Civilizations, futurs drops) ──
    // Pour CHAQUE collection avec un `contract` renseigné (voir CROVIA_COLLECTIONS) :
    //  • SOURCE PRIMAIRE : API publique Crovia (détenteurs, ventes cross-marketplace, floor, volume).
    //  • Mints LIVE : scan on-chain borné récent (capte un drop en cours ; 0 si sold-out).
    //  • REPLI : scan on-chain complet (fetchV3Holders) si l'API tombe (V3 uniquement).
    // Chaque vente/mint est taguée `col` (titre) + `contract` → flux Sales Bot multi-collections.
    const externalCollections = [];
    const externalAssets = {};
    let externalSales = [];
    for (const cfg of CROVIA_COLLECTIONS) {
      if (!cfg.contract) { console.log(`ℹ ${cfg.title} : pas encore lancée (contract vide) → ignorée.`); continue; }
      const api = await fetchCroviaCollection(cfg.contract);
      let ranking, secSales, mints, stats;
      if (api) {
        ranking = api.owners;
        secSales = api.sales;
        stats = { floor: api.floor, volume: api.volume, salesCount: api.salesCount };
        mints = await fetchRecentMints(cfg.contract, 400000, cfg.mintPriceCro);
      } else if (cfg.contract.toLowerCase() === V3_CONTRACT) {
        const v3 = await fetchV3Holders();                        // repli on-chain complet (V3 seulement)
        ranking = (v3 && v3.ranking) || V3_FALLBACK;
        secSales = (v3 && v3.sales) || [];
        mints = (v3 && v3.mints) || [];
        stats = {};
      } else {
        console.warn(`⚠ ${cfg.title} : API Crovia indisponible et pas de repli → ignorée ce run.`);
        continue;
      }
      if (!ranking.length) { console.warn(`⚠ ${cfg.title} : aucun détenteur → ignorée.`); continue; }
      // Noms des détenteurs : résolus on-chain via Cronos ID (.cro inverse) — l'API owners ne les donne pas.
      const names = await resolveCroNames(ranking.map(r => r.addr));
      externalCollections.push(buildCroviaCollection(cfg, ranking, names, stats));
      for (const s of secSales) externalSales.push({ ...s, col: cfg.title, contract: cfg.contract });
      for (const m of mints) externalSales.push({ ...m, col: cfg.title, contract: cfg.contract });
    }

    // Flux Sales Bot = ventes (cross-marketplace) + mints de TOUTES les collections, triés par date, max 60.
    externalSales = externalSales.sort((a, b) => b.ts - a.ts).slice(0, 60);
    // Cartes NFT (image + nom) par collection : galerie du site + vignettes Sales Bot. Construites APRÈS
    // le slice pour garantir une image à CHAQUE token du flux (l'endpoint bulk plafonne à 100).
    const feedByContract = {};
    for (const m of externalSales) (feedByContract[m.contract] = feedByContract[m.contract] || []).push(Number(m.t));
    for (const cfg of CROVIA_COLLECTIONS) {
      if (!cfg.contract) continue;
      const assets = await fetchExternalAssets(cfg.contract, feedByContract[cfg.contract] || []);
      if (assets.length) externalAssets[cfg.contract] = assets;
      console.log(`✅ ${cfg.title} : ${assets.length} assets indexés (image + nom).`);
    }
    // Nom de chaque vente/mint depuis la carte d'assets (l'image est gérée côté site via externalAssets).
    const nameByKey = {};
    for (const [c, arr] of Object.entries(externalAssets)) for (const a of arr) nameByKey[c + ':' + a.i] = a.n;
    for (const m of externalSales) { const n = nameByKey[m.contract + ':' + Number(m.t)]; if (n) m.n = n; }

    writeCryptonautsData(collectionsData, globalOwnerNFTs, ownersData, externalCollections, externalSales, externalAssets);

  } catch (error) {
    console.error('Main execution failed:', error.message);
    process.exitCode = 1;
  }
}

// Exécuter le script (uniquement en lancement direct `node Test.js` ; pas si require() pour tests).
if (require.main === module) {
  main().catch(error => {
    console.error('Main execution failed:', error.message);
    process.exitCode = 1;
  });
}

// Exposé pour tests ciblés (résolution de noms .cro, ventes secondaires) sans lancer main().
module.exports = { resolveCroName, resolveCroNames, fetchV3SecondarySales, fetchCroviaCollection, fetchRecentMints, buildCroviaCollection, enrichExternalImages, CROVIA_COLLECTIONS, namehash, reverseNode };
