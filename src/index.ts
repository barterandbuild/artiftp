import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerRouter } from './routes/owner.js';
import { agentRouter } from './routes/agent.js';
import { ensureDefaultOwner, createOwnerMagicLink } from './auth.js';
import { logPublicBaseUrlOnStartup } from './publicUrl.js';
import { logMailConfigOnStartup } from './mail.js';
import { db } from './db.js';
import { getBackendMode } from './fs/storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);

ensureDefaultOwner();

const app = express();
app.use(express.json({ limit: '6mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, product: 'ArtiFTP', backend: getBackendMode() });
});

app.use(ownerRouter);
app.use(agentRouter);

app.use('/ui', express.static(path.join(__dirname, '../public')));
app.get('/', (_req, res) => res.redirect('/ui/'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nArtiFTP listening on http://0.0.0.0:${PORT}`);
  console.log(`Owner UI: http://0.0.0.0:${PORT}/ui/`);
  console.log(`Backend mode: ${getBackendMode()}`);
  logPublicBaseUrlOnStartup();
  logMailConfigOnStartup();
  const siteCount = (db.prepare('SELECT COUNT(*) AS c FROM sites').get() as { c: number }).c;
  if (siteCount === 0) {
    console.log('No sites yet — use dogfood script or Owner UI after magic-link login.');
  }
  // Print a fresh owner login link on boot for ops backup — do not email
  // (Railway deploys/restarts would otherwise flood the owner inbox).
  createOwnerMagicLink({ email: false });
});
