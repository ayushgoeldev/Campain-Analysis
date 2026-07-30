import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '.env') });

// Now import and start the server
const { default: app } = await import('./server.js');
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Lead Report App on http://localhost:${port}`));