import { db } from '../src/db.js';
import { initVault, openCredential } from '../src/vault.js';
import SftpClient from 'ssh2-sftp-client';
import fs from 'node:fs';
import path from 'node:path';

const SITE_ID = '-8nH0Hojk2_Bj43MxD1k1';
const LOCAL = '/workspace/signature-hero-study';
const REMOTE_REL = 'samples/signature-hero';

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

async function main() {
  initVault();
  const site = db.prepare('SELECT * FROM sites WHERE id=?').get(SITE_ID) as any;
  const password = openCredential(site.cred_enc);
  const sftp = new SftpClient();
  await sftp.connect({
    host: site.host,
    port: Number(site.port) || 22,
    username: site.sftp_user,
    password,
  });
  try {
    const root = String(site.root_path).replace(/\/$/, '');
    const remoteRoot = `${root}/${REMOTE_REL}`;
    await sftp.mkdir(remoteRoot, true);
    await sftp.mkdir(`${remoteRoot}/assets`, true);
    await sftp.mkdir(`${remoteRoot}/assets/frames`, true);
    for (const rel of walk(LOCAL)) {
      const local = path.join(LOCAL, rel);
      const remote = `${remoteRoot}/${rel}`;
      const dir = path.posix.dirname(remote);
      // ensure nested dirs
      await sftp.mkdir(dir, true);
      console.log('put', rel, fs.statSync(local).size);
      await sftp.fastPut(local, remote);
    }
    console.log('done');
  } finally {
    await sftp.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
