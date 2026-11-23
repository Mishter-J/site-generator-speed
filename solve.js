// Fast drop-in replacement for makefun-site 1.0.0 (site-generator-speed-01).
//
// run(input) returns exactly the answer makefun-site 1.0.0's build returns for
// the same input: the output tree (each page's index.html, the index and tag
// pages, build-report.txt and each static file), byte for byte. It is a fresh
// implementation of the same rules (README.md of makefun-site 1.0.0, its code
// the reference wherever the two differ), written for speed:
//
//  - Markdown is lexed and rendered in one fused pass over the lines, with no
//    token array and no per-block intermediate strings.
//  - Inline rendering scans plain-text runs in bulk: plain runs are copied
//    whole (they need no escaping by construction), and only the markup
//    characters are handled one by one. The reference escapes every single
//    character with a regex replace; that is the dominant cost of the house
//    baseline.
//  - slugify results are cached (tags and headings re-slugify the same text)
//    and take a fast ASCII path (NFKD is the identity on ASCII).
//  - Templates are parsed once into the same tree the reference builds, then
//    compiled to a plain JavaScript function (new Function) with identical
//    lookup, truthiness, loop and include semantics, so rendering a page is
//    straight-line code instead of a tree walk.
//  - Front matter keeps the body's line array so Markdown never re-splits it.
//
// No dependencies, no I/O, no clock, no randomness: the output is a function
// of the input alone, so two runs are byte-identical.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------------------------------------------ text */

// The HTML escape table, in this order: & < > " '.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), "untitled" when
 * nothing is left.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  // NFKD is the identity on ASCII, and ASCII holds no combining marks.
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/* ------------------------------------------------------------ front matter */

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body lines: { data, bodyLines, body }, or
 * { error } with the first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const bodyLines = lines.slice(close + 1);
  return { data, bodyLines, body: bodyLines.join('\n') };
}

/* --------------------------------------------------------------- markdown */

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return BLANK.test(line);
  if (c === 96) return FENCE_OPEN.test(line); // `
  if (c === 35) return headingOf(line) !== null; // #
  if (c === 45 || c === 42) return HR.test(line); // - *
  return false;
}

/** A line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The next index at or after `from` holding a character inline treats specially, or s.length. */
function nextSpecial(s, from) {
  let j = s.length;
  let k;
  k = s.indexOf('\\', from); if (k !== -1 && k < j) j = k;
  k = s.indexOf('`', from); if (k !== -1 && k < j) j = k;
  k = s.indexOf('*', from); if (k !== -1 && k < j) j = k;
  k = s.indexOf('[', from); if (k !== -1 && k < j) j = k;
  k = s.indexOf('&', from); if (k !== -1 && k < j) j = k;
  k = s.indexOf('<', from); if (k !== -1 && k < j) j = k;
  k = s.indexOf('>', from); if (k !== -1 && k < j) j = k;
  k = s.indexOf('"', from); if (k !== -1 && k < j) j = k;
  k = s.indexOf("'", from); if (k !== -1 && k < j) j = k;
  return j;
}

/**
 * `s` rendered inline, its pieces pushed onto `out`. `env.link(target)` is a
 * link's href. Plain-text runs are pushed whole: a run holds no character
 * that needs escaping by construction, so no per-character escape is needed.
 * The next markup character is found with indexOf scans (C++ speed) instead
 * of a per-character JavaScript loop.
 */
