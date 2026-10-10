/**
 * فحص ملف الصوت من **محتواه** (لا من Content-Type المتصفح ولا الامتداد): نوع الحاوية الحقيقي + المدة.
 *
 * المسموح فقط ما يُخرجه MediaRecorder في المتصفحات: WebM/Matroska (Chrome/Firefox/Android)،
 * Ogg (Firefox: Opus/Vorbis)، MP4/M4A (Safari/iOS). أي شيء آخر (SVG/HTML/تنفيذي/MP3/…) مرفوض.
 *
 * المدة تُقاس من الحاوية نفسها:
 *   • WebM: عنصر Duration في Info إن وُجد، وإلا أقصى (Cluster Timecode + Block Timecode) — MediaRecorder
 *     في Chrome لا يكتب Duration، فنمشي العناصر بشكل مسطّح يتحمل الأحجام المجهولة (live).
 *   • Ogg: granule آخر صفحة ÷ معدل العينة (Opus 48kHz مطروحًا منه pre-skip؛ Vorbis من ترويسته).
 *   • MP4: mvhd، وإلا (fragmented من Safari) مجموع مدد عينات trun ÷ timescale من mdhd.
 * تعذّر القياس = null والمتصل يرفض (fail-closed).
 */
export type AudioContainer = "webm" | "ogg" | "mp4";
export const AUDIO_CONTAINERS: Record<AudioContainer, { mime: string; ext: string; browserMimes: RegExp; extensions: string[] }> = {
  webm: { mime: "audio/webm", ext: ".webm", browserMimes: /^(audio|video)\/webm(;.*)?$/i, extensions: [".webm", ".weba"] },
  ogg: { mime: "audio/ogg", ext: ".ogg", browserMimes: /^(audio|application)\/ogg(;.*)?$/i, extensions: [".ogg", ".oga", ".opus"] },
  mp4: { mime: "audio/mp4", ext: ".m4a", browserMimes: /^(audio|video)\/(mp4|x-m4a|aac)(;.*)?$/i, extensions: [".m4a", ".mp4", ".aac"] },
};

/** الحاوية من البايتات الأولى (magic bytes) أو null. */
export function sniffAudioContainer(buf: Buffer): AudioContainer | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "webm";
  if (buf.subarray(0, 4).toString("latin1") === "OggS") return "ogg";
  if (buf.subarray(4, 8).toString("latin1") === "ftyp") return "mp4";
  return null;
}

export function measureAudioDurationMs(buf: Buffer, container: AudioContainer): number | null {
  try {
    const ms = container === "webm" ? webmDurationMs(buf) : container === "ogg" ? oggDurationMs(buf) : mp4DurationMs(buf);
    return ms != null && Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
  } catch {
    return null;
  }
}

// ==================== WebM / EBML ====================
function readVint(buf: Buffer, pos: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } | null {
  const first = buf[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || pos + length > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) { value = value * 256 + buf[pos + i]; if (buf[pos + i] !== 0xff) allOnes = false; }
  return { value, length, unknown: !keepMarker && allOnes };
}
const readUInt = (buf: Buffer, pos: number, size: number) => { let v = 0; for (let i = 0; i < size; i++) v = v * 256 + buf[pos + i]; return v; };

/** عناصر حاوية ننزل داخلها بدل تخطيها: Segment، Info، Cluster، BlockGroup. */
const EBML_DESCEND = new Set([0x18538067, 0x1549a966, 0x1f43b675, 0xa0]);

function webmDurationMs(buf: Buffer): number | null {
  let pos = 0, scale = 1_000_000, declared: number | null = null, cluster = 0, maxTc = -1;
  while (pos < buf.length) {
    const id = readVint(buf, pos, true); if (!id) break;
    const size = readVint(buf, pos + id.length, false); if (!size) break;
    const data = pos + id.length + size.length;
    if (EBML_DESCEND.has(id.value)) { pos = data; continue; }
    if (size.unknown || data + size.value > buf.length) break;
    if (id.value === 0x2ad7b1) scale = readUInt(buf, data, size.value);                      // TimecodeScale (ns)
    else if (id.value === 0x4489) declared = size.value === 4 ? buf.readFloatBE(data) : buf.readDoubleBE(data); // Duration
    else if (id.value === 0xe7) { cluster = readUInt(buf, data, size.value); maxTc = Math.max(maxTc, cluster); } // Cluster Timecode
    else if (id.value === 0xa3 || id.value === 0xa1) {                                         // SimpleBlock / Block
      const track = readVint(buf, data, false);
      if (track && data + track.length + 2 <= buf.length) maxTc = Math.max(maxTc, cluster + buf.readInt16BE(data + track.length));
    }
    pos = data + size.value;
  }
  const units = declared != null && declared > 0 ? declared : maxTc >= 0 ? maxTc : null;
  return units == null ? null : (units * scale) / 1_000_000;
}

