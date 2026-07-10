import { describe, expect, it, vi } from 'vitest';
import type { EventTemplate, NostrEvent, UploadResult } from '@napplet/sdk';
import * as nip19 from 'nostr-tools/nip19';
import {
  DEPLOYER_CLIENT_TAG,
  NAPPLET_INDEX_PATH,
  buildNappletManifestTemplate,
  computeSingleFileAggregateHash,
  deployNappletHtml,
  nappletManifestAddress,
  nappletManifestNaddr,
  parseNappletHtmlMetadata,
  prepareNappletHtml,
  relayHintsFromPublishResult,
  serverTagsFromUploadResult,
  sha256Hex,
  validateHtmlFile,
} from './deployer';

const HTML = [
  '<!doctype html><html><head>',
  '<meta name="napplet-type" content="demo-tool">',
  '<meta name="naplet-ignored" content="x">',
  '<meta name="napplet-requires" content="identity, relay, nap:upload">',
  '<meta name="napplet-config-schema" content="{&quot;type&quot;:&quot;object&quot;}">',
  '<meta name="description" content="Deployable demo">',
  '<title>Demo Tool</title>',
  '</head><body>ok</body></html>',
].join('');

function file(name = 'index.html', html = HTML): File {
  return new File([html], name, { type: 'text/html' });
}

function eventFromTemplate(template: EventTemplate): NostrEvent {
  return {
    id: 'e'.repeat(64),
    pubkey: 'f'.repeat(64),
    sig: 'a'.repeat(128),
    ...template,
  };
}

function publishResult(template: EventTemplate, relays: Record<string, boolean> = { 'wss://relay.example': true }) {
  const event = eventFromTemplate(template);
  return {
    ok: true,
    event,
    eventId: event.id,
    relays,
  };
}

describe('parseNappletHtmlMetadata', () => {
  it('detects NIP-5D d-tag, requires, config, title, and description from HTML', () => {
    expect(parseNappletHtmlMetadata(HTML)).toEqual({
      dTag: 'demo-tool',
      requires: ['identity', 'relay', 'upload'],
      configSchema: '{"type":"object"}',
      title: 'Demo Tool',
      description: 'Deployable demo',
    });
  });
});

describe('prepareNappletHtml', () => {
  it('hashes the HTML and computes the NIP-5A aggregate for /index.html', async () => {
    const prepared = await prepareNappletHtml(file());
    const expectedHtmlHash = await sha256Hex(HTML);
    const expectedAggregate = await sha256Hex(`${expectedHtmlHash} ${NAPPLET_INDEX_PATH}\n`);

    expect(prepared.htmlSha256).toBe(expectedHtmlHash);
    expect(prepared.aggregateHash).toBe(expectedAggregate);
    await expect(computeSingleFileAggregateHash(expectedHtmlHash)).resolves.toBe(expectedAggregate);
  });
});

describe('buildNappletManifestTemplate', () => {
  it('builds a kind-35129 named napplet manifest with injected NIP-5D tags', () => {
    const template = buildNappletManifestTemplate({
      dTag: 'demo-tool',
      htmlSha256: '1'.repeat(64),
      aggregateHash: '2'.repeat(64),
      servers: ['https://cdn.example', 'https://cdn.example'],
      requires: ['relay', 'upload'],
      configSchema: '{"type":"object"}',
      title: 'Demo Tool',
      description: 'Deployable demo',
      createdAt: 123,
    });

    expect(template).toEqual({
      kind: 35129,
      created_at: 123,
      content: '',
      tags: [
        ['d', 'demo-tool'],
        ['path', '/index.html', '1'.repeat(64)],
        ['x', '2'.repeat(64), 'aggregate'],
        ['server', 'https://cdn.example'],
        ['requires', 'relay'],
        ['requires', 'upload'],
        ['config', '{"type":"object"}'],
        ['title', 'Demo Tool'],
        ['description', 'Deployable demo'],
        ['client', DEPLOYER_CLIENT_TAG],
      ],
    });
  });
});

describe('serverTagsFromUploadResult', () => {
  it('derives server origins from primary and fallback HTTPS URLs', () => {
    expect(serverTagsFromUploadResult({
      url: 'blossom:abc.html?x=https%3A%2F%2Fignored.example',
      fallbackUrls: ['https://one.example/abc.html', 'https://two.example/path/abc.html', 'https://one.example/abc.html'],
    })).toEqual(['https://one.example', 'https://two.example']);
  });
});

