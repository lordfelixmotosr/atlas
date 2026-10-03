// @ts-nocheck
import {randomUUID} from 'node:crypto';
import {renameSync} from 'node:fs';
import {AsyncLocalStorage} from "node:async_hooks";
import { app, safeStorage } from 'electron';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';
import type {
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai';

interface LockResult<T> {
  result: T;
  next?: string;
}

/**
 * Locked read-modify-write over the credential blob. Mirrors the shape pi's
 * own `AuthStorageBackend` used to have — pi 0.82 stopped exporting that
 * interface (and the `AuthStorage` class that consumed it) from its public
 * entry point, so we declare the contract ourselves and pair it with
 * `SafeStorageCredentialStore` below.
 */
interface AuthStorageBackend {
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
  withLockAsync<T>(
    fn: (current: string | undefined) => Promise<LockResult<T>>,
  ): Promise<T>;
}

/**
 * Storage backend backed by Electron's safeStorage. Replaces pi's default
 * `FileAuthStorageBackend` which writes the JSON token blob plaintext.
 *
 * Storage layout:
 *   - `auth.enc` — Buffer payload, written via `safeStorage.encryptString`.
 *   - `auth.json` — legacy plaintext file. If present at first read, we
 *     migrate its contents into `auth.enc` and delete it. After migration the
 *     plaintext file no longer appears on disk, so even an attacker who
 *     reads the userData directory after the app has been launched once
 *     does not see tokens.
 *
 * The `auth.enc` file is locked the same way pi locks `auth.json` so a
 * concurrent token refresh from another process doesn't corrupt the file.
 *
 * Key behaviour notes:
 *   - `safeStorage.isEncryptionAvailable()` may be false on Linux without
 *     keyring or before `app.ready` on Windows. We *fail closed* — an
 *     unavailable keyring means we treat creds as missing (so the user is
 *     prompted to re-login), rather than silently falling back to plaintext.
 *   - We never throw out of `withLock` for missing-keyring; instead we
 *     return empty data and skip writing. AuthStorage's reload() can be
 *     called again later when encryption becomes available.
 */
export class SafeStorageAuthBackend implements AuthStorageBackend {
  /** Encryption is verified once and cached so subsequent calls are cheap. */
  private encryptionState: 'unknown' | 'available' | 'unavailable' = 'unknown';

  constructor(
    private readonly encPath: string,
    private readonly legacyPlaintextPath: string,
  ) {}

  private ensureParentDir(): void {
    const dir = dirname(this.encPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  private isEncryptionAvailable(): boolean {
    if (this.encryptionState === 'available') return true;
    if (this.encryptionState === 'unavailable') return false;
    // Re-check each time until we've conclusively succeeded. On Linux
    // without a keyring this returns false even after ready; on Windows it
    // returns false before ready and true after.
    if (!app.isReady()) return false;
    const ok = safeStorage.isEncryptionAvailable();
    this.encryptionState = ok ? 'available' : 'unavailable';
    if (!ok) {
      // eslint-disable-next-line no-console
      console.warn(
        '[modmixer:auth] safeStorage is not available on this system. ' +
          'OAuth tokens will not be persisted. The user will need to re-login each session.',
      );
    }
    return ok;
  }

  /**
   * Read the on-disk JSON, performing a one-time migration from any legacy
   * plaintext `auth.json` to the encrypted `auth.enc`. Returns the decoded
   * JSON content as a string, or undefined when there is genuinely nothing
   * stored yet.
   *
   * THROWS when a non-empty `auth.enc` exists but can't be read (keyring
   * unavailable, or a blob sealed by a different app identity). That
   * distinction matters: callers under `withLock` turn what they read into
   * the *replacement* blob, so returning "no credentials" for a file we
   * simply couldn't open would persist that emptiness and wipe every
   * provider's credential on one transient keychain hiccup. Read-only
   * callers (`SafeStorageCredentialStore.reload`) catch this and degrade to
   * an empty view without writing.
   */
  private readDecrypted(): string | undefined {
    // ensureLockableFile() touches a zero-byte file so proper-lockfile has a
    // target on first run — that's "nothing stored", not a failure.
    if (existsSync(this.encPath) && statSync(this.encPath).size > 0) {
      if (!this.isEncryptionAvailable()) {
        throw new Error(
          'safeStorage is unavailable — refusing to read auth.enc as empty.',
        );
      }
      try {
        const blob = readFileSync(this.encPath);
        return safeStorage.decryptString(blob);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[modmixer:auth] Failed to decrypt auth.enc:', err);
        throw err;
      }
    }

    if (existsSync(this.legacyPlaintextPath)) {
      // First-launch migration. Read the old plaintext, write encrypted,
      // then delete the plaintext. We do not attempt the migration if the
      // keyring is unavailable — better to leave the plaintext file alone
      // (the user can manually delete it / re-login) than write garbage.
      const plaintext = readFileSync(this.legacyPlaintextPath, 'utf-8');
      if (this.isEncryptionAvailable()) {
        try {
          this.writeEncrypted(plaintext);
          // Truncate the plaintext file to zero before unlinking, in case
          // the file is being held open by another process or backed up
          // somewhere outside our control.
          try {
            writeFileSync(this.legacyPlaintextPath, '', 'utf-8');
          } catch {
            // Ignore — the unlink below is the actual cleanup.
          }
          try {
            unlinkSync(this.legacyPlaintextPath);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
              '[modmixer:auth] Migrated tokens to auth.enc but could not remove auth.json:',
              err,
            );
          }
          // eslint-disable-next-line no-console
          console.log('[modmixer:auth] Migrated plaintext auth.json to encrypted auth.enc.');
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[modmixer:auth] Migration to encrypted store failed:', err);
        }
      }
      return plaintext;
    }

    return undefined;
  }

  private writeEncrypted(content: string): void {
    if (!this.isEncryptionAvailable()) {
      throw new Error(
        'safeStorage is not available — refusing to persist OAuth tokens in plaintext.',
      );
    }
    this.ensureParentDir();
    const blob = safeStorage.encryptString(content);
    const temporary=this.encPath+".atlas-new-"+randomUUID();
    try{writeFileSync(temporary,blob,{flag:"wx",mode:0o600});chmodSync(temporary,0o600);renameSync(temporary,this.encPath);}finally{if(existsSync(temporary))unlinkSync(temporary);}
  }

  private acquireLockSyncWithRetry(path: string): () => void {
    const maxAttempts = 10;
    const delayMs = 20;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return lockfile.lockSync(path, { realpath: false });
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code?: unknown }).code)
            : undefined;
        if (code !== 'ELOCKED' || attempt === maxAttempts) {
          throw error;
        }
        lastError = error;
        const start = Date.now();
        // Synchronous spin so callers don't have to be async-aware. Matches
        // pi's FileAuthStorageBackend.acquireLockSyncWithRetry.
        while (Date.now() - start < delayMs) {
          // intentionally empty
        }
      }
    }
    throw (lastError as Error) ?? new Error('Failed to acquire auth storage lock');
  }

  /**
   * proper-lockfile expects the lock target to exist on disk. The encrypted
   * file may not exist on first run (no creds yet) — touch it so we can
   * acquire the lock, then leave the touch alone (subsequent writes overwrite).
   */
  private ensureLockableFile(): void {
    this.ensureParentDir();
    if (!existsSync(this.encPath)) {
      writeFileSync(this.encPath, '');
      chmodSync(this.encPath, 0o600);
    }
  }

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    this.ensureLockableFile();
    let release: (() => void) | undefined;
    try {
      release = this.acquireLockSyncWithRetry(this.encPath);
      const current = this.readDecrypted();
      const { result, next } = fn(current);
      if (next !== undefined) {
        this.writeEncrypted(next);
      }
      return result;
    } finally {
      if (release) release();
    }
  }

  async withLockAsync<T>(
    fn: (current: string | undefined) => Promise<LockResult<T>>,
  ): Promise<T> {
    this.ensureLockableFile();
    let release: (() => Promise<void>) | undefined;
    let lockCompromised = false;
    let lockCompromisedError: Error | undefined;
    const throwIfCompromised = () => {
      if (lockCompromised) {
        throw lockCompromisedError ?? new Error('Auth storage lock was compromised');
      }
    };
    try {
      release = await lockfile.lock(this.encPath, {
        retries: {
          retries: 10,
          factor: 2,
          minTimeout: 100,
          maxTimeout: 10000,
          randomize: true,
        },
        stale: 30000,
        onCompromised: (err: Error) => {
          lockCompromised = true;
          lockCompromisedError = err;
        },
      });
      throwIfCompromised();
      const current = this.readDecrypted();
      const { result, next } = await fn(current);
      throwIfCompromised();
      if (next !== undefined) {
        this.writeEncrypted(next);
      }
      throwIfCompromised();
      return result;
    } finally {
      if (release) {
        try {
          await release();
        } catch {
          // Ignore unlock errors when compromised.
        }
      }
    }
  }
}

