// Fake DOWNLOAD_AGENT module for the test harness. Subclasses http.Agent
// (the same shape proxy-agent / https-proxy-agent expose), records every
// addRequest call to a sidecar JSON file so the test can assert on it,
// and otherwise behaves like a default agent for HTTP and HTTPS.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';

const recordPath = process.env.RECORD_PATH;

class RecordingAgent extends http.Agent {
  addRequest(req, options) {
    if (recordPath) {
      const entry = {
        host: options.host || options.hostname,
        port: options.port,
        path: options.path,
        method: options.method,
        protocol: options.protocol
      };
      fs.appendFileSync(recordPath, JSON.stringify(entry) + '\n');
    }
    const delegate = options.protocol === 'https:' ? https.globalAgent : http.globalAgent;
    return delegate.addRequest(req, options);
  }
}

export default new RecordingAgent();
