import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CODE_SITE_LIVE_EVENT_TYPES,
  subscribeCodeSiteProjectEvents,
} from '../codesiteClient';

describe('CodeSite live event subscription', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('subscribes to every agent lifecycle event so registry presence refreshes immediately', () => {
    const listeners = new Map();
    const close = vi.fn();
    class FakeEventSource {
      constructor(url) { this.url = url; }
      addEventListener(type, listener) { listeners.set(type, listener); }
      removeEventListener(type) { listeners.delete(type); }
      close() { close(); }
    }
    vi.stubGlobal('window', { EventSource: FakeEventSource });

    const onEvent = vi.fn();
    const unsubscribe = subscribeCodeSiteProjectEvents('team', 'project-1', { onEvent });

    expect(CODE_SITE_LIVE_EVENT_TYPES).toEqual(expect.arrayContaining([
      'agent_attached',
      'agent_resumed',
      'agent_heartbeat',
      'agent_detached',
    ]));
    for (const eventType of ['agent_attached', 'agent_resumed', 'agent_heartbeat', 'agent_detached']) {
      expect(listeners.has(eventType)).toBe(true);
    }
    listeners.get('agent_heartbeat')({ data: JSON.stringify({ eventType: 'agent_heartbeat', actorId: 'agent-1' }) });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'agent_heartbeat' }));
    unsubscribe();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
