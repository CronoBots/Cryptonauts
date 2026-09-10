// Commit data.json UNIQUEMENT si le classement a réellement changé (en ignorant
// le champ generatedAt qui change à chaque run). Lancé par la GitHub Action.
// Écrit en Node (pas de bash) pour fonctionner sur le runner self-hosted Windows.
const fs = require('fs');
const { execSync } = require('child_process');

let prev = {};
try {
  prev = JSON.parse(execSync('git show HEAD:data.json', { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
} catch (e) { /* 1er commit / fichier absent */ }

const next = JSON.parse(fs.readFileSync('data.json', 'utf8'));
const strip = (d) => JSON.stringify({ c: d.collectionsData, g: d.globalOwnersData, a: d.externalAssets });

if (strip(prev) === strip(next)) {
  console.log('Classement inchangé — aucun commit.');
  process.exit(0);
}

console.log('Classement modifié — commit + push.');
execSync('git config user.name "github-actions[bot]"', { stdio: 'inherit' });
execSync('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"', { stdio: 'inherit' });
execSync('git add data.json', { stdio: 'inherit' });
execSync('git commit -m "data: rafraichit le classement Cryptonauts (auto)"', { stdio: 'inherit' });
execSync('git push', { stdio: 'inherit' });
console.log('✅ Poussé.');
