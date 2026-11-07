/** Colors of the fixture terminal, shared by the page and the specs that read its pixels. */
export const THEME = {
  background: '#000000',
  foreground: '#ffffff',
  cursor: '#00ff00',
  cursorAccent: '#ff00ff',
  selectionBackground: '#3366ff',
  selectionForeground: '#ffff00',
};

/** The fixture's `theme=light` colors. */
export const LIGHT_THEME = {
  ...THEME,
  background: '#ffffff',
  foreground: '#000000',
};

/** The fixture's `theme=transparent` colors: the page shows through the default background. */
export const TRANSPARENT_THEME = {
  ...THEME,
  background: 'rgba(0, 0, 0, 0)',
};

/** The underline drawn under a hovered link (lib/renderer.ts). */
export const LINK_COLOR = '#4a90e2';
