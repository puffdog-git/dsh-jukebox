// 純函式：比對、連結解析、範圍、遙控白名單、設定。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTitle, matchScore, pickBest, similarity } from '../lib/match.js';
import { parseRange } from '../lib/range.js';
import { openTarget, createRemote } from '../lib/remote.js';
import { parseAppleLink, signDeveloperToken } from '../lib/sources/apple.js';
import { parseKkboxLink } from '../lib/sources/kkbox.js';
import { listUrl, parseBilibiliLink } from '../lib/sources/bilibili.js';
import { parseSpotifyLink } from '../lib/sources/spotify.js';
import { parseYoutubeLink } from '../lib/core.js';
import { normalizeConfig, DEFAULT_CONFIG } from '../lib/store.js';
import { fromFileName } from '../lib/library.js';
import { generateKeyPairSync, verify } from 'node:crypto';

test('比對：官方音源勝過翻唱、現場與伴奏', () => {
  const target = { title: '晴天', artist: '周杰倫', duration: 270 };
  const candidates = [
    { id: 'cover', title: '晴天 (cover by 某某)', artist: '某某', duration: 268 },
    { id: 'inst', title: '晴天（纯音乐）', artist: '娅霜', duration: 171 },
    { id: 'live', title: '周杰倫 晴天 Live 演唱會', artist: '周杰倫', duration: 300 },
    { id: 'real', title: '晴天', artist: '周杰倫', duration: 270 },
    { id: 'other', title: '彩虹', artist: '周杰倫', duration: 264 },
  ];
  assert.equal(pickBest(candidates, target).candidate.id, 'real');
  assert.ok(matchScore(candidates[4], target) < 0.55, '同歌手的別首歌不能過門檻');
  assert.ok(matchScore(candidates[1], target) < 0.55, '伴奏不能過門檻');
});

test('比對：YouTube 標題「歌手 - 歌名 (Official Video)」對得上', () => {
  const target = { title: 'Shape of You', artist: 'Ed Sheeran', duration: 234 };
  const mv = { title: 'Ed Sheeran - Shape of You (Official Music Video)', artist: 'Ed Sheeran', duration: 263 };
  assert.ok(matchScore(mv, target) >= 0.55);
  assert.equal(pickBest([{ title: 'Shape of My Heart', artist: 'Sting', duration: 278 }], target), null);
  assert.equal(cleanTitle('Hello (feat. Someone) [Official Video]'), 'Hello');
  assert.ok(similarity('ＡＢＣ　晴天', 'abc 晴天') > 0.99, '全形半形視為相同');
});

test('比對：目標本身是現場版時不扣現場版的分', () => {
  const target = { title: '倒帶 (Live)', artist: '蔡依林' };
  assert.ok(matchScore({ title: '倒帶 Live', artist: '蔡依林' }, target) > matchScore({ title: '倒帶', artist: '蔡依林' }, target));
});

