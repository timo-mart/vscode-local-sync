import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as provider from './data-provider';
import { logger } from './initOutputChannel';

export class SyncService {
  #extensionFolder: vscode.Uri;
  #userFolder: vscode.Uri;
  #dataProviders: Array<provider.DataProvider>;

  #isRestoring = false;

  backupTimer?: NodeJS.Timeout;
  private backupDebounced = () => {
    if (this.#isRestoring) {
      return;
    }
    clearTimeout(this.backupTimer);
    this.backupTimer = setTimeout(() => {
      void this.backup();
    }, 300);
  };

  constructor(context: vscode.ExtensionContext) {
    this.#extensionFolder = vscode.Uri.joinPath(context.extensionUri, '..', 'extensions.json');
    this.#userFolder = this.getUserfolder(context);
    this.#dataProviders = [
      new provider.ProfilesProvider(this.#userFolder),
      new provider.SettingsProvider(),
      new provider.KeybindingsProvider(),
      new provider.SnippetsProvider(),
      new provider.ExtensionProvider(this.#extensionFolder),
    ];
  }

  public backupPath: vscode.Uri | undefined;

  public async backup(options?: { providerId?: string; dryRun?: boolean }): Promise<void> {
    if (this.#isRestoring) {
      logger.debug('backup prevented because restore is running');
      return;
    }
    logger.debug('backup started');
    try {
      await this.runWithLock(async path => {
        for (const provider of this.getDataProviders(options?.providerId)) {
          logger.debug(`provider ${provider.id} backup started`);
          await provider.backup({
            path,
            userFolder: this.#userFolder,
            dryRun: !!options?.dryRun,
          });
          logger.debug(`provider ${provider.id} backup finished`);
        }
      });
    } catch (err) {
      logger.error('unhandled error in backup', err);
    } finally {
      logger.debug('backup finished');
    }
  }

  private getDataProviders(providerId: string | undefined) {
    if (providerId) {
      return this.#dataProviders.filter(d => d.id === providerId);
    }
    return this.#dataProviders;
  }

  public async restore(options?: { providerId?: string; dryRun?: boolean }): Promise<void> {
    if (this.#isRestoring) {
      logger.debug('restore prevented because restore is running');
      return;
    }
    logger.debug('restore started');
    this.#isRestoring = true;

    try {
      const shouldFinalizeProfileRestore =
        !options?.dryRun && this.getDataProviders(options?.providerId).some(d => d.id === provider.ProfilesProviderId);
      await this.runWithLock(async path => {
        for (const dataProvider of this.getDataProviders(options?.providerId)) {
          logger.debug(`provider ${dataProvider.id} restore started`);
          await dataProvider.restore({
            path,
            userFolder: this.#userFolder,
            dryRun: !!options?.dryRun,
          });
          logger.debug(`provider ${dataProvider.id} restore finished`);
        }
      });
      if (shouldFinalizeProfileRestore) {
        await this.finalizeProfileRestore();
      }
    } catch (err) {
      logger.error('unhandled error in restore', err);
    } finally {
      this.#isRestoring = false;
      logger.debug('restore finished');
    }
  }

  private getUserfolder(context: vscode.ExtensionContext): vscode.Uri {
    if (process.env.VSCODE_PORTABLE) {
      const path = vscode.Uri.file(process.env.VSCODE_PORTABLE);
      return vscode.Uri.joinPath(path, 'user-data', 'User');
    } else {
      const path = vscode.Uri.joinPath(context.globalStorageUri, '..', '..', '..');
      return vscode.Uri.joinPath(path, 'User');
    }
  }

  public watchForChanges(): Array<vscode.Disposable> {
    const fileSystemWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.#userFolder, '{*.json,snippets/*.{json,code-snippets}}'),
      false,
      false,
      true
    );
    const profilesWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.#userFolder, 'profiles/**'),
      false,
      false,
      true
    );

