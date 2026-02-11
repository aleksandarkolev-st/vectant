/**
 * Open VSX Registry API Proxy
 * Proxies requests to open-vsx.org to avoid CORS issues in the browser.
 * 
 * GET /api/extensions/search?action=search&query=...&offset=0&size=20
 * GET /api/extensions/search?action=detail&namespace=...&extension=...
 * GET /api/extensions/search?action=proxy&url=<open-vsx.org URL>       (JSON/text)
 * GET /api/extensions/search?action=download-vsix&namespace=...&extension=...&version=...  (binary)
 */

import { NextResponse } from 'next/server';

const OPEN_VSX_BASE = 'https://open-vsx.org/api';
const OPEN_VSX_ORIGIN = 'https://open-vsx.org';
const REQUEST_TIMEOUT = 15000;   // 15s for JSON API calls
const VSIX_DL_TIMEOUT = 120000;  // 120s for large VSIX binary downloads

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || 'search';

    // ── action=proxy: proxy an arbitrary open-vsx.org URL (JSON/text) ──
    if (action === 'proxy') {
      const targetUrl = searchParams.get('url');
      if (!targetUrl || !targetUrl.startsWith(OPEN_VSX_ORIGIN)) {
        return NextResponse.json(
          { error: 'url parameter must be an open-vsx.org URL' },
          { status: 400 }
        );
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      const response = await fetch(targetUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) {
        return NextResponse.json(
          { error: `Open VSX returned ${response.status}` },
          { status: response.status }
        );
      }
      const text = await response.text();
      // Try to return as JSON if it parses, otherwise plain text
      try {
        const json = JSON.parse(text);
        return NextResponse.json(json, {
          headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
        });
      } catch {
        return new Response(text, {
          headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, s-maxage=300' },
        });
      }
    }

    // ── action=download-vsix: proxy a VSIX binary download ──
    if (action === 'download-vsix') {
      const namespace = searchParams.get('namespace');
      const extension = searchParams.get('extension');
      const version = searchParams.get('version');
      if (!namespace || !extension) {
        return NextResponse.json(
          { error: 'namespace and extension are required' },
          { status: 400 }
        );
      }

      // --- Stage 1: Fetch extension detail to find the download URL ---
      const versionPath = version ? `/${version}` : '';
      const detailUrl = `${OPEN_VSX_BASE}/${namespace}/${extension}${versionPath}`;
      const detailCtrl = new AbortController();
      const detailTimer = setTimeout(() => detailCtrl.abort(), REQUEST_TIMEOUT);
      let detail;
      try {
        const detailRes = await fetch(detailUrl, {
          headers: { 'Accept': 'application/json' },
          signal: detailCtrl.signal,
        });
        clearTimeout(detailTimer);
        if (!detailRes.ok) {
          return NextResponse.json(
            { error: `Detail fetch failed: ${detailRes.status}` },
            { status: detailRes.status }
          );
        }
        detail = await detailRes.json();
      } catch (e) {
        clearTimeout(detailTimer);
        console.error(`[Open VSX Proxy] Detail fetch error for ${namespace}/${extension}:`, e.message);
        const status = e.name === 'AbortError' ? 504 : 502;
        return NextResponse.json({ error: `Detail fetch failed: ${e.message}` }, { status });
      }

      // Prefer the web target platform download if available
      let vsixDownloadUrl = detail.files?.download;
      if (vsixDownloadUrl && !vsixDownloadUrl.includes('targetPlatform=web')) {
        try {
          const webDetailUrl = `${detailUrl}?targetPlatform=web`;
          const webCtrl = new AbortController();
          const webTimer = setTimeout(() => webCtrl.abort(), REQUEST_TIMEOUT);
          const webRes = await fetch(webDetailUrl, {
            headers: { 'Accept': 'application/json' },
            signal: webCtrl.signal,
          });
          clearTimeout(webTimer);
          if (webRes.ok) {
            const webDetail = await webRes.json();
            if (webDetail.files?.download) {
              vsixDownloadUrl = webDetail.files.download;
            }
          }
        } catch (_) {
          // Fall back to default download URL
        }
      }
      if (!vsixDownloadUrl) {
        return NextResponse.json(
          { error: 'No download URL found for this extension' },
          { status: 404 }
        );
      }

      // --- Stage 2: Download the actual VSIX binary (may be 10-20MB) ---
      const dlCtrl = new AbortController();
      const dlTimer = setTimeout(() => dlCtrl.abort(), VSIX_DL_TIMEOUT);
      let vsixRes;
      try {
        vsixRes = await fetch(vsixDownloadUrl, { signal: dlCtrl.signal });
        clearTimeout(dlTimer);
      } catch (e) {
        clearTimeout(dlTimer);
        console.error(`[Open VSX Proxy] VSIX download error for ${namespace}/${extension}:`, e.message);
        const status = e.name === 'AbortError' ? 504 : 502;
        return NextResponse.json({ error: `VSIX download failed: ${e.message}` }, { status });
      }
      if (!vsixRes.ok) {
        return NextResponse.json(
          { error: `VSIX download failed: ${vsixRes.status}` },
          { status: vsixRes.status }
        );
      }

      // Stream the binary body through instead of buffering the entire
      // VSIX in memory — avoids OOM / timeout for large extensions.
      return new Response(vsixRes.body, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${namespace}.${extension}.vsix"`,
          'Content-Length': vsixRes.headers.get('content-length') || '',
          'Cache-Control': 'public, s-maxage=3600',
        },
      });
    }

    // ── action=search (default) ──
    let url;
    if (action === 'search') {
      const query = searchParams.get('query') || '';
      const offset = searchParams.get('offset') || '0';
      const size = searchParams.get('size') || '20';
      const category = searchParams.get('category') || '';
      const sortBy = searchParams.get('sortBy') || 'relevance';
      const sortOrder = searchParams.get('sortOrder') || 'desc';

      const params = new URLSearchParams({
        query,
        offset,
        size,
        sortBy,
        sortOrder,
      });
      if (category) params.set('category', category);
      
      url = `${OPEN_VSX_BASE}/-/search?${params.toString()}`;
    } else if (action === 'detail') {
      const namespace = searchParams.get('namespace');
      const extension = searchParams.get('extension');
      if (!namespace || !extension) {
        return NextResponse.json(
          { error: 'namespace and extension are required' },
          { status: 400 }
        );
      }
      url = `${OPEN_VSX_BASE}/${namespace}/${extension}`;
    } else {
      return NextResponse.json(
        { error: `Unknown action: ${action}` },
        { status: 400 }
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return NextResponse.json(
        { error: `Open VSX API returned ${response.status}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      },
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      return NextResponse.json(
        { error: 'Open VSX API request timed out' },
        { status: 504 }
      );
    }
    console.error('[Open VSX Proxy] Error:', err);
    return NextResponse.json(
      { error: err.message },
      { status: 500 }
    );
  }
}
