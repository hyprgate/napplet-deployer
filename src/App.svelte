<script lang="ts">
  import { onMount } from 'svelte';
  import { identity, outbox, upload, type NostrEvent, type UploadResult } from '@napplet/sdk';
  import {
    NAPPLET_DTAG_RE,
    NAPPLET_HTML_MIME,
    deployNappletHtml,
    nappletManifestAddress,
    nappletManifestNaddr,
    prepareNappletHtml,
    serverTagsFromUploadResult,
    validateHtmlFile,
    type NappletHtmlMetadata,
    type PreparedNappletHtml,
    type RuntimeUploadInfo,
  } from './lib/deployer';

  type Step = 'idle' | 'ready' | 'hashing' | 'uploading' | 'publishing' | 'success' | 'error';

  interface RelayRow {
    url: string;
    mode: string;
  }

  interface ResultRow {
    id: string;
    label: string;
    value: string;
    display: string;
    primary?: boolean;
  }

  let fileInput: HTMLInputElement | null = $state(null);
  let selectedFile: File | null = $state(null);
  let prepared: PreparedNappletHtml | null = $state(null);
  let uploadInfo: RuntimeUploadInfo | null = $state(null);
  let uploadResult: UploadResult | null = $state(null);
  let publishedEvent: NostrEvent | null = $state(null);
  let publishRelayHints = $state<string[]>([]);
  let relays = $state<RelayRow[]>([]);
  let pubkey = $state<string | null>(null);
  let step = $state<Step>('idle');
  let status = $state('Choose a built napplet index.html file.');
  let error = $state<string | null>(null);
  let dTag = $state('');
  let title = $state('');
  let description = $state('');
  let dragActive = $state(false);
  let copiedResultId = $state<string | null>(null);

  const canDeploy = $derived(
    selectedFile !== null
      && prepared !== null
      && dTag.trim().length > 0
      && NAPPLET_DTAG_RE.test(dTag.trim())
      && step !== 'hashing'
      && step !== 'uploading'
      && step !== 'publishing',
  );

  const uploadRails = $derived(uploadInfo?.rails ?? []);
  const blossomKnown = $derived(uploadRails.some((rail) => rail.rail === 'blossom' && rail.enabled));
  const serverRows = $derived(uploadResult ? serverTagsFromUploadResult(uploadResult) : []);
  const resultRows = $derived.by<ResultRow[]>(() => {
    if (!publishedEvent) return [];
    const address = nappletManifestAddress(publishedEvent);
    const naddr = nappletManifestNaddr(
      publishedEvent,
      publishRelayHints.length > 0 ? publishRelayHints : relays.map((row) => row.url),
    );
    return [
      {
        id: 'naddr',
        label: 'NIP-19 entity',
        value: naddr ?? '',
        display: naddr ?? 'unavailable',
        primary: true,
      },
      {
        id: 'address',
        label: 'Address',
        value: address ?? '',
        display: address ?? 'unavailable',
      },
      {
        id: 'kind',
        label: 'Kind',
        value: String(publishedEvent.kind),
        display: String(publishedEvent.kind),
      },
      {
        id: 'publisher',
        label: 'Publisher',
        value: publishedEvent.pubkey,
        display: shortHash(publishedEvent.pubkey),
      },
      {
        id: 'blob-url',
        label: 'Blob URL',
        value: uploadResult?.url ?? '',
        display: uploadResult?.url ?? 'unknown',
      },
    ];
  });

  onMount(() => {
    void hydrateRuntime();
  });

  async function hydrateRuntime(): Promise<void> {
    try {
      const [nextPubkey, nextUploadInfo, relayMap] = await Promise.all([
        identity.getPublicKey().catch(() => null),
        upload.info().catch(() => null),
        identity.getRelays().catch(() => ({} as Record<string, { read: boolean; write: boolean }>)),
      ]);
      pubkey = nextPubkey;
      uploadInfo = nextUploadInfo;
      relays = Object.entries(relayMap)
        .filter(([, mode]) => mode.write)
        .map(([url, mode]) => ({ url, mode: mode.read ? 'read/write' : 'write' }));
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Runtime capability check failed';
    }
  }

  function chooseFile(): void {
    fileInput?.click();
  }

  async function setFile(file: File): Promise<void> {
    error = null;
    status = 'Reading index.html...';
    step = 'hashing';
    selectedFile = file;
    uploadResult = null;
    publishedEvent = null;
    publishRelayHints = [];
    copiedResultId = null;
    const fileError = validateHtmlFile(file, uploadInfo?.maxBytes);
    if (fileError) {
      prepared = null;
      error = fileError;
      status = 'Choose a built napplet index.html file.';
      step = 'error';
      return;
    }
    try {
      const next = await prepareNappletHtml(file);
      prepared = next;
      applyMetadata(next.metadata);
      status = 'Ready to deploy one HTML artifact through the runtime upload rail.';
      step = 'ready';
    } catch (caught) {
      prepared = null;
      error = caught instanceof Error ? caught.message : 'Could not read HTML metadata';
      step = 'error';
    }
  }

  function applyMetadata(metadata: NappletHtmlMetadata): void {
    dTag = metadata.dTag ?? '';
    title = metadata.title ?? '';
    description = metadata.description ?? '';
  }

  async function onFileChange(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) await setFile(file);
  }

  async function onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    dragActive = false;
    const file = event.dataTransfer?.files?.[0];
    if (file) await setFile(file);
  }

  async function deploy(): Promise<void> {
    if (!selectedFile || !canDeploy) return;
    error = null;
    publishedEvent = null;
    uploadResult = null;
    publishRelayHints = [];
    copiedResultId = null;
    try {
      step = 'uploading';
      status = 'Uploading index.html through NAP-UPLOAD...';
      const result = await deployNappletHtml(
        {
          file: selectedFile,
          dTag: dTag.trim(),
          title,
          description,
        },
        {
          uploader: {
            info: () => upload.info(),
            upload: async (request) => {
              const result = await upload.upload(request);
              uploadResult = result;
              step = result.ok ? 'publishing' : 'error';
              status = result.ok ? 'Publishing the NIP-5D manifest event...' : 'Upload failed.';
              return result;
            },
          },
          publisher: {
            publish: (template) => outbox.publish(template),
          },
        },
      );
      uploadResult = result.upload;
      publishedEvent = result.event;
      publishRelayHints = result.relayHints;
      step = 'success';
      status = 'Napplet deployed.';
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Deploy failed';
      step = 'error';
      status = 'Deploy failed.';
    }
  }

  function reset(): void {
    selectedFile = null;
    prepared = null;
    uploadResult = null;
    publishedEvent = null;
    publishRelayHints = [];
    copiedResultId = null;
    dTag = '';
    title = '';
    description = '';
    error = null;
    status = 'Choose a built napplet index.html file.';
    step = 'idle';
  }

  function shortHash(value: string | undefined): string {
    return value ? `${value.slice(0, 10)}...${value.slice(-6)}` : 'unknown';
  }

  function formatBytes(bytes: number | undefined): string {
    if (bytes === undefined) return 'unknown';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  }

  async function copyResult(row: ResultRow): Promise<void> {
    if (!row.value) return;
    copiedResultId = null;
    error = null;
    try {
      await writeClipboard(row.value);
      copiedResultId = row.id;
    } catch {
      error = `Could not copy ${row.label}.`;
    }
  }

  async function writeClipboard(value: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('copy failed');
  }
