import { expect } from 'chai';
import { connectionInfoFromDatabaseUrl, previewDatabaseUrl } from '../../utils/databaseUrl';
import { DATABASE_URL_ENV_KEYS, extractDatabaseUrlsFromEnvText } from '../../utils/envFileDatabaseUrls';

describe('databaseUrl / env DATABASE_URL helpers', () => {
  const acceptStandardKeys = (k: string): boolean =>
    new Set<string>(DATABASE_URL_ENV_KEYS).has(k);

  describe('extractDatabaseUrlsFromEnvText', () => {
    const cases: Array<{ title: string; text: string; expected: Array<{ key: string; value: string }> }> = [
      {
        title: 'parses quoted DATABASE_URL',
        text: `DATABASE_URL="postgresql://u:p@db.example.com:5432/mydb"`,
        expected: [{ key: 'DATABASE_URL', value: 'postgresql://u:p@db.example.com:5432/mydb' }],
      },
      {
        title: 'ignores comments and unrelated keys',
        text: `# DATABASE_URL=x\nFOO=1\nDATABASE_URL=postgres://a@h/db\n`,
        expected: [{ key: 'DATABASE_URL', value: 'postgres://a@h/db' }],
      },
      {
        title: 'skips non-postgres URLs',
        text: 'DATABASE_URL=mysql://x',
        expected: [],
      },
    ];

    for (const { title, text, expected } of cases) {
      it(title, () => {
        const got = extractDatabaseUrlsFromEnvText(text, acceptStandardKeys);
        expect(got).to.deep.equal(expected);
      });
    }
  });

  describe('connectionInfoFromDatabaseUrl', () => {
    it('maps URL fields and sslmode query param', () => {
      const info = connectionInfoFromDatabaseUrl(
        'postgresql://user:secret@localhost:5433/appdb?sslmode=require',
        'id-1',
      );
      expect(info.id).to.equal('id-1');
      expect(info.host).to.equal('localhost');
      expect(info.port).to.equal(5433);
      expect(info.username).to.equal('user');
      expect(info.password).to.equal('secret');
      expect(info.database).to.equal('appdb');
      expect(info.sslmode).to.equal('require');
    });
  });

  describe('previewDatabaseUrl', () => {
    it('shows host:port/db without password', () => {
      expect(previewDatabaseUrl('postgresql://u:p@hostz:5432/dbname')).to.equal('hostz:5432/dbname');
    });
  });
});
