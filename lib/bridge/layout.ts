/**
 * Struct offsets and packed bit fields of libghostty-vt, read from the module's type manifest.
 */

import type { AbiLayout, BitField } from '../abi';

export interface Layout {
  abi: AbiLayout;
  cell: {
    contentTag: BitField;
    codepoint: BitField;
    bgPalette: BitField;
    bgR: BitField;
    bgG: BitField;
    bgB: BitField;
    styleId: BitField;
    wide: BitField;
    hyperlink: BitField;
  };
  styleFlags: {
    bold: BitField;
    italic: BitField;
    faint: BitField;
    blink: BitField;
    inverse: BitField;
    invisible: BitField;
    strikethrough: BitField;
    underline: BitField;
    overline: BitField;
  };
  /** Size of a raw GhosttyCell, as stored in a row's cells view. */
  cellSize: number;
  style: { size: number; fg: number; bg: number; underline: number; flags: number };
  styleColor: { tag: number; value: number; r: number; g: number; b: number };
  cursor: {
    size: number;
    hasValue: number;
    x: number;
    y: number;
    visible: number;
    blinking: number;
    style: number;
  };
  colors: {
    size: number;
    bg: number;
    fg: number;
    cursor: number;
    hasCursor: number;
    palette: number;
  };
  point: { size: number; value: number; x: number; y: number };
  gridRef: number;
  cellsView: { size: number; ptr: number; len: number };
  modeConfig: { size: number; value: number };
  selection: { size: number; start: number; end: number; rectangle: number };
  coordinate: { size: number; x: number; y: number };
  geometry: {
    size: number;
    columns: number;
    cellWidth: number;
    paddingLeft: number;
    screenHeight: number;
  };
  surface: { size: number; x: number; y: number };
  writeStop: { size: number; consumed: number; reached: number };
  string: { size: number; ptr: number; len: number };
  rgb: { size: number; r: number; g: number; b: number };
  writer: { write: number; userdata: number };
  clipboardWrite: { location: number; contents: number; contentsLen: number; reply: number };
  clipboardContent: { size: number; mime: number; data: number };
  clipboardReply: { size: number; result: number; remember: number };
  notification: { title: number; body: number };
  progress: { state: number; progress: number };
  programStatus: {
    state: number;
    kind: number;
    progress: number;
    id: number;
    app: number;
    title: number;
    message: number;
  };
  semanticPrompt: {
    kind: number;
    promptKind: number;
    hasExitCode: number;
    exitCode: number;
    command: number;
    error: number;
  };
  sizeReport: { rows: number; columns: number; cellWidth: number; cellHeight: number };
  paste: {
    size: number;
    location: number;
    source: number;
    mimes: number;
    mimesLen: number;
    reader: number;
    allowUnsafe: number;
  };
  mimeReader: { read: number; userdata: number };
  mouseSize: {
    size: number;
    screenWidth: number;
    screenHeight: number;
    cellWidth: number;
    cellHeight: number;
  };
  mousePosition: { size: number; x: number; y: number };
  scrollbar: { size: number; total: number; offset: number; len: number };
  scrollViewport: { size: number; tag: number; delta: number; row: number };
  rowSelection: { size: number; startX: number; endX: number };
  selectionBuffer: { size: number; ptr: number; cap: number; len: number };
  codepointBuffer: { size: number; ptr: number; cap: number; len: number };
}

