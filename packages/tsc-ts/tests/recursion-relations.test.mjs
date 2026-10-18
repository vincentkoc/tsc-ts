// TypeScript-Go #4913 changes deep relation behavior relative to the 7.0.2 oracle.
// Keep explicit expectations and negative controls; TSC_TS_BIN also runs these against newer upstream builds.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { tempDir } from './temp.mjs';
import { tscTs, tscTsMissing } from './toolchain.mjs';

const libs = resolve('../../upstream/typescript-go/internal/bundled/libs');

// Upstream veryDeepRelations.ts: two 40-interface cycles exceed the relation depth backstop.
function recursiveRelations(incompatibleAt = -1) {
  const declarations = [];
  for (const prefix of ['A', 'B']) {
    for (let i = 0; i < 40; i++) {
      const nameType = prefix === 'B' && i === incompatibleAt ? 'number' : 'string';
      declarations.push(
        'interface ' + prefix + i + ' { name: ' + nameType + '; next?: ' + prefix + ((i + 1) % 40) + '[]; }',
      );
    }
  }
  return [...declarations, 'declare const a: A0;', 'const assigned: B0 = a;', 'export {};'].join('\n');
}

// Exact upstream excessivelyDeepConditionalTypes.ts, with its indexed accesses and default constraint.
const conditionalSource = [
  '// @noEmit: true',
  '// @noErrorTruncation: false',
  '',
  '// https://github.com/microsoft/typescript-go/issues/2917',
  '',
  'export type FlattenKeys<O> = {',
  '\t[K in keyof O & (string | number)]: O[K] extends Record<any, any>',
  '\t\t? K | `${K}.${FlattenKeys<O[K]>}`',
  '\t\t: K;',
  '}[O extends readonly any[]',
  '\t? keyof O & `${number}`',
  '\t: keyof O & (string | number)];',
  '',
  "export type KeySeparator = '.' | '[' | ']';",
  '',
  'export type GetByString<',
  '\tData,',
  '\tPath extends string | number = FlattenKeys<Data>,',
  "> = Path extends `__proto__${`${KeySeparator}${string | number}` | ''}`",
  '\t? never',
  '\t: Path extends `${KeySeparator}${infer Rest}`',
  '\t\t? GetByString<Data, Rest>',
  '\t\t: Path extends `${infer Rest}${KeySeparator}`',
  '\t\t\t? GetByString<Data, Rest>',
  '\t\t\t: Path extends `${infer Key extends keyof Data & (string | number)}${KeySeparator}${infer Rest}`',
  '\t\t\t\t? GetByString<Data[Key], Rest>',
  '\t\t\t\t: Path extends keyof Data & (string | number)',
  '\t\t\t\t\t? Data[Path]',
  '\t\t\t\t\t: undefined;',
  '',
  'interface Duck {',
  '\ttaxonomy: {',
  "\t\tgenus: 'anas';",
  "\t\tspecies: 'platyrhynchos';",
  '\t};',
  '}',
  '',
  "type DuckSpecies = GetByString<Duck, 'taxonomy.species'>; // 'platyrhynchos'",
].join('\n');

