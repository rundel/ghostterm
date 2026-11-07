/**
 * Checks the build output in dist/ (run at the end of `bun run build`).
 *
 * - dist/index.d.ts compiles on its own with strict settings and no skipLibCheck, so a public
 *   declaration that names a stripped @internal one fails here.
 * - scripts/dist-consumer.ts compiles against it: the public API is there, the internals are not.
 *
 *   bun scripts/check-dist.ts
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.join(import.meta.dir, '..');
const dist = path.join(root, 'dist');

const failures: string[] = [];

function fail(message: string): void {
  failures.push(message);
}

function requireFile(name: string): string {
  const file = path.join(dist, name);
  if (!existsSync(file)) fail(`dist/${name} is missing`);
  return file;
}

/** Compile `files` with strict consumer settings; returns the formatted diagnostics. */
function compile(files: string[]): string[] {
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    skipLibCheck: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
  };
  const program = ts.createProgram(files, options);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const text = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    if (!d.file || d.start === undefined) return text;
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${path.relative(root, d.file.fileName)}:${line + 1}:${character + 1} ${text}`;
  });
}

function checkTypings(): void {
  const dts = requireFile('index.d.ts');
  if (!existsSync(dts)) return;
  for (const message of compile([dts])) fail(`dist/index.d.ts: ${message}`);
  for (const message of compile([path.join(root, 'scripts', 'dist-consumer.ts')])) {
    fail(`scripts/dist-consumer.ts: ${message}`);
  }
}

if (import.meta.main) {
  checkTypings();
  if (failures.length) {
    console.error(`dist/ check failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('✓ dist/ check passed');
}
