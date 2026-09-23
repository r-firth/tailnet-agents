import type { TerminalResources } from "./terminal-session";
let runtime: Promise<typeof import("ghostty-web")> | undefined;
function loadRuntime() {
  return (runtime ??= (async () => {
    const module = await import("ghostty-web");
    await module.init();
    return module;
  })().catch((error) => {
    runtime = undefined;
    throw error;
  }));
}
export async function createGhosttyTerminal(): Promise<TerminalResources> {
  const [{ Terminal, FitAddon }] = await Promise.all([
    loadRuntime(),
    document.fonts.load('14px "IBM Plex Mono"'),
    document.fonts.load('bold 14px "IBM Plex Mono"'),
    document.fonts.load('italic 14px "IBM Plex Mono"'),
    // FontFaceSet.load defaults to a space; request PUA glyphs explicitly.
    document.fonts.load(
      '14px "Symbols Nerd Font Mono"',
      "\ue0b0\uf120\uf07c\uf179",
    ),
  ]);
  const terminal = new Terminal({
    fontFamily: '"IBM Plex Mono", "Symbols Nerd Font Mono", monospace',
    fontSize: 14,
    cursorBlink: true,
    cursorStyle: "bar",
    scrollback: 10000,
    theme: {
      background: "#101011",
      foreground: "#ede9e3",
      cursor: "#fb9760",
      selectionBackground: "#ffffff22",
      black: "#22241f",
      red: "#ee8a77",
      green: "#99c998",
      yellow: "#e3c18a",
      blue: "#86b5da",
      magenta: "#c7a4cb",
      cyan: "#8dc5c2",
      white: "#dedfd5",
    },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  return { terminal, fit };
}
