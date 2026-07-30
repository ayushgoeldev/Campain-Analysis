// Vercel serverless entry point.
// Vercel routes /api/* here (see vercel.json); the Express app then routes
// normally. Static files in /public are served directly by Vercel's CDN.
import app from '../src/server.js';

export default app;
