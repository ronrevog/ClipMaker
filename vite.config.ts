import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { handleCopilotRequest } from './api/ai-copilot';
import { handleStyleCloneRequest } from './api/ai-style-clone';
import { handleAnalyzeVideoRequest } from './api/ai-analyze-video';
import { getServerAIStatus } from './api/ai-status';

function vercelApiLocalDevPlugin(): Plugin {
  return {
    name: 'vercel-api-local-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.method === 'GET' && req.url === '/api/ai-status') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(getServerAIStatus()));
          return;
        }

        if (
          req.method === 'POST' &&
          (req.url === '/api/ai-copilot' ||
            req.url === '/api/ai-style-clone' ||
            req.url === '/api/ai-analyze-video')
        ) {
          let rawBody = '';
          req.on('data', (chunk) => {
            rawBody += chunk;
          });
          req.on('end', async () => {
            try {
              const parsed = JSON.parse(rawBody || '{}');
              const result =
                req.url === '/api/ai-copilot'
                  ? await handleCopilotRequest(parsed)
                  : req.url === '/api/ai-style-clone'
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
