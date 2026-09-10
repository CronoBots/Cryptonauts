// publish-sales.js — PUBLICATION DES VENTES SUR DISCORD (version CLOUD, sans Puppeteer)
// ─────────────────────────────────────────────────────────────────────────────
// Portage de main.js (qui tournait sur le PC) pour tourner en GitHub Actions cloud :
//   • plus de Puppeteer : le nombre de holdings ET le handle Twitter des vendeurs/
//     acheteurs sont lus dans data.json (globalOwnersData), déjà généré par Test.js.
//   • les webhooks Discord viennent des GitHub Secrets (jamais en clair dans le code).
//   • un seul passage puis sortie (le cron du workflow gère la répétition horaire).
// Tout le reste (ventes crypto.com, ventes+mints Crovia/Cronos) est identique à main.js
// et a été vérifié comme fonctionnant depuis une IP datacenter (pas de 429 sur ces
// requêtes légères — le 429 ne frappait que l'agrégation lourde du classement).
//
// Le seul écart fonctionnel vs main.js : le RANG de rareté (fetchRank) était scrapé
// par Puppeteer → il est désormais affiché « N/A » pour les ventes crypto.com. Tout
// le reste (prix, vendeur/acheteur, holdings, Twitter, supply/owners/volume/floor,
// %/floor, image) est préservé à l'identique.
// ─────────────────────────────────────────────────────────────────────────────
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { keccak256 } = require('js-sha3'); // résolution inverse des noms .cro (Crovia)

const baseDir = __dirname;
const savesDir = path.join(baseDir, 'Saves');