test('連結解析', () => {
  assert.deepEqual(parseSpotifyLink('https://open.spotify.com/intl-zh/track/4cOdK2wGLETKBW3PvgPWqT?si=abc'), { kind: 'track', id: '4cOdK2wGLETKBW3PvgPWqT' });
  assert.deepEqual(parseSpotifyLink('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'), { kind: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' });
  assert.equal(parseSpotifyLink('https://evil.example/track/4cOdK2wGLETKBW3PvgPWqT'), null);
  assert.deepEqual(parseKkboxLink('https://www.kkbox.com/tw/tc/song/Gq5EJ8C3m-XkSQhTrl'), { kind: 'track', id: 'Gq5EJ8C3m-XkSQhTrl' });
  assert.deepEqual(parseAppleLink('https://music.apple.com/tw/album/%E6%99%B4%E5%A4%A9/535824731?i=535824738'), { kind: 'track', id: '535824738', country: 'tw' });
  assert.deepEqual(parseAppleLink('https://music.apple.com/us/album/x/535824731'), { kind: 'album', id: '535824731', country: 'us' });
  assert.deepEqual(parseAppleLink('https://music.apple.com/tw/playlist/top/pl.u-abc123DEF'), { kind: 'playlist', id: 'pl.u-abc123DEF', country: 'tw' });
  assert.deepEqual(parseYoutubeLink('https://music.youtube.com/watch?v=SJKoWAd5ySo&si=x'), { kind: 'track', id: 'SJKoWAd5ySo' });
  assert.deepEqual(parseYoutubeLink('https://youtu.be/SJKoWAd5ySo'), { kind: 'track', id: 'SJKoWAd5ySo' });
  assert.deepEqual(parseYoutubeLink('https://www.youtube.com/playlist?list=PLabcdefghijklmnop'), { kind: 'playlist', id: 'PLabcdefghijklmnop' });
  assert.equal(parseYoutubeLink('https://youtube.com.evil.example/watch?v=SJKoWAd5ySo'), null);
  const bili = parseBilibiliLink;
  assert.deepEqual(bili('https://www.bilibili.com/video/BV1d4411N7zD/?spm_id_from=x'), { kind: 'track', id: 'BV1d4411N7zD' });
  assert.deepEqual(bili('https://www.bilibili.com/zh-Hant/video/BV1d4411N7zD/'), { kind: 'track', id: 'BV1d4411N7zD' });
  assert.deepEqual(bili('https://www.bilibili.com/audio/au15664'), { kind: 'track', id: 'au15664' });
  assert.deepEqual(bili('https://www.bilibili.com/audio/am10624?type=2'), { kind: 'playlist', id: 'am10624' });
  assert.deepEqual(bili('https://space.bilibili.com/9666167/lists/9535465?type=season'), { kind: 'playlist', id: 'season-9666167-9535465' });
  assert.deepEqual(bili('https://space.bilibili.com/9666167/lists/77?type=series'), { kind: 'playlist', id: 'series-9666167-77' });
  assert.deepEqual(bili('https://space.bilibili.com/9666167/channel/collectiondetail?sid=9535465'), { kind: 'playlist', id: 'season-9666167-9535465' });
  assert.deepEqual(bili('https://space.bilibili.com/123/favlist?fid=456&ftype=create'), { kind: 'playlist', id: 'fav-123-456' });
  assert.deepEqual(bili('https://www.bilibili.com/list/ml1052622027?oid=1'), { kind: 'playlist', id: 'ml1052622027' });
  assert.deepEqual(bili('https://b23.tv/AbCd123'), { kind: 'short', id: 'AbCd123' });
  assert.deepEqual(bili('https://www.bilibili.com/list/1346923466?sid=1&oid=2'), { kind: 'playlist', id: 'up-1346923466' });
  assert.deepEqual(bili('https://space.bilibili.com/1346923466/upload/video'), { kind: 'playlist', id: 'up-1346923466' });
  assert.deepEqual(bili('https://space.bilibili.com/1346923466/video'), { kind: 'playlist', id: 'up-1346923466' });
  assert.equal(bili('https://space.bilibili.com/1346923466'), null, 'UP 主的首頁不是清單');
  assert.equal(listUrl('up-1346923466'), 'https://www.bilibili.com/list/1346923466');
  assert.equal(bili('https://www.bilibili.com/audio/home/?type=9'), null, '音頻區首頁不是一首歌或一張歌單');
  assert.equal(bili('https://www.bilibili.com/video/av55185686'), null);
  assert.equal(bili('https://bilibili.com.evil.example/video/BV1d4411N7zD'), null);
  assert.equal(listUrl('season-9666167-9535465'), 'https://space.bilibili.com/9666167/lists/9535465?type=season');
  assert.equal(listUrl('fav-123-456'), 'https://space.bilibili.com/123/favlist?fid=456');
  assert.equal(listUrl('ml99'), 'https://www.bilibili.com/list/ml99');
  assert.equal(listUrl('../x'), '');
  assert.equal(openTarget('bilibili', 'https://www.bilibili.com/audio/au15664'), 'https://www.bilibili.com/audio/au15664');
  assert.equal(openTarget('bilibili', 'https://www.bilibili.com/video/BV1d4411N7zD'), 'https://www.bilibili.com/video/BV1d4411N7zD');
  assert.equal(openTarget('bilibili', 'https://www.bilibili.com/video/BV1d4411N7zD?x=1&y'), '');
});

test('Range 標頭', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange('bytes=-20', 100), { start: 80, end: 99 });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), false);
  assert.equal(parseRange('bytes=5-2', 100), false);
  assert.equal(parseRange('bytes=0-1,5-6', 100), false);
  assert.equal(parseRange('items=0-1', 100), false);
});

