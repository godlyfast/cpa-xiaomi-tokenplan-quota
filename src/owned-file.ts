import { open } from "node:fs/promises";
import { constants, type Stats } from "node:fs";

export type OwnedFile =
  | { ok: true; bytes: Uint8Array; stat: Stats }
  | { ok: false; reason: "missing" | "invalid"; stat: Stats | null };

// Never throws. Opens with O_NOFOLLOW and fstats the same descriptor to avoid
// symlink/permission races; reads at most maxBytes + 1 bytes even if the file grows.
export async function readOwnedFile(
  path: string,
  maxBytes: number,
  forbiddenMode: number,
): Promise<OwnedFile> {
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const missing = (error as { code?: unknown } | null)?.code === "ENOENT";
    return { ok: false, reason: missing ? "missing" : "invalid", stat: null };
  }
  let stat: Stats | null = null;
  try {
    stat = await file.stat();
    if (
      !stat.isFile() ||
      (stat.mode & forbiddenMode) !== 0 ||
      stat.uid !== process.getuid?.() ||
      stat.size > maxBytes
    )
      return { ok: false, reason: "invalid", stat };
    const buffer = new Uint8Array(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) return { ok: false, reason: "invalid", stat };
    return { ok: true, bytes: buffer.subarray(0, length), stat };
  } catch {
    return { ok: false, reason: "invalid", stat };
  } finally {
    await file.close().catch(() => {});
  }
}
