import type { EventTemplate, NostrEvent, OutboxPublishResult, UploadRequest, UploadResult } from '@napplet/sdk';
import * as nip19 from 'nostr-tools/nip19';

export const NAPPLET_INDEX_PATH = '/index.html';
export const NAPPLET_HTML_MIME = 'text/html';
export const KIND_NIP5D_NAMED = 35129;
export const DEPLOYER_CLIENT_TAG = 'hyprgate/napplet-deployer';
export const NAPPLET_DTAG_RE = /^[a-z0-9][a-z0-9._:-]*$/;

export interface NappletHtmlMetadata {
  dTag: string | null;
  requires: string[];
  configSchema: string | null;
  title: string | null;
  description: string | null;
}

export interface PreparedNappletHtml {
  bytes: ArrayBuffer;
  size: number;
  metadata: NappletHtmlMetadata;
  htmlSha256: string;
  aggregateHash: string;
}

export interface DeployNappletInput {
  file: File;
  dTag?: string;
  title?: string;
  description?: string;
  createdAt?: number;
}

export interface DeployNappletResult {
  prepared: PreparedNappletHtml;
  upload: UploadResult;
  publish: OutboxPublishResult;
  event: NostrEvent;
  serverTags: string[];
  relayHints: string[];
}

export interface RuntimeUploadInfo {
  rails?: Array<{ rail: string; enabled?: boolean }>;
  maxBytes?: number;
  mimeTypes?: string[];
}

export interface NappletUploader {
  info(): Promise<RuntimeUploadInfo>;
  upload(request: UploadRequest): Promise<UploadResult>;
}

export interface NappletPublisher {
  publish(template: EventTemplate): Promise<OutboxPublishResult>;
}

export function validateHtmlFile(file: File, maxBytes?: number): string | null {
  if (file.size === 0) return `${file.name} is empty. Build your app and choose its index.html.`;
  if (maxBytes !== undefined && file.size > maxBytes) return `${file.name} exceeds the runtime limit of ${formatBytes(maxBytes)}. Single-file apps need to fit under it.`;
  if (!file.name.toLowerCase().endsWith('.html')) return `${file.name} isn't an HTML file. Choose the index.html from your app's build output, usually dist/.`;
  if (file.type && file.type !== 'text/html') return `${file.name} has the type ${file.type}, not text/html. Choose the index.html from your app's build output.`;
  return null;
}

export async function prepareNappletHtml(file: File): Promise<PreparedNappletHtml> {
  const bytes = await readFileBytes(file);
  const html = new TextDecoder().decode(bytes);
  const htmlSha256 = await sha256Hex(bytes);
  const aggregateHash = await computeSingleFileAggregateHash(htmlSha256);
  return {
    bytes,
    size: file.size,
    metadata: parseNappletHtmlMetadata(html),
    htmlSha256,
    aggregateHash,
  };
}

export function parseNappletHtmlMetadata(html: string): NappletHtmlMetadata {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const meta = (name: string): string | null => {
    const value = doc.querySelector(`meta[name="${cssEscape(name)}"]`)?.getAttribute('content')?.trim();
    return value ? value : null;
  };
  return {
    dTag: cleanDTag(meta('napplet-type') ?? meta('napplet-napp-type')),
    requires: parseRequires(meta('napplet-requires')),
    configSchema: meta('napplet-config-schema'),
    title: textOrNull(doc.querySelector('title')?.textContent ?? meta('title')),
    description: meta('description'),
  };
}