test('遙控：只打開白名單裡的網址，不經過 shell', async () => {
  assert.equal(openTarget('spotify', 'spotify:track:4cOdK2wGLETKBW3PvgPWqT'), 'spotify:track:4cOdK2wGLETKBW3PvgPWqT');
  assert.equal(openTarget('spotify', 'spotify:track:4cOdK2wGLETKBW3PvgPWqT & calc'), '');
  assert.equal(openTarget('kkbox', 'https://www.kkbox.com/tw/tc/song/Gq5EJ8C3m-XkSQhTrl'), 'https://www.kkbox.com/tw/tc/song/Gq5EJ8C3m-XkSQhTrl');
  assert.equal(openTarget('kkbox', 'file:///C:/Windows/System32/calc.exe'), '');
  assert.equal(openTarget('apple', 'https://music.apple.com/tw/album/x/1?i=2&uo=4'), 'https://music.apple.com/tw/album/x/1?i=2&uo=4');
  assert.equal(openTarget('apple', 'https://music.apple.com/tw/album/x/1" & calc'), '');
  assert.equal(openTarget('ytmusic', 'https://music.youtube.com/watch?v=SJKoWAd5ySo'), 'https://music.youtube.com/watch?v=SJKoWAd5ySo');
  assert.equal(openTarget('local', 'C:\\x.mp3'), '');
  const calls = [];
  const remote = createRemote({ platform: 'win32', run: (bin, args, _o, cb) => (calls.push([bin, args]), cb(null)) });
  await remote.open('spotify', 'spotify:track:4cOdK2wGLETKBW3PvgPWqT');
  assert.deepEqual(calls, [['rundll32.exe', ['url.dll,FileProtocolHandler', 'spotify:track:4cOdK2wGLETKBW3PvgPWqT']]]);
  assert.throws(() => remote.open('spotify', 'https://example.com'), /格式/);
  assert.equal(calls.length, 1);
});

test('設定：不合法的值退回原值', () => {
  const c = normalizeConfig({ libraryFolders: ['relative/path', process.platform === 'win32' ? 'C:\\Music' : '/music'], enabledSources: ['local', 'bogus', 'spotify'], territory: 'jp', cacheMaxMb: 5, spotifyClientId: 'bad id!', matchOrder: 'x' });
  assert.equal(c.libraryFolders.length, 1);
  assert.deepEqual(c.enabledSources, ['local', 'spotify']);
  assert.equal(c.territory, 'JP');
  assert.equal(c.cacheMaxMb, 100);
  assert.equal(c.spotifyClientId, '');
  assert.equal(c.matchOrder, DEFAULT_CONFIG.matchOrder);
});

test('檔名當後備標籤', () => {
  assert.deepEqual(fromFileName('/m/周杰倫 - 晴天.mp3'), { artist: '周杰倫', title: '晴天' });
  assert.deepEqual(fromFileName('/m/03. 晴天.flac'), { artist: '', title: '晴天' });
});

test('Apple 開發者權杖：ES256 簽章可以用公鑰驗證', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const token = signDeveloperToken({ teamId: 'TEAM123456', keyId: 'KEY1234567', key: privateKey.export({ type: 'pkcs8', format: 'pem' }), now: 1_700_000_000_000 });
  const [head, payload, sig] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { alg: 'ES256', kid: 'KEY1234567' });
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, 'TEAM123456');
  assert.ok(verify('sha256', Buffer.from(head + '.' + payload), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('打開播放器時不把 DSH 的 Electron／Node 環境變數傳下去', async () => {
  const { cleanEnv, createRemote } = await import('../lib/remote.js');
  assert.deepEqual(cleanEnv({ PATH: 'x', ELECTRON_RUN_AS_NODE: '1', electron_no_asar: '1', NODE_OPTIONS: '--x', Other: 'y' }), { PATH: 'x', Other: 'y' });
  let seen;
  const remote = createRemote({ platform: 'win32', run: (bin, args, options, done) => ((seen = options), done(null)) });
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    await remote.open('kkbox', 'kkbox://song/Kn9Aw92cKmKv6tCogT#play');
  } finally {
    delete process.env.ELECTRON_RUN_AS_NODE;
  }
  assert.equal('ELECTRON_RUN_AS_NODE' in seen.env, false);
});
