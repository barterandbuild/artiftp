import { db } from '../src/db.js';
import { decrypt } from '../src/crypto.js';
import SftpClient from 'ssh2-sftp-client';

async function main() {
  const site = db.prepare('SELECT * FROM sites WHERE id=?').get('-8nH0Hojk2_Bj43MxD1k1') as {
    host: string;
    port: number;
    sftp_user: string;
    cred_enc: string;
    root_path: string;
  };
  const password = decrypt(site.cred_enc);
  const sftp = new SftpClient();
  await sftp.connect({
    host: site.host,
    port: Number(site.port) || 22,
    username: site.sftp_user,
    password,
  });
  try {
    const root = site.root_path.replace(/\/$/, '');
    const file = `${root}/work/index.html`;
    const dir = `${root}/work`;
    const fe = await sftp.exists(file);
    console.log('file', fe);
    if (fe === '-') await sftp.delete(file);
    const de = await sftp.exists(dir);
    console.log('dir', de);
    if (de === 'd') {
      const list = await sftp.list(dir);
      for (const item of list) {
        const p = `${dir}/${item.name}`;
        if (item.type === '-') await sftp.delete(p);
        else if (item.type === 'd') await sftp.rmdir(p, true);
      }
      await sftp.rmdir(dir);
    }
    console.log('done');
  } finally {
    await sftp.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
