// bilibili 網頁接口的請求層：簽名、裝置編號、排隊間隔、快取、被擋後冷卻。全部不連網。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBilibiliWeb, durationSeconds, plainTitle, wbiMixinKey, wbiSign } from '../lib/sources/bilibili-web.js';

const IMG = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png';
const SUB = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png';
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

function fakeSite(handlers = {}) {
  const calls = [];
  let clock = 1_700_000_000_000;
  const sleeps = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, query: u.searchParams, cookie: init.headers.cookie || '', referer: init.headers.referer, ua: init.headers['user-agent'] });
    if (handlers[u.pathname]) return handlers[u.pathname](u, init);
    if (u.pathname === '/x/frontend/finger/spi') return reply({ code: 0, data: { b_3: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE12345infoc', b_4: 'buvid4-value-abcdefghij' } });
    if (u.pathname === '/x/web-interface/nav') return reply({ code: -101, message: '账号未登录', data: { isLogin: false, wbi_img: { img_url: IMG, sub_url: SUB } } });
    return reply({ code: -404 });
  };
  return {
    calls,
    sleeps,
    options: { fetchImpl, now: () => clock, sleep: async (ms) => (sleeps.push(ms), (clock += ms)) },
    advance: (ms) => (clock += ms),
  };
}

test('簽名：混合金鑰符合公開說明文件的範例；簽名是「排序後的參數＋金鑰」的 MD5', () => {
  // 混合金鑰的範例取自公開的 WBI 說明文件。
  assert.equal(wbiMixinKey(IMG, SUB), 'ea1db124af3c7062474693fa704f4ff8');
  const query = 'bar=514&baz=1919810&foo=114&wts=1702204169';
  assert.equal(wbiSign({ foo: '114', bar: '514', baz: 1919810 }, 'ea1db124af3c7062474693fa704f4ff8', 1702204169), query + '&w_rid=' + createHash('md5').update(query + 'ea1db124af3c7062474693fa704f4ff8').digest('hex'));
  assert.match(wbiSign({ keyword: "a!'()*b" }, 'k'.repeat(32), 1), /keyword=ab&/, '特殊字元要先去掉');
  assert.equal(wbiMixinKey('x', 'y'), '');
});

test('整理標題與長度', () => {
  assert.equal(plainTitle('<em class="keyword">晴天</em> &amp; &quot;MV&quot;'), '晴天 & "MV"');
  assert.equal(durationSeconds('4:30'), 270);
  assert.equal(durationSeconds('1:02:03'), 3723);
  assert.equal(durationSeconds(317.4), 317);
  assert.equal(durationSeconds('abc'), 0);
});

test('搜尋：三個請求拿完（裝置編號、金鑰、搜尋），結果帶標題與長度；第二次搜尋只多一個請求', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jb-biliweb-'));
  const site = fakeSite({
    '/x/web-interface/wbi/search/type': (u) =>
      reply({ code: 0, data: { result: [
        { bvid: 'BV1BZbSzZEGT', title: '<em class="keyword">晴天</em> - 周杰伦', author: 'UP甲', duration: '4:30' },
        { bvid: 'BV1xx411c7mD', title: '兩小時合集', author: 'UP乙', duration: '120:00' },
        { bvid: 'bad', title: 'x' },
      ] }, _q: u.search }),
  });
  const web = createBilibiliWeb({ ...site.options, deviceFile: join(dir, 'device.json') });
  const rows = await web.search('周杰伦 晴天');
  assert.deepEqual(rows, [{ id: 'BV1BZbSzZEGT', title: '晴天 - 周杰伦', artist: 'UP甲', duration: 270 }], '超過 30 分鐘與格式不對的被濾掉');
  assert.deepEqual(site.calls.map((c) => c.path), ['/x/frontend/finger/spi', '/x/web-interface/nav', '/x/web-interface/wbi/search/type']);
  const search = site.calls[2];
  assert.match(search.cookie, /^buvid3=AAAAAAAA-.*; buvid4=buvid4-value/);
  assert.equal(search.referer, 'https://www.bilibili.com', '來源網址不帶結尾斜線');
  assert.match(search.ua, /Mozilla/);
  assert.match(search.query.get('w_rid'), /^[0-9a-f]{32}$/);
  assert.equal(search.query.get('keyword'), '周杰伦 晴天');
  assert.match(await readFile(join(dir, 'device.json'), 'utf8'), /AAAAAAAA-BBBB/, '裝置編號存檔，之後沿用');
  // 兩次請求之間至少隔 0.5 秒。
  assert.ok(site.sleeps.length >= 2 && site.sleeps.every((ms) => ms > 0 && ms <= 500));
  // 同一個關鍵字五分鐘內用快取，不再送請求。
  await web.search('周杰伦 晴天');
  assert.equal(site.calls.length, 3);
  // 另一個關鍵字：只多一個請求（裝置編號與金鑰都沿用）。
  await web.search('稻香');
  assert.equal(site.calls.length, 4);
  // 新的實例讀回存檔的裝置編號，不再向 bilibili 要。
  const site2 = fakeSite({ '/x/web-interface/wbi/search/type': () => reply({ code: 0, data: { result: [] } }) });
  const again = createBilibiliWeb({ ...site2.options, deviceFile: join(dir, 'device.json') });
  assert.deepEqual(await again.search('x'), []);
  assert.deepEqual(site2.calls.map((c) => c.path), ['/x/web-interface/nav', '/x/web-interface/wbi/search/type']);
  assert.match(site2.calls[1].cookie, /AAAAAAAA-BBBB/);
});