const cases = [
  { name: 'deep-recursive-relations', source: recursiveRelations(), codes: [] },
  {
    name: 'deep-conditional-types',
    source: conditionalSource + '\nexport const species: DuckSpecies = "platyrhynchos";',
    codes: [],
  },
  {
    name: 'conditional-literal-control',
    source: conditionalSource + '\nexport const species: DuckSpecies = "anser";',
    codes: [2322],
    errorAt: 'export const species:',
  },
  { name: 'shallow-recursive-mismatch', source: recursiveRelations(0), codes: [2322], errorAt: 'const assigned:' },
  { name: 'mid-cycle-recursive-mismatch', source: recursiveRelations(10), codes: [2322], errorAt: 'const assigned:' },
  {
    name: 'finite-mapped-indexed-mismatch',
    source: `type Lookup<T> = { item: T }["item"];
type Copy<T> = { [K in keyof T]: Lookup<T[K]> };
type Source = Copy<{ box: Copy<{ box: Copy<{ value: string }> }> }>;
type Target = Copy<{ box: Copy<{ box: Copy<{ value: number }> }> }>;
declare const source: Source;
export const valid: Copy<{ box: Copy<{ box: Copy<{ value: string }> }> }> = source;
export const invalid: Target = source;`,
    codes: [2322],
    errorAt: 'export const invalid:',
  },
  {
    name: 'finite-mapped-intersection-mismatch',
    source: `type Copy<T> = { [K in keyof T]: T[K] };
type Source = Copy<{ box: Copy<{ box: Copy<{ value: string } & { tag: boolean }> } & { tag: boolean }> }>;
type Target = Copy<{ box: Copy<{ box: Copy<{ value: number } & { tag: boolean }> } & { tag: boolean }> }>;
declare const source: Source;
export const valid: Copy<{ box: Copy<{ box: Copy<{ value: string } & { tag: boolean }> } & { tag: boolean }> }> = source;
export const invalid: Target = source;`,
    codes: [2322],
    errorAt: 'export const invalid:',
  },
  {
    name: 'reverse-mapped-inference',
    source: `type Boxed<T> = { [K in keyof T]: { value: T[K] } };
declare function unwrap<T>(value: Boxed<T>): T;
const result = unwrap({ item: { value: { nested: { text: "ok" } } }, count: { value: 1 } });
export const text: string = result.item.nested.text;
export const count: number = result.count;
export const invalid: number = result.item.nested.text;`,
    codes: [2322],
    errorAt: 'export const invalid:',
  },
  {
    name: 'small-generic-assertion-control',
    source: `type Request = { kind: "a"; value: string } | { kind: "b"; value: number };
export function prepare<K extends Request["kind"], Input extends object>(kind: K, input: Input) {
  return { kind, ...input } as Extract<Request, { kind: K }>;
}`,
    codes: [2352],
    errorAt: '  return { kind, ...input }',
  },
];

const project = tempDir('tsc-ts-recursion-relations-');
for (const { name, source } of cases) writeFileSync(join(project, name + '.ts'), source + '\n');
writeFileSync(
  join(project, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', types: [], noEmit: true },
    files: cases.map(({ name }) => name + '.ts'),
  }),
);

for (const sideState of ['0', '1']) {
  test(
    'deep relations with side state ' + sideState,
    { skip: tscTsMissing || (!existsSync(libs) && 'needs upstream sources'), timeout: 120_000 },
    () => {
      const result = spawnSync(tscTs[0], [...tscTs.slice(1), '-p', project, '--pretty', 'false'], {
        cwd: project,
        encoding: 'utf8',
        timeout: 110_000,
        env: { ...process.env, TSC_TS_LIB_DIR: libs, TSC_TS_SIDE_STATE: sideState },
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.ok(result.status === 1 || result.status === 2, 'expected diagnostic exit, not a crash');
      assert.equal(result.stderr, '');
      const diagnostics = result.stdout.split('\n').filter((line) => /error TS\d+:/.test(line));
      assert.equal(
        diagnostics.length,
        cases.reduce((sum, { codes }) => sum + codes.length, 0),
        result.stdout,
      );
      for (const { name, source, codes, errorAt } of cases) {
        const sourceLines = source.split('\n');
        if (codes.length) assert.equal(sourceLines.filter((line) => line.includes(errorAt)).length, 1);
        const expected = codes.map((code) => ({
          code,
          line: sourceLines.findIndex((line) => line.includes(errorAt)) + 1,
        }));
        const lines = diagnostics.filter((line) => line.includes(name + '.ts('));
        assert.deepEqual(
          lines.map((line) => ({
            code: Number(line.match(/error TS(\d+):/)[1]),
            line: Number(line.match(/\.ts\((\d+),/)[1]),
          })),
          expected,
          name + '\n' + result.stdout,
        );
      }
    },
  );
}
