import { describe, it, expect } from "vitest";
import { sniffAudioContainer, measureAudioDurationMs } from "./audioProbe";
import { fakeWebm, fakeOgg, fakeMp4, box } from "./testAudioFixtures";

describe("🔊 فحص الصوت من المحتوى", () => {
  it("يتعرف على WebM وOgg وMP4 من البايتات، ويرفض SVG/HTML/تنفيذي/MP3/فارغ", () => {
    expect(sniffAudioContainer(fakeWebm(3000))).toBe("webm");
    expect(sniffAudioContainer(fakeOgg(3000))).toBe("ogg");
    expect(sniffAudioContainer(fakeMp4(3000))).toBe("mp4");
    for (const bad of ['<svg xmlns="http://www.w3.org/2000/svg"></svg>', "<!doctype html><script>x</script>", "MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00", "ID3\x03\x00\x00\x00\x00\x00\x00\x00\x00\x00", "\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00", ""])
      expect(sniffAudioContainer(Buffer.from(bad, "latin1"))).toBeNull();
  });

  it("المدة: WebM بلا Duration (Clusters)، ومع Duration، وOgg Opus، وMP4 عادي وfragmented", () => {
    expect(measureAudioDurationMs(fakeWebm(12_345), "webm")).toBe(12_345);
    expect(measureAudioDurationMs(fakeWebm(4_000, { declared: true }), "webm")).toBe(4_000);
    expect(measureAudioDurationMs(fakeWebm(310_000), "webm")).toBe(310_000);
    expect(measureAudioDurationMs(fakeOgg(7_500), "ogg")).toBe(7_500);
    expect(measureAudioDurationMs(fakeMp4(9_000), "mp4")).toBe(9_000);
    expect(Math.abs(measureAudioDurationMs(fakeMp4(6_000, true), "mp4")! - 6_000)).toBeLessThan(30);
  });

  it("ملف تالف أو مقطوع = null (والمتصل يرفض)", () => {
    expect(measureAudioDurationMs(Buffer.from("OggS"), "ogg")).toBeNull();
    expect(measureAudioDurationMs(fakeWebm(2000).subarray(0, 40), "webm")).toBeNull();
    expect(measureAudioDurationMs(box("ftyp", Buffer.alloc(8)), "mp4")).toBeNull();
  });
});
