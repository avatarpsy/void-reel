/**
 * Reading a zip, with no dependency.
 *
 * ── WHY NOT JSZip ───────────────────────────────────────────────────────────
 * A .docx is a zip and a .pptx is a zip, so importing one needs exactly this
 * much of a zip library: list the entries, inflate the ones we want. JSZip is
 * ~100KB in the bundle of every user, including the overwhelming majority who
 * never import a Word file, and it also writes zips, encrypts them and walks
 * directory trees — none of which happens here.
 *
 * The platform already has the hard part. `DecompressionStream('deflate-raw')`
 * is the same inflate the browser uses for every gzipped response, and it is in
 * Chrome, Safari, Firefox and Node. What is left is the container format, and
 * the container format is a header with the name and the sizes in it.
 *
 * ── THE ONE SUBTLETY ────────────────────────────────────────────────────────
 * A zip can be read from the front (local file headers) or from the back (the
 * central directory). The front is simpler and is wrong for streamed zips: when
 * bit 3 of the flags is set, the sizes in the local header are ZERO and the real
 * ones follow the data, so walking forward loses its place and every entry after
 * it is garbage. Word does not write those, but plenty of tools do — so this
 * reads the CENTRAL DIRECTORY, which always has the true sizes and offsets.
 */

const SIG_END = 0x06054b50; // end of central directory
const SIG_ENTRY = 0x02014b50; // central directory file header
const SIG_LOCAL = 0x04034b50; // local file header

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

function readU16(v: DataView, at: number): number { return v.getUint16(at, true); }
function readU32(v: DataView, at: number): number { return v.getUint32(at, true); }

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  // The cast is a TypeScript quirk, not a runtime one: a Uint8Array over a
  // SharedArrayBuffer is not a BlobPart, and lib.dom cannot tell which we have.
  const stream = new Blob([data as BlobPart]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Find the end-of-central-directory record.
 *
 * It is at the very end unless the zip carries a comment, so the last 64KB —
 * the largest a comment can be — is searched backwards.
 */
function findEnd(view: DataView, length: number): number {
  const floor = Math.max(0, length - 0xffff - 22);
  for (let i = length - 22; i >= floor; i--) {
    if (readU32(view, i) === SIG_END) return i;
  }
  return -1;
}

/**
 * Every entry in the archive, decompressed.
 *
 * `wanted` skips the work for files the caller does not need — a .docx carries
 * its fonts and its thumbnails, and inflating a 4MB font to ignore it is time
 * the user spends watching a spinner.
 */
export async function readZip(
  bytes: Uint8Array,
  wanted?: (name: string) => boolean,
): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEnd(view, bytes.byteLength);
  if (end < 0) throw new Error('That file is not a zip archive.');

  const count = readU16(view, end + 10);
  let at = readU32(view, end + 16);
  const out: ZipEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.byteLength || readU32(view, at) !== SIG_ENTRY) break;
    const method = readU16(view, at + 10);
    const compressedSize = readU32(view, at + 20);
    const nameLen = readU16(view, at + 28);
    const extraLen = readU16(view, at + 30);
    const commentLen = readU16(view, at + 32);
    const localAt = readU32(view, at + 42);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    if (wanted && !wanted(name)) continue;
    if (readU32(view, localAt) !== SIG_LOCAL) continue;

    // The local header's own name and extra lengths, which differ from the
    // central directory's — using the central copy here is the classic way to
    // land a few bytes into the data and inflate rubbish.
    const localNameLen = readU16(view, localAt + 26);
    const localExtraLen = readU16(view, localAt + 28);
    const start = localAt + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(start, start + compressedSize);

    try {
      out.push({ name, bytes: method === 8 ? await inflateRaw(raw) : raw.slice() });
    } catch {
      // One unreadable entry must not cost the document: a .docx with a corrupt
      // thumbnail still has all of its text.
    }
  }
  return out;
}

/** The entries as a map, which is how every caller actually wants them. */
export async function readZipMap(
  bytes: Uint8Array,
  wanted?: (name: string) => boolean,
): Promise<Map<string, Uint8Array>> {
  const map = new Map<string, Uint8Array>();
  for (const entry of await readZip(bytes, wanted)) map.set(entry.name, entry.bytes);
  return map;
}
