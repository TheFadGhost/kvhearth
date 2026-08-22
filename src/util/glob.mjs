function matchToken(pat, p, val, s) {
  const plen = pat.length;
  const c = pat.charCodeAt(p);
  if (c === 63) {
    return p + 1;
  }
  if (c === 42) {
    return -1;
  }
  if (c === 92) {
    if (p + 1 < plen) {
      return pat.charCodeAt(p + 1) === val.charCodeAt(s) ? p + 2 : -1;
    }
    return c === val.charCodeAt(s) ? p + 1 : -1;
  }
  if (c === 91) {
    let i = p + 1;
    let negate = false;
    if (i < plen && pat.charCodeAt(i) === 33) {
      negate = true;
      i += 1;
    }
    let matched = false;
    let first = true;
    while (i < plen && (first || pat.charCodeAt(i) !== 93)) {
      first = false;
      let lo = pat.charCodeAt(i);
      i += 1;
      if (lo === 92 && i < plen) {
        lo = pat.charCodeAt(i);
        i += 1;
      }
      let hi = lo;
      if (
        i + 1 < plen &&
        pat.charCodeAt(i) === 45 &&
        pat.charCodeAt(i + 1) !== 93
      ) {
        i += 1;
        hi = pat.charCodeAt(i);
        i += 1;
        if (hi === 92 && i < plen) {
          hi = pat.charCodeAt(i);
          i += 1;
        }
      }
      const v = val.charCodeAt(s);
      if (v >= lo && v <= hi) {
        matched = true;
      }
    }
    if (i >= plen) {
      return c === val.charCodeAt(s) ? p + 1 : -1;
    }
    i += 1;
    return matched !== negate ? i : -1;
  }
  return c === val.charCodeAt(s) ? p + 1 : -1;
}

export function globMatch(pattern, value) {
  const plen = pattern.length;
  const vlen = value.length;
  let p = 0;
  let s = 0;
  let starP = -1;
  let starS = 0;
  while (s < vlen) {
    const t = p < plen ? matchToken(pattern, p, value, s) : -1;
    if (t !== -1) {
      p = t;
      s += 1;
    } else if (p < plen && pattern.charCodeAt(p) === 42) {
      starP = p;
      starS = s;
      p += 1;
    } else if (starP !== -1) {
      p = starP + 1;
      starS += 1;
      s = starS;
    } else {
      return false;
    }
  }
  while (p < plen && pattern.charCodeAt(p) === 42) {
    p += 1;
  }
  return p === plen;
}

export default globMatch;
