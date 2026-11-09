<script lang="ts">
  import { onMount } from 'svelte';
  import { identity, outbox, upload, type NostrEvent, type UploadResult } from '@napplet/sdk';
  import * as nip19 from 'nostr-tools/nip19';
  import {
    NAPPLET_DTAG_RE,
    NAPPLET_HTML_MIME,
    DEPLOY_BLOCKER_TEXT,
    deployBlocker,
    deployNappletHtml,
    describeDeployFailure,
    nappletManifestAddress,
    nappletManifestNaddr,
    prepareNappletHtml,
    serverTagsFromUploadResult,
    validateHtmlFile,
    type DeployFailure,
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
  let status = $state('');
  let error = $state<string | null>(null);
  let failure = $state<DeployFailure | null>(null);
  let dTag = $state('');
  let title = $state('');
  let description = $state('');
  let dragActive = $state(false);
  let copiedResultId = $state<string | null>(null);

  const busy = $derived(step === 'hashing' || step === 'uploading' || step === 'publishing');
  const blocker = $derived(deployBlocker({
    hasFile: selectedFile !== null,
    prepared: prepared !== null,
    dTag,
    busy,
  }));
  const canDeploy = $derived(blocker === null);
  const blockerText = $derived(blocker && blocker !== 'busy' ? DEPLOY_BLOCKER_TEXT[blocker] : '');
  const dTagInvalid = $derived(dTag.trim().length > 0 && !NAPPLET_DTAG_RE.test(dTag.trim()));
  /** Which of the three steps someone is on. */
  const currentStep = $derived(publishedEvent ? 4 : prepared ? (blocker === null || busy ? 3 : 2) : 1);

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
        value: nip19.npubEncode(publishedEvent.pubkey),
        display: shortHash(nip19.npubEncode(publishedEvent.pubkey)),
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
    failure = null;
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
      status = '';
      step = 'error';
      return;
    }
    try {
      const next = await prepareNappletHtml(file);
      prepared = next;
      applyMetadata(next.metadata);
      status = 'Ready to deploy.';
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
    failure = null;
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
      status = 'Deployed.';
    } catch (caught) {
      failure = describeDeployFailure(caught, uploadResult?.ok === true);
      step = 'error';
      status = '';
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
    failure = null;
    status = '';
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
    // The sandbox usually refuses the async API, so a rejection falls through to execCommand.
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through.
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.append(textarea);
    textarea.focus();
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('copy failed');
  }
</script>

