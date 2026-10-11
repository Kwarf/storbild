/** The admin's sidebar sections (DESIGN.md §8.2). */
export const sections = [
  { path: "/live", label: "Live" },
  { path: "/rotation", label: "Rotation" },
  { path: "/schedule", label: "Schedule" },
  { path: "/library", label: "Library" },
  { path: "/overlays", label: "Overlays" },
  { path: "/theme", label: "Theme" },
  { path: "/plugins", label: "Plugins" },
  { path: "/settings", label: "Settings" },
] as const satisfies readonly { path: string; label: string }[];

export type Section = (typeof sections)[number];

/** Every path that serves the admin shell. */
export const shellPaths: readonly string[] = ["/", ...sections.map((section) => section.path)];
