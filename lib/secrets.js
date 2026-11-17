// 各服務的金鑰與登入權杖。
//
// Windows：用作業系統的 DPAPI（目前登入的 Windows 使用者才能解開）加密後存檔。
// 其他系統：不寫入磁碟，只留在記憶體，DSH 重啟後要重新輸入。
// 內容只進不出：任何接口都只回報「有沒有填」，不回傳值，也不寫進記錄。
import { spawn } from 'node:child_process';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

function dpapi(bytes, decrypt) {
  return new Promise((resolve, reject) => {
    const script =
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[System.Security.Cryptography.ProtectedData]::" +
      (decrypt ? 'Unprotect' : 'Protect') +
      '($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))';
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    let done = false;
    const end = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      end(Error('憑證加密服務逾時'));
    }, 10000);
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stdin.on('error', () => {});
    child.on('error', () => end(Error('無法啟動憑證加密服務')));
    child.on('close', (code) => end(code === 0 ? null : Error('無法用這個 Windows 使用者解開保存的金鑰'), Buffer.from(output, 'base64')));
    child.stdin.end(Buffer.from(bytes).toString('base64'));
  });
}

// 可以保存的欄位與長度上限。
export const SECRET_FIELDS = Object.freeze({
  spotifyRefresh: 600,
  kkboxId: 80,
  kkboxSecret: 120,
  appleToken: 2000,
  appleTeamId: 20,
  appleKeyId: 20,
  appleKey: 2000,
});

export function createSecrets({ file, platform = process.platform, protect = (b) => dpapi(b, false), unprotect = (b) => dpapi(b, true) } = {}) {
  const persistent = platform === 'win32';
  let values = {};
  let loading;
  let error = '';
  let writes = Promise.resolve();

  const load = () =>
    (loading ||= (async () => {
      if (!persistent) return;
      let stored;
      try {
        stored = JSON.parse(await readFile(file, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') error = '保存的金鑰檔讀不出來';
        return;
      }
      try {
        if (stored?.scheme !== 'dpapi-current-user') throw Error('格式不對');
        const parsed = JSON.parse((await unprotect(Buffer.from(stored.data, 'base64'))).toString('utf8'));
        for (const key of Object.keys(SECRET_FIELDS)) if (typeof parsed?.[key] === 'string' && parsed[key]) values[key] = parsed[key];
      } catch {
        error = '保存的金鑰解不開，請重新輸入';
      }
    })());

  async function persist() {
    if (!persistent) return;
    const snapshot = JSON.stringify(values);
    writes = writes
      .catch(() => {})
      .then(async () => {
        if (snapshot === '{}') return unlink(file).catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
        const data = (await protect(Buffer.from(snapshot, 'utf8'))).toString('base64');
        const temp = file + '.tmp-' + process.pid;
        await writeFile(temp, JSON.stringify({ scheme: 'dpapi-current-user', data }), 'utf8');
        await rename(temp, file);
      });
    await writes;
  }

  return {
    persistent,
    /** 給介面看：每個欄位有沒有填，沒有內容。 */
    async status() {
      await load();
      return { persistent, error, has: Object.fromEntries(Object.keys(SECRET_FIELDS).map((k) => [k, !!values[k]])) };
    },
    /** 只給各來源模組用。 */
    async get(key) {
      await load();
      return values[key] || '';
    },
    /** patch 的值：字串＝設定、空字串＝清除、沒給＝不動。 */
    async set(patch = {}) {
      await load();
      const next = { ...values };
      for (const [key, max] of Object.entries(SECRET_FIELDS)) {
        if (typeof patch[key] !== 'string') continue;
        const value = patch[key].trim();
        if (value.length > max || /\0/.test(value)) throw Object.assign(Error('金鑰格式不正確或太長'), { status: 400 });
        if (value) next[key] = value;
        else delete next[key];
      }
      values = next;
      error = '';
      await persist();
    },
  };
}
