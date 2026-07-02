// Publica el juego en GitHub Pages: build + push forzado a la rama gh-pages.
// Uso: npm run deploy
import { execSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';

const REPO = 'https://github.com/luisecg87/padel-cam.git';
const run = (cmd, cwd) => execSync(cmd, { stdio: 'inherit', cwd });

run('npm run build');
writeFileSync('dist/.nojekyll', '');
run('git init -b gh-pages', 'dist');
run('git add -A', 'dist');
run('git commit -m deploy', 'dist');
run(`git push -f ${REPO} gh-pages`, 'dist');
rmSync('dist/.git', { recursive: true, force: true });
console.log('\n✅ Publicado en https://luisecg87.github.io/padel-cam/ (puede tardar ~1 min)');
