// Whole-program noEmit follows TypeScript-Go #4407, beyond the pinned 7.0.2 oracle.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { tempDir } from './temp.mjs';
import { tscTs, tscTsMissing } from './toolchain.mjs';

const libs = resolve('../../upstream/typescript-go/internal/bundled/libs');
const skip = tscTsMissing || (!existsSync(libs) && 'needs upstream libraries');

function project(options, source = 'export const value: string = 123;\n') {
  const cwd = tempDir('tsc-ts-noemit-');
  writeFileSync(join(cwd, 'index.ts'), source);
  // Eight independent files let the native four-checker path distribute real work.
  for (let i = 0; i < 8; i++) writeFileSync(join(cwd, 'extra' + i + '.ts'), 'export const extra = 1;\n');
  writeFileSync(
    join(cwd, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, types: [], noEmit: true, ...options },
      include: ['*.ts'],
    }),
  );
  return cwd;
}

function run(cwd, checkers, side, args = []) {
  const result = spawnSync(
    tscTs[0],
    [...tscTs.slice(1), '-p', '.', '--pretty', 'false', '--checkers', String(checkers), ...args],
    {
      cwd,
      encoding: 'utf8',
      timeout: 60000,
      env: { PATH: process.env.PATH ?? '', TSC_TS_LIB_DIR: libs, TSC_TS_SIDE_STATE: String(side) },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  return result;
}

function expect(result, status, codes) {
  assert.equal(result.status, status, result.stdout);
  assert.deepEqual(
    [...result.stdout.matchAll(/error TS(\d+):/g)].map((match) => Number(match[1])),
    codes,
    result.stdout,
  );
}

function outputs(cwd) {
  return readdirSync(cwd)
    .filter((name) => !name.endsWith('.ts') && name !== 'tsconfig.json')
    .sort();
}

for (const checkers of [1, 4]) {
  for (const side of [0, 1]) {
    test('noEmit exit and cache contract: checkers ' + checkers + ', side ' + side, { skip, timeout: 300000 }, () => {
      const bad = "index.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.\n";
      for (const noEmitOnError of [false, true]) {
        const cwd = project({ noEmitOnError });
        const result = run(cwd, checkers, side);
        expect(result, 2, [2322]);
        assert.equal(result.stdout, bad);
        assert.deepEqual(outputs(cwd), []);
        writeFileSync(join(cwd, 'index.ts'), 'export const value: string = "ok";\n');
        expect(run(cwd, checkers, side), 0, []);
        assert.deepEqual(outputs(cwd), []);
      }

      const cwd = project({ incremental: true, tsBuildInfoFile: 'cache.tsbuildinfo' });
      let before;
      for (const phase of ['cold', 'warm', 'unrelated', 'repair', 'regress']) {
        if (phase === 'unrelated') writeFileSync(join(cwd, 'extra0.ts'), 'export const extra = 2;\n');
        if (phase === 'repair') writeFileSync(join(cwd, 'index.ts'), 'export const value: string = "ok";\n');
        if (phase === 'regress') writeFileSync(join(cwd, 'index.ts'), 'export const value: string = 123;\n');
        const result = run(cwd, checkers, side);
        expect(result, phase === 'repair' ? 0 : 2, phase === 'repair' ? [] : [2322]);
        assert.equal(result.stdout, phase === 'repair' ? '' : bad);
        assert.deepEqual(outputs(cwd), ['cache.tsbuildinfo']);
        const info = readFileSync(join(cwd, 'cache.tsbuildinfo'), 'utf8');
        assert.ok(JSON.parse(info).fileNames.length >= 9);
        if (phase === 'warm') assert.equal(info, before);
        if (phase === 'unrelated') assert.notEqual(info, before);
        before = info;
      }

      // Build-info failure is still a skipped emit; retry must retain pending state.
      const blocked = project({ incremental: true, tsBuildInfoFile: 'cache.tsbuildinfo' }, 'export const value = 1;\n');
      mkdirSync(join(blocked, 'cache.tsbuildinfo'));
      expect(run(blocked, checkers, side), 1, [5033]);
      rmSync(join(blocked, 'cache.tsbuildinfo'), { recursive: true });
      expect(run(blocked, checkers, side), 0, []);
      assert.ok(JSON.parse(readFileSync(join(blocked, 'cache.tsbuildinfo'), 'utf8')).fileNames.length >= 9);

      const declaration = project({ declaration: true }, 'export const value = class { private member = 1; };\n');
      expect(run(declaration, checkers, side), 2, [4094]);
      assert.deepEqual(outputs(declaration), []);

      const syntax = project({}, 'export const value: = 1;\n');
      expect(run(syntax, checkers, side), 2, [1110]);
      assert.deepEqual(outputs(syntax), []);

      // Emitting errors and noEmitOnError remain distinct; don't remap every failure to 2.
      for (const noEmitOnError of [false, true]) {
        const emitting = project({ noEmit: false, noEmitOnError, declaration: true, sourceMap: true, outDir: 'out' });
        expect(run(emitting, checkers, side), noEmitOnError ? 1 : 2, [2322]);
        assert.deepEqual(outputs(emitting), noEmitOnError ? [] : ['out']);
        if (!noEmitOnError) {
          assert.match(readFileSync(join(emitting, 'out/index.js'), 'utf8'), /export const value = 123;/);
          assert.match(readFileSync(join(emitting, 'out/index.d.ts'), 'utf8'), /value: string/);
          assert.equal(JSON.parse(readFileSync(join(emitting, 'out/index.js.map'), 'utf8')).version, 3);
        }
        writeFileSync(join(emitting, 'index.ts'), 'export const value: string = "ok";\n');
        expect(run(emitting, checkers, side), 0, []);
        assert.match(readFileSync(join(emitting, 'out/index.js'), 'utf8'), /export const value = "ok";/);
      }
      expect(run(cwd, checkers, side, ['--unknownOption']), 1, [5023]);
      expect(run(cwd, checkers, side, ['-p', 'missing.json']), 1, [5058]);
    });
  }
}
