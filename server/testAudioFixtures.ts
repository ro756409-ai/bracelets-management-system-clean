/**
 * مُولِّدات ملفات صوت صناعية بالحد الأدنى من البنية (كما يكتبها MediaRecorder) — لاختبار فحص
 * المحتوى والمدة بلا ملفات ثنائية في المستودع. تُستخدم في اختبارات الفحص ومسار الرفع.
 */
const u = (n: number, bytes: number) => { const b = Buffer.alloc(bytes); for (let i = bytes - 1; i >= 0; i--) { b[i] = n % 256; n = Math.floor(n / 256); } return b; };
const ebmlSize = (n: number) => Buffer.concat([Buffer.from([0x10]), u(n, 3)]); // vint بطول 4 بايت
const el = (id: number[], data: Buffer) => Buffer.concat([Buffer.from(id), ebmlSize(data.length), data]);
const UNKNOWN = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

/** WebM بلا Duration (مثل Chrome): Clusters بأحجام مجهولة، كل ثانية كتلة. */
export function fakeWebm(durationMs: number, opts: { declared?: boolean; padTo?: number } = {}) {
  const info = el([0x15, 0x49, 0xa9, 0x66], Buffer.concat([
    el([0x2a, 0xd7, 0xb1], u(1_000_000, 3)),
    ...(opts.declared ? [el([0x44, 0x89], (() => { const b = Buffer.alloc(8); b.writeDoubleBE(durationMs); return b; })())] : []),
  ]));
  const clusters: Buffer[] = [];
  for (let t = 0; t <= durationMs; t += 1000) {
    const rel = Math.min(999, durationMs - t);
    const block = Buffer.concat([Buffer.from([0x81]), (() => { const b = Buffer.alloc(2); b.writeInt16BE(rel); return b; })(), Buffer.from([0x80, 1, 2, 3])]);
    clusters.push(Buffer.concat([Buffer.from([0x1f, 0x43, 0xb6, 0x75]), UNKNOWN, el([0xe7], u(t, 4)), el([0xa3], block)]));
  }
  const body = Buffer.concat([el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], Buffer.from("webm"))), Buffer.from([0x18, 0x53, 0x80, 0x67]), UNKNOWN, info, ...clusters]);
  return opts.padTo && opts.padTo > body.length ? Buffer.concat([body, el([0xec], Buffer.alloc(opts.padTo - body.length - 8))]) : body;
}

function oggPage(granule: bigint, packet: Buffer, seq: number) {
  const h = Buffer.alloc(27);
  h.write("OggS", 0, "latin1"); h[5] = seq === 0 ? 2 : 0; h.writeBigInt64LE(granule, 6); h.writeUInt32LE(1, 14); h.writeUInt32LE(seq, 18);
  const lacing: number[] = []; let n = packet.length; while (n >= 255) { lacing.push(255); n -= 255; } lacing.push(n);
  h[26] = lacing.length;
  return Buffer.concat([h, Buffer.from(lacing), packet]);
}
/** Ogg Opus (مثل Firefox): pre-skip 312، granule آخر صفحة = المدة × 48000. */
export function fakeOgg(durationMs: number) {
  const head = Buffer.alloc(19); head.write("OpusHead", 0, "latin1"); head[8] = 1; head[9] = 1; head.writeUInt16LE(312, 10); head.writeUInt32LE(48000, 12);
  const tags = Buffer.from("OpusTags\0\0\0\0\0\0\0\0", "latin1");
  const pages = [oggPage(0n, head, 0), oggPage(0n, tags, 1)];
  const total = Math.round((durationMs / 1000) * 48000) + 312;
  for (let i = 1, seq = 2; i <= 4; i++, seq++) pages.push(oggPage(BigInt(Math.round((total * i) / 4)), Buffer.alloc(40, 7), seq));
  return Buffer.concat(pages);
}

export const box = (type: string, ...payload: Buffer[]) => { const body = Buffer.concat(payload); const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(type, 4, "latin1"); return Buffer.concat([h, body]); };
const full = (version: number, flags: number) => u(version * 2 ** 24 + flags, 4);
const hd = (scale: number, dur: number) => Buffer.concat([full(0, 0), u(0, 4), u(0, 4), u(scale, 4), u(dur, 4), Buffer.alloc(80)]);
/** MP4: عادي (mvhd فيه المدة) أو fragmented بلا مدة (مثل Safari) فتُجمع عينات trun. */
export function fakeMp4(durationMs: number, fragmented = false) {
  const ftyp = box("ftyp", Buffer.from("M4A \0\0\0\0isomM4A ", "latin1"));
  if (!fragmented) return Buffer.concat([ftyp, box("moov", box("mvhd", hd(1000, durationMs)))]);
  const scale = 48000, per = 1024, count = Math.round((durationMs / 1000) * scale / per);
  const moov = box("moov", box("mvhd", hd(1000, 0)), box("trak", box("mdia", box("mdhd", hd(scale, 0)))), box("mvex", box("trex", full(0, 0), u(1, 4), u(1, 4), u(per, 4), u(0, 4), u(0, 4))));
  const moof = box("moof", box("traf", box("tfhd", full(0, 0), u(1, 4)), box("trun", full(0, 0x200), u(count, 4), Buffer.alloc(count * 4, 1))));
  return Buffer.concat([ftyp, moov, moof, box("mdat", Buffer.alloc(64))]);
}
