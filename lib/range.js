/** 解析 Range 標頭（只支援單一區間）。回傳 null 表示整個檔案，false 表示範圍不合法。 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (!m[1] && !m[2])) return false;
  let start = m[1] ? Number(m[1]) : size - Number(m[2]);
  let end = m[1] && m[2] ? Number(m[2]) : size - 1;
  if (!m[1]) start = Math.max(0, start);
  end = Math.min(end, size - 1);
  return Number.isSafeInteger(start) && start >= 0 && start <= end ? { start, end } : false;
}
