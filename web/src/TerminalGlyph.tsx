import { HardwareSprite } from "./HardwareSprite";

/** A software window, visually separate from device hardware. */
export function TerminalGlyph({ small = false }: { small?: boolean }) {
  return (
    <HardwareSprite
      kind="terminal"
      className={`terminal-glyph ${small ? "small" : ""}`}
      size={small ? 38 : 48}
    />
  );
}