<main>
  <header class="topbar">
    <div>
      <h1>App Deployer</h1>
      <p class="lede">Publish a built single-file NIP-5D napplet to Nostr.</p>
    </div>
    <ul class="runtime" aria-label="Runtime status">
      <li class:ok={pubkey !== null}>{pubkey ? 'Identity ready' : 'No identity'}</li>
      <li class:ok={blossomKnown}>{blossomKnown ? 'Blossom upload available' : 'Upload rail unknown'}</li>
    </ul>
  </header>

  <ol class="steps" aria-label="Steps">
    {#each ['Choose index.html', 'Check the details', 'Deploy'] as label, index}
      <li class:done={currentStep > index + 1} class:current={currentStep === index + 1} aria-current={currentStep === index + 1 ? 'step' : undefined}>
        <span class="step-number" aria-hidden="true">{currentStep > index + 1 ? '✓' : index + 1}</span>{label}
      </li>
    {/each}
  </ol>

  {#if publishedEvent}
    <section class="panel result-panel" aria-labelledby="result-title" data-testid="deploy-result">
      <div class="panel-head">
        <h2 id="result-title">Deployed {title.trim() || dTag.trim()}</h2>
        <button type="button" class="secondary" onclick={reset}>Deploy another</button>
      </div>
      <p class="note">Share the NIP-19 entity below. Anyone can open your app with it.</p>
      <dl class="facts result">
        {#each resultRows as row}
          <div class:primary-result={row.primary}>
            <dt>{row.label}</dt>
            <dd title={row.value || row.display}>{row.display}</dd>
            <button
              type="button"
              class="copy-button"
              disabled={!row.value}
              aria-label="Copy {row.label}"
              onclick={() => { void copyResult(row); }}
            >{copiedResultId === row.id ? 'Copied' : 'Copy'}</button>
          </div>
        {/each}
      </dl>
    </section>
  {/if}

  {#if !publishedEvent}
  <section class="workspace">
    <section
      class="dropzone"
      class:active={dragActive}
      class:has-file={selectedFile !== null}
      ondragenter={(event) => { event.preventDefault(); dragActive = true; }}
      ondragover={(event) => { event.preventDefault(); dragActive = true; }}
      ondragleave={() => { dragActive = false; }}
      ondrop={onDrop}
      aria-label="HTML upload drop zone"
    >
      {#if selectedFile}
        <h2>{selectedFile.name}</h2>
        {#if prepared}<p>{formatBytes(prepared.size)}, ready to check.</p>{/if}
      {:else}
        <h2>Drop your built index.html here</h2>
        <p>Build your app first, then use the single file from its output folder, usually <code>dist/index.html</code>.</p>
      {/if}
      <div class="drop-actions">
        <button type="button" class={selectedFile ? 'secondary' : 'primary'} onclick={chooseFile}>{selectedFile ? 'Choose another' : 'Choose file'}</button>
        {#if selectedFile}
          <button type="button" class="secondary" onclick={reset}>Clear</button>
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
      {#if error}<p class="error" role="alert" data-testid="deploy-file-error">{error}</p>{/if}
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Details</h2>
      </div>

      <label>
        <span>Napplet d-tag</span>
        <input
          bind:value={dTag}
          placeholder="my-napplet"
          class:invalid={dTagInvalid}
          aria-invalid={dTagInvalid ? 'true' : undefined}
          aria-describedby="d-tag-help"
          spellcheck="false"
          autocomplete="off"
        />
        <small id="d-tag-help" class:field-error={dTagInvalid}>
          {#if dTagInvalid}Use lowercase letters and numbers, plus . _ : or -, starting with a letter or number.{:else}Deploying again with the same d-tag replaces the earlier version.{/if}
        </small>
      </label>
      <label>
        <span>Title</span>
        <input bind:value={title} placeholder="Optional display title" />
      </label>
      <label>
        <span>Description</span>
        <textarea bind:value={description} placeholder="Optional short description" rows="2"></textarea>
      </label>

      {#if prepared}
        <p class="requires"><span>Needs</span> {prepared.metadata.requires.length ? prepared.metadata.requires.join(', ') : 'no declared domains'}</p>
        <details class="hashes">
          <summary>Hashes</summary>
          <dl class="facts">
            <div><dt>HTML sha256</dt><dd title={prepared.htmlSha256}>{shortHash(prepared.htmlSha256)}</dd></div>
            <div><dt>Aggregate x</dt><dd title={prepared.aggregateHash}>{shortHash(prepared.aggregateHash)}</dd></div>
          </dl>
        </details>
      {/if}

      <button type="button" class="deploy" disabled={!canDeploy} onclick={deploy}>
        {step === 'uploading' ? 'Uploading…' : step === 'publishing' ? 'Publishing…' : 'Deploy napplet'}
      </button>
      {#if blockerText}<p class="note" data-testid="deploy-blocker">{blockerText}</p>{/if}

      {#if status && !blockerText}<p class="status" role="status">{status}</p>{/if}
      {#if failure}
        <div class="failure" role="alert" data-testid="deploy-failure">
          <strong>{failure.title}</strong>
          <p>{failure.hint}</p>
          <small>Runtime said: {failure.detail}</small>
        </div>
      {/if}
    </section>
  </section>

  {/if}

  <details class="panel where" open={publishedEvent !== null} data-testid="deploy-destinations">
    <summary>Where this goes</summary>
    <div class="grid">
      <article>
        <h3>File upload</h3>
        <div class="rows">
          {#each serverRows as server}
            <div class="row ok"><span>{server}</span><strong>stored</strong></div>
          {:else}
            <div class="row"><span>Your Blossom servers</span><strong>runtime picks</strong></div>
          {/each}
        </div>
        <p class="note">NAP-UPLOAD doesn't say which server it'll use up front, so destinations show once the runtime returns URLs.</p>
      </article>
      <article>
        <h3>Manifest publish</h3>
        <div class="rows">
          {#if publishedEvent}
            <div class="row ok"><span>{shortHash(publishedEvent.id)}</span><strong>signed</strong></div>
          {/if}
          {#each publishRelayHints as url}
            <div class="row ok"><span>{url}</span><strong>accepted</strong></div>
          {:else}
            {#each relays as row}
              <div class="row"><span>{row.url}</span><strong>{row.mode}</strong></div>
            {:else}
              <div class="row"><span>Your write relays</span><strong>outbox picks</strong></div>
            {/each}
          {/each}
        </div>
        <p class="note">NAP-OUTBOX owns relay selection, and returns the relays it used as hints for the NIP-19 entity.</p>
      </article>
    </div>
  </details>
</main>

<style>
  :global(body) {
    margin: 0;
    background: var(--hg-bg-base);
    color: var(--hg-text-primary);
    font: 13px/1.45 var(--hg-font-body);
  }

  main {
    min-height: 100vh;
    box-sizing: border-box;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  h1, h2, h3, p { margin: 0; }
  h1 { font: 600 20px/1.2 var(--hg-font-title, var(--hg-font-body)); }
  h2 { font-size: 14px; font-weight: 600; }
  h3 { font-size: 12px; font-weight: 600; }
  .lede, .note { color: var(--hg-text-muted); }
  .note { font-size: 12px; }

  .topbar { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: start; gap: 8px 12px; }
  .runtime { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0; padding: 0; list-style: none; color: var(--hg-text-muted); font-size: 12px; }
  .runtime li::before { content: ''; display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: var(--hg-accent-warning); }
  .runtime li.ok::before { background: var(--hg-accent-success); }

  .steps { display: flex; flex-wrap: wrap; gap: 4px 18px; margin: 0; padding: 8px 10px; list-style: none; border: 1px solid var(--hg-border-default); border-radius: 6px; background: var(--hg-bg-surface); color: var(--hg-text-muted); }
  .steps li { display: flex; align-items: center; gap: 6px; }
  .steps li.current { color: var(--hg-text-primary); font-weight: 600; }
  .step-number { display: inline-grid; place-items: center; width: 18px; height: 18px; border: 1px solid var(--hg-border-default); border-radius: 50%; font-size: 11px; }
  .steps li.current .step-number { border-color: var(--hg-accent-primary); color: var(--hg-accent-primary); }
  .steps li.done .step-number { border-color: var(--hg-accent-success); color: var(--hg-accent-success); }

  .workspace { display: grid; grid-template-columns: minmax(240px, .8fr) minmax(300px, 1.2fr); gap: 12px; align-items: start; }

  .dropzone, .panel, article { border: 1px solid var(--hg-border-default); background: var(--hg-bg-surface); border-radius: 6px; }

  .dropzone { display: grid; justify-items: center; gap: 10px; padding: 28px 18px; text-align: center; border-style: dashed; }
  .dropzone.active { border-color: var(--hg-accent-primary); background: color-mix(in srgb, var(--hg-accent-primary) 8%, var(--hg-bg-surface)); }
  .dropzone.has-file { border-style: solid; padding-block: 18px; }
  .dropzone h2 { overflow-wrap: anywhere; }
  .dropzone p { color: var(--hg-text-muted); }
  .dropzone code { color: var(--hg-text-primary); }
  .drop-actions, .panel-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
  .drop-actions { justify-content: center; }

  button { padding: 6px 12px; border: 1px solid var(--hg-border-default); border-radius: 4px; color: var(--hg-text-primary); background: var(--hg-bg-elevated); font: inherit; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--hg-accent-primary); }
  button:disabled { cursor: default; opacity: .5; }
  button:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--hg-accent-primary); outline-offset: 1px; }
  .primary, .deploy { border-color: var(--hg-accent-primary); color: var(--hg-accent-primary); background: color-mix(in srgb, var(--hg-accent-primary) 12%, var(--hg-bg-elevated)); font-weight: 600; }

  .panel { display: grid; gap: 10px; padding: 12px; min-width: 0; }
  label { display: grid; gap: 3px; }
  label > span { color: var(--hg-text-muted); font-size: 12px; }
  label small { color: var(--hg-text-muted); font-size: 11px; }
  input, textarea { box-sizing: border-box; width: 100%; padding: 6px 8px; border: 1px solid var(--hg-border-default); border-radius: 4px; color: var(--hg-text-primary); background: var(--hg-bg-base); font: inherit; }
  input::placeholder, textarea::placeholder { color: var(--hg-text-muted); opacity: .75; }
  textarea { resize: vertical; }
  .invalid { border-color: var(--hg-accent-danger); }
  label small.field-error, .dropzone p.error { color: var(--hg-accent-danger); }
  .hidden-file { display: none; }

  .requires { font-size: 12px; }
  .requires span { color: var(--hg-text-muted); margin-right: 4px; }
  .hashes summary, .where summary { cursor: pointer; color: var(--hg-text-muted); }
  .where summary { font-weight: 600; }
  .deploy { padding-block: 8px; }
  .status { color: var(--hg-text-muted); font-size: 12px; }

  .failure { display: grid; gap: 3px; padding: 8px 10px; border: 1px solid var(--hg-accent-danger); border-radius: 4px; background: color-mix(in srgb, var(--hg-accent-danger) 10%, var(--hg-bg-surface)); }
  .failure strong { color: var(--hg-accent-danger); }
  .failure small { color: var(--hg-text-muted); font-size: 11px; overflow-wrap: anywhere; }

  .facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin: 6px 0 0; }
  .facts div { min-width: 0; padding: 6px 8px; border: 1px solid var(--hg-border-default); border-radius: 4px; background: var(--hg-bg-base); }
  dt { color: var(--hg-text-muted); font-size: 11px; }
  dd { margin: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

  .result-panel { border-color: var(--hg-accent-success); }
  .result { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .result div { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 8px; align-items: center; }
  .result dt { grid-column: 1; }
  .result dd { grid-column: 1; }
  .result .copy-button { grid-column: 2; grid-row: 1 / span 2; padding: 3px 8px; font-size: 12px; }
  .result .primary-result { grid-column: 1 / -1; border-color: var(--hg-accent-success); }

  .where { display: block; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
  article { display: grid; gap: 8px; padding: 10px; background: var(--hg-bg-base); min-width: 0; }
  .rows { display: grid; gap: 4px; }
  .row { display: flex; justify-content: space-between; gap: 8px; min-width: 0; }
  .row span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .row strong { flex: 0 0 auto; color: var(--hg-text-muted); font-size: 11px; font-weight: 500; }
  .row.ok strong { color: var(--hg-accent-success); }

  @media (max-width: 760px) {
    .workspace, .grid { grid-template-columns: minmax(0, 1fr); }
    .facts, .result { grid-template-columns: minmax(0, 1fr); }
  }
</style>
