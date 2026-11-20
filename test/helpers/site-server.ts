/**
 * Small test site. Pages are served on `localhost` (first party); `127.0.0.1` plays the
 * third party, so both hosts point at the same server.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestSite {
  firstParty: string;
  thirdParty: string;
  /** Change what a script returns, e.g. to simulate a compromised vendor. */
  setScript(path: string, body: string): void;
  close(): Promise<void>;
}

export async function startTestSite(): Promise<TestSite> {
  const scripts = new Map<string, string>([
    ['/first-party.js', 'window.firstParty = true;'],
    ['/vendor.js', 'window.vendor = function () { return 1; };'],
    ['/after-consent.js', 'window.afterConsent = true;'],
    ['/lazy.js', 'window.lazy = true;'],
    ['/page2-only.js', 'window.page2 = true;'],
    ['/in-iframe.js', 'window.inIframe = true;'],
  ]);
  let port = 0;
  const third = () => `http://127.0.0.1:${port}`;

  const pages: Record<string, () => string> = {
    '/': () => `<!doctype html><html><body>
      <script src="/first-party.js"></script>
      <script src="${third()}/vendor.js?v=1"></script>
      <div id="banner"></div>
      <script>
        const root = document.getElementById('banner').attachShadow({ mode: 'open' });
        root.innerHTML = '<button class="accept">Accept all</button>';
        root.querySelector('.accept').addEventListener('click', () => {
          const s = document.createElement('script');
          s.src = '${third()}/after-consent.js';
          document.head.appendChild(s);
        });
      </script>
      <iframe src="${third()}/frame"></iframe>
      <div style="height: 4000px"></div>
      <div id="bottom">bottom</div>
      <script>
        new IntersectionObserver((entries, observer) => {
          if (entries[0].isIntersecting) {
            observer.disconnect();
            const s = document.createElement('script');
            s.src = '${third()}/lazy.js';
            document.body.appendChild(s);
          }
        }).observe(document.getElementById('bottom'));
      </script>
    </body></html>`,
    '/page2': () => `<!doctype html><html><body>
      <script src="${third()}/vendor.js?v=1"></script>
      <script src="${third()}/page2-only.js"></script>
    </body></html>`,
    '/frame': () =>
      `<!doctype html><html><body><script src="/in-iframe.js"></script></body></html>`,
  };

  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    const script = scripts.get(path);
    if (script !== undefined) {
      response.writeHead(200, {
        'content-type': 'text/javascript',
        'cache-control': 'max-age=3600',
      });
      response.end(script);
      return;
    }
    const page = pages[path];
    if (page) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(page());
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  // localhost has to resolve to the same server; Chromium maps it to the loopback address
  return {
    firstParty: `http://localhost:${port}`,
    thirdParty: third(),
    setScript(path, body) {
      scripts.set(path, body);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
