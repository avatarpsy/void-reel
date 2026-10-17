/** Dates as people read them. Pure; shared by the grid, the cards and the canvas card. */
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-10-20 -> "Tue 20 Oct 2026". Anything else comes back as it was. */
export function prettyDate(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return v;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return `${WEEKDAY[d.getUTCDay()]} ${+m[3]!} ${MONTH[+m[2]! - 1]} ${m[1]}`;
}

/** 2026-10-20 -> "Tue 20 Oct". */
export function prettyDateShort(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return v;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return `${WEEKDAY[d.getUTCDay()]} ${+m[3]!} ${MONTH[+m[2]! - 1]}`;
}

export { MONTH };
