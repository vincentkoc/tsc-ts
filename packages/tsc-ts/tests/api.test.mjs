import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Differential, explore, exploreServices } from './differential.mjs';
import { typescriptLib as bundledLib, tscTs, tscTsMissing } from './toolchain.mjs';
import { tempDir } from './temp.mjs';

// The reference: TypeScript 7.0.2's tsc, shipped with scriptc. It reads lib
// files from its real directory.
const typescriptLib = bundledLib !== undefined && existsSync(bundledLib) ? realpathSync(bundledLib) : '';
const realTsc = join(typescriptLib, 'tsc');
const env = { TSC_TS_LIB_DIR: typescriptLib };
const skip = !existsSync(realTsc) ? 'needs the scriptc toolchain' : tscTsMissing;

function copyProject() {
  const dir = tempDir('tsc-ts-api-');
  cpSync(resolve('tests/fixtures/project'), dir, { recursive: true });
  return dir;
}

function report(d) {
  assert.deepEqual(
    d.failures.slice(0, Number(process.env.SHOW_FAILURES ?? 20)),
    [],
    `${d.failures.length} of ${d.count} responses differ`,
  );
}

test('tsc-ts --api answers like tsc --api', { skip, timeout: 600_000 }, async () => {
  const dir = copyProject();
  const d = new Differential([realTsc], tscTs, dir, env);
  try {
    await d.call('initialize');
    await d.call('ping');
    await d.call('getServerTiming');
    const config = join(dir, 'tsconfig.json');
    await d.call('parseConfigFile', { file: config });
    const update = await d.call('updateSnapshot', { openProjects: [config] });
    const snapshot = update.snapshot;
    const project = update.projects[0].id;
    const base = { snapshot, project };

    const fileNames = await d.call('getSourceFileNames', base);
    const userFiles = [];
    for (const file of fileNames) {
      const encoded = await d.call('getSourceFile', { ...base, file });
      await d.call('getSourceFileMetadata', { ...base, file });
      if (file.startsWith(dir)) userFiles.push({ file, length: readFileSync(file, 'utf8').length, encoded });
    }
    await d.call('getSourceFile', { ...base, file: join(dir, 'missing.ts') });
    await d.call('getDefaultProjectForFile', { snapshot, file: join(dir, 'src/main.ts') });

    for (const method of ['getConfigFileParsingDiagnostics', 'getProgramDiagnostics', 'getGlobalDiagnostics']) {
      await d.call(method, base);
    }
    for (const method of [
      'getSyntacticDiagnostics',
      'getBindDiagnostics',
      'getSemanticDiagnostics',
      'getSuggestionDiagnostics',
    ]) {
      await d.call(method, base);
      for (const { file } of userFiles) await d.call(method, { ...base, file });
    }

    for (const name of [
      'Any',
      'String',
      'Number',
      'Boolean',
      'Void',
      'Undefined',
      'Null',
      'Never',
      'Unknown',
      'BigInt',
      'ESSymbol',
    ]) {
      await d.call(`get${name}Type`, base);
    }
    await d.call('getWellKnownSymbols', base);
    await d.call('resolveName', { ...base, name: 'Circle', meaning: 0xffffffff, file: userFiles[0].file, position: 0 });
    await d.call('resolveName', { ...base, name: 'Array', meaning: 0xffffffff });

    const explored = await explore(d, snapshot, project, userFiles, 4000);
    assert.ok(explored > 500, `explored ${explored} objects`);

    // Type nodes round-trip through printNode.
    const positions = Array.from({ length: 60 }, (_, i) => i * 37);
    const types = await d.call('getTypesAtPositions', { ...base, file: userFiles[0].file, positions });
    for (const type of types.filter((t) => t !== null)) {
      const node = await d.call('typeToTypeNode', { ...base, type: type.id });
      if (node instanceof Uint8Array) await d.call('printNode', { data: Buffer.from(node).toString('base64') });
    }
    await d.call('printNode', { data: '!!' });
    await d.call('echo', { hello: 'wörld' });

    // Errors the API reports for bad requests.
    await d.call('getTypeOfSymbol', { ...base, symbol: 999999 });
    await d.call('getPropertiesOfType', { ...base, type: 999999 });
    await d.call('getTypeAtLocation', { ...base, location: '1.2' });
    await d.call('getTypeAtLocation', { ...base, location: `99999.79.${userFiles[0].file}` });
    await d.call('getSourceFileNames', { snapshot: 99, project });
    await d.call('getSourceFileNames', { snapshot, project: '/nope/tsconfig.json' });
    await d.call('noSuchMethod', base);

    // Snapshots: an unchanged update reuses the snapshot; edits report changes.
    const again = await d.call('updateSnapshot', {});
    assert.equal(again.snapshot, snapshot + 1);
    await d.call('release', { snapshot });
    const shapes = join(dir, 'src/shapes.ts');
    writeFileSync(shapes, readFileSync(shapes, 'utf8') + '\nexport const added = 1;\n');
    const changed = await d.call('updateSnapshot', { fileChanges: { changed: [shapes] } });
    await d.call('getSourceFile', { snapshot: changed.snapshot, project, file: shapes });
    await d.call('getSemanticDiagnostics', { snapshot: changed.snapshot, project, file: shapes });
    await d.call('updateSnapshot', { closeProjects: [config] });
    await d.call('release', { snapshot });
    await d.call('release', { snapshot: changed.snapshot });
    await d.call('release', { snapshot: changed.snapshot });
  } finally {
    await d.close();
  }
  console.log(`compared ${d.count} responses`);
  report(d);
});

