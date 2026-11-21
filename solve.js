// Fast CSV reader, byte-identical to csv-reader 1.0.0 on every input.
// Strategy: most records are plain lines with no quotes and no stray CR.
// Those are handled by one slice + one split per line (the line fast path).
// Anything with a quote, a stray CR, or a multiline field falls through to
// a field-by-field slow path that reproduces the reference semantics
// exactly, including every error code and its line/row attribution.
//
// Reference semantics reproduced here:
//  - U+FEFF at offset 0 is dropped.
//  - A record ends at LF or CRLF. A zero-length line is not a record; the
//    blank-line skip at a record start only eats LF and CRLF, never a lone CR.
//  - Outside quotes a CR not followed by LF is dropped and reported as
//    stray_cr (one error per CR).
//  - A quoted field runs to the closing quote that is not part of a doubled
//    pair ("" inside quotes is one literal "). CRLF / lone CR inside quotes
//    read as LF. Anything after the closing quote up to the next comma or
//    line break is appended as-is; if anything was appended that is
//    quote_junk. A quote that never closes is literal and the text after it
//    is re-read as unquoted (unterminated_quote, recorded before the re-read,
//    with the line reset to the line where the quote opened).
//  - A quote inside an unquoted field is literal. Fields stay strings.
//  - columns is the first record when header is true ( [] when there is no
//    record at all), else null. Later records are padded with "" (short_row,
//    with fields: <field count>) or cut (long_row, with extra: <cut fields>)
//    to the first record's width.
//  - Errors are {code, line, row} in order of occurrence; line is the
//    1-based line where the record STARTED (counting LF, CRLF and lone CR
//    inside quotes); row is the record's index in rows (null for the header).
//    Field-level errors are recorded when they happen; short/long_row when
//    the record ends. quote_junk is recorded after the junk is read, so a
//    stray_cr inside junk is reported first.
//  - A record that is a single unquoted empty field ([''], quoted=false) is
//    skipped entirely; a single quoted empty field ("") is a real record.

const COMMA = 0;
const BREAK = 1;
const EOF = 2;

