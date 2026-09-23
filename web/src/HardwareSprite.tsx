const cells = {
  laptop: [0, 0],
  tower: [1, 0],
  server: [2, 0],
  board: [0, 1],
  coordinator: [1, 1],
  terminal: [2, 1],
} as const;

/** Fixed intrinsic bounds keep pixel artwork safe before the stylesheet loads. */
export function HardwareSprite({
  kind,
  className = "",
  size = 48,
}: {
  kind: keyof typeof cells;
  className?: string;
  size?: number;
}) {
  const [column, row] = cells[kind];
  return (
    <svg
      className={`hardware-sprite ${className}`}
      width={size}
      height={size}
      viewBox="48 48 416 416"
      overflow="hidden"
      aria-hidden="true"
    >
      <image
        href="/art/hardware-atlas.png"
        x={-column * 512}
        y={-row * 512}
        width={1536}
        height={1024}
      />
    </svg>
  );
}
