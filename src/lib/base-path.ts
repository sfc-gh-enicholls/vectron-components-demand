/**
 * Prefix for files in public/. Empty on the live host; the repo sub-path on the
 * static GitHub Pages copy, where plain "/ui/..." paths would miss the site.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const asset = (path: string) => (path.startsWith("/") ? BASE_PATH + path : path);