export function buildLayout(abi: AbiLayout): Layout {
  const cellBits = (f: string) => abi.bits('GhosttyCell', f);
  const content = (arm: string, inner: string) =>
    abi.unionBits('GhosttyCell', 'content', arm, inner);
  const flag = (f: string) => abi.bits('GhosttyStyleFlags', f);
  const at = (struct: string) => (field: string) => abi.offset(struct, field);
  const rgb = at('GhosttyColorRgb');
  const clip = at('GhosttyClipboardWrite');
  const status = at('GhosttyTerminalProgramStatus');
  const prompt = at('GhosttyTerminalSemanticPrompt');
  const sizeReport = at('GhosttySizeReportSize');
  const paste = at('GhosttyPaste');
  const mouseSize = at('GhosttyMouseEncoderSize');
  const scrollValue = abi.offset('GhosttyTerminalScrollViewport', 'value');
  const styleColorValue = abi.offset('GhosttyStyleColor', 'value');
  const styleColorRgb = styleColorValue + abi.offset('GhosttyStyleColorValue', 'rgb');
  return {
    abi,
    cell: {
      contentTag: cellBits('content_tag'),
      codepoint: content('CODEPOINT', 'codepoint'),
      bgPalette: content('BG_COLOR_PALETTE', 'index'),
      bgR: content('BG_COLOR_RGB', 'r'),
      bgG: content('BG_COLOR_RGB', 'g'),
      bgB: content('BG_COLOR_RGB', 'b'),
      styleId: cellBits('style_id'),
      wide: cellBits('wide'),
      hyperlink: cellBits('hyperlink'),
    },
    styleFlags: {
      bold: flag('bold'),
      italic: flag('italic'),
      faint: flag('faint'),
      blink: flag('blink'),
      inverse: flag('inverse'),
      invisible: flag('invisible'),
      strikethrough: flag('strikethrough'),
      underline: flag('underline'),
      overline: flag('overline'),
    },
    cellSize: abi.size('GhosttyCell'),
    styleColor: {
      tag: abi.offset('GhosttyStyleColor', 'tag'),
      value: styleColorValue + abi.offset('GhosttyStyleColorValue', 'palette'),
      r: styleColorRgb + rgb('r'),
      g: styleColorRgb + rgb('g'),
      b: styleColorRgb + rgb('b'),
    },
    style: {
      size: abi.size('GhosttyStyle'),
      fg: abi.offset('GhosttyStyle', 'fg_color'),
      bg: abi.offset('GhosttyStyle', 'bg_color'),
      underline: abi.offset('GhosttyStyle', 'underline_color'),
      flags: abi.offset('GhosttyStyle', 'flags'),
    },
    cursor: {
      size: abi.size('GhosttyRenderStateCursor'),
      hasValue: abi.offset('GhosttyRenderStateCursor', 'viewport_has_value'),
      x: abi.offset('GhosttyRenderStateCursor', 'viewport_x'),
      y: abi.offset('GhosttyRenderStateCursor', 'viewport_y'),
      visible: abi.offset('GhosttyRenderStateCursor', 'visible'),
      blinking: abi.offset('GhosttyRenderStateCursor', 'blinking'),
      style: abi.offset('GhosttyRenderStateCursor', 'visual_style'),
    },
    colors: {
      size: abi.size('GhosttyRenderStateColors'),
      bg: abi.offset('GhosttyRenderStateColors', 'background'),
      fg: abi.offset('GhosttyRenderStateColors', 'foreground'),
      cursor: abi.offset('GhosttyRenderStateColors', 'cursor'),
      hasCursor: abi.offset('GhosttyRenderStateColors', 'cursor_has_value'),
      palette: abi.offset('GhosttyRenderStateColors', 'palette'),
    },
    point: {
      size: abi.size('GhosttyPoint'),
      value: abi.offset('GhosttyPoint', 'value'),
      x: abi.offset('GhosttyPointCoordinate', 'x'),
      y: abi.offset('GhosttyPointCoordinate', 'y'),
    },
    gridRef: abi.size('GhosttyGridRef'),
    cellsView: {
      size: abi.size('GhosttyCellsView'),
      ptr: abi.offset('GhosttyCellsView', 'ptr'),
      len: abi.offset('GhosttyCellsView', 'len'),
    },
    modeConfig: {
      size: abi.size('GhosttyTerminalModeConfig'),
      value: abi.offset('GhosttyTerminalModeConfig', 'value'),
    },
    selection: {
      size: abi.size('GhosttySelection'),
      start: abi.offset('GhosttySelection', 'start'),
      end: abi.offset('GhosttySelection', 'end'),
      rectangle: abi.offset('GhosttySelection', 'rectangle'),
    },
    coordinate: {
      size: abi.size('GhosttyPointCoordinate'),
      x: abi.offset('GhosttyPointCoordinate', 'x'),
      y: abi.offset('GhosttyPointCoordinate', 'y'),
    },
    geometry: {
      size: abi.size('GhosttySelectionGestureGeometry'),
      columns: abi.offset('GhosttySelectionGestureGeometry', 'columns'),
      cellWidth: abi.offset('GhosttySelectionGestureGeometry', 'cell_width'),
      paddingLeft: abi.offset('GhosttySelectionGestureGeometry', 'padding_left'),
      screenHeight: abi.offset('GhosttySelectionGestureGeometry', 'screen_height'),
    },
    surface: {
      size: abi.size('GhosttySurfacePosition'),
      x: abi.offset('GhosttySurfacePosition', 'x'),
      y: abi.offset('GhosttySurfacePosition', 'y'),
    },
    writeStop: {
      size: abi.size('GhosttyTerminalWriteStop'),
      consumed: abi.offset('GhosttyTerminalWriteStop', 'consumed'),
      reached: abi.offset('GhosttyTerminalWriteStop', 'reached'),
    },
    string: {
      size: abi.size('GhosttyString'),
      ptr: abi.offset('GhosttyString', 'ptr'),
      len: abi.offset('GhosttyString', 'len'),
    },
    rgb: {
      size: abi.size('GhosttyColorRgb'),
      r: rgb('r'),
      g: rgb('g'),
      b: rgb('b'),
    },
    writer: {
      write: abi.offset('GhosttyWriter', 'write'),
      userdata: abi.offset('GhosttyWriter', 'userdata'),
    },
    clipboardWrite: {
      location: clip('location'),
      contents: clip('contents'),
      contentsLen: clip('contents_len'),
      reply: clip('reply'),
    },
    clipboardContent: {
      size: abi.size('GhosttyClipboardContent'),
      mime: abi.offset('GhosttyClipboardContent', 'mime'),
      data: abi.offset('GhosttyClipboardContent', 'data'),
    },
    clipboardReply: {
      size: abi.size('GhosttyClipboardWriteReply'),
      result: abi.offset('GhosttyClipboardWriteReply', 'result'),
      remember: abi.offset('GhosttyClipboardWriteReply', 'remember'),
    },
    notification: {
      title: abi.offset('GhosttyTerminalDesktopNotification', 'title'),
      body: abi.offset('GhosttyTerminalDesktopNotification', 'body'),
    },
    progress: {
      state: abi.offset('GhosttyTerminalProgressReport', 'state'),
      progress: abi.offset('GhosttyTerminalProgressReport', 'progress'),
    },
    programStatus: {
      state: status('state'),
      kind: status('kind'),
      progress: status('progress'),
      id: status('id'),
      app: status('app'),
      title: status('title'),
      message: status('message'),
    },
    semanticPrompt: {
      kind: prompt('kind'),
      promptKind: prompt('prompt_kind'),
      hasExitCode: prompt('has_exit_code'),
      exitCode: prompt('exit_code'),
      command: prompt('command'),
      error: prompt('error'),
    },
    sizeReport: {
      rows: sizeReport('rows'),
      columns: sizeReport('columns'),
      cellWidth: sizeReport('cell_width'),
      cellHeight: sizeReport('cell_height'),
    },
    paste: {
      size: abi.size('GhosttyPaste'),
      location: paste('location'),
      source: paste('source'),
      mimes: paste('mimes'),
      mimesLen: paste('mimes_len'),
      reader: paste('reader'),
      allowUnsafe: paste('allow_unsafe'),
    },
    mimeReader: {
      read: abi.offset('GhosttyMimeReader', 'read'),
      userdata: abi.offset('GhosttyMimeReader', 'userdata'),
    },
    mouseSize: {
      size: abi.size('GhosttyMouseEncoderSize'),
      screenWidth: mouseSize('screen_width'),
      screenHeight: mouseSize('screen_height'),
      cellWidth: mouseSize('cell_width'),
      cellHeight: mouseSize('cell_height'),
    },
    mousePosition: {
      size: abi.size('GhosttyMousePosition'),
      x: abi.offset('GhosttyMousePosition', 'x'),
      y: abi.offset('GhosttyMousePosition', 'y'),
    },
    scrollbar: {
      size: abi.size('GhosttyTerminalScrollbar'),
      total: abi.offset('GhosttyTerminalScrollbar', 'total'),
      offset: abi.offset('GhosttyTerminalScrollbar', 'offset'),
      len: abi.offset('GhosttyTerminalScrollbar', 'len'),
    },
    scrollViewport: {
      size: abi.size('GhosttyTerminalScrollViewport'),
      tag: abi.offset('GhosttyTerminalScrollViewport', 'tag'),
      delta: scrollValue + abi.offset('GhosttyTerminalScrollViewportValue', 'delta'),
      row: scrollValue + abi.offset('GhosttyTerminalScrollViewportValue', 'row'),
    },
    rowSelection: {
      size: abi.size('GhosttyRenderStateRowSelection'),
      startX: abi.offset('GhosttyRenderStateRowSelection', 'start_x'),
      endX: abi.offset('GhosttyRenderStateRowSelection', 'end_x'),
    },
    selectionBuffer: {
      size: abi.size('GhosttySelectionBuffer'),
      ptr: abi.offset('GhosttySelectionBuffer', 'ptr'),
      cap: abi.offset('GhosttySelectionBuffer', 'cap'),
      len: abi.offset('GhosttySelectionBuffer', 'len'),
    },
    codepointBuffer: {
      size: abi.size('GhosttyCodepointBuffer'),
      ptr: abi.offset('GhosttyCodepointBuffer', 'ptr'),
      cap: abi.offset('GhosttyCodepointBuffer', 'cap'),
      len: abi.offset('GhosttyCodepointBuffer', 'len'),
    },
  };
}
