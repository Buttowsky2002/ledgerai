/** Copy vendored report assets (fonts) into dist/ after nest build. */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'assets', 'fonts');
const destDir = path.join(root, 'dist', 'assets', 'fonts');

if (!fs.existsSync(path.join(srcDir, 'DejaVuSans.ttf'))) {
  console.error('copy-report-assets: missing assets/fonts/DejaVuSans.ttf — run npm install or vendor the font');
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
for (const name of fs.readdirSync(srcDir)) {
  fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name));
}
console.log('copy-report-assets: copied fonts to dist/assets/fonts');
