import { HardwareSprite } from "./HardwareSprite";

export function DeviceArt({
  small = false,
  active = true,
  os = "",
  name = "",
}: {
  small?: boolean;
  active?: boolean;
  os?: string;
  name?: string;
}) {
  const kind =
    os === "macOS"
      ? "laptop"
      : /\bpi\d|raspberry/i.test(name)
        ? "board"
        : /server|experiments/i.test(name)
          ? "server"
          : "tower";
  return (
    <span
      className={`device-art ${small ? "small" : ""} ${active ? "active" : ""} ${kind}`}
      aria-hidden="true"
    >
      <HardwareSprite kind={kind} size={small ? 40 : 56} />
    </span>
  );
}
