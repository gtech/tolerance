import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { endpointAccessPattern, OPTIONAL_SITES, PROVIDER_HOSTS } from '../src/shared/optional-sites';

const manifests = ['manifest.json', 'manifest.firefox.json'].map(name => ({
  name,
  json: JSON.parse(readFileSync(join(__dirname, '..', name), 'utf8')) as {
    permissions: string[];
    host_permissions: string[];
    optional_host_permissions: string[];
    content_scripts: { matches: string[] }[];
  },
}));

describe('endpointAccessPattern', () => {
  it('asks for a known provider by host', () => {
    expect(endpointAccessPattern('https://api.openai.com/v1/chat/completions')).toBe('*://api.openai.com/*');
    expect(endpointAccessPattern('  https://api.groq.com/openai/v1/chat/completions ')).toBe('*://api.groq.com/*');
  });

  it('asks for a local model on any port', () => {
    expect(endpointAccessPattern('http://localhost:11434/v1/chat/completions')).toBe('http://localhost/*');
    expect(endpointAccessPattern('http://127.0.0.1:1234/v1/chat/completions')).toBe('http://127.0.0.1/*');
  });

  it('asks for nothing it cannot be granted', () => {
    expect(endpointAccessPattern('https://my-server.example.com/v1/chat/completions')).toBeNull();
    expect(endpointAccessPattern('https://localhost/v1')).toBeNull();
    expect(endpointAccessPattern('https://evil-api.openai.com.example.net/v1')).toBeNull();
    expect(endpointAccessPattern('not a url')).toBeNull();
    expect(endpointAccessPattern('')).toBeNull();
    expect(endpointAccessPattern('ftp://api.openai.com/x')).toBeNull();
  });
});

describe.each(manifests)('$name', ({ json }) => {
  it('lists every pattern the code may ask for as optional', () => {
    const optional = json.optional_host_permissions;
    for (const site of OPTIONAL_SITES) for (const origin of site.origins) expect(optional).toContain(origin);
    for (const host of PROVIDER_HOSTS) expect(optional).toContain(`*://${host}/*`);
    expect(optional).toContain('http://localhost/*');
    expect(optional).toContain('http://127.0.0.1/*');
  });

  it('keeps optional sites out of the install prompt', () => {
    const atInstall = [...json.host_permissions, ...json.content_scripts.flatMap(c => c.matches)];
    for (const pattern of json.optional_host_permissions) expect(atInstall).not.toContain(pattern);
  });

  it('can register content scripts at runtime', () => {
    expect(json.permissions).toContain('scripting');
  });
});
