import { OPTIONS, proxyWorkflowBridge } from '../[...path]/route';

export const runtime = 'nodejs';

const stateRouteContext = {
  params: Promise.resolve({ path: ['state'] }),
};

export function GET(request) {
  return proxyWorkflowBridge(request, stateRouteContext);
}

export { OPTIONS };