test('tsc-ts --api reports global diagnostics like tsc --api', { skip, timeout: 300_000 }, async () => {
  // Below ES2022 the libs have no Disposable, so `using` reports global diagnostics, which have no node.
  const dir = tempDir('tsc-ts-api-');
  writeFileSync(
    join(dir, 'tsconfig.json'),
    '{"compilerOptions":{"target":"ES2015","strict":true,"types":[]},"files":["a.ts"]}',
  );
  writeFileSync(join(dir, 'a.ts'), 'export function f(d: any) {\n  using x = d;\n}\n');
  const d = new Differential([realTsc], tscTs, dir, env);
  try {
    await d.call('initialize');
    const update = await d.call('updateSnapshot', { openProjects: [join(dir, 'tsconfig.json')] });
    const base = { snapshot: update.snapshot, project: update.projects[0].id };
    await d.call('getSemanticDiagnostics', { ...base, file: join(dir, 'a.ts') });
    await d.call('getGlobalDiagnostics', base);
  } finally {
    await d.close();
  }
  report(d);
});

test('tsc-ts --api tracks projects and open files like tsc --api', { skip, timeout: 300_000 }, async () => {
  const dir = tempDir('tsc-ts-api-');
  cpSync(resolve('tests/fixtures/project'), join(dir, 'a'), { recursive: true });
  mkdirSync(join(dir, 'b'));
  writeFileSync(join(dir, 'b/tsconfig.json'), '{"compilerOptions":{"strict":false,"types":[]},"files":["x.ts"]}');
  writeFileSync(join(dir, 'b/x.ts'), 'export const x: number = 1;\n');
  mkdirSync(join(dir, 'loose'));
  writeFileSync(join(dir, 'loose/y.ts'), 'export const y = 2;\n');
  const d = new Differential([realTsc], tscTs, dir, env);
  try {
    await d.call('initialize');
    const first = await d.call('updateSnapshot', { openProjects: [join(dir, 'b/tsconfig.json'), 'a/tsconfig.json'] });
    await d.call('getDefaultProjectForFile', { snapshot: first.snapshot, file: join(dir, 'b/x.ts') });
    await d.call('getDefaultProjectForFile', { snapshot: first.snapshot, file: join(dir, 'loose/y.ts') });
    await d.call('updateSnapshot', { closeProjects: ['a/tsconfig.json'] });
    await d.call('updateSnapshot', { openFiles: [join(dir, 'a/src/main.ts')] });
    await d.call('updateSnapshot', { openFiles: [{ uri: `file://${join(dir, 'b/x.ts')}` }] });
    const loose = await d.call('updateSnapshot', { openFiles: [join(dir, 'loose/y.ts')] });
    await d.call('getSourceFileNames', { snapshot: loose.snapshot, project: '/dev/null/inferred' });
    writeFileSync(join(dir, 'b/x.ts'), 'export const x: number = 2;\n');
    await d.call('updateSnapshot', { fileChanges: { changed: [join(dir, 'b/x.ts')] } });
    await d.call('updateSnapshot', { fileChanges: { invalidateAll: true } });
    await d.call('updateSnapshot', { closeFiles: [join(dir, 'loose/y.ts'), join(dir, 'a/src/main.ts')] });
  } finally {
    await d.close();
  }
  report(d);
});

