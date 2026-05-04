import { expect } from 'chai';
import { SqlParser } from '../../providers/kernel/SqlParser';

describe('SqlParser', () => {
  describe('splitSqlStatements', () => {
    it('should split simple statements', () => {
      const sql = 'SELECT 1; SELECT 2;';
      const statements = SqlParser.splitSqlStatements(sql);
      expect(statements).to.have.lengthOf(2);
      expect(statements[0]).to.equal('SELECT 1;');
      expect(statements[1]).to.equal('SELECT 2;');
    });

    it('should ignore semicolons in single quotes', () => {
      const sql = "SELECT 'a;b'; SELECT 2;";
      const statements = SqlParser.splitSqlStatements(sql);
      expect(statements).to.have.lengthOf(2);
      expect(statements[0]).to.equal("SELECT 'a;b';");
    });

    it('should handle escaped single quotes', () => {
      const sql = "SELECT 'O''Reilly'; SELECT 1;";
      const statements = SqlParser.splitSqlStatements(sql);
      expect(statements).to.have.lengthOf(2);
      expect(statements[0]).to.equal("SELECT 'O''Reilly';");
    });

    it('should ignore semicolons in line comments', () => {
      const sql = 'SELECT 1; -- comment with ; inside \n SELECT 2;';
      const statements = SqlParser.splitSqlStatements(sql);
      expect(statements).to.have.lengthOf(2);
      expect(statements[0]).to.equal('SELECT 1;');
      expect(statements[1]).to.contain('SELECT 2;');
    });

    it('should ignore semicolons in block comments', () => {
      const sql = 'SELECT 1; /* comment with ; \n inside */ SELECT 2;';
      const statements = SqlParser.splitSqlStatements(sql);
      expect(statements).to.have.lengthOf(2);
      expect(statements[0]).to.equal('SELECT 1;');
      expect(statements[1]).to.contain('SELECT 2;');
    });

    it('should ignore semicolons in dollar-quoted strings', () => {
      const sql = 'CREATE FUNCTION foo() AS $$ BEGIN; RETURN; END; $$ LANGUAGE plpgsql; SELECT 1;';
      const statements = SqlParser.splitSqlStatements(sql);
      expect(statements).to.have.lengthOf(2);
      expect(statements[0]).to.contain('$$ BEGIN; RETURN; END; $$');
    });

    it('should handle tagged dollar-quoted strings', () => {
      const sql = 'SELECT $tag$ ; $tag$; SELECT 2;';
      const statements = SqlParser.splitSqlStatements(sql);
      expect(statements).to.have.lengthOf(2);
      expect(statements[0]).to.equal('SELECT $tag$ ; $tag$;');
    });

    it('should handle empty input', () => {
      const statements = SqlParser.splitSqlStatements('');
      expect(statements).to.be.empty;
    });

    it('should handle whitespace only', () => {
      const statements = SqlParser.splitSqlStatements('   \n   ');
      expect(statements).to.be.empty;
    });

    it('should handle nested complex structures', () => {
      const sql = `
                -- Start
                SELECT 1; 
                /* 
                   Multi-line comment ; 
                */
                SELECT 'text with ;' AS col;
                SELECT $tag$ 
                    nested ; string 
                $tag$;
            `;
      const statements = SqlParser.splitSqlStatements(sql);
      expect(statements).to.have.lengthOf(3);
    });

    it('should handle comments without statements', () => {
      const sql = '-- just a comment';
      const statements = SqlParser.splitSqlStatements(sql);
      expect(statements).to.have.lengthOf(1);
      expect(statements[0]).to.equal('-- just a comment');
    });

    it('should not split if no semicolon', () => {
      const sql = 'SELECT 1';
      const statements = SqlParser.splitSqlStatements(sql);
      expect(statements).to.have.lengthOf(1);
      expect(statements[0]).to.equal('SELECT 1');
    });
  });

  describe('substituteNamedParametersWithPgPlaceholders', () => {
    it('rewrites :name to $n in first-seen order', () => {
      const { text, paramNames } = SqlParser.substituteNamedParametersWithPgPlaceholders(
        'SELECT * FROM t WHERE a = :b AND c = :a'
      );
      expect(paramNames).to.deep.equal(['b', 'a']);
      expect(text).to.equal('SELECT * FROM t WHERE a = $1 AND c = $2');
    });

    it('reuses the same $n when the same name appears twice', () => {
      const { text, paramNames } = SqlParser.substituteNamedParametersWithPgPlaceholders(
        'SELECT * FROM t WHERE id = :id OR parent_id = :id'
      );
      expect(paramNames).to.deep.equal(['id']);
      expect(text).to.equal('SELECT * FROM t WHERE id = $1 OR parent_id = $1');
    });

    it('does not treat PostgreSQL ::type casts as parameters', () => {
      const { text, paramNames } = SqlParser.substituteNamedParametersWithPgPlaceholders(
        "SELECT '2020-01-01'::date, col::text FROM t WHERE x = :x"
      );
      expect(paramNames).to.deep.equal(['x']);
      expect(text).to.equal("SELECT '2020-01-01'::date, col::text FROM t WHERE x = $1");
    });

    it('ignores :name inside single-quoted literals', () => {
      const { text, paramNames } = SqlParser.substituteNamedParametersWithPgPlaceholders(
        "SELECT ':foo', :bar FROM t"
      );
      expect(paramNames).to.deep.equal(['bar']);
      expect(text).to.equal("SELECT ':foo', $1 FROM t");
    });

    it('ignores :name in line comments', () => {
      const { text, paramNames } = SqlParser.substituteNamedParametersWithPgPlaceholders(
        'SELECT 1 -- :nope\n, :yes'
      );
      expect(paramNames).to.deep.equal(['yes']);
      expect(text).to.include('-- :nope');
      expect(text).to.include('$1');
    });

    it('ignores :name in block comments', () => {
      const { text, paramNames } = SqlParser.substituteNamedParametersWithPgPlaceholders(
        'SELECT /* :nope */ :yes'
      );
      expect(paramNames).to.deep.equal(['yes']);
      expect(text).to.equal('SELECT /* :nope */ $1');
    });
  });

  describe('detectPositionalParameters', () => {
    it('detects simple positional placeholders', () => {
      const found = SqlParser.detectPositionalParameters('SELECT $1, $2, $3');
      expect(found).to.deep.equal([1, 2, 3]);
    });

    it('keeps gaps and deduplicates placeholders', () => {
      const found = SqlParser.detectPositionalParameters('SELECT $1, $3, $1');
      expect(found).to.deep.equal([1, 3]);
    });

    it('ignores placeholders inside single-quoted strings', () => {
      const found = SqlParser.detectPositionalParameters("SELECT '$1 unread'");
      expect(found).to.deep.equal([]);
    });

    it('ignores placeholders inside dollar-quoted blocks', () => {
      const sql = 'CREATE FUNCTION f(a int) RETURNS int AS $$ BEGIN RETURN $1; END $$ LANGUAGE plpgsql';
      const found = SqlParser.detectPositionalParameters(sql);
      expect(found).to.deep.equal([]);
    });

    it('ignores placeholders in comments and dollar quote markers', () => {
      const sql = 'SELECT $$not a $1 placeholder$$, $tag$abc$tag$, 1 -- $4\n/* $5 */\n, $2';
      const found = SqlParser.detectPositionalParameters(sql);
      expect(found).to.deep.equal([2]);
    });
  });

  describe('substituteQuotedPsqlVariables', () => {
    it('substitutes literal and identifier variables with proper escaping', () => {
      const { text, paramNames } = SqlParser.substituteQuotedPsqlVariables(
        "SELECT :'name' AS n, :\"col\" FROM :\"tbl\"",
        { name: "O'Brien", col: 'my"col', tbl: 'my"tbl' }
      );

      expect(paramNames).to.deep.equal(['name', 'col', 'tbl']);
      expect(text).to.equal("SELECT 'O''Brien' AS n, \"my\"\"col\" FROM \"my\"\"tbl\"");
    });

    it('ignores quoted psql variables inside strings, comments, and dollar quotes', () => {
      const { text, paramNames } = SqlParser.substituteQuotedPsqlVariables(
        "SELECT ':\"ignored\"', :'ok' -- :'ignored'\n, $$ :'ignored' $$, /* :'ignored' */ :'ok'",
        { ok: 'x' }
      );

      expect(paramNames).to.deep.equal(['ok']);
      expect(text).to.equal("SELECT ':\"ignored\"', 'x' -- :'ignored'\n, $$ :'ignored' $$, /* :'ignored' */ 'x'");
    });

    it('uses one prompted name for repeated tokens', () => {
      const { text, paramNames } = SqlParser.substituteQuotedPsqlVariables(
        "SELECT :'v', :'v'",
        { v: 'a' }
      );
      expect(paramNames).to.deep.equal(['v']);
      expect(text).to.equal("SELECT 'a', 'a'");
    });
  });

  describe('detectParameters', () => {
    it('returns positional, named, and quoted buckets', () => {
      const params = SqlParser.detectParameters(
        "SELECT $1, :name, :'literalVar', :\"identifierVar\", col::text"
      );

      expect(params.positional).to.deep.equal([1]);
      expect(params.named).to.deep.equal(['name']);
      expect(params.quoted).to.deep.equal([
        { name: 'literalVar', kind: 'literal' },
        { name: 'identifierVar', kind: 'identifier' }
      ]);
    });

    it('keeps casts out of named parameters', () => {
      const params = SqlParser.detectParameters("SELECT '2020-01-01'::date, col::text");
      expect(params.named).to.deep.equal([]);
    });
  });

  describe('hasNamedParameters', () => {
    it('is true when a bind placeholder exists outside literals', () => {
      expect(SqlParser.hasNamedParameters('SELECT :a')).to.be.true;
    });

    it('is false when only casts or literals contain colons', () => {
      expect(SqlParser.hasNamedParameters("SELECT '::'::text")).to.be.false;
      expect(SqlParser.hasNamedParameters('SELECT 1::int')).to.be.false;
    });
  });

  describe('stripCommentsAndStrings', () => {
    it('removes comments and string literals while keeping code tokens', () => {
      const sql = "SELECT 'value -- not comment', col /* block */ FROM \"My Table\" -- line comment\nWHERE name = $$literal$$;";
      const stripped = SqlParser.stripCommentsAndStrings(sql);
      expect(stripped).to.contain('SELECT');
      expect(stripped).to.contain('FROM "My Table"');
      expect(stripped).to.contain('WHERE name =');
      expect(stripped).to.not.contain('value -- not comment');
      expect(stripped).to.not.contain('block');
      expect(stripped).to.not.contain('line comment');
    });
  });

  describe('normalizeIdentifier', () => {
    it('lowercases unquoted identifiers and preserves quoted identifiers', () => {
      expect(SqlParser.normalizeIdentifier('Users')).to.equal('users');
      expect(SqlParser.normalizeIdentifier('"CaseSensitive"')).to.equal('CaseSensitive');
    });
  });
});
