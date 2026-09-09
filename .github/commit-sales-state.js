// Commit le fichier de dédoublonnage des ventes (Saves/Cryptonauts_Discord.json)
// UNIQUEMENT s'il a changé, pour que la mémoire « déjà publié » persiste d'un run
// cloud à l'autre (les runners GitHub sont sans état). Lancé par publish-sales.yml.
const fs = require('fs');
const { execSync } = require('child_process');

const FILE = 'Saves/Cryptonauts_Discord.json';

if (!fs.existsSync(FILE)) {
  console.log('Aucun fichier de dédup — rien à committer.');
  process.exit(0);
}

let prev = '';
try {
  prev = execSync(`git show HEAD:${FILE}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
} catch (e) { /* fichier pas encore committé */ }

const next = fs.readFileSync(FILE, 'utf8');

if (prev === next) {
  console.log('Dédup inchangé — aucun commit.');
  process.exit(0);
}

console.log('Dédup modifié — commit + push.');
execSync('git config user.name "github-actions[bot]"', { stdio: 'inherit' });
execSync('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"', { stdio: 'inherit' });
execSync(`git add ${FILE}`, { stdio: 'inherit' });
execSync('git commit -m "sales: memoire de publication Discord (auto)"', { stdio: 'inherit' });
// Rebase au cas où le refresh du classement aurait poussé entre-temps.
try { execSync('git pull --rebase --autostash', { stdio: 'inherit' }); } catch (e) { /* best-effort */ }
execSync('git push', { stdio: 'inherit' });
console.log('✅ Poussé.');