// ==================== Ogg ====================
function oggDurationMs(buf: Buffer): number | null {
  let pos = 0, rate: number | null = null, preSkip = 0, lastGranule: number | null = null;
  while (pos + 27 <= buf.length && buf.subarray(pos, pos + 4).toString("latin1") === "OggS") {
    const granule = Number(buf.readBigInt64LE(pos + 6));
    const segments = buf[pos + 26];
    let body = 0;
    for (let i = 0; i < segments; i++) body += buf[pos + 27 + i];
    const start = pos + 27 + segments;
    if (start + body > buf.length) break;
    const packet = buf.subarray(start, start + body);
    if (rate == null && packet.subarray(0, 8).toString("latin1") === "OpusHead") { rate = 48_000; preSkip = packet.readUInt16LE(10); }
    else if (rate == null && packet[0] === 1 && packet.subarray(1, 7).toString("latin1") === "vorbis") rate = packet.readUInt32LE(12);
    if (granule > 0) lastGranule = granule;
    pos = start + body;
  }
  if (!rate || lastGranule == null) return null;
  return (Math.max(0, lastGranule - preSkip) / rate) * 1000;
}

// ==================== MP4 ====================
const MP4_DESCEND = new Set(["moov", "trak", "mdia", "moof", "traf", "mvex"]);
function mp4DurationMs(buf: Buffer): number | null {
  let movie: number | null = null, trackScale: number | null = null, trexDefault = 0, fragTicks = 0;
  let tfhdDefault: number | null = null;
  const walk = (start: number, end: number) => {
    let pos = start;
    while (pos + 8 <= end) {
      let size = buf.readUInt32BE(pos);
      const type = buf.subarray(pos + 4, pos + 8).toString("latin1");
      let header = 8;
      if (size === 1) { size = Number(buf.readBigUInt64BE(pos + 8)); header = 16; }
      else if (size === 0) size = end - pos;
      if (size < header || pos + size > end) return;
      const d = pos + header;
      if (MP4_DESCEND.has(type)) { if (type === "traf") tfhdDefault = null; walk(d, pos + size); }
      else if (type === "mvhd" || type === "mdhd") {
        const v1 = buf[d] === 1;
        const scale = buf.readUInt32BE(d + (v1 ? 20 : 12));
        const dur = v1 ? Number(buf.readBigUInt64BE(d + 24)) : buf.readUInt32BE(d + 16);
        if (type === "mvhd" && scale && dur) movie = (dur / scale) * 1000;
        if (type === "mdhd" && scale && trackScale == null) trackScale = scale;
      } else if (type === "trex") trexDefault = buf.readUInt32BE(d + 12);
      else if (type === "tfhd") {
        const flags = buf.readUInt32BE(d) & 0xffffff;
        let o = d + 8;
        if (flags & 0x01) o += 8;
        if (flags & 0x02) o += 4;
        tfhdDefault = flags & 0x08 ? buf.readUInt32BE(o) : null;
      } else if (type === "trun") {
        const flags = buf.readUInt32BE(d) & 0xffffff;
        const count = buf.readUInt32BE(d + 4);
        let o = d + 8;
        if (flags & 0x01) o += 4;
        if (flags & 0x04) o += 4;
        const per = [0x100, 0x200, 0x400, 0x800].filter(f => flags & f).length * 4;
        for (let i = 0; i < count; i++) {
          fragTicks += flags & 0x100 ? buf.readUInt32BE(o) : tfhdDefault ?? trexDefault;
          o += per;
        }
      }
      pos += size;
    }
  };
  walk(0, buf.length);
  if (movie) return movie;
  return trackScale && fragTicks ? (fragTicks / trackScale) * 1000 : null;
}
