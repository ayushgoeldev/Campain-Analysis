import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import api from './routes/api.js';

dotenv.config();

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '5mb' }));
app.use('/api', api);
app.use(express.static(path.join(here, '..', 'public')));

const port = Number(process.env.PORT || 3000);

// Only listen when run directly (so it can also be imported by a test/serverless).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(port, () => console.log(`Lead Report App on http://localhost:${port}`));
}

export default app;