export function run(input) {
  const text = input.text;
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  for (;;) {
    // Skip blank lines at the start of a record: LF and CRLF only.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else break;
    }
    if (pos >= len) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;

    // ----- line fast path -----
    // Slice one physical line first, so every check below is bounded by
    // that line instead of scanning into the rest of the file.
    const eol = text.indexOf('\n', pos);
    const lineEnd0 = eol === -1 ? len : eol;
    const raw = text.slice(pos, lineEnd0);
    let fields = null;
    let quoted = false;
    if (raw.indexOf('"') === -1) {
      if (raw.length > 0 && raw.charCodeAt(raw.length - 1) === 13) {
        // Ends in CR: only a CRLF ending is clean; a lone CR at EOF or a
        // stray CR anywhere else goes to the slow path.
        if (eol !== -1) {
          const body = raw.slice(0, -1);
          if (body.length > 0 && body.indexOf('\r') === -1) {
            fields = body.split(',');
            pos = eol + 1;
            line += 1;
          }
        }
      } else if (raw.indexOf('\r') === -1) {
        if (raw.length > 0) {
          fields = raw.split(',');
          pos = eol === -1 ? len : eol + 1;
          line += 1;
        } else {
          // Empty line (only reachable if the blank skip above missed it).
          pos = eol === -1 ? len : eol + 1;
          line += 1;
          continue;
        }
      }
      // A stray CR inside the line falls through to the slow path.
    }

    if (fields === null) {
      // ----- slow path: one field at a time, plain locals -----
      fields = [];
      let ended = EOF;
      // End of the current physical line; refreshed after any quoted field
      // (which may span lines) and after each line break.
      let lineEnd = eol;
      for (;;) {
        quoted = text.charCodeAt(pos) === 34;
        let value;
        if (!quoted) {
          const comma = text.indexOf(',', pos);
          if (comma !== -1 && (lineEnd === -1 || comma < lineEnd)) {
            value = text.slice(pos, comma);
            if (value.indexOf('\r') !== -1) {
              let n = 0;
              for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 13) n++;
              for (let i = 0; i < n; i++) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
              value = value.replaceAll('\r', '');
            }
            pos = comma + 1;
            ended = COMMA;
          } else if (lineEnd !== -1) {
            value = text.slice(pos, lineEnd);
            if (value.indexOf('\r') !== -1) {
              // A trailing CR here pairs with the line's LF (CRLF, no error).
              let body = value.charCodeAt(value.length - 1) === 13 ? value.slice(0, -1) : value;
              if (body.indexOf('\r') !== -1) {
                let n = 0;
                for (let i = 0; i < body.length; i++) if (body.charCodeAt(i) === 13) n++;
                for (let i = 0; i < n; i++) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
                body = body.replaceAll('\r', '');
              }
              value = body;
            }
            pos = lineEnd + 1;
            line += 1;
            lineEnd = text.indexOf('\n', pos);
            ended = BREAK;
          } else {
            value = text.slice(pos, len);
            if (value.indexOf('\r') !== -1) {
              let n = 0;
              for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 13) n++;
              for (let i = 0; i < n; i++) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
              value = value.replaceAll('\r', '');
            }
            pos = len;
            ended = EOF;
          }
        } else {
          const open = pos;
          const openLine = line;
          let q = text.indexOf('"', open + 1);
          while (q !== -1 && text.charCodeAt(q + 1) === 34) q = text.indexOf('"', q + 2);
          if (q === -1) {
            // Unterminated quote: the quote is literal; re-read the rest
            // of the field as unquoted, starting right after the quote.
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            pos = open + 1;
            line = openLine;
            lineEnd = text.indexOf('\n', pos);
            value = '"';
            for (;;) {
              if (pos >= len) {
                ended = EOF;
                break;
              }
              const code = text.charCodeAt(pos);
              if (code === 44) {
                pos += 1;
                ended = COMMA;
                break;
              }
              if (code === 10) {
                pos += 1;
                line += 1;
                lineEnd = text.indexOf('\n', pos);
                ended = BREAK;
                break;
              }
              if (code === 13) {
                if (text.charCodeAt(pos + 1) === 10) {
                  pos += 2;
                  line += 1;
                  lineEnd = text.indexOf('\n', pos);
                  ended = BREAK;
                  break;
                }
                errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
                pos += 1;
                continue;
              }
              value += text[pos];
              pos += 1;
            }
          } else {
            let content = text.slice(open + 1, q);
            if (content.indexOf('\n') !== -1 || content.indexOf('\r') !== -1) {
              // Count physical line breaks: each LF, plus each CR not
              // followed by LF (a CRLF pair is one break).
              let breaks = 0;
              for (let i = 0; i < content.length; i++) {
                const cc = content.charCodeAt(i);
                if (cc === 10) breaks++;
                else if (cc === 13 && content.charCodeAt(i + 1) !== 10) breaks++;
              }
              line += breaks;
              content = content.replace(/\r\n?/g, '\n');
            }
            if (content.indexOf('""') !== -1) content = content.replaceAll('""', '"');
            value = content;
            pos = q + 1;
            if (pos >= len) {
              ended = EOF;
            } else {
              const next = text.charCodeAt(pos);
              if (next === 44) {
                pos += 1;
                ended = COMMA;
              } else if (next === 10) {
                pos += 1;
                line += 1;
                ended = BREAK;
              } else if (next === 13 && text.charCodeAt(pos + 1) === 10) {
                pos += 2;
                line += 1;
                ended = BREAK;
              } else {
                // Junk after the closing quote, appended as it stands.
                let added = 0;
                for (;;) {
                  if (pos >= len) {
                    ended = EOF;
                    break;
                  }
                  const code = text.charCodeAt(pos);
                  if (code === 44) {
                    pos += 1;
                    ended = COMMA;
                    break;
                  }
                  if (code === 10) {
                    pos += 1;
                    line += 1;
                    ended = BREAK;
                    break;
                  }
                  if (code === 13) {
                    if (text.charCodeAt(pos + 1) === 10) {
                      pos += 2;
                      line += 1;
                      ended = BREAK;
                      break;
                    }
                    errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
                    pos += 1;
                    continue;
                  }
                  value += text[pos];
                  added += 1;
                  pos += 1;
                }
                if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              }
            }
            lineEnd = text.indexOf('\n', pos);
          }
        }
        fields.push(value);
        if (ended !== COMMA) break;
      }
    }

    // A record that is one unquoted empty field is not a record at all.
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
