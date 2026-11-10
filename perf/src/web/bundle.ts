import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

export interface BundleFile {
  file: string;
  kb: number;
  gzipKb: number;
  brotliKb: number;
}

export interface BundleResult {
  files: BundleFile[];
  /** JavaScript and CSS only: what has to download and run before the app can render. */
  code: Omit<BundleFile, "file">;
}

const kb = (bytes: number) => Math.round((bytes / 1024) * 10) / 10;

/** Sizes of everything in the built app, raw and as Cloudflare would compress it. */
export async function bundleSizes(distDir: string): Promise<BundleResult> {
  const names = (await readdir(distDir, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  const files = await Promise.all(
    names.map(async (entry) => {
      const contents = await readFile(path.join(entry.parentPath, entry.name));
      return {
        file: path.relative(distDir, path.join(entry.parentPath, entry.name)),
        kb: kb(contents.length),
        gzipKb: kb(gzipSync(contents, { level: 9 }).length),
        brotliKb: kb(brotliCompressSync(contents).length),
      };
    }),
  );
  files.sort((a, b) => b.kb - a.kb);

  const code = files.filter((f) => /\.(js|css)$/.test(f.file));
  const total = (key: "kb" | "gzipKb" | "brotliKb") => kb(code.reduce((sum, f) => sum + f[key] * 1024, 0));
  return { files, code: { kb: total("kb"), gzipKb: total("gzipKb"), brotliKb: total("brotliKb") } };
}