// File contents are kept across snapshots: an edit is seen once the client reports the file, its real
// path (for a file read through a symbolic link in node_modules) or invalidateAll.
test(
  'tsc-ts --api reads changed files when the client reports them, like tsc --api',
  { skip, timeout: 300_000 },
  async () => {
    const dir = tempDir('tsc-ts-api-');
    writeFileSync(join(dir, 'base.json'), '{"compilerOptions":{"strict":true}}');
    writeFileSync(
      join(dir, 'tsconfig.json'),
      '{"extends":"./base.json","compilerOptions":{"types":[],"module":"nodenext"},"files":["a.ts","b.ts","c.ts"]}',
    );
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(
      join(dir, 'b.ts'),
      "import { a } from './a.js';\nimport { p } from 'pkg';\nexport const b = a + p;\n",
    );
    writeFileSync(join(dir, 'c.ts'), 'export function c(x) { return x; }\n');
    mkdirSync(join(dir, 'packages/pkg'), { recursive: true });
    writeFileSync(join(dir, 'packages/pkg/package.json'), '{"name":"pkg","types":"index.d.ts"}');
    writeFileSync(join(dir, 'packages/pkg/index.d.ts'), 'export declare const p: number;\n');
    writeFileSync(join(dir, 'packages/pkg/other.d.ts'), 'export declare const p: string;\n');
    mkdirSync(join(dir, 'node_modules'));
    symlinkSync(join(dir, 'packages/pkg'), join(dir, 'node_modules/pkg'));
    const d = new Differential([realTsc], tscTs, dir, env);
    try {
      await d.call('initialize');
      const config = join(dir, 'tsconfig.json');
      let update = await d.call('updateSnapshot', { openProjects: [config] });
      const project = update.projects[0].id;
      const query = async (snapshot) => {
        const base = { snapshot, project };
        await d.call('getSourceFileNames', base);
        for (const name of ['a.ts', 'b.ts', 'c.ts']) {
          await d.call('getSyntacticDiagnostics', { ...base, file: join(dir, name) });
          await d.call('getSemanticDiagnostics', { ...base, file: join(dir, name) });
        }
      };
      // a.ts changes without a report; b.ts is reported.
      writeFileSync(join(dir, 'a.ts'), 'export const a = ;\n');
      writeFileSync(
        join(dir, 'b.ts'),
        "import { a } from './a.js';\nimport { p } from 'pkg';\nexport const b = a + p + 1;\n",
      );
      update = await d.call('updateSnapshot', { fileChanges: { changed: [join(dir, 'b.ts')] } });
      await query(update.snapshot);
      update = await d.call('updateSnapshot', { fileChanges: { changed: [join(dir, 'a.ts')] } });
      await query(update.snapshot);
      // The package.json read through node_modules/pkg changes, reported by its real path.
      writeFileSync(join(dir, 'packages/pkg/package.json'), '{"name":"pkg","types":"other.d.ts"}');
      update = await d.call('updateSnapshot', { fileChanges: { changed: [join(dir, 'packages/pkg/package.json')] } });
      await query(update.snapshot);
      // The extended config changes.
      writeFileSync(join(dir, 'base.json'), '{"compilerOptions":{"strict":false}}');
      update = await d.call('updateSnapshot', { fileChanges: { changed: [join(dir, 'base.json')] } });
      await query(update.snapshot);
      // c.ts is deleted; then a.ts changes without a report, and invalidateAll rereads it.
      rmSync(join(dir, 'c.ts'));
      update = await d.call('updateSnapshot', { fileChanges: { deleted: [join(dir, 'c.ts')] } });
      await d.call('getProgramDiagnostics', { snapshot: update.snapshot, project });
      writeFileSync(join(dir, 'c.ts'), 'export function c(x: number) { return x; }\n');
      writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
      update = await d.call('updateSnapshot', { fileChanges: { invalidateAll: true } });
      await query(update.snapshot);
    } finally {
      await d.close();
    }
    report(d);
  },
);

// `await (legacy())` parses as a call of `await` until the file turns out to be a module, so
// its statement is reparsed in an await context; the statements around it are retained with
// the JSDoc parsed the first time, including `@deprecated`.
test(
  'tsc-ts --api keeps JSDoc of statements retained by top-level await reparsing',
  { skip, timeout: 300_000 },
  async () => {
    const dir = tempDir('tsc-ts-api-');
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          allowJs: true,
          checkJs: true,
          noEmit: true,
          strict: true,
          module: 'esnext',
          target: 'esnext',
          types: [],
        },
        files: ['main.js'],
      }),
    );
    const file = join(dir, 'main.js');
    const source = [
      '/**',
      ' * Computes the legacy value.',
      ' * @deprecated Use `current` instead.',
      ' * @returns {Promise<number>}',
      ' */',
      'export async function legacy() {',
      '  return 1;',
      '}',
      '',
      '/** @type {string} */',
      'export const label = 1;',
      '',
      '/** @deprecated Reparsed. */',
      'const value = await (legacy());',
      'legacy();',
      'value;',
      'export { value };',
      '',
    ].join('\n');
    writeFileSync(file, source);
    const d = new Differential([realTsc], tscTs, dir, env);
    try {
      await d.call('initialize');
      const update = await d.call('updateSnapshot', { openProjects: [join(dir, 'tsconfig.json')] });
      const base = { snapshot: update.snapshot, project: update.projects[0].id };
      await d.call('getSourceFile', { ...base, file });
      await d.call('getSyntacticDiagnostics', { ...base, file });
      await d.call('getSemanticDiagnostics', { ...base, file });
      const suggestions = await d.call('getSuggestionDiagnostics', { ...base, file });
      // The reference reports the deprecated calls, so the comparison is not vacuous.
      assert.ok(
        suggestions.some((s) => s.reportsDeprecated),
        `expected a deprecation suggestion from tsc: ${JSON.stringify(suggestions)}`,
      );
      const positions = Array.from({ length: source.length }, (_, i) => i);
      const symbols = new Map();
      for (const symbol of (await d.call('getSymbolsAtPositions', { ...base, file, positions })) ?? [])
        if (symbol !== null) symbols.set(symbol.id, symbol);
      let deprecatedTags = 0;
      for (const symbol of symbols.values()) {
        const tags = await d.call('getJsDocTags', { ...base, symbol: symbol.id });
        if (tags?.some((t) => t.name === 'deprecated')) deprecatedTags++;
        await d.call('getDocumentationComment', { ...base, symbol: symbol.id });
      }
      assert.ok(deprecatedTags > 0, 'expected tsc to report the @deprecated tag of legacy');
    } finally {
      await d.close();
    }
    report(d);
  },
);