/** On-disk shape: one credential per provider id, same as pi's auth.json. */
type CredentialData = Record<string, Credential>;

function parseCredentials(raw: string | undefined): CredentialData {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as CredentialData;
  } catch {
    // Decrypted but not valid JSON — treat as "no credentials" rather than a
    // hard failure, so the user re-logins instead of the app failing to boot.
    // (An *undecryptable* blob is a different case: the backend throws, so a
    // write path can never mistake it for an empty store.)
    return {};
  }
}

/**
 * pi-ai `CredentialStore` over the encrypted backend above.
 *
 * pi 0.80 gave us this for free: `AuthStorage.fromStorage(backend)` wrapped a
 * backend and pi's ModelRegistry consumed it. In 0.82 the credential layer
 * became the pi-ai `CredentialStore` interface and `AuthStorage` stopped
 * being exported, so we own the (small) adapter: parse the locked blob,
 * serve reads from an in-memory copy, and route every write through
 * `withLockAsync` so a concurrent OAuth refresh can't clobber the file.
 *
 * Reads are served from cache because pi calls `read()` on request paths and
 * the underlying decrypt is a keychain round-trip. `reload()` re-primes that
 * cache — see `AgentHost.primeAfterReady`, which calls it once safeStorage
 * is actually available.
 */

