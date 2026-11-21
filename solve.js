// Fast drop-in for csv-reader 1.0.0 (make.fun): run(input) returns exactly
// csv-reader's {columns, rows, errors} for every {text, header}, but reads in
// bulk instead of one character at a time.
//
// Same policy as the reference (vendor/csv-reader), re-implemented with
// regex scans + String.slice instead of char-by-char concatenation:
//  - U+FEFF at the very start is dropped;
//  - a record ends at LF or CRLF; a line left with no characters is no record;
//  - outside quotes a CR not followed by LF is dropped (stray_cr);
//  - a field opening with a quote runs to the next non-doubled quote ("" is one
//    quote; CRLF / lone CR inside read as LF); junk after the closing quote is
//    appended as it stands (quote_junk, when the field ends); a quote that
//    never closes is a literal character and the text after it is read again
//    as unquoted (unterminated_quote);
//  - a quote inside an unquoted field is literal; fields stay strings;
//  - columns is the first record when header is true, else null; rows are
//    padded (short_row) or cut (long_row) to the first record's width;
//  - each error is {code, line, row}: line is the 1-based line its record
//    starts on, row its record's index in rows (null for the header).
//
// Pure: no clock, no randomness, no locale, nothing kept between calls.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  const len = text.length;
  if (len > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Errors report these, not the live line.
  let recordLine = 1;
  let recordRow = null;

  // Delimiter scanners, one per call (cheap; avoids shared lastIndex state).
  const reUnq = /[,\r\n]/g; // next comma / CR / LF for an unquoted field
  const reQuo = /["\r\n]/g; // next quote / CR / LF inside a quoted field

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field,
  // how it ended, and `added`: the characters kept in this call (the initial
  // `value` is not counted).
  function readUnquoted(value) {
    let added = 0;
    let start = pos;
    let parts = null; // segments kept across stray CRs (null: single slice)
    for (;;) {
      reUnq.lastIndex = pos;
      const m = reUnq.exec(text);
      if (m === null) {
        // End of text: the field is done and pos must reach len, or the
        // caller's loop would re-read the same tail forever.
        pos = len;
        const tail = text.slice(start);
        if (parts === null) return { value: value + tail, ended: END, added: added + tail.length };
        parts.push(tail);
        return { value: value + parts.join(''), ended: END, added: added + tail.length };
      }
      const i = m.index;
      const ch = m[0];
      if (ch === ',') {
        const seg = text.slice(start, i);
        pos = i + 1;
        if (parts === null) return { value: value + seg, ended: COMMA, added: added + seg.length };
        parts.push(seg);
        return { value: value + parts.join(''), ended: COMMA, added: added + seg.length };
      }
      if (ch === '\n') {
        const seg = text.slice(start, i);
        pos = i + 1;
        line += 1;
        if (parts === null) return { value: value + seg, ended: LINE_BREAK, added: added + seg.length };
        parts.push(seg);
        return { value: value + parts.join(''), ended: LINE_BREAK, added: added + seg.length };
      }
      // ch === '\r'
      if (text[i + 1] === '\n') {
        const seg = text.slice(start, i);
        pos = i + 2;
        line += 1;
        if (parts === null) return { value: value + seg, ended: LINE_BREAK, added: added + seg.length };
        parts.push(seg);
        return { value: value + parts.join(''), ended: LINE_BREAK, added: added + seg.length };
      }
      // Stray CR: error, drop it, keep reading the same field.
      error('stray_cr');
      if (parts === null) parts = [];
      const seg = text.slice(start, i);
      added += seg.length;
      parts.push(seg);
      pos = i + 1;
      start = pos;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let parts = null; // segments + inserted chars (null: single slice)
    let start = pos;
    for (;;) {
      reQuo.lastIndex = pos;
      const m = reQuo.exec(text);
      if (m === null) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      const i = m.index;
      const ch = m[0];
      if (ch === '"') {
        if (text[i + 1] === '"') {
          if (parts === null) parts = [];
          parts.push(text.slice(start, i), '"');
          pos = i + 2;
          start = pos;
          continue;
        }
        const seg = text.slice(start, i);
        let value;
        if (parts === null) value = seg;
        else {
          parts.push(seg);
          value = parts.join('');
        }
        pos = i + 1;
        if (pos >= len) return { value, ended: END };
        const c = text[pos];
        if (c === ',') {
          pos += 1;
          return { value, ended: COMMA };
        }
        if (c === '\n') {
          pos += 1;
          line += 1;
          return { value, ended: LINE_BREAK };
        }
        if (c === '\r' && text[pos + 1] === '\n') {
          pos += 2;
          line += 1;
          return { value, ended: LINE_BREAK };
        }
        // What follows the closing quote is appended as it stands, up to the
        // next comma or line break.
        const junk = readUnquoted(value);
        if (junk.added > 0) error('quote_junk');
        return junk;
      }
      if (ch === '\r') {
        // CRLF and a lone CR inside quotes are each one LF.
        if (parts === null) parts = [];
        parts.push(text.slice(start, i), '\n');
        line += 1;
        pos = text[i + 1] === '\n' ? i + 2 : i + 1;
        start = pos;
        continue;
      }
      // ch === '\n': one LF, counted.
      if (parts === null) parts = [];
      parts.push(text.slice(start, i), '\n');
      line += 1;
      pos = i + 1;
      start = pos;
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text[pos];
      if (c === '\n') {
        pos += 1;
        line += 1;
      } else if (c === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted = false;
    do {
      quoted = text[pos] === '"';
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