for (const [name, response] of [
  ['HTTP 412', () => reply('<html>blocked</html>', 412)],
  ['風控碼 -352', () => reply({ code: -352, message: '风控校验失败' })],
  ['v_voucher', () => reply({ code: 0, data: { v_voucher: 'voucher_x' } })],
  ['200 但回網頁', () => reply('<!DOCTYPE html><html>请求过于频繁</html>')],
]) {
  test('被擋（' + name + '）：只重試一次、說明原因、冷卻期間不再送請求、也不換裝置編號', async () => {
    const site = fakeSite({ '/x/web-interface/wbi/search/type': response });
    const web = createBilibiliWeb({ ...site.options });
    await assert.rejects(web.search('a'), (e) => e.rateLimited === true && /暫時限制.*5 分鐘/.test(e.message));
    const sent = site.calls.length;
    assert.equal(site.calls.filter((c) => c.path.endsWith('/search/type')).length, 2, '只重試一次');
    assert.ok(site.sleeps.includes(2500), '重試前等 2.5 秒');
    await assert.rejects(web.search('b'), (e) => e.rateLimited === true);
    assert.equal(site.calls.length, sent, '冷卻期間那個接口完全不送請求');
    // 其他接口不受影響（實測：搜尋被擋時影片資料與音頻區仍然正常）。
    await assert.rejects(web.video('BV1BZbSzZEGT'), (e) => !e.rateLimited);
    assert.equal(site.calls.length, sent + 1);
    assert.match(web.stats().lastBlock.path, /search/);
    assert.equal(site.calls.filter((c) => c.path.endsWith('/finger/spi')).length, 1, '沒有換新的裝置編號');
    assert.equal(web.stats().coolingDown, true);
    // 冷卻結束後才會再試。
    site.advance(300001);
    await assert.rejects(web.search('c'));
    assert.equal(site.calls.length, sent + 3);
  });
}

