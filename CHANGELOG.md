# Changelog

## Unreleased

### Fixes

- Match TypeScript-Go #4913 when comparing deeply nested types: resolve indexed-access and mapped-type recursion identities consistently, and keep depth-limit comparisons provisional. This avoids false assertion errors for generic prepared-input unions while preserving complexity limits.
- Preserve regular literal types when narrowing uniform primitive unions, matching TypeScript-Go #4781. This keeps optional string properties narrowed after copying them into mutable objects, without changing mixed-enum or loose-equality behavior.

<!-- release:start -->

## 0.0.2

### Fixes

- **Linux glibc compatibility:** ARM64 and x64 packages now target glibc 2.34 and newer, fixing startup failures on distributions such as Debian 12.

### Improvements

- Emit files skipped by type checking, such as `// @ts-nocheck` files, while checker threads check other files.
- Batch diagnostic output and reuse each file's relative path during formatting.
- Flatten the documentation sidebar into a single level.
- Publish GitHub releases with changelog notes and all eight npm package archives after npm publishing succeeds.

<!-- release:end -->

## 0.0.1

Initial release of **tsc-ts**, a Vercel Labs experiment: the TypeScript 7.0.2 compiler ported to TypeScript and compiled to native code with [scriptc](https://scriptc.dev).

### Features

- **The `tsc-ts` command line** type-checks projects and emits JavaScript and declaration files using `tsconfig.json`, with support for incremental builds, project references, and watch mode.
- **The `--api` server** provides the TypeScript 7.0.2 compiler API over stdin and stdout for tools that use `tsc --api`.
- **Native npm packages** support macOS ARM64 and x64, Linux ARM64 and x64 with glibc or musl, and Windows x64. The `tsc-ts` launcher selects the package for the host platform.

### Installation

```sh
npm install --save-dev tsc-ts
npx tsc-ts -p tsconfig.json
```
