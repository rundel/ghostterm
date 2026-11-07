/**
 * Checks the build output in dist/ (run at the end of `bun run build`).
 *
 * - dist/index.d.ts compiles on its own with strict settings and no skipLibCheck, so a public
 *   declaration that names a stripped @internal one fails here.
 * - scripts/dist-consumer.ts compiles against it: the public API is there, the internals are not.
 * - dist/ghostterm.js inlines ghostty-vt.wasm; dist/ghostterm-slim.js does not, and loads the
 *   ghostty-vt.wasm next to it by URL. Both wasm builds are shipped.
 *
 *   bun scripts/check-dist.ts
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const root = path.join(import.meta.dir, '..');
const dist = path.join(root, 'dist');

const INLINE_WASM = 'data:application/wasm;base64,';
// "\0asm" in base64, the start of any inlined module whatever its data: prefix.
const WASM_BASE64_MAGIC = 'AGFzbQ';
const SLIM_WASM_URL = /new URL\(\s*"\.\/ghostty-vt\.wasm",\s*import\.meta\.url\s*\)/;

const failures: string[] = [];

function fail(message: string): void {
  failures.push(message);
}

function distFile(name: string): string | null {
  const file = path.join(dist, name);
  if (existsSync(file)) return file;
  fail(`dist/${name} is missing`);
  return null;
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
  const dts = distFile('index.d.ts');
  if (!dts) return;
  for (const message of compile([dts])) fail(`dist/index.d.ts: ${message}`);
  for (const message of compile([path.join(root, 'scripts', 'dist-consumer.ts')])) {
    fail(`scripts/dist-consumer.ts: ${message}`);
  }
}

function checkBundles(): void {
  distFile('ghostty-vt.wasm');
  distFile('ghostty-vt-fast.wasm');

  const main = distFile('ghostterm.js');
  if (main && !readFileSync(main, 'utf8').includes(INLINE_WASM)) {
    fail('dist/ghostterm.js does not inline ghostty-vt.wasm');
  }

  const slim = distFile('ghostterm-slim.js');
  if (!slim) return;
  const code = readFileSync(slim, 'utf8');
  if (code.includes(WASM_BASE64_MAGIC) || code.includes('data:application/wasm')) {
    fail('dist/ghostterm-slim.js contains an inlined wasm module');
  }
  if (!SLIM_WASM_URL.test(code)) {
    fail('dist/ghostterm-slim.js has no new URL("./ghostty-vt.wasm", import.meta.url)');
  }
  if (code.includes('@vite-ignore')) {
    fail("dist/ghostterm-slim.js still has @vite-ignore, which hides the URL from apps' bundlers");
  }
}

/**
 * Load the slim bundle from a directory where `ghostty-vt.wasm` is a copy of the fast build: an
 * init() that reports release-fast read the file next to the bundle by URL (the fallback paths
 * would find the repo's size-optimized build).
 */
async function checkSlimLoads(): Promise<void> {
  const slim = path.join(dist, 'ghostterm-slim.js');
  const fast = path.join(dist, 'ghostty-vt-fast.wasm');
  if (!existsSync(slim) || !existsSync(fast)) return;
  const dir = mkdtempSync(path.join(tmpdir(), 'ghostterm-slim-'));
  try {
    copyFileSync(slim, path.join(dir, 'ghostterm-slim.js'));
    copyFileSync(fast, path.join(dir, 'ghostty-vt.wasm'));
    const mod = await import(path.join(dir, 'ghostterm-slim.js'));
    await mod.init();
    const ghostty = await mod.Ghostty.load();
    if (ghostty.optimizeMode !== 'release-fast') {
      fail(`the slim bundle loaded ${ghostty.optimizeMode}, not the ghostty-vt.wasm next to it`);
    }
    const term = ghostty.createTerminal(20, 2);
    term.write('slim');
    const cells: { codepoint: number }[] = term.getLine(0) ?? [];
    const line = String.fromCodePoint(...cells.map((c) => c.codepoint || 32)).trimEnd();
    term.free();
    if (line !== 'slim') fail(`a terminal from the slim bundle read back ${JSON.stringify(line)}`);
  } catch (error) {
    fail(`the slim bundle failed to load: ${error instanceof Error ? error.message : error}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  checkTypings();
  checkBundles();
  await checkSlimLoads();
  if (failures.length) {
    console.error(`dist/ check failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('✓ dist/ check passed');
}
