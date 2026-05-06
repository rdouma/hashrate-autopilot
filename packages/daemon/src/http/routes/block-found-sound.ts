/**
 * Block-found custom-sound endpoints (#88).
 *
 * - POST /api/config/block-found-sound  : upload a custom MP3, stored
 *   as a SQLite blob on the singleton config row. Body is JSON
 *   `{ data_base64: string, mime: string }` rather than multipart so
 *   we don't pull in a new dependency for a one-shot tiny upload.
 *   Hard 200 KB cap on the decoded payload (SQLite backups stay sane,
 *   and a typical block-found cue is well under that).
 *
 * - GET /api/config/block-found-sound : streams the stored blob back
 *   with its sniffed Content-Type so the dashboard can
 *   `<audio src="/api/config/block-found-sound" />` it.
 *
 * The plain JSON config endpoint at PUT /api/config keeps doing what
 * it does - the blob and mime columns are intentionally write-only
 * here so a routine config save can't accidentally null them out.
 */

import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import type { Database } from '../../state/types.js';

const MAX_BYTES = 200 * 1024; // 200 KB
const ALLOWED_MIME = new Set([
  'audio/mpeg', // MP3
  'audio/mp3', // MP3 (some clients)
  'audio/ogg', // OGG Vorbis / Opus
  'audio/wav', // WAV
  'audio/x-wav',
  'audio/webm',
]);

export interface BlockFoundSoundDeps {
  readonly db: Kysely<Database>;
}

export async function registerBlockFoundSoundRoute(
  app: FastifyInstance,
  deps: BlockFoundSoundDeps,
): Promise<void> {
  // Bump body limit on this route since the JSON payload carries a
  // base64-encoded audio blob (200 KB raw -> ~270 KB base64, plus JSON
  // wrapper). The default 1 MB Fastify limit is enough but we set
  // 512 KB explicitly so a runaway payload fails fast at parse time
  // rather than after decode.
  app.post<{ Body: { data_base64?: string; mime?: string; filename?: string } }>(
    '/api/config/block-found-sound',
    {
      bodyLimit: 512 * 1024,
    },
    async (req, reply) => {
      const { data_base64, mime, filename } = req.body ?? {};
      if (typeof data_base64 !== 'string' || typeof mime !== 'string') {
        reply.code(400);
        return { error: 'expected JSON body { data_base64: string, mime: string }' };
      }
      if (!ALLOWED_MIME.has(mime)) {
        reply.code(415);
        return { error: `unsupported mime "${mime}"; allowed: ${[...ALLOWED_MIME].join(', ')}` };
      }
      let decoded: Buffer;
      try {
        decoded = Buffer.from(data_base64, 'base64');
      } catch {
        reply.code(400);
        return { error: 'invalid base64 payload' };
      }
      if (decoded.length === 0) {
        reply.code(400);
        return { error: 'empty payload' };
      }
      if (decoded.length > MAX_BYTES) {
        reply.code(413);
        return { error: `payload exceeds ${MAX_BYTES} bytes (got ${decoded.length})` };
      }
      // Sniff: every audio container we accept has a recognisable
      // first-few-bytes header. We don't fully parse - just enough to
      // catch "operator uploaded a JPG with mime audio/mpeg" mistakes.
      if (!looksLikeAudio(decoded)) {
        reply.code(415);
        return { error: 'payload does not look like an audio container (header sniff failed)' };
      }
      // Trim the filename: strip directory prefixes (some browsers
      // send "C:\\fakepath\\foo.mp3"), cap length so a pathological
      // upload can't bloat the row, fall back to null when the
      // client didn't send one.
      const cleanName = typeof filename === 'string'
        ? filename.split(/[\\/]/).pop()?.slice(0, 200) || null
        : null;
      await deps.db
        .updateTable('config')
        .set({
          block_found_sound_custom_blob: decoded,
          block_found_sound_custom_mime: mime,
          block_found_sound_custom_filename: cleanName,
        })
        .where('id', '=', 1)
        .execute();
      return { ok: true, bytes: decoded.length, mime, filename: cleanName };
    },
  );

  // Status probe used by the dashboard to know if a custom blob is
  // already on the daemon, without streaming the whole file. Drives
  // the Config UI's "Choose file…" / "Replace file…" button label
  // and decides whether picking 'custom' from the dropdown should
  // auto-open the OS file picker (auto-open only when no blob yet).
  app.get('/api/config/block-found-sound/status', async () => {
    const row = await deps.db
      .selectFrom('config')
      .select([
        'block_found_sound_custom_blob',
        'block_found_sound_custom_mime',
        'block_found_sound_custom_filename',
      ])
      .where('id', '=', 1)
      .executeTakeFirst();
    const blob = row?.block_found_sound_custom_blob;
    const mime = row?.block_found_sound_custom_mime ?? null;
    const filename = row?.block_found_sound_custom_filename ?? null;
    return {
      has_blob: !!blob,
      bytes: blob ? Buffer.from(blob).length : null,
      mime,
      filename,
    };
  });

  app.get('/api/config/block-found-sound', async (_req, reply) => {
    const row = await deps.db
      .selectFrom('config')
      .select(['block_found_sound_custom_blob', 'block_found_sound_custom_mime'])
      .where('id', '=', 1)
      .executeTakeFirst();
    const blob = row?.block_found_sound_custom_blob;
    const mime = row?.block_found_sound_custom_mime;
    if (!blob || !mime) {
      reply.code(404);
      return { error: 'no custom sound uploaded' };
    }
    reply.header('content-type', mime);
    reply.header('cache-control', 'no-store');
    return Buffer.from(blob);
  });
}

/**
 * Cheap header sniff: return true if `buf` looks like one of the
 * accepted audio containers. Catches blatant MIME mismatches; not a
 * full parser. Magic bytes documented at
 * https://en.wikipedia.org/wiki/List_of_file_signatures.
 */
function looksLikeAudio(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  // MP3: "ID3" tag header, or 0xFFFB / 0xFFFA / 0xFFF3 / 0xFFF2 frame sync
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // "ID3"
  if (buf[0] === 0xff && buf[1] !== undefined && (buf[1] & 0xe0) === 0xe0) return true; // MPEG frame sync
  // OGG: "OggS"
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return true;
  // WAV / RIFF: "RIFF" then 4 bytes then "WAVE"
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf.length >= 12 &&
    buf[8] === 0x57 &&
    buf[9] === 0x41 &&
    buf[10] === 0x56 &&
    buf[11] === 0x45
  ) {
    return true;
  }
  // WebM: 0x1A 0x45 0xDF 0xA3 (EBML header, shared with Matroska)
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true;
  return false;
}
