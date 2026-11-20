import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractYouTubeVideoId,
  formatTimestamp,
  parseTimestamp,
  clampClipRange,
  generateSrtFromClip,
  buildSocialShareUrl,
  formatGeminiErrorMessage,
  generateAssFromClip,
  buildYtDlpFfmpegCommand,
} from './youtube';
import type { PodcastClip } from '../types/clipper';

const sampleClip: PodcastClip = {
  id: 'clip-1',
  episodeId: 'ep-1',
  orderIndex: 1,
  title: 'Kenapa Podcast Panjang Menang di Era AI',
  hookLine: 'Perhatian audiens bukan makin pendek, tapi makin selektif.',
  startSec: 120,
  endSec: 165,
  ringkasanTeks: 'Ringkasan tentang bagaimana kreator memotong podcast panjang menjadi klip pendek berdampak tinggi.',
  poinKunci: ['Hook 3 detik pertama menentukan retensi'],
  transcriptExcerpt: 'Perhatian audiens bukan makin pendek.',
  captionCues: [
    { offsetSec: 0, durationSec: 3.5, text: 'Perhatian audiens bukan makin pendek,' },
    { offsetSec: 3.5, durationSec: 4, text: 'tapi mereka makin selektif di 3 detik pertama.' },
  ],
  priorityLabel: 'Sorotan Utama',
  status: 'draft',
  publishedPlatforms: [],
  platformCopies: {
    youtube_shorts: {
      title: 'Rahasia Retensi Podcast #Shorts',
      caption: 'Klip terbaik dari episode minggu ini.',
      hashtags: ['#Shorts', '#PodcastIndonesia'],
    },
    tiktok: {
      title: 'Retensi Podcast',
      caption: 'Setuju sama poin ini?',
      hashtags: ['#podcast', '#kreator'],
    },
    instagram_reels: {
      title: 'Insight Kreator',
      caption: 'Simpan klip ini buat referensi konten.',
      hashtags: ['#reels', '#podcastclips'],
    },
    x_twitter: {
      title: 'Thread singkat dari podcast hari ini',
      caption: 'Audiens bukan tidak sabar, tapi selektif.',
      hashtags: ['#Podcast', '#CreatorEconomy'],
    },
    linkedin: {
      title: 'Pelajaran Strategi Konten Video Pendek',
      caption: 'Distribusi klip podcast meningkatkan jangkauan organik.',
      hashtags: ['#ContentStrategy', '#Podcasting'],
    },
  },
};

test('extractYouTubeVideoId handles watch, short, live, and youtu.be URLs', () => {
  assert.equal(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=45'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeVideoId('https://www.youtube.com/shorts/abcDEF12345'), 'abcDEF12345');
  assert.equal(extractYouTubeVideoId('https://www.youtube.com/live/xyz98765432?si=test'), 'xyz98765432');
  assert.equal(extractYouTubeVideoId('youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeVideoId('https://vimeo.com/123456'), null);
  assert.equal(extractYouTubeVideoId('   '), null);
});

test('formatTimestamp and parseTimestamp round-trip cleanly', () => {
  assert.equal(formatTimestamp(0), '00:00');
  assert.equal(formatTimestamp(75), '01:15');
  assert.equal(formatTimestamp(3661), '01:01:01');

  assert.equal(parseTimestamp('01:15'), 75);
  assert.equal(parseTimestamp('01:01:01'), 3661);
  assert.equal(parseTimestamp('12:75'), null);
  assert.equal(parseTimestamp('abc'), null);
});

test('clampClipRange enforces minimum, maximum, and episode duration boundaries', () => {
  const clampedShort = clampClipRange(50, 52, 600, 10, 60);
  assert.equal(clampedShort.durationSec, 10);
  assert.equal(clampedShort.endSec, 60);

  const clampedLong = clampClipRange(100, 220, 600, 10, 60);
  assert.equal(clampedLong.durationSec, 60);
  assert.equal(clampedLong.endSec, 160);

  const clampedEnd = clampClipRange(595, 620, 600, 10, 60);
  assert.equal(clampedEnd.startSec, 590);
  assert.equal(clampedEnd.endSec, 600);
});

test('generateSrtFromClip produces valid sequential SRT cues', () => {
  const srt = generateSrtFromClip(sampleClip);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:03,500\nPerhatian audiens bukan makin pendek,/);
  assert.match(srt, /2\n00:00:03,500 --> 00:00:07,500\ntapi mereka makin selektif/);
});

test('buildSocialShareUrl constructs valid platform intent URLs', () => {
  const xUrl = buildSocialShareUrl('x_twitter', sampleClip, 'https://youtu.be/dQw4w9WgXcQ');
  assert.ok(xUrl.startsWith('https://twitter.com/intent/tweet?text='));
  assert.ok(xUrl.includes(encodeURIComponent('https://youtu.be/dQw4w9WgXcQ')));

  const ytUrl = buildSocialShareUrl('youtube_shorts', sampleClip, 'https://youtu.be/dQw4w9WgXcQ');
  assert.equal(ytUrl, 'https://studio.youtube.com/');
});

test('formatGeminiErrorMessage translates raw API 429/403 errors into clean Indonesian guidance', () => {
  const err429 = new Error(
    '{"error":{"code":429,"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED"}}'
  );
  const msg429 = formatGeminiErrorMessage(err429);
  assert.ok(msg429.includes('429 RESOURCE_EXHAUSTED'));
  assert.ok(msg429.includes('Settings > Secrets'));

  const err403 = new Error('PERMISSION_DENIED: API key invalid');
  assert.ok(formatGeminiErrorMessage(err403).includes('400/403'));

  const err503 = new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}');
  assert.ok(formatGeminiErrorMessage(err503).includes('503 UNAVAILABLE'));
});

test('generateAssFromClip outputs 720x1280 ASS dialogue cues', () => {
  const ass = generateAssFromClip(sampleClip);
  assert.ok(ass.includes('PlayResX: 720'));
  assert.ok(ass.includes('PlayResY: 1280'));
  assert.ok(ass.includes('Dialogue: 0,0:00:00.00,0:00:03.50,Default,,0,0,0,,Perhatian audiens bukan makin pendek,'));
});

test('buildYtDlpFfmpegCommand includes exact section timestamps and source URL', () => {
  const cmd = buildYtDlpFfmpegCommand(sampleClip, 'https://youtu.be/6QyRGE6Cg8E');
  assert.ok(cmd.includes('*02:00-02:45'));
  assert.ok(cmd.includes('https://youtu.be/6QyRGE6Cg8E'));
  assert.ok(cmd.includes('libx264'));
});


