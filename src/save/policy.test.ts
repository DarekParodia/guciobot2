import {describe, expect, test} from 'bun:test';

import {encodingPlan, getOutputLimit, isUploadable, parseMetadata, parseSaveConfig, selectFormats, sourceBudget} from './policy';

describe('save policy', () => {
  test('uses the smaller integer limit and rejects the exact byte boundary', () => {
    expect(getOutputLimit(25_000_000)).toBe(20_000_000);
    expect(getOutputLimit(10_485_760)).toBe(10_485_760);
    expect(isUploadable(19_999_999, 20_000_000)).toBe(true);
    expect(isUploadable(20_000_000, 20_000_000)).toBe(false);
    expect(isUploadable(0, 20_000_000)).toBe(false);
    for (const value of [NaN, Infinity, 0, -1, 10.5]) {
      expect(() => getOutputLimit(value)).toThrow();
    }
  });

  test('loads defaults lazily and validates host overrides', () => {
    expect(parseSaveConfig({}).maxInputBytes).toBe(268435456);
    expect(parseSaveConfig({save: {maxInputBytes: 12345}}).maxInputBytes).toBe(12345);
    for (const save of [null, [], {maxInputBytes: -1}, {maxInputBytes: null}, {tmpfsDir: 'relative'}, {memoryReserveBytes: NaN}]) {
      expect(() => parseSaveConfig({save})).toThrow();
    }
  });

  test('reserves working memory and output copies before accepting source bytes', () => {
    expect(sourceBudget(1_000_000_000, 500_000_000, 20_000_000, parseSaveConfig({}))).toBe(268435456);
    expect(() => sourceBudget(500_000_000, 500_000_000, 20_000_000, parseSaveConfig({}))).toThrow();
  });

  test('falls back to a smaller video and sums separate audio admission', () => {
    const meta = parseMetadata({title: 'clip', duration: 60, formats: [
      {format_id: '720', width: 1280, height: 720, vcodec: 'avc1', acodec: 'none', filesize: 90_000_000},
      {format_id: '480', width: 854, height: 480, vcodec: 'avc1', acodec: 'none', filesize: 30_000_000},
      {format_id: 'audio', vcodec: 'none', acodec: 'mp4a', filesize: 5_000_000},
    ]});
    const choice = selectFormats(meta, 50_000_000);
    expect(choice.tracks.map(t => t.id)).toEqual(['480', 'audio']);
    expect(choice.estimatedBytes).toBe(35_000_000);
    expect(() => selectFormats(meta, 40_000_000)).toThrow();
  });

  test('allows unknown sizes under an actual-byte cap and rejects live/playlist data', () => {
    const meta = parseMetadata({title: 'silent', duration: 20, formats: [
      {format_id: 'v', width: 360, height: 640, vcodec: 'vp9', acodec: 'none'},
    ]});
    expect(selectFormats(meta, 20_000_000).estimatedBytes).toBeNull();
    for (const raw of [{_type: 'playlist'}, {is_live: true, duration: 10}, {duration: null}, {duration: Infinity}]) {
      expect(() => parseMetadata(raw)).toThrow();
    }
  });

  test('computes an audio-aware bitrate budget and refuses unusable results', () => {
    const plan = encodingPlan(60, true, 19_000_000);
    expect(plan.videoBitrate).toBe(2437333);
    expect(plan.shortSide).toBe(720);
    expect(encodingPlan(60, false, 19_000_000).videoBitrate).toBe(2533333);
    expect(() => encodingPlan(2000, true, 19_000_000)).toThrow();
  });

  test('falls back to a format that can be downloaded without staging native fragments', () => {
    const meta = parseMetadata({title: 'clip', duration: 60, formats: [
      {format_id: 'dash', protocol: 'http_dash_segments', width: 1280, height: 720, vcodec: 'avc1', acodec: 'mp4a'},
      {format_id: 'hls', protocol: 'm3u8_native', width: 854, height: 480, vcodec: 'avc1', acodec: 'mp4a'},
    ]});
    expect(selectFormats(meta, 100_000_000).tracks.map(track => track.id)).toEqual(['hls']);
  });
});
