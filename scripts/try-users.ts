import { db } from '../src/db.js';
import { initVault, openCredential } from '../src/vault.js';
import { Client as FtpClient } from 'basic-ftp';

async function main() {
  initVault();
  const site = db.prepare('SELECT * FROM sites WHERE id=?').get('gUygIu3YBPQAjnnucC0Ob') as {
    sftp_user: string;
    cred_enc: string;
  };
  const password = openCredential(site.cred_enc);
  const users = [site.sftp_user, `${site.sftp_user}@barterandbuild.com`, 'grokbot@barterandbuild.com'];
  for (const user of users) {
    const client = new FtpClient(15_000);
    try {
      await client.access({ host: 'barterandbuild.com', port: 21, user, password, secure: false });
      const pwd = await client.pwd();
      const list = await client.list();
      console.log('OK', user, 'pwd', pwd, 'count', list.length, 'names', list.slice(0, 8).map((x) => x.name));
    } catch (e) {
      console.log('FAIL', user, String((e as Error).message || e).slice(0, 140));
    } finally {
      client.close();
    }
  }
}
main();
