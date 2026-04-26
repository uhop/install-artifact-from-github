import http from 'node:http';

// Local HTTP server impersonating the bits of GitHub the two CLIs touch.
// install-from-cache hits asset URLs:
//   GET  /:owner/:repo/releases/download/:ver/:asset(.br|.gz|none)
// save-to-github-cache hits the API + an upload URL:
//   GET  /repos/:owner/:repo/releases/tags/:tag    -> {upload_url}
//   POST /_uploads/?name=...&label=...             -> 201, body recorded
//
// Use setAsset(path, body) to pre-stage a download fixture. Anything
// else returns 404. Posted uploads land in `recorded` for assertions.

export const startMockServer = async (opts = {}) => {
  const assets = new Map(); // path -> {body: Buffer, contentType?: string}
  const recorded = []; // {name, label, body, headers}

  const releaseHandler =
    opts.releaseHandler ||
    ((req, res, ctx) => {
      const uploadUrl = `http://${req.headers.host}/_uploads/{?name,label}`;
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({upload_url: uploadUrl, tag_name: ctx.tag}));
    });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // GET /repos/:owner/:repo/releases/tags/:tag
    let m = req.method === 'GET' && pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/releases\/tags\/(.+)$/);
    if (m) {
      const [, owner, repo, tag] = m;
      releaseHandler(req, res, {owner, repo, tag});
      return;
    }

    // POST /_uploads/...?name=...&label=...
    if (req.method === 'POST' && pathname.startsWith('/_uploads')) {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        recorded.push({
          name: url.searchParams.get('name'),
          label: url.searchParams.get('label'),
          body: Buffer.concat(chunks),
          headers: {...req.headers}
        });
        res.writeHead(201, {'content-type': 'application/json'});
        res.end(JSON.stringify({id: recorded.length}));
      });
      return;
    }

    // GET asset
    if (req.method === 'GET') {
      const asset = assets.get(pathname);
      if (asset) {
        res.writeHead(200, {'content-type': asset.contentType || 'application/octet-stream', 'content-length': asset.body.length});
        res.end(asset.body);
        return;
      }
      res.writeHead(404);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const {port} = /** @type {import('node:net').AddressInfo} */ (server.address());

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    recorded,
    setAsset(pathname, body, contentType) {
      assets.set(pathname, {body, contentType});
    },
    clearAssets() {
      assets.clear();
      recorded.length = 0;
    },
    close: () => new Promise(r => server.close(() => r()))
  };
};
