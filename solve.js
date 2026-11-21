// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Returns exactly csv-reader 1.0.0's answer {columns, rows, errors} for every
// input {text, header}. Same broken-row policy, byte for byte:
//   - U+FEFF at the very start is dropped
//   - a record ends at LF or CRLF; a line with no characters is no record
//   - outside quotes a CR not followed by LF is dropped (stray_cr)
//   - a field opening with a quote runs to the next non-doubled quote ("" is one
//     quote; CRLF / lone CR inside read as LF); what follows the closing quote
//     up to the next comma or line break is appended as it stands (quote_junk,
//     when the field ends); a quote that never closes is a literal character and
//     the text after it is read again as unquoted (unterminated_quote)
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted
//   - columns is the first record when header is true, else null; rows are the
//     records after it, each padded (short_row, fields: its count) or cut
//     (long_row, extra: the cut fields) to the first record's width
//   - each error is {code, line, row} in the order met; line is the 1-based
//     line its record starts on (every LF, CRLF and lone CR inside quotes
//     counted), row its record's index in rows, null for the header.
//
// Speed comes from never reading the text one character at a time: unquoted
// fields are cut with two native indexOf scans and one slice, quoted fields
// jump from quote to quote, and the only per-character work is the rare
// stray-CR fixup inside a field. No state is kept between calls.

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

  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and its index in rows (null: header).
  let recordLine = 1;
  let recordRow = null;

  // Scratch results of readUnquoted (avoids one object per field).
  let uValue = '';
  let uEnded = END;
  let uAdded = 0;

  // Reads an unquoted field starting at pos, appending onto `prefix` ("" for a
  // plain field, the opening quote for an unterminated one, the quoted value
  // for the junk after a closing quote). Sets uValue/uEnded/uAdded and moves
  // pos/line. `uAdded` counts the characters kept after the prefix.
  function readUnquoted(prefix) {
    let comma = text.indexOf(',', pos);
    let nl = text.indexOf('\n', pos);
    let d;
    let ended;
    if (comma === -1 && nl === -1) {
      d = n;
      ended = END;
    } else if (comma === -1) {
      d = nl;
      ended = LINE_BREAK;
    } else if (nl === -1) {
      d = comma;
      ended = COMMA;
    } else if (comma < nl) {
      d = comma;
      ended = COMMA;
    } else {
      d = nl;
      ended = LINE_BREAK;
    }
    let value = prefix === '' ? text.slice(pos, d) : prefix + text.slice(pos, d);
    const cr = value.indexOf('\r');
    if (cr !== -1) {
      // A CR at the very end before a line break is the CRLF that ends the
      // record (no error); every other CR is a stray one: dropped, one
      // stray_cr error each, in the order met.
      if (ended === LINE_BREAK && cr === value.length - 1) {
        value = value.slice(0, -1);
      } else {
        let out = '';
        let start = 0;
        let strays = 0;
        for (let i = 0; i < value.length; i++) {
          if (value.charCodeAt(i) === 13) {
            if (ended === LINE_BREAK && i === value.length - 1) {
              // the CRLF at the end: strip, no error
            } else {
              strays++;
            }
            out += value.slice(start, i);
            start = i + 1;
          }
        }
        out += value.slice(start);
        value = out;
        for (let k = 0; k < strays; k++) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      }
    }
    // Characters kept after the prefix (a CR never counts: it is dropped, or
    // ends the field as the CRLF). Only the junk-after-a-quote path reads this.
    uAdded = value.length - prefix.length;
    if (ended === COMMA) pos = d + 1;
    else if (ended === LINE_BREAK) {
      pos = d + 1;
      line += 1;
    } else {
      pos = n;
    }
    uValue = value;
    uEnded = ended;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
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
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended;
    let lastQuoted = false;
    do {
        if (text.charCodeAt(pos) === 34) {
        // A field that opens with a quote.
        lastQuoted = true;
        const open = pos;
        const openLine = line;
        let q = pos + 1;
        let segStart = pos + 1;
        let assembled = '';
        let closed = false;
        let closeQ = -1;
        while (true) {
          const qq = text.indexOf('"', q);
          if (qq === -1) break;
          if (text.charCodeAt(qq + 1) === 34) {
            assembled += text.slice(segStart, qq) + '"';
            q = qq + 2;
            segStart = qq + 2;
            continue;
          }
          closeQ = qq;
          closed = true;
          break;
        }
        if (!closed) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          readUnquoted('"');
          fields.push(uValue);
          ended = uEnded;
          continue;
        }
        // The value: the segments with doubled quotes collapsed, CRLF and
        // lone CR inside read as LF. Every line break inside quotes becomes
        // exactly one LF in the value, so the '\n' count is the line advance.
        let value = assembled + text.slice(segStart, closeQ);
        if (value.indexOf('\r') !== -1) value = value.replace(/\r\n?/g, '\n');
        let nlCount = 0;
        let idx = -1;
        while ((idx = value.indexOf('\n', idx + 1)) !== -1) nlCount++;
        line += nlCount;
        const after = closeQ + 1;
        if (after >= n) {
          pos = n;
          ended = END;
        } else {
          const c = text.charCodeAt(after);
          if (c === 44) {
            pos = after + 1;
            ended = COMMA;
          } else if (c === 10) {
            pos = after + 1;
            line += 1;
            ended = LINE_BREAK;
          } else if (c === 13 && text.charCodeAt(after + 1) === 10) {
            pos = after + 2;
            line += 1;
            ended = LINE_BREAK;
          } else {
            // What follows the closing quote is appended as it stands, up to
            // the next comma or line break.
            pos = after;
            readUnquoted(value);
            if (uAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            value = uValue;
            ended = uEnded;
          }
        }
        fields.push(value);
      } else {
        lastQuoted = false;
        readUnquoted('');
        fields.push(uValue);
        ended = uEnded;
      }
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

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