test('影片資料與清單：一個請求就帶回標題；清單各種類型走對的接口', async () => {
  const archive = (bvid, title) => ({ bvid, title, duration: 200 });
  const site = fakeSite({
    '/x/web-interface/view': () => reply({ code: 0, data: { bvid: 'BV1BZbSzZEGT', title: '晴天', duration: 270, owner: { name: 'UP甲' } } }),
    '/x/polymer/web-space/seasons_archives_list': (u) => (assert.equal(u.searchParams.get('season_id'), '9535465'), reply({ code: 0, data: { meta: { name: 'JAY' }, archives: [archive('BV1BZbSzZEGT', '晴天'), archive('BV18gxq6HEgX', '发如雪')] } })),
    '/x/v2/medialist/resource/list': (u) => reply({ code: 0, data: u.searchParams.get('oid') ? { has_more: false, media_list: [{ id: 9002, bv_id: 'BV18gxq6HEgX', title: '第二支', duration: 120, upper: { name: 'UP七' } }] } : { has_more: true, media_list: [{ id: 9001, bv_id: 'BV1BZbSzZEGT', title: '第一支', duration: 100, upper: { name: 'UP七' } }] } }),
    '/x/series/archives': () => reply({ code: 0, data: { archives: [archive('BV1BZbSzZEGT', '系列一')] } }),
    '/x/series/series': () => reply({ code: 0, data: { meta: { name: '我的系列' } } }),
    '/x/web-interface/card': (u) => (u.searchParams.get('mid') === '1' ? reply({ code: -404 }) : reply({ code: 0, data: { card: { name: 'UP主' + u.searchParams.get('mid') } } })),
    '/x/v3/fav/resource/list': (u) => u.searchParams.get('media_id') === '999' ? reply({ code: -404, message: '啥都木有' }) : reply({ code: 0, data: { info: { title: '我的收藏' }, has_more: u.searchParams.get('pn') === '1', medias: [{ bvid: u.searchParams.get('pn') === '1' ? 'BV1BZbSzZEGT' : 'BV18gxq6HEgX', title: '收藏' + u.searchParams.get('pn'), duration: 100, upper: { name: 'UP丙' } }] } }),
  });
  const web = createBilibiliWeb({ ...site.options });
  assert.deepEqual(await web.video('BV1BZbSzZEGT'), { id: 'BV1BZbSzZEGT', title: '晴天', artist: 'UP甲', duration: 270 });
  const season = await web.list('season-9666167-9535465');
  assert.equal(season.title, 'JAY');
  assert.deepEqual(season.entries.map((e) => e.title), ['晴天', '发如雪']);
  assert.equal(season.skipped, 0);
  assert.deepEqual(season.entries.map((e) => e.artist), ['UP主9666167', 'UP主9666167'], '合集的歌手欄用擁有者的名稱');
  assert.equal(site.calls.at(-1).referer, 'https://space.bilibili.com/9666167');
  const series = await web.list('series-1-2');
  assert.deepEqual([series.title, series.entries[0].title, series.entries[0].artist], ['我的系列', '系列一', ''], '查不到擁有者名稱時歌手留空，不影響清單');
  const fav = await web.list('fav-123-456');
  assert.deepEqual([fav.title, fav.entries.map((e) => e.artist).join()], ['我的收藏', 'UP丙,UP丙']);
  assert.equal(site.calls.filter((c) => c.path === '/x/v3/fav/resource/list').length, 2);
  assert.equal(site.calls.at(-1).query.get('media_id'), '456');
  // UP 主的全部投稿：第二頁從上一頁最後一筆接下去。
  site.options.fetchImpl = site.options.fetchImpl;
  const up = await web.list('up-777');
  assert.deepEqual([up.title, up.entries.map((e) => e.id).join(), up.entries[0].artist], ['UP七 的投稿', 'BV1BZbSzZEGT,BV18gxq6HEgX', 'UP七']);
  const upCalls = site.calls.filter((c) => c.path === '/x/v2/medialist/resource/list');
  assert.deepEqual(upCalls.map((c) => [c.query.get('biz_id'), c.query.get('type'), c.query.get('oid')]), [['777', '1', ''], ['777', '1', '9001']]);
  const before = site.calls.length;
  await web.list('season-9666167-9535465');
  await web.video('BV1BZbSzZEGT');
  assert.equal(site.calls.length, before, '清單與影片資料有快取');
  await assert.rejects(web.list('../x'), /格式/);
  await assert.rejects(web.video('nope'), /格式/);
  // 不存在的項目是一般錯誤，不是被限流，也不進入冷卻。
  await assert.rejects(web.list('ml999'), (e) => !e.rateLimited && /沒有這個項目|回應錯誤/.test(e.message));
  assert.equal(web.stats().coolingDown, false);
});

test('偶爾被拒絕一次：等一下重試就成功，不進入冷卻', async () => {
  let hits = 0;
  const site = fakeSite({ '/x/web-interface/wbi/search/type': () => (hits++ === 0 ? reply({ code: 0, data: { v_voucher: 'voucher_x' } }) : reply({ code: 0, data: { result: [{ bvid: 'BV1BZbSzZEGT', title: '晴天', author: 'UP', duration: '4:30' }] } })) });
  const web = createBilibiliWeb({ ...site.options });
  assert.equal((await web.search('a')).length, 1);
  assert.deepEqual([web.stats().retried, web.stats().limited, web.stats().coolingDown], [1, 0, false]);
});
