// Internal emit ownership: whole-program noEmit differs from targeted and forced emit.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { compileSources, tempDir } from './temp.mjs';

const out = compileSources('tsc-ts-program-noemit-', ['main.ts']);
const load = (name) => import(pathToFileURL(join(out, name)).href);
const { createNodeSystem } = await load('drivers/node-system.js');
const { executeCommandLine } = await load('compiler/tsc-cli.js');
const { CheckedProgram, CompileTimes, OutputWriter, PlainProgram, getDiagnosticsOfProgram } =
  await load('compiler/compile-program.js');
const { IncrementalProgram } = await load('compiler/incremental.js');
const { SystemTimeStamps } = await load('compiler/tsc-compile.js');
const libs = resolve('../../upstream/typescript-go/internal/bundled/libs');

class Writer extends OutputWriter {
  failed = false;
  outputs = [];
  write(fileName, text) {
    if (this.failed) return 'test write failure';
    this.outputs.push({ fileName, text });
    return '';
  }
}

function program(incremental, source = 'export const value = 1;\n') {
  const cwd = tempDir('tsc-ts-program-noemit-case-');
  writeFileSync(join(cwd, 'index.ts'), source);
  writeFileSync(
    join(cwd, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        declaration: true,
        types: [],
        incremental,
        ...(incremental ? { tsBuildInfoFile: './cache.tsbuildinfo' } : {}),
      },
      files: ['index.ts'],
    }),
  );
  const sys = createNodeSystem(libs, '');
  const work = executeCommandLine(sys, ['-p', cwd]);
  assert.equal(work.kind, 'compile');
  const checked = new CheckedProgram(work.program);
  return incremental
    ? new IncrementalProgram(checked, new CompileTimes(), undefined, new SystemTimeStamps(sys))
    : new PlainProgram(checked, new CompileTimes());
}

test('targeted noEmit stays skipped and forced declarations still emit', () => {
  const compiled = program(false);
  assert.deepEqual(getDiagnosticsOfProgram(compiled, false), []);
  const file = compiled.program.getSourceFiles().find((file) => file.fileName.endsWith('/index.ts'));
  assert.ok(file);
  const writer = new Writer();
  // EmitOnly.All = 0, EmitOnly.ForcedDts = 3 (const enum).
  assert.equal(compiled.emitter.emit([file], 0, writer).emitSkipped, true);
  assert.deepEqual(writer.outputs, []);
  assert.equal(compiled.emitter.emit([file], 3, writer).emitSkipped, false);
  assert.equal(writer.outputs.length, 1);
  assert.match(writer.outputs[0].fileName, /index\.d\.ts$/);
  assert.match(writer.outputs[0].text, /export declare const value = 1;/);
  const wholeWriter = new Writer();
  assert.equal(compiled.emit(wholeWriter).emitSkipped, false);
  assert.deepEqual(wholeWriter.outputs, []);
});

test('noEmit declaration diagnostics survive whole-program emit completion', () => {
  for (const incremental of [false, true]) {
    const compiled = program(incremental, 'export const value = class { private member = 1; };\n');
    assert.deepEqual(
      getDiagnosticsOfProgram(compiled, false).map((d) => d.code),
      [4094],
    );
    const writer = new Writer();
    assert.equal(compiled.emit(writer).emitSkipped, false);
    assert.ok(writer.outputs.every((output) => output.fileName.endsWith('.tsbuildinfo')));
  }
});

test('failed noEmit build info retains pending state for retry on the same program', () => {
  const compiled = program(true);
  assert.deepEqual(getDiagnosticsOfProgram(compiled, false), []);
  const writer = new Writer();
  writer.failed = true;
  const failed = compiled.emit(writer);
  assert.equal(failed.emitSkipped, true);
  assert.deepEqual(
    failed.diagnostics.map((d) => d.code),
    [5033],
  );
  assert.deepEqual(failed.emittedFiles, []);
  assert.equal(compiled.lastBuildInfo, undefined);
  writer.failed = false;
  const retried = compiled.emit(writer);
  assert.equal(retried.emitSkipped, false);
  assert.deepEqual(retried.diagnostics, []);
  assert.equal(retried.emittedFiles.length, 1);
  assert.equal(writer.outputs.length, 1);
  assert.ok(compiled.lastBuildInfo);
  assert.ok(JSON.parse(writer.outputs[0].text).fileNames.length > 0);
  const unchanged = compiled.emit(writer);
  assert.equal(unchanged.emitSkipped, false);
  assert.deepEqual(unchanged.emittedFiles, []);
  assert.equal(writer.outputs.length, 1);
});
