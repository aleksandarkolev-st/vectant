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
const REQUEST_TIMEOUT = 30000;  // 30s for large VSIX downloads

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
      // First get the detail to find the download URL
      const versionPath = version ? `/${version}` : '';
      const detailUrl = `${OPEN_VSX_BASE}/${namespace}/${extension}${versionPath}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      const detailRes = await fetch(detailUrl, {
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });
      if (!detailRes.ok) {
        clearTimeout(timeout);
        return NextResponse.json(
          { error: `Detail fetch failed: ${detailRes.status}` },
          { status: detailRes.status }
        );
      }
      const detail = await detailRes.json();
      const downloadUrl = detail.files?.download;
      if (!downloadUrl) {
        clearTimeout(timeout);
        return NextResponse.json(
          { error: 'No download URL found for this extension' },
          { status: 404 }
        );
      }
      // Download the actual VSIX binary
      const vsixRes = await fetch(downloadUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!vsixRes.ok) {
        return NextResponse.json(
          { error: `VSIX download failed: ${vsixRes.status}` },
          { status: vsixRes.status }
        );
      }
      const buffer = await vsixRes.arrayBuffer();
      return new Response(buffer, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${namespace}.${extension}.vsix"`,
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
