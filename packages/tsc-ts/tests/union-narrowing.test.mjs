// TypeScript-Go #4781 deliberately differs from the 7.0.2 oracle on fresh literals.
// These cases also run against an exact newer compiler with TSC_TS_BIN.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { tempDir } from './temp.mjs';
import { tscTs, tscTsMissing } from './toolchain.mjs';

const libs = resolve('../../upstream/typescript-go/internal/bundled/libs');
const cases = [
  {
    name: 'optional-string',
    source: `declare function accept(x: { status: "ok" | "failed" }): void;
export function record(opts: { status?: string }) {
  if (opts.status !== "ok" && opts.status !== "failed") throw 0;
  const outcome = { status: opts.status };
  accept(outcome);
}`,
    codes: [],
  },
  {
    name: 'optional-string-spreads',
    source: `declare function accept(x: { kind: "external"; status: "ok" | "failed"; bytes?: number }): void;
export function record(opts: { status?: string; bytes?: number }) {
  if (opts.status !== "ok" && opts.status !== "failed") throw 0;
  const outcome = { kind: "external" as const, status: opts.status,
    ...(opts.bytes !== undefined ? { bytes: opts.bytes } : {}) };
  accept(outcome);
}`,
    codes: [],
  },
  {
    name: 'required-string-control',
    source: `declare function accept(x: { status: "ok" | "failed" }): void;
export function record(opts: { status: string }) {
  if (opts.status !== "ok" && opts.status !== "failed") throw 0;
  const outcome = { status: opts.status };
  accept(outcome);
}`,
    codes: [2345],
  },
  {
    name: 'loose-equality-control',
    source: `declare function accept(x: { status: "ok" }): void;
export function record(opts: { status?: string }) {
  if (opts.status == "ok") {
    const outcome = { status: opts.status };
    accept(outcome);
  }
}`,
    codes: [2345],
  },
  {
    name: 'optional-number',
    source: `export function record(value: number | undefined) {
  if (value !== 1) return;
  const outcome = { value };
  const copy: { value: 1 } = outcome;
  return copy;
}`,
    codes: [],
  },
  {
    name: 'optional-bigint',
    source: `export function record(value: bigint | undefined) {
  if (value !== 1n) return;
  const outcome = { value };
  const copy: { value: 1n } = outcome;
  return copy;
}`,
    codes: [],
  },
  {
    name: 'switch-and-default',
    source: `export function record(value: string | undefined) {
  switch (value) {
    case "ok": {
      const outcome = { value };
      const copy: { value: "ok" } = outcome;
      return copy;
    }
    default: {
      const remaining: string | undefined = value;
      return remaining;
    }
  }
}`,
    codes: [],
  },
  {
    name: 'same-enum',
    source: `enum E { A = 1, B = 2 }
export function record(value: E | undefined) {
  if (value === E.A) {
    const outcome = { value };
    const copy: { value: E.A } = outcome;
    return copy;
  }
  const remaining: E.B | undefined = value;
  return remaining;
}`,
    codes: [],
  },
  {
    name: 'enum-and-literal',
    source: `enum E { A = 1, B = 2 }
export function record(value: E | 1 | 2) {
  if (value === E.A) { const witness: never = value; return witness; }
  const remaining: 2 | E.B = value;
  return remaining;
}`,
    codes: [2322],
    type: /Type '1 \| E\.A'/,
  },
  {
    name: 'mixed-enums',
    source: `namespace N1 { export enum E { A = 1, B = 2 } }
namespace N2 { export enum E { A = 1, B = 2 } }
export function record(value: N1.E | N2.E) {
  if (value === N1.E.A) { const witness: never = value; return witness; }
  const remaining: N1.E.B | N2.E.B = value;
  return remaining;
}`,
    codes: [2322],
    type: /Type '(?:N1\.E\.A \| N2\.E\.A|E\.A \| E\.A)'/,
  },
  {
    name: 'mixed-enum-switch',
    source: `namespace N1 { export enum E { A = 1, B = 2 } }
namespace N2 { export enum E { A = 1, B = 2 } }
export function record(value: N1.E | N2.E) {
  switch (value) {
    case N1.E.A: { const witness: never = value; return witness; }
    default: { const remaining: N1.E.B | N2.E.B = value; return remaining; }
  }
}`,
    codes: [2322],
    type: /Type '(?:N1\.E\.A \| N2\.E\.A|E\.A \| E\.A)'/,
  },
  {
    name: 'symbol-control',
    source: `const sym = Symbol();
export function record(value: symbol | string) {
  if (value === sym) { const witness: never = value; return witness; }
}
export function switched(value: symbol | string) {
  switch (value) {
    case sym: { const witness: never = value; return witness; }
  }
}`,
    codes: [2322, 2322],
    type: /Type 'symbol'/,
  },
  {
    name: 'literal-exclusion',
    source: `type Choice = "a" | "b" | "c";
export function record(value: Choice | undefined) {
  if (value === "a") return;
  const remaining: "b" | "c" | undefined = value;
  return remaining;
}`,
    codes: [],
  },
];

const project = tempDir('tsc-ts-uniform-unions-');
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
    'uniform union narrowing with side state ' + sideState,
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
      const expectedCount = cases.reduce((sum, { codes }) => sum + codes.length, 0);
      assert.equal(diagnostics.length, expectedCount, result.stdout);
      for (const { name, codes, type } of cases) {
        const lines = diagnostics.filter((line) => line.includes(name + '.ts('));
        assert.deepEqual(
          lines.map((line) => Number(line.match(/error TS(\d+):/)[1])),
          codes,
          name,
        );
        // Enum qualification differs between printers; both member types must remain.
        if (type) assert.match(lines.join('\n'), type, name);
      }
    },
  );
}
