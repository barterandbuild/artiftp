import { db } from '../src/db.js';
import type { SiteRow } from '../src/db.js';
import { Client as FtpClient } from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';
import { decrypt } from '../src/crypto.js';

const ID = 'gUygIu3YBPQAjnnucC0Ob';

async function tryPlainFtp(site: SiteRow, port = 21) {
  const client = new FtpClient(25_000);
  try {
    await client.access({
      host: site.host,
      port,
      user: site.sftp_user,
      password: decrypt(site.cred_enc),
      secure: false,
    });
    const pwd = await client.pwd();
    const list = await client.list();
    return { ok: true, mode: `ftp-plain:${port}`, pwd, count: list.length, names: list.slice(0, 12).map((x) => x.name) };
  } finally {
    client.close();
  }
}

async function tryFtps(site: SiteRow, port = 21) {
  const client = new FtpClient(25_000);
  try {
    await client.access({
      host: site.host,
      port,
      user: site.sftp_user,
      password: decrypt(site.cred_enc),
      secure: true,
      secureOptions: { rejectUnauthorized: false },
    });
    const pwd = await client.pwd();
    const list = await client.list();
    return { ok: true, mode: `ftp-tls:${port}`, pwd, count: list.length, names: list.slice(0, 12).map((x) => x.name) };
  } finally {
    client.close();
  }
}

async function trySftp(site: SiteRow) {
  const sftp = new SftpClient();
  try {
    await sftp.connect({
      host: site.host,
      port: 22,
      username: site.sftp_user,
      password: decrypt(site.cred_enc),
      readyTimeout: 20_000,
    });
    const list = await sftp.list('.');
    return { ok: true, mode: 'sftp-22', count: list.length, names: list.slice(0, 12).map((x) => x.name) };
  } finally {
    try {
      await sftp.end();
    } catch {
      /* */
    }
  }
}

async function main() {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(ID) as SiteRow;
  console.log('site', {
    name: site.display_name,
    host: site.host,
    port: site.port,
    user: site.sftp_user,
    root: site.root_path,
  });
  for (const fn of [
    () => tryPlainFtp(site, 21),
    () => tryFtps(site, 21),
    () => trySftp(site),
  ]) {
    const name = fn.toString().includes('Plain') ? 'plain21' : fn.toString().includes('Ftps') ? 'ftps21' : 'sftp22';
    try {
      console.log(await fn());
    } catch (e) {
      console.log(name, 'FAIL', String((e as Error).message || e).slice(0, 180));
    }
  }
}

main();
