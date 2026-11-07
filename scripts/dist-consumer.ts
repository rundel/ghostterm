/**
 * A consumer of the published typings, compiled against dist/index.d.ts by scripts/check-dist.ts
 * (it is not part of `bun run typecheck`, since dist/ may not exist). It uses the public API, so
 * a type that is missing from the rollup fails the check, and expects the @internal members to be
 * gone.
 */

import {
  FitAddon,
  Ghostty,
  type IBufferLine,
  type ITerminalOptions,
  type ITheme,
  SearchAddon,
  SerializeAddon,
  Terminal,
  init,
} from '../dist/index';

export async function consumer(element: HTMLElement): Promise<string> {
  await init({ wasmPath: '/ghostty-vt.wasm' });
  const theme: ITheme = { background: '#000000', foreground: '#ffffff' };
  const options: ITerminalOptions = { cols: 80, rows: 24, theme };
  const term = new Terminal(options);
  const fit = new FitAddon();
  const search = new SearchAddon();
  const serialize = new SerializeAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(serialize);
  term.open(element);
  fit.fit();
  term.onData((data: string) => term.write(data));
  search.findNext('needle');
  const line: IBufferLine | undefined = term.buffer.active.getLine(0);

  // @ts-expect-error internal (for FitAddon)
  term.getMetrics();
  // @ts-expect-error internal (for FitAddon)
  term.setScrollbarGutter(0);
  // @ts-expect-error internal (for SearchAddon)
  term.setHighlightProvider(undefined);
  // @ts-expect-error internal
  term.scrollToViewportOffset(0);
  // @ts-expect-error internal
  term.viewportRowToBufferRow(0);

  const ghostty = await Ghostty.load();
  // @ts-expect-error internal
  ghostty.callTable(0);

  return (line?.translateToString() ?? '') + serialize.serialize();
}
