import { db } from '../src/db.js';
import { initVault, openPersistedCredential } from '../src/vault.js';
import SftpClient from 'ssh2-sftp-client';
import fs from 'node:fs';
import path from 'node:path';

const SITE_ID = '-8nH0Hojk2_Bj43MxD1k1';
const LOCAL_ROOT = '/workspace/barterandbuild';
const files = [
  'assets/showcase.css',
  'index.html',
  'apps/index.html',
  'ai/index.html',
  'services/index.html',
  'about/index.html',
  'contact/index.html',
  'special/index.html',
];

async function main() {
  initVault();
  const site = db.prepare('SELECT * FROM sites WHERE id=?').get(SITE_ID) as any;
  const password = openPersistedCredential(site.cred_enc);
  const sftp = new SftpClient();
  await sftp.connect({
    host: site.host,
    port: Number(site.port) || 22,
    username: site.sftp_user,
    password,
  });
  try {
    const root = String(site.root_path).replace(/\/$/, '');
    for (const rel of files) {
      const local = path.join(LOCAL_ROOT, rel);
      const remote = `${root}/${rel}`;
      await sftp.put(local, remote);
      console.log('put', remote, fs.statSync(local).size);
    }
  } finally {
    await sftp.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