describe('manifest share references', () => {
  it('derives the address and NIP-19 naddr from the signed manifest event', () => {
    const event = eventFromTemplate(buildNappletManifestTemplate({
      dTag: 'demo-tool',
      htmlSha256: '1'.repeat(64),
      aggregateHash: '2'.repeat(64),
      createdAt: 123,
    }));

    const naddr = nappletManifestNaddr(event, ['wss://relay.example', 'wss://relay.example']);
    const decoded = nip19.decode(naddr ?? '');

    expect(nappletManifestAddress(event)).toBe(`35129:${'f'.repeat(64)}:demo-tool`);
    expect(decoded.type).toBe('naddr');
    expect(decoded.data).toMatchObject({
      kind: 35129,
      pubkey: 'f'.repeat(64),
      identifier: 'demo-tool',
      relays: ['wss://relay.example'],
    });
  });

  it('keeps only accepted outbox publish relays as share hints', () => {
    expect(relayHintsFromPublishResult({
      relays: {
        'wss://accepted.example': true,
        'wss://failed.example': false,
      },
    })).toEqual(['wss://accepted.example']);
  });
});

describe('validateHtmlFile', () => {
  it('accepts index.html and rejects empty/non-html/oversized files', () => {
    expect(validateHtmlFile(file())).toBeNull();
    expect(validateHtmlFile(new File([], 'index.html', { type: 'text/html' }))).toMatch(/empty/);
    expect(validateHtmlFile(new File(['x'], 'app.js', { type: 'text/javascript' }))).toMatch(/index.html/);
    expect(validateHtmlFile(file(), 1)).toMatch(/exceeds/);
  });
});

describe('deployNappletHtml', () => {
  it('uploads one HTML blob on the Blossom rail and publishes the NIP-5D manifest', async () => {
    const uploadResult: UploadResult = {
      ok: true,
      status: 'complete',
      rail: 'blossom',
      uploadId: 'up-1',
      url: 'https://cdn.example/hash.html',
      sha256: await sha256Hex(HTML),
      fallbackUrls: ['https://mirror.example/hash.html'],
    };
    const uploader = {
      info: vi.fn(async () => ({ rails: [{ rail: 'blossom', enabled: true }] })),
      upload: vi.fn(async () => uploadResult),
    };
    const publisher = {
      publish: vi.fn(async (template: EventTemplate) => publishResult(template, {
        'wss://writer.example': true,
        'wss://failed.example': false,
      })),
    };

    const result = await deployNappletHtml({ file: file(), createdAt: 456 }, { uploader, publisher });

    expect(uploader.upload).toHaveBeenCalledWith(expect.objectContaining({
      rail: 'blossom',
      filename: 'index.html',
      mimeType: 'text/html',
    }));
    expect(publisher.publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: 35129,
      created_at: 456,
      tags: expect.arrayContaining([
        ['d', 'demo-tool'],
        ['path', '/index.html', result.prepared.htmlSha256],
        ['x', result.prepared.aggregateHash, 'aggregate'],
        ['server', 'https://cdn.example'],
        ['server', 'https://mirror.example'],
        ['requires', 'upload'],
      ]),
    }));
    expect(result.serverTags).toEqual(['https://cdn.example', 'https://mirror.example']);
    expect(result.relayHints).toEqual(['wss://writer.example']);
  });

  it('fails closed when the runtime upload hash does not match the selected HTML', async () => {
    const uploader = {
      info: vi.fn(async () => ({ rails: [{ rail: 'blossom', enabled: true }] })),
      upload: vi.fn(async (): Promise<UploadResult> => ({
        ok: true,
        status: 'complete',
        rail: 'blossom',
        uploadId: 'up-1',
        url: 'https://cdn.example/wrong.html',
        sha256: '0'.repeat(64),
      })),
    };
    const publisher = { publish: vi.fn(async (template: EventTemplate) => publishResult(template)) };

    await expect(deployNappletHtml({ file: file() }, { uploader, publisher })).rejects.toThrow(/hash mismatch/);
    expect(publisher.publish).not.toHaveBeenCalled();
  });
});
