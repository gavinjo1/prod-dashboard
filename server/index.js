import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { pool } from './db.js';
import { loomRouter } from './routes/loom.js';
import { faultHandler } from './errors.js';
import { limit } from './ratelimit.js';
import { requireLogin } from './auth.js';
import { router as authRoutes } from './routes/auth.js';
import { router as usersRoutes } from './routes/users.js';
import { router as filtersRoutes } from './routes/filters.js';
import { router as productionRoutes } from './routes/production.js';
import { router as targetsRoutes } from './routes/targets.js';
import { router as pabrikRoutes } from './routes/pabrik.js';
import { router as machinesRoutes } from './routes/machines.js';
import { router as searchRoutes } from './routes/search.js';
import { router as ordersRoutes } from './routes/orders.js';
import { router as qualityRoutes } from './routes/quality.js';
import { router as gabunganRoutes } from './routes/gabungan.js';
import { router as entryRoutes } from './routes/entry.js';
import { router as importsRoutes } from './routes/imports.js';
import { router as exportRoutes } from './routes/export.js';
import { router as efisiensiRoutes } from './routes/efisiensi.js';
import { router as shiftInputRoutes } from './routes/shift-input.js';
import { router as masterRoutes } from './routes/master.js';
import { router as registryRoutes } from './routes/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Routes must match case exactly. Express matches them case-insensitively by
// default, while the session guard below decides by a case-sensitive prefix —
// so GET /API/summary skipped the guard and still reached /api/summary,
// returning the mill's data to anyone. This has to be set before the first
// app.use: the router is created then, and reads the setting only once.
app.set('case sensitive routing', true);
app.use(express.json());

if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is not set — sign-in cannot work. Add it to .env.');
  process.exit(1);
}

// Behind Caddy every request arrives from the proxy, so req.ip would be the
// same container address for everybody and one attacker would rate-limit the
// whole mill. TRUST_PROXY is the number of proxies in front (1 for Caddy).
//
// It is only safe because the app publishes on 127.0.0.1 and Caddy is the one
// way in: reachable directly, anyone could forge X-Forwarded-For and dodge
// every limit below.
app.set('trust proxy', Number(process.env.TRUST_PROXY || 0));

// A ceiling on everything, well above what clicking around produces — the
// dashboard fires about a dozen requests per panel — but low enough that
// scraping the whole history is not free.
app.use('/api', limit({
  windowMs: 60_000, max: 300, prefix: 'api',
  message: 'Terlalu banyak permintaan. Tunggu sebentar.'
}));

// Ahead of every route, so nothing under /api can be reached without a session.
app.use(requireLogin);

// One router per feature, in the order the routes were first written.
app.use(authRoutes);
app.use(usersRoutes);
app.use(filtersRoutes);
app.use(productionRoutes);
app.use(targetsRoutes);
app.use(pabrikRoutes);
app.use(machinesRoutes);
app.use(searchRoutes);
app.use(ordersRoutes);
app.use(qualityRoutes);
app.use(gabunganRoutes);
app.use(entryRoutes);
app.use(importsRoutes);
app.use(exportRoutes);
app.use(efisiensiRoutes);
app.use(shiftInputRoutes);
app.use(masterRoutes);
app.use(registryRoutes);

// The factory's own loom monitoring data, on its own router and its own
// database. Mounted here only so both are served from one port.
app.use('/api/loom', loomRouter);

app.use(express.static(path.join(__dirname, '..', 'public')));

// Registered last, so it catches whatever every route and middleware above let
// through. Without it Express answers with an HTML page carrying the stack
// trace and, for a database fault, the table and column names.
app.use(faultHandler);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Machine dashboard on http://localhost:${port}`));

process.on('SIGINT', async () => { await pool.end(); process.exit(0); });
