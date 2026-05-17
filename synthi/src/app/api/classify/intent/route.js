import { proxyAiEngineRequest } from '@/lib/proxyAiEngine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  return proxyAiEngineRequest(request, '/classify/intent');
}