function inline(s, env, out) {
  let start = 0; // start of the unflushed plain run
  let pos = 0; // where the scan resumes
  const n = s.length;
  for (;;) {
    const j = nextSpecial(s, pos);
    if (j === n) break;
    const c = s[j];
    if (c === '\\') { // backslash
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        if (j > start) out.push(s.slice(start, j));
        const nx = s[j + 1];
        out.push(nx === '>' ? '&gt;' : nx);
        pos = j + 2;
        start = pos;
      } else pos = j + 1; // a lone backslash is itself, left in the plain run
      continue;
    }
    if (c === '`') { // backtick: code span, closed by the next backtick
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > start) out.push(s.slice(start, j));
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        pos = k + 1;
        start = pos;
      } else pos = j + 1; // no closer: the backtick is itself
      continue;
    }
    if (c === '*') { // star: strong or emphasis
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > start) out.push(s.slice(start, j));
          out.push('<strong>');
          inline(s.slice(j + 2, k), env, out);
          out.push('</strong>');
          pos = k + 2;
          start = pos;
        } else pos = j + 2;
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          if (j > start) out.push(s.slice(start, j));
          out.push('<em>');
          inline(s.slice(j + 1, k), env, out);
          out.push('</em>');
          pos = k + 1;
          start = pos;
        } else pos = j + 1;
      }
      continue;
    }
    if (c === '[') { // [: a link, or itself
      const k = findUnescaped(s, ']', j + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        if (j > start) out.push(s.slice(start, j));
        out.push('<a href="', escapeHtml(env.link(target)), '">');
        inline(s.slice(j + 1, k), env, out);
        out.push('</a>');
        pos = m + 1;
        start = pos;
      } else pos = j + 1;
      continue;
    }
    // One of & < > " ': an entity of its own.
    if (j > start) out.push(s.slice(start, j));
    out.push(c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
    pos = j + 1;
    start = pos;
  }
  if (n > start) out.push(s.slice(start));
}

/**
 * `lines` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or ""). Lexing and rendering are one
 * pass: no token array, no per-block intermediate strings.
 */
