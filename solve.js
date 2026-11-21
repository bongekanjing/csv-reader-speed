// A faster drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// run(input) returns, for a case's input {text, header}, exactly the answer
// csv-reader 1.0.0 returns: {columns, rows, errors}. It reproduces csv-reader's
// broken-row policy exactly:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it is one quote and each CRLF or lone CR inside it is read as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended as it stands (quote_junk, when the field ends); a quote that never
//     closes is a literal character, and the text after it is read again as
//     unquoted (unterminated_quote); a quote inside an unquoted field is literal;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it (every record when header is false), each padded with ""
//     (short_row, with fields: its field count) or cut (long_row, with extra:
//     the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met, a record's short_row or
//     long_row when it ends: line the 1-based line its record starts on,
//     counting every LF, CRLF and lone CR inside quotes, and row its record's
//     index in rows, null for the header.
//
// How it is faster: the reference reads one character at a time and builds each
// field up a character at a time. This one finds each field's end with indexOf
// jumps and takes the field with one slice. The next line break and the next CR
// are cached (fields are read left to right, so a rescan starts where the last
// one left off and the total scanning for them stays linear), so an unquoted
// field costs one indexOf for its comma plus a slice. A record with no quote
// and no stray CR in it is one slice plus a split. The only per-character work
// left is inside quoted fields that span lines or hold doubled quotes, which
// are a small share of fields. No clock, no randomness, no locale, nothing kept
// from one call to the next.

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text (the record ends). */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The next LF / CR at or after pos: -1 when unknown, Infinity when there is none left.
  // Fields are read left to right, so a rescan starts where the last one left off
  // and the total scanning for them stays linear in the text.
  let nextNL = -1;
  let nextCR = -1;

  // The field just read: its value, how it ended, and how many characters the
  // unquoted scan kept (for quote_junk).
  let outValue = '';
  let outEnded = END;
  let outAdded = 0;

  /** Refresh nextNL to the first LF at or after `from` (Infinity: none left). */
  function refreshNL(from) {
    if (nextNL < from) {
      const n = text.indexOf('\n', from);
      nextNL = n === -1 ? Infinity : n;
    }
  }

  /** Refresh nextCR to the first CR at or after `from` (Infinity: none left). */
  function refreshCR(from) {
    if (nextCR < from) {
      const r = text.indexOf('\r', from);
      nextCR = r === -1 ? Infinity : r;
    }
  }

  /** Appends text[a..b) to value, turning each CRLF or lone CR inside it into LF
   *  and counting every line break in `line`. Returns the new value. */
  function appendSeg(a, b, value) {
    const n = text.indexOf('\n', a);
    if (n !== -1 && n < b) return appendSegSlow(a, b, value);
    refreshCR(a);
    if (nextCR !== Infinity && nextCR < b) return appendSegSlow(a, b, value);
    return value + text.slice(a, b);
  }

  function appendSegSlow(a, b, value) {
    let p = a;
    while (p < b) {
      let n = text.indexOf('\n', p);
      let r = text.indexOf('\r', p);
      if (n !== -1 && n >= b) n = -1;
      if (r !== -1 && r >= b) r = -1;
      if (n === -1 && r === -1) {
        value += text.slice(p, b);
        break;
      }
      if (n !== -1 && (r === -1 || n < r)) {
        value += text.slice(p, n + 1);
        line += 1;
        p = n + 1;
      } else {
        value += text.slice(p, r);
        value += '\n';
        line += 1;
        p = r + (text.charCodeAt(r + 1) === 10 ? 2 : 1);
      }
    }
    return value;
  }

  // Reads an unquoted field from pos, starting from `value`. Sets the out* registers.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      refreshNL(pos);
      refreshCR(pos);
      const c = text.indexOf(',', pos);
      // The field ends at the nearest of the next comma, the next LF and the next CR.
      let idx = c === -1 ? Infinity : c;
      let kind = 0;
      if (nextNL < idx) {
        idx = nextNL;
        kind = 1;
      }
      if (nextCR < idx) {
        idx = nextCR;
        kind = 2;
      }
      if (idx === Infinity) {
        if (pos < len) {
          value += text.slice(pos, len);
          added += len - pos;
          pos = len;
        }
        outValue = value;
        outEnded = END;
        outAdded = added;
        return;
      }
      if (kind === 2) {
        if (text.charCodeAt(idx + 1) === 10) {
          // CRLF: a line break.
          if (idx > pos) {
            value += text.slice(pos, idx);
            added += idx - pos;
          }
          pos = idx + 2;
          line += 1;
          outValue = value;
          outEnded = LINE_BREAK;
          outAdded = added;
          return;
        }
        // A lone CR is dropped (stray_cr).
        if (idx > pos) {
          value += text.slice(pos, idx);
          added += idx - pos;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos = idx + 1;
        continue;
      }
      if (idx > pos) {
        value += text.slice(pos, idx);
        added += idx - pos;
      }
      if (kind === 0) {
        pos = idx + 1;
        outValue = value;
        outEnded = COMMA;
        outAdded = added;
        return;
      }
      pos = idx + 1;
      line += 1;
      outValue = value;
      outEnded = LINE_BREAK;
      outAdded = added;
      return;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Sets the out* registers.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos = open + 1;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after
        // it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        nextNL = -1;
        nextCR = -1;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      if (text.charCodeAt(q + 1) === 34) {
        value = appendSeg(pos, q, value);
        value += '"';
        pos = q + 2;
        continue;
      }
      value = appendSeg(pos, q, value);
      pos = q + 1;
      break;
    }
    if (pos >= len) {
      outValue = value;
      outEnded = END;
      outAdded = 0;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      outValue = value;
      outEnded = COMMA;
      outAdded = 0;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      outValue = value;
      outEnded = LINE_BREAK;
      outAdded = 0;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      outValue = value;
      outEnded = LINE_BREAK;
      outAdded = 0;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    readUnquoted(value);
    if (outAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a record with no quote and no stray CR in it is one slice plus
    // a split. A quote anywhere in it (a quoted field, or a literal quote in an
    // unquoted field) or a CR that is not the CRLF of its line break takes the
    // careful path below. Most records take this path.
    refreshNL(pos);
    const nl = nextNL;
    const recEnd = nl === Infinity ? len : nl;
    const q = text.indexOf('"', pos);
    let fast = q === -1 || q >= recEnd;
    if (fast) {
      refreshCR(pos);
      // A CR at recEnd-1 is the CRLF of this record's line break only when a
      // real LF follows it (nl !== Infinity); a CR at the very end of the text
      // is a lone CR (stray_cr) and takes the careful path.
      fast = nextCR === Infinity || nextCR >= recEnd || (nl !== Infinity && nextCR === recEnd - 1);
    }
    let fields;
    let quoted = false;
    if (fast) {
      const end = nl !== Infinity && nextCR === recEnd - 1 ? recEnd - 1 : recEnd;
      fields = text.slice(pos, end).split(',');
      if (nl === Infinity) {
        pos = len;
      } else {
        pos = nl + 1;
        line += 1;
      }
    } else {
      fields = [];
      do {
        quoted = text.charCodeAt(pos) === 34;
        if (quoted) readQuoted();
        else readUnquoted('');
        fields.push(outValue);
      } while (outEnded === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
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