export async function deployNappletHtml(
  input: DeployNappletInput,
  deps: { uploader: NappletUploader; publisher: NappletPublisher },
): Promise<DeployNappletResult> {
  const info: RuntimeUploadInfo = await deps.uploader.info().catch(() => ({ rails: [] }));
  const fileError = validateHtmlFile(input.file, info.maxBytes);
  if (fileError) throw new Error(fileError);

  const prepared = await prepareNappletHtml(input.file);
  const dTag = cleanDTag(input.dTag) ?? prepared.metadata.dTag;
  if (!dTag) throw new Error('Napplet d-tag is missing');
  if (!NAPPLET_DTAG_RE.test(dTag)) throw new Error(`Invalid napplet d-tag: ${dTag}`);

  const uploadResult = await deps.uploader.upload({
    rail: 'blossom',
    data: input.file,
    filename: 'index.html',
    mimeType: NAPPLET_HTML_MIME,
  });
  if (!uploadResult.ok || !uploadResult.url) {
    throw new Error(uploadResult.error ?? 'Upload failed');
  }
  if (uploadResult.sha256 && uploadResult.sha256.toLowerCase() !== prepared.htmlSha256) {
    throw new Error(`Upload hash mismatch: ${uploadResult.sha256} != ${prepared.htmlSha256}`);
  }

  const serverTags = serverTagsFromUploadResult(uploadResult);
  const template = buildNappletManifestTemplate({
    dTag,
    htmlSha256: prepared.htmlSha256,
    aggregateHash: prepared.aggregateHash,
    servers: serverTags,
    requires: prepared.metadata.requires,
    configSchema: prepared.metadata.configSchema,
    title: textOrNull(input.title) ?? prepared.metadata.title,
    description: textOrNull(input.description) ?? prepared.metadata.description,
    createdAt: input.createdAt,
  });
  const publishResult = await deps.publisher.publish(template);
  if (!publishResult.ok || !publishResult.event) {
    throw new Error(publishResult.error ?? 'Outbox publish failed');
  }
  return {
    prepared,
    upload: uploadResult,
    publish: publishResult,
    event: publishResult.event,
    serverTags,
    relayHints: relayHintsFromPublishResult(publishResult),
  };
}

export function buildNappletManifestTemplate(input: {
  dTag: string;
  htmlSha256: string;
  aggregateHash: string;
  servers?: readonly string[];
  requires?: readonly string[];
  configSchema?: string | null;
  title?: string | null;
  description?: string | null;
  createdAt?: number;
}): EventTemplate {
  const tags: string[][] = [
    ['d', input.dTag],
    ['path', NAPPLET_INDEX_PATH, input.htmlSha256],
    ['x', input.aggregateHash, 'aggregate'],
  ];
  for (const server of uniqueClean(input.servers ?? [])) tags.push(['server', server]);
  for (const req of uniqueClean(input.requires ?? [])) tags.push(['requires', req]);
  if (input.configSchema) tags.push(['config', input.configSchema]);
  if (input.title) tags.push(['title', input.title]);
  if (input.description) tags.push(['description', input.description]);
  tags.push(['client', DEPLOYER_CLIENT_TAG]);

  return {
    kind: KIND_NIP5D_NAMED,
    created_at: input.createdAt ?? Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}

export function serverTagsFromUploadResult(result: Pick<UploadResult, 'url' | 'fallbackUrls'>): string[] {
  return uniqueClean([result.url, ...(result.fallbackUrls ?? [])].flatMap((url) => serverTagFromUrl(url)));
}

export function nappletManifestAddress(event: Pick<NostrEvent, 'kind' | 'pubkey' | 'tags'>): string | null {
  const identifier = nappletManifestDTag(event);
  return identifier ? `${event.kind}:${event.pubkey}:${identifier}` : null;
}

export function nappletManifestNaddr(
  event: Pick<NostrEvent, 'kind' | 'pubkey' | 'tags'>,
  relays: readonly string[] = [],
): string | null {
  const identifier = nappletManifestDTag(event);
  if (!identifier) return null;
  try {
    return nip19.naddrEncode({
      kind: event.kind,
      pubkey: event.pubkey,
      identifier,
      relays: uniqueClean(relays),
    });
  } catch {
    return null;
  }
}

export function relayHintsFromPublishResult(result: Pick<OutboxPublishResult, 'relays'>): string[] {
  return uniqueClean(
    Object.entries(result.relays ?? {})
      .filter(([, ok]) => ok)
      .map(([relay]) => relay),
  );
}

export async function computeSingleFileAggregateHash(htmlSha256: string): Promise<string> {
  return sha256Text(`${htmlSha256} ${NAPPLET_INDEX_PATH}\n`);
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : data instanceof Uint8Array
      ? data
      : new Uint8Array(data);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sha256Text(text: string): Promise<string> {
  return sha256Hex(text);
}

function parseRequires(value: string | null): string[] {
  if (!value) return [];
  return uniqueClean(
    value
      .split(',')
      .map((item) => item.trim().replace(/^nap:/, ''))
      .filter((item) => /^[a-z0-9][a-z0-9._:-]*$/i.test(item)),
  );
}

function cleanDTag(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function textOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function uniqueClean(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? '').filter(Boolean))];
}