function renderMarkdown(lines, env) {
  const parts = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line.length === 0) {
      i++;
      continue;
    }
    const fc = line.charCodeAt(0);
    if (fc === 32 || fc === 9) { // blank (spaces/tabs only) or a list continuation handled below
      if (BLANK.test(line)) {
        i++;
        continue;
      }
      // A line opening on spaces/tabs is a paragraph line, not a block start.
    } else if (fc === 96) { // ` : a fence may open
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        parts.push(`<pre><code${cls}>`);
        i++;
        while (i < n && !FENCE_CLOSE.test(lines[i])) {
          parts.push(escapeHtml(lines[i]), '\n');
          i++;
        }
        i++;
        parts.push('</code></pre>', '\n');
        continue;
      }
    } else if (fc === 35) { // # : a heading may start
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        parts.push(`<h${heading.depth} id="${id}">`);
        const tmp = [];
        inline(heading.text, env, tmp);
        const html = tmp.join('');
        parts.push(html, `</h${heading.depth}>`, '\n');
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (fc === 45 || fc === 42) { // - * : a thematic break or a list may start
      if (HR.test(line)) {
        parts.push('<hr>', '\n');
        i++;
        continue;
      }
    } else if (fc === 62) { // > : a blockquote
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        i++;
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) parts.push('<blockquote>\n</blockquote>', '\n');
      else {
        parts.push('<blockquote>\n<p>');
        inline(kept.join('\n'), env, parts);
        parts.push('</p>\n</blockquote>', '\n');
      }
      continue;
    }
    // A list: a bullet or an ordered line, then items and continuations.
    const isBulletStart = (fc === 45 || fc === 42) && line.charCodeAt(1) === 32;
    const isOrderedStart = fc >= 48 && fc <= 57;
    if (isBulletStart || isOrderedStart) {
      const bullet = isBulletStart ? BULLET.exec(line) : null;
      const ordered = bullet === null ? ORDERED.exec(line) : null;
      if (bullet !== null || ordered !== null) {
        const isOrdered = ordered !== null;
        const marker = isOrdered ? ORDERED : BULLET;
        const start = isOrdered ? Number(ordered[1]) : 1;
        const items = [];
        while (i < n) {
          const li = lines[i];
          const lc = li.charCodeAt(0);
          const maybeItem = isOrdered
            ? lc >= 48 && lc <= 57
            : (lc === 45 || lc === 42) && li.charCodeAt(1) === 32;
          if (maybeItem) {
            const m = marker.exec(li);
            if (m !== null) {
              items.push([trimLine(isOrdered ? m[2] : m[1])]);
              i++;
              continue;
            }
          }
          if (li.charCodeAt(0) === 32 && li.charCodeAt(1) === 32 && CONTINUED.test(li)) {
            items[items.length - 1].push(trimLine(li));
            i++;
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        parts.push(isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n');
        for (const item of items) {
          parts.push('<li>');
          inline(item.join('\n'), env, parts);
          parts.push('</li>\n');
        }
        parts.push(`</${tag}>`, '\n');
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const text = body.join('\n');
    parts.push('<p>');
    if (excerpt === null) {
      const tmp = [];
      inline(text, env, tmp);
      excerpt = tmp.join('');
      parts.push(excerpt);
    } else {
      inline(text, env, parts);
    }
    parts.push('</p>', '\n');
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

/* -------------------------------------------------------------- templates */

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * A parsed template's nodes compiled to a render function
 * (scope, ctx, depth, out): the same lookup, truthiness, loop and include
 * semantics as the tree walk, as straight-line code. Template content only
 * ever reaches the generated code inside JSON string literals.
 */
function compileTemplate(nodes) {
  const lines = [];
  let uid = 0;
  const genLookup = (path, sv) => {
    const s = `_s${uid}`;
    const v = `_v${uid}`;
    uid++;
    lines.push(`let ${s}=${sv};while(${s}!==null&&!Object.hasOwn(${s}.vars,${JSON.stringify(path[0])}))${s}=${s}.parent;`);
    lines.push(`let ${v}=${s}===null?void 0:${s}.vars[${JSON.stringify(path[0])}];`);
    for (let k = 1; k < path.length; k++) {
      lines.push(`if(${v}===null||typeof ${v}!=="object"||!Object.hasOwn(${v},${JSON.stringify(path[k])}))${v}=void 0;else ${v}=${v}[${JSON.stringify(path[k])}];`);
    }
    return v;
  };
  const genNodes = (ns, sv) => {
    for (const n of ns) {
      if (n.kind === 'text') lines.push(`out.push(${JSON.stringify(n.text)});`);
      else if (n.kind === 'var') lines.push(`out.push(ctx.escape(ctx.textOf(${genLookup(n.path, sv)})));`);
      else if (n.kind === 'raw') lines.push(`out.push(ctx.textOf(${genLookup(n.path, sv)}));`);
      else if (n.kind === 'if') {
        const v = genLookup(n.path, sv);
        lines.push(n.not ? `if(!ctx.truthy(${v})){` : `if(ctx.truthy(${v})){`);
        genNodes(n.then, sv);
        if (n.else !== null) {
          lines.push('}else{');
          genNodes(n.else, sv);
        }
        lines.push('}');
      } else if (n.kind === 'for') {
        const xs = genLookup(n.path, sv);
        const k = uid++;
        const sc = `sc${uid++}`;
        lines.push(`if(Array.isArray(${xs})){for(let _k${k}=0;_k${k}<${xs}.length;_k${k}++){const _x${k}=${xs}[_k${k}];const ${sc}={vars:{},parent:${sv}};${sc}.vars[${JSON.stringify(n.name)}]=_x${k};${sc}.vars.loop={index:_k${k}+1,first:_k${k}===0,last:_k${k}===${xs}.length-1,length:${xs}.length};`);
        genNodes(n.body, sc);
        lines.push('}}');
      } else if (n.kind === 'include') {
        const t = `_t${uid++}`;
        lines.push(`{const ${t}=ctx.fns.get(${JSON.stringify(n.name)});if(${t}!==void 0&&depth<${INCLUDE_DEPTH})${t}(${sv},ctx,depth+1,out);}`);
      }
    }
  };
  genNodes(nodes, 'scope');
  return new Function('scope', 'ctx', 'depth', 'out', lines.join('\n'));
}

/** Compiled templates, keyed by their source: identical sources share one function. */
const compiledCache = new Map();

/* ------------------------------------------------------------------- build */

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // JavaScript \s: \t \n \v \f \r space, U+00A0 U+1680 U+2000-U+200A
    // U+2028 U+2029 U+202F U+205F U+3000 U+FEFF.
    const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12
      || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232
      || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** One site's output tree: path -> text. */
export function build(input) {
  const report = [];
  const fns = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    const src = input.templates[name];
    try {
      const nodes = parseTemplate(name, src);
      let fn = compiledCache.get(src);
      if (fn === undefined) {
        fn = compileTemplate(nodes);
        compiledCache.set(src, fn);
      }
      fns.set(name, fn);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const ctx = { escape: escapeHtml, textOf, truthy, fns };

  // 1. The sources, in code-unit order of their paths; a source that is not
  // .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped,
  // and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.bodyLines = fm.bodyLines;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!fns.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its
  // directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static
  // files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.bodyLines, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and
  // older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the
  // posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name)) && seen.add(slugify(name)));
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages
  // through theirs.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const fn = fns.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
