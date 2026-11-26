import { env as runtimeEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('Kirisame production caller configuration', () => {
  it('binds only Soyuz to the named private entrypoint and keeps dispatch enabled', () => {
    const config = JSON.parse((runtimeEnv as unknown as { TEST_WRANGLER_CONFIG: string }).TEST_WRANGLER_CONFIG) as {
      services: Array<{ binding: string; service: string; entrypoint?: string }>;
      vars: Record<string, string>;
      secrets: { required: string[] };
    };
    const kirisame = config.services.find((binding) => binding.binding === 'KIRISAME');
    const rules = JSON.parse(config.vars.PUBLICATION_REPOSITORY_ALLOWLIST ?? 'null') as unknown;

    expect(kirisame).toEqual({ binding: 'KIRISAME', service: 'kirisame', entrypoint: 'PublisherEntrypoint' });
    expect(config.vars.PUBLICATION_DISPATCH_ENABLED).toBe('true');
    expect(config.vars.KIRISAME_CALLER_ID).toBe('soyuz');
    expect(config.secrets.required).toContain('KIRISAME_API_KEY');
    expect(rules).toEqual([{ owner: 'CyanAutomation', name: 'somatic', modes: ['pr'], baseRefs: ['main'] }]);
  });
});
