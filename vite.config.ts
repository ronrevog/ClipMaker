import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { handleCopilotRequest } from './api/ai-copilot';
import { handleStyleCloneRequest } from './api/ai-style-clone';
import { handleAnalyzeVideoRequest } from './api/ai-analyze-video';
import { getServerAIStatus } from './api/ai-status';
import { handleAuthRequest } from './api/auth';
import { handleProjectsRequest } from './api/projects';
import { handleUploadVideoBlob } from './api/upload-video';

function vercelApiLocalDevPlugin(): Plugin {
  return {
    name: 'vercel-api-local-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url || '';
        const urlObj = new URL(rawUrl, 'http://localhost');
        const pathname = urlObj.pathname;

        if (req.method === 'GET' && pathname === '/api/ai-status') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(getServerAIStatus()));
          return;
        }

        if (pathname === '/api/projects') {
          let rawBody = '';
          req.on('data', (chunk) => {
            rawBody += chunk;
          });
          req.on('end', async () => {
            try {
              const parsed = rawBody ? JSON.parse(rawBody) : {};
              const query = { id: urlObj.searchParams.get('id') || undefined };
              const result = await handleProjectsRequest(req.method || 'GET', query, parsed);
              res.statusCode = result.ok ? 200 : 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(result));
            } catch (err: any) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: false, error: err?.message || 'Projects API error' }));
            }
          });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/upload-video') {
          const chunks: Buffer[] = [];
          req.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          req.on('end', async () => {
            try {
              const fileName = urlObj.searchParams.get('filename') || 'video.mp4';
              const contentType = req.headers['content-type'] || 'video/mp4';
              const result = await handleUploadVideoBlob(
                fileName,
                contentType,
                Buffer.concat(chunks)
              );
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(result));
            } catch (err: any) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: false, error: err?.message || 'Upload error' }));
            }
          });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/auth') {
          let rawBody = '';
          req.on('data', (chunk) => {
            rawBody += chunk;
          });
          req.on('end', () => {
            try {
              const parsed = JSON.parse(rawBody || '{}');
              const result = handleAuthRequest(parsed);
              res.statusCode = result.ok ? 200 : 403;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(result));
            } catch (err: any) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: false, error: err?.message || 'Auth error' }));
            }
          });
          return;
        }

        if (
          req.method === 'POST' &&
          (pathname === '/api/ai-copilot' ||
            pathname === '/api/ai-style-clone' ||
            pathname === '/api/ai-analyze-video')
        ) {
          let rawBody = '';
          req.on('data', (chunk) => {
            rawBody += chunk;
          });
          req.on('end', async () => {
            try {
              const parsed = JSON.parse(rawBody || '{}');
              const result =
                pathname === '/api/ai-copilot'
                  ? await handleCopilotRequest(parsed)
                  : pathname === '/api/ai-style-clone'
                    ? await handleStyleCloneRequest(parsed)
                    : await handleAnalyzeVideoRequest(parsed);
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(result));
            } catch (err: any) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err?.message || 'API error' }));
            }
          });
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  Object.assign(process.env, env);

  return {
    plugins: [react(), vercelApiLocalDevPlugin()],
    server: {
      port: 5173,
    },
  };
});
