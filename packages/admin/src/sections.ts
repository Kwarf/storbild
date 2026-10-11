/** The admin's sidebar sections (DESIGN.md §8.2). `milestone` marks pages not built yet. */
export const sections = [
  { path: "/live", label: "Live" },
  { path: "/rotation", label: "Rotation" },
  { path: "/schedule", label: "Schedule", milestone: "M6b" },
  { path: "/library", label: "Library" },
  { path: "/overlays", label: "Overlays", milestone: "M8" },
  { path: "/theme", label: "Theme", milestone: "M7" },
  { path: "/plugins", label: "Plugins" },
  { path: "/settings", label: "Settings" },
] as const satisfies readonly { path: string; label: string; milestone?: string }[];

export type Section = (typeof sections)[number];

/** Every path that serves the admin shell. */
export const shellPaths: readonly string[] = ["/", ...sections.map((section) => section.path)];