    return [
      vscode.extensions.onDidChange(async () => {
        if (vscode.window.state.focused && this.backupPath && !this.#isRestoring) {
          logger.info('Extensions changed');
          await this.backup({
            providerId: provider.ExtensionProviderId,
          });
        }
      }),
      fileSystemWatcher.onDidCreate(() => {
        if (!this.#isRestoring) {
          this.backupDebounced();
        }
      }),
      fileSystemWatcher.onDidChange(() => {
        if (!this.#isRestoring) {
          this.backupDebounced();
        }
      }),
      fileSystemWatcher.onDidDelete(() => {
        if (!this.#isRestoring) {
          this.backupDebounced();
        }
      }),
      profilesWatcher.onDidCreate(() => {
        if (!this.#isRestoring) {
          this.backupDebounced();
        }
      }),
      profilesWatcher.onDidChange(() => {
        if (!this.#isRestoring) {
          this.backupDebounced();
        }
      }),
      profilesWatcher.onDidDelete(() => {
        if (!this.#isRestoring) {
          this.backupDebounced();
        }
      }),
      fileSystemWatcher,
      profilesWatcher,
    ];
  }

  private async finalizeProfileRestore(): Promise<void> {
    const pendingRestorePath = vscode.Uri.joinPath(
      this.#userFolder,
      'globalStorage',
      provider.PendingProfilesRestoreFileName
    );

    try {
      await vscode.workspace.fs.stat(pendingRestorePath);
    } catch {
      return;
    }

    const storagePath = vscode.Uri.joinPath(this.#userFolder, 'globalStorage', 'storage.json');
    const helperScript = [
      "const fs=require('node:fs');",
      'const [metadataPath,storagePath,parentPid]=process.argv.slice(1);',
      'const pid=Number(parentPid);',
      'const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));',
      'const alive=value=>{try{process.kill(value,0);return true;}catch{return false;}};',
      '(async()=>{',
      'while(Number.isFinite(pid)&&alive(pid)){await sleep(500);}',
      "const metadata=JSON.parse(fs.readFileSync(metadataPath,'utf8'));",
      'let storage={};',
      "try{storage=JSON.parse(fs.readFileSync(storagePath,'utf8'));}catch{}",
      "for(const key of ['profileAssociations','profileAssociationsMigration','userDataProfiles','userDataProfilesMigration']){",
      'if(Object.prototype.hasOwnProperty.call(metadata,key)){storage[key]=metadata[key];}',
      '}',
      "fs.writeFileSync(storagePath,JSON.stringify(storage,null,2));",
      "fs.unlinkSync(metadataPath);",
      '})().catch(()=>process.exit(1));',
    ].join('');

    try {
      const child = spawn(process.execPath, ['-e', helperScript, pendingRestorePath.fsPath, storagePath.fsPath, String(process.pid)], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
        },
      });
      child.unref();
      void vscode.window.showInformationMessage(
        'Profiles were restored. Close all VSCodium windows and reopen to finish registering them in the Profiles UI.'
      );
    } catch (err) {
      logger.error('failed to schedule profile restore finalization', err);
      void vscode.window.showWarningMessage(
        'Profiles were restored, but VSCodium could not schedule the final registration step automatically.'
      );
    }
  }

  private async runWithLock(action: (path: vscode.Uri) => Promise<void>) {
    if (!this.backupPath) {
      logger.warn('no backup path configured');
      return;
    }
    const lockUri = vscode.Uri.joinPath(this.backupPath, 'sync.lock');
    try {
      await vscode.workspace.fs.stat(lockUri);
      logger.warn('lock file exists');
      return;
    } catch {
      try {
        await vscode.workspace.fs.writeFile(lockUri, new Uint8Array());
      } catch (err) {
        logger.warn('lock file was not created', err);
        return;
      }
    }
    await action(this.backupPath);
    try {
      // wait for 200ms before releasing lock
      await new Promise<void>(resolve =>
        setTimeout(() => {
          resolve();
        }, 200)
      );
      await vscode.workspace.fs.delete(lockUri);
      return;
    } catch (err) {
      logger.error('lock file not deleted', err);
    }
  }
}