const FELIX_ACCOUNTS_KEY="__felixOpenAIAccounts";
function felixValidCredential(value){return value?.type==="oauth"&&typeof value.access==="string"&&!!value.access&&typeof value.refresh==="string"&&!!value.refresh&&typeof value.expires==="number"&&Number.isFinite(value.expires)&&typeof value.accountId==="string"&&!!value.accountId;}
function felixAccountLabel(value,fallback){
  if(value===undefined)return fallback;
  if(typeof value!=="string")throw new Error("Enter an account name.");
  const label=value.replace(/[\x00-\x1f\x7f]/g," ").trim();
  if(!label||label.length>40)throw new Error("Account names must be 1–40 characters.");
  return label;
}
function felixAccountDocument(data){
  let document=data[FELIX_ACCOUNTS_KEY];
  if(document!==undefined){
    if(document?.version!==1||!Array.isArray(document.accounts)||document.accounts.length>2||document.accounts.some(item=>!item||!["account-1","account-2"].includes(item.id)||typeof item.label!=="string"||!item.label||item.label.length>40||!felixValidCredential(item.credential))||new Set(document.accounts.map(item=>item.id)).size!==document.accounts.length||new Set(document.accounts.map(item=>item.credential.accountId)).size!==document.accounts.length||(!document.accounts.length?document.activeId!==null:!document.accounts.some(item=>item.id===document.activeId)))throw new Error("Saved OpenAI accounts could not be read. Your sign-ins have been left unchanged.");
  }else document={version:1,activeId:null,accounts:[]};
  const current=data["openai-codex"];
  if(felixValidCredential(current)){
    let item=document.accounts.find(entry=>entry.credential.accountId===current.accountId);
    if(!item){
      const id=["account-1","account-2"].find(id=>!document.accounts.some(entry=>entry.id===id));
      if(!id)throw new Error("The active OpenAI sign-in does not match the two saved accounts. Your sign-ins have been left unchanged.");
      item={id,label:id==="account-1"?"Account 1":"Account 2",credential:current};document.accounts.push(item);
    }
    item.credential=current;document.activeId=item.id;
  }else if(current!==undefined&&document.accounts.length)throw new Error("The active OpenAI sign-in could not be read. Your sign-ins have been left unchanged.");
  else if(document.accounts.length){
    document.activeId=null;document.accounts=[];
  }
  data[FELIX_ACCOUNTS_KEY]=document;
  return document;
}
function felixAccountView(document){return {activeId:document.activeId,accounts:document.accounts.map(item=>({id:item.id,label:item.label,active:item.id===document.activeId}))};}
export class SafeStorageCredentialStore{
  data:any;backend:any;felixLoginContext:any;
  constructor(backend){this.data={};this.backend=backend;this.felixLoginContext=new AsyncLocalStorage();this.reload();}
  reload(){try{this.data=this.backend.withLock(raw=>({result:parseCredentials(raw)}));}catch{this.data={};if(app.isReady())console.error("[modmixer:auth] Failed to reload encrypted credentials.");}}
  peek(provider){return provider===FELIX_ACCOUNTS_KEY?undefined:this.data[provider];}
  async read(provider){return this.peek(provider);}
  async list(){return Object.entries(this.data).filter(([id,value])=>id!==FELIX_ACCOUNTS_KEY&&["oauth","api_key"].includes(value?.type)).map(([providerId,value])=>({providerId,type:value.type}));}
  async felixTransaction(callback){
    let updated;
    const result=await this.backend.withLockAsync(async raw=>{
      let data;
      try{data=raw?.trim()?JSON.parse(raw):{};if(!data||typeof data!=="object"||Array.isArray(data))throw new Error();}
      catch{throw new Error("Encrypted credentials could not be read. Your sign-ins have been left unchanged.");}
      const result=await callback(data);updated=data;
      const next=JSON.stringify(data,null,2);
      return {result,next:next===raw?undefined:next};
    });
    this.data=updated;return result;
  }
  async initializeOpenAIAccounts(){return this.felixTransaction(data=>felixAccountView(felixAccountDocument(data)));}
  openAIAccounts(){return felixAccountView(felixAccountDocument(JSON.parse(JSON.stringify(this.data))));}
  async modify(provider,callback){
    const login=provider==="openai-codex"?this.felixLoginContext.getStore():null;
    let loginAccepted=false;
    const result=await this.felixTransaction(async data=>{
      const document=provider==="openai-codex"?felixAccountDocument(data):null;
      const next=await callback(data[provider]);
      if(next===undefined)return data[provider];
      if(document&&felixValidCredential(next)){
        let item=document.accounts.find(entry=>entry.credential.accountId===next.accountId);
        if(login){
          if(login.signal?.aborted)throw new Error("Sign-in cancelled.");
          if(!item){
            const id=login.id||["account-1","account-2"].find(id=>!document.accounts.some(entry=>entry.id===id));
            if(!id)throw new Error("Both account slots are filled. Remove one before adding another account.");
            const target=document.accounts.find(entry=>entry.id===id);
            if(target)throw new Error("This slot belongs to a different account. Remove it before signing in with another account.");
            item={id,label:felixAccountLabel(login.label,id==="account-1"?"Account 1":"Account 2"),credential:next};document.accounts.push(item);
          }else login.duplicate=!!login.id&&login.id!==item.id||!login.id;
          loginAccepted=true;
        }else if(!item){
          const id=["account-1","account-2"].find(id=>!document.accounts.some(entry=>entry.id===id));
          if(!id)throw new Error("The refreshed sign-in does not match a saved OpenAI account.");
          item={id,label:id==="account-1"?"Account 1":"Account 2",credential:next};document.accounts.push(item);
        }
        item.credential=next;document.activeId=item.id;
      }
      data[provider]=next;return next;
    });
    if(login&&loginAccepted)login.committed=true;
    return result;
  }
  async delete(provider){
    return this.felixTransaction(data=>{
      if(provider==="openai-codex"){
        const document=felixAccountDocument(data);document.accounts=document.accounts.filter(item=>item.id!==document.activeId);
        const next=document.accounts[0];document.activeId=next?.id??null;
        if(next)data[provider]=next.credential;else delete data[provider];
      }else delete data[provider];
    });
  }
  async selectOpenAIAccount(id){return this.felixTransaction(data=>{
    const document=felixAccountDocument(data),item=document.accounts.find(item=>item.id===id);
    if(!item)throw new Error("This saved OpenAI account is no longer available.");
    document.activeId=id;data["openai-codex"]=item.credential;return felixAccountView(document);
  });}
  async removeOpenAIAccount(id){return this.felixTransaction(data=>{
    const document=felixAccountDocument(data);
    if(!document.accounts.some(item=>item.id===id))throw new Error("This saved OpenAI account is no longer available.");
    document.accounts=document.accounts.filter(item=>item.id!==id);
    if(document.activeId===id){const next=document.accounts[0];document.activeId=next?.id??null;if(next)data["openai-codex"]=next.credential;else delete data["openai-codex"];}
    return felixAccountView(document);
  });}
  async renameOpenAIAccount(id,label){return this.felixTransaction(data=>{
    const document=felixAccountDocument(data),item=document.accounts.find(item=>item.id===id);
    if(!item)throw new Error("This saved OpenAI account is no longer available.");
    item.label=felixAccountLabel(label,item.label);return felixAccountView(document);
  });}
}
