const _ON = "bdgklmnrstvz", _CO = "lnrsk", _V = "aeiou";

function _pick(pool: string) { return pool[Math.floor(Math.random() * pool.length)]; }

function _word() {
  const n = Math.random() < 0.15 ? 1 : Math.random() < 0.6 ? 2 : 3;
  let w = "";
  for (let i = 0; i < n; i++) {
    w += _pick(_ON) + _pick(_V);
    if (i === n - 1 && Math.random() < 0.45) w += _pick(_CO);
  }
  return w;
}

function _cap(s: string) { return s[0].toUpperCase() + s.slice(1); }

export function hashSeedWord(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 100000;
}

export function genSeedWord(): string {
  const n = Math.random() > 0.8 ? 1 : Math.random() > 0.4 ? 2 : 3;
  return Array.from({ length: n }, () => _cap(_word())).join("");
}
