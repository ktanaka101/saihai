// 人が読む記録の日付は、手元の日付（ローカル時刻）にする。UTC だと、日本の朝は前の日になる
export function localDate(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