// ── Webhooks depuis l'environnement (GitHub Secrets) ──
const WEBHOOK_URLS = (process.env.DISCORD_WEBHOOK_URLS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const HEARTBEAT_WEBHOOK_URL = (process.env.DISCORD_HEARTBEAT_WEBHOOK_URL || '').trim();

// DRY_RUN=1 : simule tout (fetch, lookup, génération des messages) SANS poster sur
// Discord NI toucher le fichier de dédup. Sert à tester le pipeline sans rien envoyer.
const DRY_RUN = !!process.env.DRY_RUN;
// SEED=1 : ne poste RIEN mais MARQUE les ventes/mints actuels comme « déjà publiés »
// (écrit le fichier de dédup). Sert à amorcer une fois, pour que le 1er run cloud ne
// republie pas ce que main.js a déjà posté. Après un seed : committer le fichier de dédup.
const SEED = !!process.env.SEED;

if (!WEBHOOK_URLS.length && !DRY_RUN && !SEED) {
  console.error('❌ Aucun webhook : définis le secret DISCORD_WEBHOOK_URLS (URLs séparées par des virgules).');
  process.exit(1);
}

const config = {
  name: "CRYPTONAUTS COLLECTION",
  collections: [
    { name: "CRYPTONAUTS", collectionId: "c942e9924b01fae996d8f817060611eb", customAvatarUrl: "https://media.nft.crypto.com/5057c430-e7f5-4462-a6d2-7bb2bfb68700/original.jpg?d=lg-logo", fetchRank: false },
    { name: "CRYPTONAUTS: DARK SIDE", collectionId: "da522f33fb5285981f6d154e575fe0a3", customAvatarUrl: "https://media.nft.crypto.com/f3bdf36b-403b-4799-a39f-2c21cea5dc99/original.jpg?d=lg-logo", fetchRank: false },
    { name: "CRYPTONAUTS: GOLDEN CREW", collectionId: "f1d242e1c49e009427b38fc953ef4e89", customAvatarUrl: "https://media.nft.crypto.com/6d6e7a76-35f6-4918-b851-ddebabf94e2c/original.jpg?d=lg-logo", fetchRank: false },
    { name: "CRYPTONAUTS: 2024", collectionId: "10615ea6d69edfc24975c419941304e3", customAvatarUrl: "https://media.nft.crypto.com/84f5f042-7cb0-404f-88d2-43d07a6d2a46/original.jpg?d=lg-logo", fetchRank: false },
    { name: "CRYPTONAUTS: QUANTUM", collectionId: "bbcd969a80642cf8934d33061be8a194", customAvatarUrl: "https://media.nft.crypto.com/395953dd-72fe-49ba-acb0-f638166b87ae/original.jpg?d=lg-logo", fetchRank: false },
    { name: "CRYPTONAUTS: QUANTUM V2", collectionId: "89d7138226413ae153f306dd5cfabf33", customAvatarUrl: "https://media.nft.crypto.com/c19a171b-0418-4eb2-b3c1-1dcb84616c52/original.jpg?d=lg-logo", fetchRank: false },
    { name: "CRYPTONAUTS: TIME TRAVEL", collectionId: "98d9a2bfd53bd130fc267c9c92ed3236", customAvatarUrl: "https://media.nft.crypto.com/3f03eae4-d4db-4ec8-96cd-ff53a95403d0/original.jpg?d=lg-logo", fetchRank: true },
    { name: "CRYPTONAUTS: LEGENDARY", collectionId: "c220b3299c59deccf1340251036ac4ac", customAvatarUrl: "https://media.nft.crypto.com/a4473840-5dce-4b64-ae66-1e265d41efce/original.jpg?d=lg-logo", fetchRank: true },
    { name: "CRYPTONAUTS: TIME TRAVEL 2", collectionId: "a870c453ec57dc8e706e999b3f37a859", customAvatarUrl: "https://media.nft.crypto.com/d2ed798c-06b3-415c-bedf-2eb7e85696a2/original.jpg?d=lg-logo", fetchRank: true },
    { name: "OG CRYPTONAUTS", collectionId: "0a9144ea31f81338454f87a1eaf101c1", customAvatarUrl: "https://media.nft.crypto.com/ed44387d-7a86-4f00-aaf4-bdc48170f5ab/original.jpg?d=lg-logo", fetchRank: true },
    { name: "HALLOWEEN CRYPTONAUTS", collectionId: "dd16eb5e01dc357e3c5a61c2457c4ff5", customAvatarUrl: "https://media.nft.crypto.com/9dac988e-dea8-42c3-bc99-952ac79c867e/original.jpg?d=lg-logo", fetchRank: true },
    { name: "OG PASS CRYPTONAUTS", collectionId: "c3b64faa19be168c4043242ccf13dcf5", customAvatarUrl: "https://media.nft.crypto.com/1eb10800-e599-46ca-ad97-5d9f0aab7848/original.jpg?d=lg-logo", fetchRank: true },
    { name: "CRYPTONAUTS: LEGENDARY V2", collectionId: "aabff17f9874020416137984b9d2b8db", customAvatarUrl: "https://media.nft.crypto.com/58a7e1a7-392b-4589-8fb1-39ede948877f/original.jpg?d=lg-logo", fetchRank: true }
  ],
  shared: {
    publishOnDiscord: true,
    webhookUrls: WEBHOOK_URLS,
    heartbeatWebhookUrl: HEARTBEAT_WEBHOOK_URL,
    emoji: "🚀",
    saveFileDiscord: path.join(savesDir, 'Cryptonauts_Discord.json'),
    nftText: { singular: "Cryptonaut", plural: "Cryptonauts" },
    useCustomAvatar: true,
    webhookNameTemplate: "CRYPTONAUTS BOT | ${nftName}",
    source: "crypto.com"
  }
};

const cryptoApiUrl = "https://crypto.com/nft-api/graphql";
const cryptonautsIds = config.collections.map(c => c.collectionId);

// ── Holdings + Twitter des holders, lus dans data.json (remplace le scraping Puppeteer) ──
const ownersMap = loadOwnersMap();
function loadOwnersMap() {
  const map = new Map();
  try {
    const d = JSON.parse(fs.readFileSync(path.join(baseDir, 'data.json'), 'utf8'));
    (d.globalOwnersData || []).forEach(o => {
      if (o && o.name) map.set(String(o.name).toLowerCase(), { count: o.count || 0, twitter: o.twitter || '' });
    });
    console.log(`data.json chargé : ${map.size} holders (holdings + Twitter).`);
  } catch (e) {
    console.warn('data.json illisible — holdings à 0 par défaut :', e.message);
  }
  return map;
}

// Équivalent de countNFTs() mais sans navigateur : lecture directe dans data.json.
function lookupHolder(name) {
  const key = String(name || '').toLowerCase();
  const e = ownersMap.get(key);
  const count = e ? e.count : 0;
  let username = name;
  let isTwitterHandle = false;
  if (e && e.twitter) {
    const handle = String(e.twitter).trim().split('/').pop().replace(/^@/, '').trim();
    if (handle && handle.toLowerCase() !== 'cryptocomnft') { username = handle; isTwitterHandle = true; }
  }
  return { count, username, isTwitterHandle };
}

const publishedSales = loadPublishedSales(config.shared.saveFileDiscord);

function nowStamp() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function loadPublishedSales(saveFile) {
  const saveDir = path.dirname(saveFile);
  try {
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
    if (!fs.existsSync(saveFile)) fs.writeFileSync(saveFile, JSON.stringify([]));
    const data = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
    return new Set(data.map(entry => entry.id));
  } catch (error) {
    console.error(`Error loading ${saveFile}:`, error.message);
    try {
      if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
      fs.writeFileSync(saveFile, JSON.stringify([]));
      return new Set([]);
    } catch (recError) {
      console.error(`Failed to recover ${saveFile}:`, recError.message);
      return new Set();
    }
  }
}

function savePublishedSales(set, saveFile) {
  try {
    let existingData = fs.existsSync(saveFile) ? JSON.parse(fs.readFileSync(saveFile, 'utf8')) : [];
    const existingMap = new Map(existingData.map(entry => [entry.id, entry.timestamp]));
    const currentTime = nowStamp();
    const data = Array.from(set).map(id => ({ id, timestamp: existingMap.get(id) || currentTime }));
    fs.writeFileSync(saveFile, JSON.stringify(data));
  } catch (error) {
    console.error(`Error saving ${saveFile}:`, error.message);
  }
}

function cleanOldSales(saveFile, publishedSet) {
  try {
    if (!fs.existsSync(saveFile)) return;
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    let data = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
    data = data.filter(entry => new Date(entry.timestamp) >= fortyEightHoursAgo);
    publishedSet.clear();
    data.forEach(entry => publishedSet.add(entry.id));
    fs.writeFileSync(saveFile, JSON.stringify(data));
  } catch (error) {
    console.error(`Error cleaning ${saveFile}:`, error.message);
  }
}

async function postToDiscord(message, imageUrl, nftName, sellerTwitter, buyerTwitter, rank, collectionConfig) {
  const webhookName = config.shared.webhookNameTemplate.replace('${nftName}', nftName);
  const data = {

    username: webhookName,
    content: message.replace('🚀', config.shared.emoji),
    embeds: [{ image: { url: imageUrl } }],
    avatar_url: collectionConfig.customAvatarUrl
  };

  [sellerTwitter, buyerTwitter].forEach(username => {
    if (!username) return;
    if (username !== "IGNORED" && !username.match(/^@?cryptocomnft$/i)) {
      const formattedUsername = username.replace(/^@/, '').toUpperCase();
      data.content = data.content.replace(
        new RegExp(`\\*${username}\\*`, 'g'),
        `[${formattedUsername}](https://twitter.com/${formattedUsername.toLowerCase()})`
      );
    } else {
      data.content = data.content.replace(
        new RegExp(`\\*${username}\\*`, 'g'),
        username.toUpperCase()
      );
    }
  });

  if (rank !== undefined && !data.content.includes(`**Rank:** ${rank}`)) {
    data.content = data.content.replace('**Rank:**', `**Rank:** ${rank}`);
  }

  if (DRY_RUN || SEED) {
    if (DRY_RUN) {
      console.log('\n──────── [DRY_RUN] message qui SERAIT publié ────────');
      console.log(data.content);
      console.log(`🖼️  image: ${imageUrl || '(aucune)'}`);
      console.log('─────────────────────────────────────────────────────\n');
    } else {
      console.log(`[SEED] marqué comme déjà publié : ${nftName}`);
    }
    return true; // succès simulé (pas d'envoi réseau)
  }

  const results = await Promise.all(
    config.shared.webhookUrls.map(url =>
      axios.post(url, data, { timeout: 30000 })
        .then(() => true)
        .catch(error => {
          console.error(`Error posting to Discord webhook (${url.split('/').slice(0, 6).join('/')}/...):`, error.message);
          return false;
        })
    )
  );

  return results.some(success => success);
}

async function publishSale(discord_text, image_url, saleId, nftName, sellerTwitter, buyerTwitter, rank, collectionConfig) {
  if (!config.shared.publishOnDiscord || publishedSales.has(saleId)) return true;

  const success = await postToDiscord(discord_text, image_url, nftName, sellerTwitter, buyerTwitter, rank, collectionConfig);

  if (success && !DRY_RUN) { // SEED persiste (marque), DRY_RUN non
    if (!SEED) console.log(`Sale successfully sent to Discord for ${nftName}`);
    publishedSales.add(saleId);
    savePublishedSales(publishedSales, config.shared.saveFileDiscord);
  }

  return success;
}

// Volume total (somme des collections crypto.com) — calculé UNE fois par run (mémoïsé),
// au lieu du 13×13 de main.js.
let _totalVolume = null;
async function getTotalVolume() {
  if (_totalVolume !== null) return _totalVolume;
  let tot = 0;
  for (const id of cryptonautsIds) {
    const q = `query { public { collectionMetric(id: "${id}") { totalSalesDecimal } } }`;
    try {
      const r = await axios.post(cryptoApiUrl, { query: q }, { timeout: 30000 });
      tot += Math.round(parseFloat(r.data?.data?.public?.collectionMetric?.totalSalesDecimal) || 0);
    } catch (e) { /* collection ignorée */ }
  }
  _totalVolume = tot;
  return tot;
}

async function getCollectionMetrics(collectionId) {
  const query = `query { public { collectionMetric(id: "${collectionId}") { minSaleListingPriceDecimal, owners, totalSalesDecimal, totalSupply } } }`;
  try {
    const response = await axios.post(cryptoApiUrl, { query }, { timeout: 30000 });
    const metric = response.data?.data?.public?.collectionMetric;
    if (!metric) {
      return { owners: "N/A", floorPrice: "$0", volume: "N/A", supply: "N/A" };
    }

    const totalVolume = await getTotalVolume();

    return {
      owners: metric.owners ? metric.owners.toLocaleString('fr-FR').replace(/\s/g, '.') : "N/A",
      floorPrice: metric.minSaleListingPriceDecimal ? `$${Math.round(parseFloat(metric.minSaleListingPriceDecimal)).toLocaleString('fr-FR').replace(/\s/g, '.')}` : "$0",
      volume: totalVolume.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'),
      supply: metric.totalSupply ? metric.totalSupply.toLocaleString('fr-FR').replace(/\s/g, '.') : "N/A"
    };
  } catch (error) {
    return { owners: "N/A", floorPrice: "$0", volume: "N/A", supply: "N/A" };
  }
}

function generateMessage(nftName, price, seller, buyer, sellerNFTText, buyerNFTText, metrics, nft_url, rank, priceDiffText, isSellerTwitterHandle, isBuyerTwitterHandle, collectionConfig) {
  return (
    `## __**${collectionConfig.name}**__\n` +
    `${config.shared.emoji} **Cryptonaut ${nftName}** sold for **${price}** ✅\n\n` +
    `📊 ${collectionConfig.fetchRank ? `**Rank:** ${rank} | ` : ''}**Sale:** ${priceDiffText}\n` +
    `📉 **Seller:** ${isSellerTwitterHandle ? `[@${seller}](https://twitter.com/${seller.toLowerCase()})` : seller} - ${sellerNFTText}\n` +
    `📈 **Buyer:** ${isBuyerTwitterHandle ? `[@${buyer}](https://twitter.com/${buyer.toLowerCase()})` : buyer} - ${buyerNFTText}\n\n` +
    `📦 **Supply:** ${metrics.supply} | 👤 **Owners:** ${metrics.owners}\n` +
    `💵 **Volume:** $${metrics.volume} | 💰 **Floor:** ${metrics.floorPrice}\n\n` +
    `🔗 [**MARKETPLACE**](${nft_url})`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// ACTIVITÉ CROVIA (Cronos) — VENTES secondaires ET MINTS (identique à main.js, cloud-OK).
// ═══════════════════════════════════════════════════════════════════════════════════════
const croviaConfig = {
  api: 'https://crovia.app/api/v1',
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36', 'Accept': 'application/json', 'Referer': 'https://crovia.app/' },
  rpcs: ['https://evm.cronos.org', 'https://cronos.drpc.org', 'https://rpc.vvs.finance'],
  registry: '0x7F4C61116729d5b27E5f180062Fdfbf32E9283E5',
  transferTopic: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  logStep: 1999,
  recentDays: 2,
  publishMints: true,
  mintSpanBlocks: 400000,
  maxMintsPerRun: parseInt(process.env.MAX_MINTS_PER_RUN, 10) || 12, // surchargeable via env (seed initial)
  collections: [
    { name: 'CRYPTONAUTS CIVILIZATIONS', contract: '0x721559274c8a739d1e5e35506f91a7ce56868c7f', mintPriceCro: 399 },
    { name: 'QUANTUM CRYPTONAUTS V3', contract: '0x840d5e2df597ab3dcfed4e5fc883c8d87606748d', mintPriceCro: 400 },
  ]
};

async function croviaGet(pathAndQuery) {
  const r = await axios.get(croviaConfig.api + pathAndQuery, { headers: croviaConfig.headers, timeout: 20000, validateStatus: s => s === 200 });
  return r.data && (r.data.data !== undefined ? r.data.data : r.data);
}
let _croRpcIdx = 0;
async function cronosRpc(method, params) {
  let lastErr;
  for (let i = 0; i < 6; i++) {
    try {
      const r = await axios.post(croviaConfig.rpcs[_croRpcIdx], { jsonrpc: '2.0', id: 1, method, params }, { timeout: 15000 });
      if (r.data && r.data.error) throw new Error(r.data.error.message);
      return r.data && r.data.result;
    } catch (e) { lastErr = e; _croRpcIdx = (_croRpcIdx + 1) % croviaConfig.rpcs.length; await new Promise(res => setTimeout(res, 250)); }
  }
  throw lastErr;
}
function croviaNamehash(name) {
  let node = '00'.repeat(32);
  if (name) { const l = name.split('.'); for (let i = l.length - 1; i >= 0; i--) { const lh = keccak256(Buffer.from(l[i], 'utf8')); node = keccak256(Buffer.from(node + lh, 'hex')); } }
  return '0x' + node;
}
function croviaDecodeString(hex) {
  if (!hex || hex === '0x') return '';
  const h = hex.slice(2); const off = parseInt(h.slice(0, 64), 16) * 2; const len = parseInt(h.slice(off, off + 64), 16) * 2;
  return Buffer.from(h.slice(off + 64, off + 64 + len), 'hex').toString('utf8');
}
async function resolveCroName(addr) {
  try {
    const node = croviaNamehash(addr.toLowerCase().replace(/^0x/, '') + '.addr.reverse');
    const res = await cronosRpc('eth_call', [{ to: croviaConfig.registry, data: '0x0178b8bf' + node.slice(2) }, 'latest']);
    if (!res || /^0x0*$/.test(res)) return null;
    const resolver = '0x' + res.slice(-40);
    const name = croviaDecodeString(await cronosRpc('eth_call', [{ to: resolver, data: '0x691f3431' + node.slice(2) }, 'latest']));
    return name || null;
  } catch (e) { return null; }
}
const croviaShort = a => a ? (a.slice(0, 6) + '…' + a.slice(-4)) : '—';
async function croviaDisplayName(addr) { const n = await resolveCroName(addr); return n || croviaShort(addr); }

function generateCroviaMessage(coll, nftName, priceCro, seller, sellerAddr, buyer, buyerAddr, sellerHoldings, buyerHoldings, metrics, rank, nftUrl, priceDiffText) {
  const emoji = config.shared.emoji;
  const nt = config.shared.nftText;
  const price = `${priceCro.toLocaleString('fr-FR').replace(/\s/g, '.')} CRO`;
  const vol = `${Number(metrics.volume).toLocaleString('fr-FR').replace(/\s/g, '.')} CRO`;
  const floor = `${Number(metrics.floor).toLocaleString('fr-FR').replace(/\s/g, '.')} CRO`;
  const sHold = `${sellerHoldings} ${sellerHoldings <= 1 ? nt.singular : nt.plural}`;
  const bHold = `${buyerHoldings} ${buyerHoldings <= 1 ? nt.singular : nt.plural}`;
  const cs = a => `https://cronoscan.com/address/${a}`;
  return (
    `## __**${coll.name}**__\n` +
    `${emoji} **Cryptonaut ${nftName}** sold for **${price}** ✅\n\n` +
    `📊 **Rank:** ${rank} | **Sale:** ${priceDiffText}\n` +
    `📉 **Seller:** [${seller}](${cs(sellerAddr)}) - ${sHold}\n` +
    `📈 **Buyer:** [${buyer}](${cs(buyerAddr)}) - ${bHold}\n\n` +
    `📦 **Supply:** ${metrics.supply} | 👤 **Owners:** ${metrics.owners}\n` +
    `💵 **Volume:** ${vol} | 💰 **Floor:** ${floor}\n\n` +
    `🔗 [**MARKETPLACE**](${nftUrl})`
  );
}

async function croviaPool(items, n, fn) {
  const q = items.map((it, i) => [i, it]);
  const out = [];
  async function worker() { while (q.length) { const [i, it] = q.shift(); out[i] = await fn(it); } }
  await Promise.all(Array.from({ length: Math.min(n, items.length || 1) }, worker));
  return out;
}

async function fetchRecentMints(contract, spanBlocks, mintPriceCro) {
  try {
    const latest = parseInt(await cronosRpc('eth_blockNumber', []), 16);
    const from0 = Math.max(0, latest - spanBlocks);
    const windows = [];
    for (let f = from0; f <= latest; f += croviaConfig.logStep + 1) windows.push([f, Math.min(f + croviaConfig.logStep, latest)]);
    const logs = [];
    await croviaPool(windows, 4, async ([f, t]) => {
      const res = await cronosRpc('eth_getLogs', [{
        address: contract, topics: [croviaConfig.transferTopic, '0x' + '0'.repeat(64)],
        fromBlock: '0x' + f.toString(16), toBlock: '0x' + t.toString(16)
      }]);
      (res || []).forEach(l => logs.push(l));
    });
    const raw = logs.filter(l => l.topics && l.topics.length === 4)
      .map(l => ({ t: Number(BigInt(l.topics[3])), b: '0x' + l.topics[2].slice(26).toLowerCase(), bn: parseInt(l.blockNumber, 16) }));
    if (!raw.length) return [];
    const uniqBlocks = [...new Set(raw.map(m => m.bn))];
    const blockTs = {};
    await croviaPool(uniqBlocks, 4, async (bn) => {
      try { const blk = await cronosRpc('eth_getBlockByNumber', ['0x' + bn.toString(16), false]); if (blk && blk.timestamp) blockTs[bn] = parseInt(blk.timestamp, 16); } catch (e) { /* bloc ignoré */ }
    });
    return raw.map(m => ({ t: m.t, b: m.b, cro: mintPriceCro, ts: blockTs[m.bn] || 0 }))
      .filter(m => m.ts > 0).sort((a, b) => b.ts - a.ts);
  } catch (e) { console.error('fetchRecentMints échoué:', e.message); return []; }
}

function generateCroviaMintMessage(coll, nftName, priceCro, minter, minterAddr, minterHoldings, metrics, rank, nftUrl) {
  const emoji = config.shared.emoji;
  const nt = config.shared.nftText;
  const price = `${Number(priceCro).toLocaleString('fr-FR').replace(/\s/g, '.')} CRO`;
  const vol = `${Number(metrics.volume).toLocaleString('fr-FR').replace(/\s/g, '.')} CRO`;
  const floor = `${Number(metrics.floor).toLocaleString('fr-FR').replace(/\s/g, '.')} CRO`;
  const mHold = `${minterHoldings} ${minterHoldings <= 1 ? nt.singular : nt.plural}`;
  const cs = a => `https://cronoscan.com/address/${a}`;
  return (
    `## __**${coll.name}**__\n` +
    `${emoji} **Cryptonaut ${nftName}** minted for **${price}** ✨\n\n` +
    `📊 **Rank:** ${rank} | 🌱 **New mint**\n` +
    `📈 **Minter:** [${minter}](${cs(minterAddr)}) - ${mHold}\n\n` +
    `📦 **Supply:** ${metrics.supply} | 👤 **Owners:** ${metrics.owners}\n` +
    `💵 **Volume:** ${vol} | 💰 **Floor:** ${floor}\n\n` +
    `🔗 [**MARKETPLACE**](${nftUrl})`
  );
}

async function checkAndPostNewCroviaSales() {
  let hasNew = false;
  const cutoff = Date.now() - croviaConfig.recentDays * 24 * 60 * 60 * 1000;
  const isFresh = id => !(!config.shared.publishOnDiscord || publishedSales.has(id));

  for (const coll of croviaConfig.collections) {
    if (!coll.contract) continue;
    try {
      const allSales = (await croviaGet(`/collections/${coll.contract}/sales?days=3650&limit=200`)) || [];
      const freshSales = allSales.filter(s => new Date(s.soldAt).getTime() >= cutoff && isFresh(`crovia:${s.txHash}`));

      let freshMints = [];
      if (croviaConfig.publishMints) {
        const mints = await fetchRecentMints(coll.contract, croviaConfig.mintSpanBlocks, coll.mintPriceCro || 0);
        freshMints = mints
          .filter(m => (m.ts * 1000) >= cutoff && isFresh(`crovia:mint:${coll.contract}:${m.t}`))
          .slice(0, croviaConfig.maxMintsPerRun);
      }

      if (!freshSales.length && !freshMints.length) continue;

      const col = await croviaGet(`/collections/${coll.contract}`);
      const floorData = await croviaGet(`/collections/${coll.contract}/floor`);
      const floor = Number(floorData && floorData.floor) || 0;
      const volume = Math.round(allSales.reduce((s, x) => s + (x.priceCro || 0), 0));
      const ownersArr = (await croviaGet(`/collections/${coll.contract}/owners?limit=1000`)) || [];
      const oMap = {}; ownersArr.forEach(o => { oMap[String(o.address).toLowerCase()] = o.count; });
      const metrics = { supply: col.totalSupply, owners: col.uniqueOwners, floor, volume };
      const collCfg = { name: coll.name, customAvatarUrl: (col && col.image) || '', fetchRank: false };
      const imgOf = nft => nft.image ? `https://images.weserv.nl/?url=${encodeURIComponent(nft.image)}&output=jpg&w=1200` : null;

      for (const s of freshSales.slice().reverse()) {
        const id = `crovia:${s.txHash}`;
        const nft = (await croviaGet(`/nfts/${coll.contract}/${s.tokenId}`)) || {};
        const nftName = nft.name || `#${s.tokenId}`;
        const rank = (nft.rarityRank != null) ? nft.rarityRank : 'N/A';
        const seller = await croviaDisplayName(s.seller);
        const buyer = await croviaDisplayName(s.buyer);
        const sHold = oMap[String(s.seller).toLowerCase()] || 0;
        const bHold = oMap[String(s.buyer).toLowerCase()] || 0;
        const pct = floor ? Math.round(((s.priceCro - floor) / floor) * 100) : 0;
        const trend = pct > 0 ? '↗️' : (pct < 0 ? '↘️' : '➡️');
        const priceDiffText = pct > 0 ? `+${pct}% above Floor ${trend}` : (pct < 0 ? `${pct}% below Floor ${trend}` : 'At Floor Price ➡️');
        const nftUrl = nft.url || `https://crovia.app/collections/${coll.contract}/${s.tokenId}`;
        const discord_text = generateCroviaMessage(coll, nftName, s.priceCro, seller, s.seller, buyer, s.buyer, sHold, bHold, metrics, rank, nftUrl, priceDiffText);
        await publishSale(discord_text, imgOf(nft), id, nftName, 'IGNORED', 'IGNORED', rank, collCfg);
        hasNew = true;
      }

      for (const m of freshMints.slice().reverse()) {
        const id = `crovia:mint:${coll.contract}:${m.t}`;
        const nft = (await croviaGet(`/nfts/${coll.contract}/${m.t}`)) || {};
        const nftName = nft.name || `#${m.t}`;
        const rank = (nft.rarityRank != null) ? nft.rarityRank : 'N/A';
        const minter = await croviaDisplayName(m.b);
        const mHold = oMap[String(m.b).toLowerCase()] || 0;
        const nftUrl = nft.url || `https://crovia.app/collections/${coll.contract}/${m.t}`;
        const discord_text = generateCroviaMintMessage(coll, nftName, m.cro, minter, m.b, mHold, metrics, rank, nftUrl);
        await publishSale(discord_text, imgOf(nft), id, nftName, 'IGNORED', 'IGNORED', rank, collCfg);
        hasNew = true;
      }
    } catch (error) {
      console.error(`Error retrieving Crovia activity for ${coll.name}:`, error.message);
    }
  }
  return hasNew;
}

async function checkAndPostNewSales() {
  let hasNewSalesAcrossCollections = false;

  cleanOldSales(config.shared.saveFileDiscord, publishedSales);

  for (const collection of config.collections) {
    let cursor = null;
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

    do {
      const query =
        `query {
          public {
            collection(id: "${collection.collectionId}") {
              eventHistory(after: ${cursor ? `"${cursor}"` : 'null'}) {
                edges {
                  node {
                    id asset { id name cover { url } }
                    user { displayName username }
                    toUser { displayName username }
                    amountDecimal nature createdAt
                  }
                }
                pageInfo { endCursor hasNextPage }
              }
            }
          }
        }`;

      try {
        const response = await axios.post(cryptoApiUrl, { query }, { timeout: 30000 });
        const event_history = response.data?.data?.public?.collection?.eventHistory?.edges || [];
        const page_info = response.data?.data?.public?.collection?.eventHistory?.pageInfo;
        cursor = page_info?.endCursor;

        if (event_history.length === 0) {
          break;
        }

        let metrics = null;

        for (let sale of event_history) {
          const node = sale.node;
          const created_at = new Date(node.createdAt);
          if (created_at < fortyEightHoursAgo) {
            cursor = null;
            break;
          }

          if (node.nature !== "transferred") {
            continue;
          }

          if (!config.shared.publishOnDiscord || publishedSales.has(node.id)) {
            continue;
          }

          const price = node.amountDecimal ? `$${Math.round(parseFloat(node.amountDecimal)).toLocaleString('fr-FR').replace(/\s/g, '.')}` : "N/A";
          let seller = (node.user?.username || node.user?.displayName || 'IGNORED').trim().toUpperCase();
          let buyer = (node.toUser?.username || node.toUser?.displayName || 'IGNORED').trim().toUpperCase();
          if (price === "N/A" || seller === "IGNORED" || buyer === "IGNORED") {
            continue;
          }

          hasNewSalesAcrossCollections = true;

          if (!metrics) {
            metrics = await getCollectionMetrics(collection.collectionId);
          }

          // Holdings + Twitter lus dans data.json (remplace Puppeteer countNFTs).
          const sellerInfo = lookupHolder(seller.toLowerCase());
          const buyerInfo = lookupHolder(buyer.toLowerCase());
          seller = sellerInfo.username.toUpperCase();
          buyer = buyerInfo.username.toUpperCase();

          const sellerNFTText = `${sellerInfo.count} ${sellerInfo.count <= 1 ? config.shared.nftText.singular : config.shared.nftText.plural}`;
          const buyerNFTText = `${buyerInfo.count} ${buyerInfo.count <= 1 ? config.shared.nftText.singular : config.shared.nftText.plural}`;

          // Rang de rareté : était scrapé par Puppeteer → 'N/A' en version cloud.
          const rank = 'N/A';
          const nft_url = `https://crypto.com/nft/collection/${collection.collectionId}?tab=activity&asset=${node.asset.id}`;
          const salePrice = parseFloat(node.amountDecimal);
          const floorPriceValue = parseFloat(metrics.floorPrice.replace('$', '').replace('.', '').replace(',', '.') || 0);
          const percentageChange = floorPriceValue !== 0 ? Math.round(((salePrice - floorPriceValue) / floorPriceValue) * 100) : (salePrice > 0 ? Infinity : -Infinity);
          const trendSymbol = percentageChange > 0 ? '↗️' : (percentageChange < 0 ? '↘️' : '➡️');
          const percentageWithSign = percentageChange >= 0 ? `+${percentageChange}` : percentageChange;
          const priceDiffText = percentageChange > 0 ? `${percentageWithSign}% above Floor ${trendSymbol}` : (percentageChange < 0 ? `${percentageWithSign}% below Floor ${trendSymbol}` : "At Floor Price ➡️");

          const discord_text = generateMessage(
            node.asset.name, price, seller, buyer, sellerNFTText, buyerNFTText, metrics, nft_url, rank, priceDiffText,
            sellerInfo.isTwitterHandle, buyerInfo.isTwitterHandle, collection
          );

          await publishSale(discord_text, node.asset.cover.url, node.id, node.asset.name, seller, buyer, rank, collection);
        }
      } catch (error) {
        console.error(`Error retrieving sales for ${collection.name}:`, error.message);
        break;
      }
    } while (cursor);
  }

  const croviaHadNew = await checkAndPostNewCroviaSales();

  return hasNewSalesAcrossCollections || croviaHadNew;
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// UN SEUL PASSAGE (le cron du workflow gère la répétition) + heartbeat optionnel.
// ═══════════════════════════════════════════════════════════════════════════════════════
(async () => {
  try {
    console.log(`Check: ${config.name}`);
    await checkAndPostNewSales();

    if (config.shared.heartbeatWebhookUrl && !DRY_RUN && !SEED) {
      await axios.post(
        config.shared.heartbeatWebhookUrl,
        { content: "Hourly check ✅", username: "BOT | Cloud check" },
        { timeout: 10000 }
      ).catch(e => console.warn('Heartbeat non envoyé:', e.message));
    }
    console.log('Terminé.');
  } catch (error) {
    console.error('Erreur inattendue:', error.message);
    process.exit(1);
  }
})();