// Completions at every position of each user file, and with symbols and trigger characters
// where a trigger character was just typed.
async function compareCompletions(d, base, file) {
  const text = readFileSync(file, 'utf8');
  for (let position = 0; position <= text.length; position++) {
    await d.call('getCompletionsAtPosition', { ...base, file, position });
    const before = text[position - 1];
    if (before !== undefined && '.\'"`<#@/ *'.includes(before)) {
      await d.call('getCompletionsAtPosition', { ...base, file, position, includeSymbol: true });
      await d.call('getCompletionsAtPosition', { ...base, file, position, triggerCharacter: before });
    }
  }
}

test('tsc-ts --api completes like tsc --api', { skip, timeout: 600_000 }, async () => {
  for (const fixture of ['completions', 'services', 'project']) {
    const dir = tempDir('tsc-ts-api-');
    cpSync(resolve('tests/fixtures', fixture), dir, { recursive: true });
    const d = new Differential([realTsc], tscTs, dir, env);
    try {
      await d.call('initialize');
      const update = await d.call('updateSnapshot', { openProjects: [join(dir, 'tsconfig.json')] });
      const base = { snapshot: update.snapshot, project: update.projects[0].id };
      for (const file of await d.call('getSourceFileNames', base))
        if (file.startsWith(dir)) await compareCompletions(d, base, file);
      await d.call('getCompletionsAtPosition', { ...base, file: join(dir, 'missing.ts'), position: 0 });
    } finally {
      await d.close();
    }
    console.log(`compared ${d.count} completions in ${fixture}`);
    report(d);
  }
});

for (const fixture of ['services', 'project']) {
  test(
    `tsc-ts --api answers language service queries like tsc --api (${fixture})`,
    { skip, timeout: 600_000 },
    async () => {
      const dir = tempDir('tsc-ts-api-');
      cpSync(resolve('tests/fixtures', fixture), dir, { recursive: true });
      const d = new Differential([realTsc], tscTs, dir, env);
      try {
        await d.call('initialize');
        const update = await d.call('updateSnapshot', { openProjects: [join(dir, 'tsconfig.json')] });
        const base = { snapshot: update.snapshot, project: update.projects[0].id };
        const files = [];
        for (const file of await d.call('getSourceFileNames', base)) {
          if (!file.startsWith(dir)) continue;
          const encoded = await d.call('getSourceFile', { ...base, file });
          files.push({ file, length: readFileSync(file, 'utf8').length, encoded });
        }
        const symbols = await exploreServices(d, base.snapshot, base.project, files);
        assert.ok(symbols > 100, `explored ${symbols} symbols`);
      } finally {
        await d.close();
      }
      console.log(`compared ${d.count} responses`);
      report(d);
    },
  );
}

test('tsc-ts runs tsc without --api', { skip, timeout: 300_000 }, () => {
  const dir = copyProject();
  const run = (command) => {
    try {
      return {
        status: 0,
        stdout: execFileSync(command[0], [...command.slice(1), '-p', '.'], {
          cwd: dir,
          env: { ...process.env, ...env },
        }).toString(),
      };
    } catch (e) {
      return { status: e.status, stdout: e.stdout.toString() };
    }
  };
  const expected = run([realTsc]);
  const actual = run(tscTs);
  // This is the CLI's erroneous noEmit project, not the API emit surface (#4407).
  assert.deepEqual([expected.status, actual.status], [1, 2]);
  assert.equal(actual.stdout, expected.stdout);
});
