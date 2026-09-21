import { db } from '../src/db.js';
import { initVault, openCredential } from '../src/vault.js';
import SftpClient from 'ssh2-sftp-client';
import fs from 'node:fs';
import path from 'node:path';

const SITE_ID = '-8nH0Hojk2_Bj43MxD1k1';
const LOCAL_ROOT = '/workspace/barterandbuild';

const files = [
  'apps/index.html',
  'index.html',
  'ai/index.html',
  'services/index.html',
  'about/index.html',
  'contact/index.html',
  'special/index.html',
];

async function main() {
  initVault();
  const site = db.prepare('SELECT * FROM sites WHERE id=?').get(SITE_ID) as {
    host: string;
    port: number;
    sftp_user: string;
    cred_enc: string;
    root_path: string;
  };
  const password = openCredential(site.cred_enc);
  const sftp = new SftpClient();
  await sftp.connect({
    host: site.host,
    port: Number(site.port) || 22,
    username: site.sftp_user,
    password,
  });
  try {
    // Probe jail root: try configured root, then /
    const candidates = [site.root_path.replace(/\/$/, '') || '/', '/', '/public_html'];
    let root = '/';
    for (const c of candidates) {
      try {
        const list = await sftp.list(c === '' ? '/' : c);
        console.log('list ok', c, 'count', list.length, 'sample', list.slice(0, 5).map((x) => x.name).join(','));
        root = c === '' ? '/' : c;
        break;
      } catch (e: any) {
        console.log('list fail', c, e?.message || e);
      }
    }
    console.log('using root', root);

    // ensure apps dir
    const appsDir = root === '/' ? '/apps' : `${root}/apps`;
    const exists = await sftp.exists(appsDir);
    if (!exists) {
      await sftp.mkdir(appsDir, true);
      console.log('mkdir', appsDir);
    }

    for (const rel of files) {
      const local = path.join(LOCAL_ROOT, rel);
      const remote = root === '/' ? `/${rel}` : `${root}/${rel}`;
      if (!fs.existsSync(local)) {
        console.log('skip missing', local);
        continue;
      }
      await sftp.put(local, remote);
      console.log('put', remote, fs.statSync(local).size);
    }
    console.log('deploy done');
  } finally {
    await sftp.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
