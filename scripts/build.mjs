import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'dist');
const files = ['index.html', 'app.js', 'config.js', 'styles.css', 'favicon.png', 'manifest.webmanifest'];
if (path.dirname(dest) !== root || path.basename(dest) !== 'dist') throw new Error('Invalid output path');
if (fs.existsSync(dest) && (fs.lstatSync(dest).isSymbolicLink() || fs.realpathSync(dest) !== dest)) throw new Error('Output must be a local directory');
for (const name of files) {
  const source = path.join(root, name);
  if (!fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) throw new Error('Only ordinary frontend files may be published');
}
const config = fs.readFileSync(path.join(root, 'config.js'), 'utf8');
if (!config.includes('REQUIRE_PERSONAL_KEY: true') || /EMBEDDED_API_KEY\s*:/.test(config)) throw new Error('Public build requires personal-key configuration');
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest);
for (const name of files) fs.copyFileSync(path.join(root, name), path.join(dest, name));
console.log(`Prepared ${files.length} frontend files; private pairing files and source tools excluded.`);