</script>

<main>
  <header class="topbar">
    <div>
      <p class="eyebrow">NIP-5D deploy</p>
      <h1>App Deployer</h1>
    </div>
    <div class="runtime">
      <span class:ok={pubkey !== null}>{pubkey ? 'identity ready' : 'identity unknown'}</span>
      <span class:ok={blossomKnown}>{blossomKnown ? 'blossom rail' : 'upload rail unknown'}</span>
    </div>
  </header>

  <section class="workspace">
    <section
      class="dropzone"
      class:active={dragActive}
      ondragenter={(event) => { event.preventDefault(); dragActive = true; }}
      ondragover={(event) => { event.preventDefault(); dragActive = true; }}
      ondragleave={() => { dragActive = false; }}
      ondrop={onDrop}
      aria-label="HTML upload drop zone"
    >
      <div class="drop-mark" aria-hidden="true">/index.html</div>
      <h2>{selectedFile ? selectedFile.name : 'Drop built index.html'}</h2>
      <p>
        One sandboxed napplet artifact. The runtime owns Blossom upload, signer prompts, and relay publish.
      </p>
      <div class="drop-actions">
        <button type="button" class="primary" onclick={chooseFile}>Choose file</button>
        {#if selectedFile}
          <button type="button" class="secondary" onclick={reset}>Reset</button>
        {/if}
      </div>
      <input
        bind:this={fileInput}
        type="file"
        accept=".html,text/html"
        class="hidden-file"
        onchange={onFileChange}
        aria-hidden="true"
        tabindex="-1"
      />
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Manifest</h2>
        <span class={`step ${step}`}>{step}</span>
      </div>

      <label>
        <span>Napplet d-tag</span>
        <input bind:value={dTag} placeholder="my-napplet" class:invalid={dTag.length > 0 && !NAPPLET_DTAG_RE.test(dTag)} />
      </label>
      <label>
        <span>Title tag</span>
        <input bind:value={title} placeholder="Optional display title" />
      </label>
      <label>
        <span>Description tag</span>
        <textarea bind:value={description} placeholder="Optional short description"></textarea>
      </label>

      {#if prepared}
        <dl class="facts">
          <div><dt>HTML bytes</dt><dd>{formatBytes(prepared.size)}</dd></div>
          <div><dt>HTML sha256</dt><dd>{shortHash(prepared.htmlSha256)}</dd></div>
          <div><dt>Aggregate x</dt><dd>{shortHash(prepared.aggregateHash)}</dd></div>
          <div><dt>Requires</dt><dd>{prepared.metadata.requires.length ? prepared.metadata.requires.join(', ') : 'none detected'}</dd></div>
        </dl>
      {/if}

      <button type="button" class="deploy" disabled={!canDeploy} onclick={deploy}>
        {step === 'uploading' ? 'Uploading' : step === 'publishing' ? 'Publishing' : 'Deploy napplet'}
      </button>

      <p class="status" role="status">{status}</p>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </section>
  </section>

  <section class="grid">
    <article>
      <h2>Upload rail</h2>
      <div class="rows">
        {#if serverRows.length > 0}
          {#each serverRows as server}
            <div class="row ok"><span>{server}</span><strong>stored</strong></div>
          {/each}
        {:else}
          <div class="row pending"><span>Blossom destination</span><strong>runtime selected</strong></div>
        {/if}
      </div>
      <p class="note">
        NAP-UPLOAD does not disclose the target Blossom server list before upload, so this can only show destinations after the runtime returns URLs.
      </p>
    </article>

    <article>
      <h2>Outbox publish</h2>
      <div class="rows">
        {#if publishedEvent}
          <div class="row ok"><span>{shortHash(publishedEvent.id)}</span><strong>signed</strong></div>
        {/if}
        {#if publishRelayHints.length > 0}
          {#each publishRelayHints as url}
            <div class="row ok"><span>{url}</span><strong>accepted</strong></div>
          {/each}
        {:else if relays.length > 0}
          {#each relays as row}
            <div class="row pending"><span>{row.url}</span><strong>{row.mode}</strong></div>
          {/each}
        {:else}
          <div class="row pending"><span>Write relays</span><strong>outbox selected</strong></div>
        {/if}
      </div>
      <p class="note">
        NAP-OUTBOX owns relay selection and returns the publish relay map used as NIP-19 relay hints.
      </p>
    </article>

    <article class="wide">
      <h2>Result</h2>
      {#if resultRows.length > 0}
        <dl class="facts result">
          {#each resultRows as row}
            <div class:primary-result={row.primary}>
              <dt>{row.label}</dt>
              <dd title={row.value || row.display}>{row.display}</dd>
              <button
                type="button"
                class="copy-button"
                disabled={!row.value}
                title="Copy {row.label}"
                aria-label="Copy {row.label}"
                onclick={() => { void copyResult(row); }}
              >{copiedResultId === row.id ? 'Copied' : 'Copy'}</button>
            </div>
          {/each}
        </dl>
      {:else}
        <p class="empty">Deploy a built napplet to see the manifest address and blob URL.</p>
      {/if}
    </article>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #090b0b;
    color: #efece3;
    font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  main {
    min-height: 100vh;
    box-sizing: border-box;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .topbar {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: start;
    border-bottom: 1px solid #28302c;
    padding-bottom: 12px;
  }

  h1, h2, p {
    margin: 0;
  }

  h1 {
    font-size: 24px;
    font-weight: 720;
  }

  h2 {
    font-size: 13px;
    text-transform: uppercase;
    color: #d8d1c2;
  }

  .eyebrow, .note, .empty {
    color: #918b7e;
    font-size: 11px;
  }

  .runtime {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
  }

  .runtime span, .step {
    border: 1px solid #3a3328;
    color: #d8a550;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 10px;
    text-transform: uppercase;
  }

  .runtime .ok, .step.success {
    border-color: #33583a;
    color: #8ed982;
  }

  .workspace {
    display: grid;
    grid-template-columns: minmax(280px, 1.15fr) minmax(280px, 0.85fr);
    gap: 12px;
    min-height: 360px;
  }

  .dropzone, .panel, article {
    border: 1px solid #28302c;
    background: #111614;
    border-radius: 6px;
  }

  .dropzone {
    display: grid;
    align-content: center;
    justify-items: center;
    gap: 12px;
    padding: 28px;
    text-align: center;
    border-style: dashed;
  }

  .dropzone.active {
    border-color: #8ed982;
    background: #152018;
  }

  .drop-mark {
    width: min(260px, 80%);
    aspect-ratio: 1.8;
    display: grid;
    place-items: center;
    border: 1px solid #435046;
    background: #080a09;
    color: #8ed982;
    border-radius: 4px;
    box-shadow: inset 0 0 0 1px #0f1712;
  }

  .dropzone h2 {
    font-size: 20px;
    text-transform: none;
    color: #efece3;
  }

  .dropzone p {
    max-width: 430px;
    color: #aca596;
  }

  .drop-actions, .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  button {
    min-height: 32px;
    border: 1px solid #435046;
    background: #18201c;
    color: #efece3;
    border-radius: 4px;
    padding: 0 12px;
    font: inherit;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    border-color: #8ed982;
  }

  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .primary, .deploy {
    border-color: #8ed982;
    color: #8ed982;
  }

  .secondary {
    color: #aca596;
  }

  .panel {
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  label {
    display: grid;
    gap: 4px;
  }

  label span, dt {
    color: #918b7e;
    font-size: 10px;
    text-transform: uppercase;
  }

  input, textarea {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    border: 1px solid #303832;
    background: #090b0b;
    color: #efece3;
    border-radius: 4px;
    padding: 8px;
    font: inherit;
  }

  textarea {
    min-height: 66px;
    resize: vertical;
  }

  input:focus, textarea:focus {
    outline: none;
    border-color: #8ed982;
  }

  .invalid {
    border-color: #cc5f4d;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin: 0;
  }

  .facts div {
    min-width: 0;
    border: 1px solid #28302c;
    border-radius: 4px;
    padding: 8px;
    background: #0c100e;
  }

  .result div {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: 2px 8px;
  }

  .result .primary-result {
    grid-column: 1 / -1;
    border-color: #3d6644;
    background: #0d1711;
  }

  .result dt,
  .result dd {
    min-width: 0;
  }

  .result dd {
    grid-column: 1;
  }

  .copy-button {
    grid-column: 2;
    grid-row: 1 / span 2;
    min-height: 26px;
    align-self: center;
    padding: 0 9px;
    color: #8ed982;
    font-size: 10px;
    text-transform: uppercase;
  }

  dd {
    margin: 2px 0 0;
    overflow-wrap: anywhere;
  }

  .status {
    color: #aca596;
    font-size: 11px;
  }

  .error {
    margin: 0;
    color: #ff8a75;
    font-size: 11px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }

  article {
    padding: 12px;
    display: grid;
    gap: 10px;
    align-content: start;
  }

  .wide {
    grid-column: 1 / -1;
  }

  .rows {
    display: grid;
    gap: 6px;
  }

  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    min-height: 30px;
    border: 1px solid #28302c;
    border-radius: 4px;
    padding: 0 8px;
    background: #0c100e;
  }

  .row span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row strong {
    color: #918b7e;
    font-size: 10px;
    text-transform: uppercase;
  }

  .row.ok strong {
    color: #8ed982;
  }

  .row.pending strong {
    color: #d8a550;
  }

  .hidden-file {
    display: none;
  }

  @media (max-width: 820px) {
    .workspace, .grid {
      grid-template-columns: 1fr;
    }

    .topbar {
      flex-direction: column;
    }

    .runtime {
      justify-content: flex-start;
    }
  }
</style>