function nappletManifestDTag(event: Pick<NostrEvent, 'tags'>): string | null {
  for (const tag of event.tags) {
    if (tag[0] === 'd') return cleanDTag(tag[1]);
  }
  return null;
}

function serverTagFromUrl(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return [];
    return [parsed.origin];
  } catch {
    return [];
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function readFileBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }
      reject(new Error('Failed to read file bytes'));
    };
    reader.readAsArrayBuffer(file);
  });
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

export interface DeployFailure {
  title: string;
  hint: string;
  detail: string;
}

/** Say what went wrong and what to do, keeping the runtime's own words for debugging. */
export function describeDeployFailure(cause: unknown, uploaded: boolean): DeployFailure {
  const detail = cause instanceof Error ? cause.message : String(cause ?? 'Deploy failed');
  if (/no server configured/i.test(detail)) {
    return {
      title: 'No Blossom server is set up',
      hint: 'Uploads go to your Blossom server list. Add a server in Blossom settings, then deploy again.',
      detail,
    };
  }
  if (/read-?only/i.test(detail)) {
    return {
      title: 'This account is read-only',
      hint: 'Deploying signs events. Sign in with a browser extension or remote signer, then deploy again.',
      detail,
    };
  }
  if (/hash mismatch/i.test(detail)) {
    return {
      title: "The server's copy doesn't match your file",
      hint: "The manifest wasn't published, because it would point at different bytes. Try again, or try another Blossom server.",
      detail,
    };
  }
  if (/denied|rejected|declined|blocked/i.test(detail)) {
    return {
      title: uploaded ? 'The upload worked, but publishing was denied' : 'The upload was denied',
      hint: uploaded
        ? 'Your file is on the server, but the manifest was not published. Deploy again and allow the publish when asked.'
        : 'Nothing was published. Deploy again and allow it when asked.',
      detail,
    };
  }
  return uploaded
    ? {
      title: 'The upload worked, but publishing failed',
      hint: 'Your file is on the server, but the manifest was not published. Check your relays and deploy again.',
      detail,
    }
    : {
      title: 'The upload failed',
      hint: 'Nothing was published. Check your Blossom servers and deploy again.',
      detail,
    };
}

export type DeployBlocker = 'no-file' | 'file-error' | 'missing-d-tag' | 'invalid-d-tag' | 'busy' | null;

/** Why Deploy is off, so the button never just sits there disabled. */
export function deployBlocker(input: { hasFile: boolean; prepared: boolean; dTag: string; busy: boolean }): DeployBlocker {
  if (input.busy) return 'busy';
  if (!input.hasFile) return 'no-file';
  if (!input.prepared) return 'file-error';
  const dTag = input.dTag.trim();
  if (!dTag) return 'missing-d-tag';
  return NAPPLET_DTAG_RE.test(dTag) ? null : 'invalid-d-tag';
}

export const DEPLOY_BLOCKER_TEXT: Record<Exclude<DeployBlocker, null | 'busy'>, string> = {
  'no-file': 'Choose a file to deploy.',
  'file-error': 'Choose a valid index.html to deploy.',
  'missing-d-tag': "This file has no napplet-type, so enter a d-tag above.",
  'invalid-d-tag': 'Fix the d-tag above to deploy.',
};
