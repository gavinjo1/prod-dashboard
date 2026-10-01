import crypto from 'node:crypto';

/**
 * An error whose message is written for the person using the dashboard —
 * "this sheet has an unexpected layout", "the file is empty". Everything
 * else is treated as a fault and its text never leaves the server.
 */
export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.expose = true;
  }
}

/**
 * Wraps an async handler. A PostgreSQL error names tables, columns and
 * sometimes the offending value, so the browser gets a reference code and
 * the detail stays in the server log where it is actually useful.
 */
export const send = (res, fn) => fn().catch((err) => {
  if (err?.expose) return res.status(err.status || 400).json({ error: err.message });

  const ref = crypto.randomBytes(4).toString('hex');
  console.error(`[${ref}]`, err);
  res.status(500).json({
    error: `Terjadi kesalahan di server. Sebutkan kode ini saat melapor: ${ref}`
  });
});

/**
 * The last word on any error that escapes a handler — middleware such as the
 * session check, the upload parser and the JSON body parser throw past send(),
 * and Express's own fallback prints the stack trace and the database's message
 * into the page.
 */
export function faultHandler(err, req, res, next) {   // eslint-disable-line no-unused-vars
  if (res.headersSent) return next(err);

  // Mistakes in the request itself, worded for the person who made them.
  // The parser's own error is checked first: body-parser marks it `expose`,
  // and its message is the parser's English, not ours.
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Isi permintaan bukan JSON yang sah.' });
  }
  if (err?.expose) return res.status(err.status || 400).json({ error: err.message });
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Berkas terlalu besar.' });
  }
  if (typeof err?.code === 'string' && err.code.startsWith('LIMIT_')) {
    return res.status(400).json({ error: 'Unggahan tidak sah.' });
  }

  const ref = crypto.randomBytes(4).toString('hex');
  console.error(`[${ref}]`, err);
  res.status(500).json({
    error: `Terjadi kesalahan di server. Sebutkan kode ini saat melapor: ${ref}`
  });
}
