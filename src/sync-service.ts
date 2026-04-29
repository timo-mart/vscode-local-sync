import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as provider from './data-provider';
import { readJsonContent, writeJsonContent } from './file.utils';
import { logger } from './initOutputChannel';

type ExtensionManifestEntry = {
  identifier?: {
    id?: string;
    uuid?: string;
  };
  version?: string;
  location?: unknown;
  relativeLocation?: string;
  metadata?: Record<string, unknown>;
};

type ProfileExtensionMap = Record<string, Array<string>>;
type LockFile = {
  pid: number;
  createdAt: number;
};

export class SyncService {
  static readonly PROFILE_METADATA_KEYS = [
    'profileAssociations',
    'profileAssociationsMigration',
    'userDataProfiles',
    'userDataProfilesMigration',
  ] as const;

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
      const shouldSyncProfileExtensionManifest =
        !options?.dryRun && this.getDataProviders(options?.providerId).some(d => d.id === provider.ProfilesProviderId);
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
        if (shouldSyncProfileExtensionManifest) {
          await this.backupProfileExtensionMap(path);
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

  public async restore(options?: { providerId?: string; dryRun?: boolean }): Promise<{ restartRequired: boolean }> {
    if (this.#isRestoring) {
      logger.debug('restore prevented because restore is running');
      return { restartRequired: false };
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
        if (shouldFinalizeProfileRestore) {
          await this.syncProfileExtensionManifests(
            vscode.Uri.joinPath(this.#userFolder, 'globalStorage', provider.PendingProfilesRestoreDirectoryName),
            await this.readProfileExtensionMap(path)
          );
        }
      });
      return { restartRequired: shouldFinalizeProfileRestore && (await this.finalizeProfileRestore()) };
    } catch (err) {
      logger.error('unhandled error in restore', err);
      return { restartRequired: false };
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

  public async promptForRestartAfterRestore(): Promise<void> {
    const restart = 'Restart VSCodium';
    const result = await vscode.window.showInformationMessage(
      'Profiles were restored. Restart VSCodium to finish registering them in the Profiles UI.',
      restart
    );
    if (result === restart) {
      await vscode.commands.executeCommand('workbench.action.quit');
    }
  }

  private async finalizeProfileRestore(): Promise<boolean> {
    const pendingRestorePath = vscode.Uri.joinPath(
      this.#userFolder,
      'globalStorage',
      provider.PendingProfilesRestoreFileName
    );
    const pendingProfilesPath = vscode.Uri.joinPath(
      this.#userFolder,
      'globalStorage',
      provider.PendingProfilesRestoreDirectoryName
    );

    const hasPendingMetadata = await this.pathExists(pendingRestorePath);
    const hasPendingProfiles = await this.pathExists(pendingProfilesPath);
    if (!hasPendingMetadata && !hasPendingProfiles) {
      return false;
    }

    const storagePath = vscode.Uri.joinPath(this.#userFolder, 'globalStorage', 'storage.json');
    const profilesPath = vscode.Uri.joinPath(this.#userFolder, 'profiles');
    const helperScript = [
      "const fs=require('node:fs');",
      "const { spawn }=require('node:child_process');",
      'const [metadataPath,stagedProfilesPath,targetProfilesPath,storagePath,parentPid,appPath]=process.argv.slice(1);',
      'const pid=Number(parentPid);',
      'const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));',
      'const alive=value=>{try{process.kill(value,0);return true;}catch{return false;}};',
      '(async()=>{',
      'while(Number.isFinite(pid)&&alive(pid)){await sleep(500);}',
      'if(fs.existsSync(stagedProfilesPath)){if(fs.existsSync(targetProfilesPath)){fs.rmSync(targetProfilesPath,{recursive:true,force:true});}fs.mkdirSync(targetProfilesPath,{recursive:true});for(const entry of fs.readdirSync(stagedProfilesPath)){fs.cpSync(`${stagedProfilesPath}/${entry}`,`${targetProfilesPath}/${entry}`,{recursive:true,force:true});}fs.rmSync(stagedProfilesPath,{recursive:true,force:true});}',
      'if(fs.existsSync(metadataPath)){const metadata=JSON.parse(fs.readFileSync(metadataPath,"utf8"));let storage={};try{storage=JSON.parse(fs.readFileSync(storagePath,"utf8"));}catch{}',
      `for(const key of ${JSON.stringify(SyncService.PROFILE_METADATA_KEYS)}){`,
      'if(Object.prototype.hasOwnProperty.call(metadata,key)){storage[key]=metadata[key];}else{delete storage[key];}}',
      'fs.writeFileSync(storagePath,JSON.stringify(storage,null,2));fs.rmSync(metadataPath,{force:true});}',
      'if(appPath){const env={...process.env};for(const key of Object.keys(env)){if(key.startsWith("ELECTRON_")||key.startsWith("VSCODE_")){delete env[key];}}delete env.NODE_OPTIONS;const child=spawn(appPath,[],{detached:true,stdio:"ignore",env});child.unref();}',
      '})().catch(()=>process.exit(1));',
    ].join('');

    try {
      const appPath = this.getRelaunchPath();
      const child = spawn(
        process.execPath,
        [
          '-e',
          helperScript,
          pendingRestorePath.fsPath,
          pendingProfilesPath.fsPath,
          profilesPath.fsPath,
          storagePath.fsPath,
          String(process.pid),
          appPath,
        ],
        {
          detached: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
          },
        }
      );
      child.unref();
      return true;
    } catch (err) {
      logger.error('failed to schedule profile restore finalization', err);
      void vscode.window.showWarningMessage(
        'Profiles were restored, but VSCodium could not schedule the restart needed to finish registering them automatically.'
      );
      return false;
    }
  }

  private getRelaunchPath(): string {
    if (process.platform === 'win32') {
      return path.join(vscode.env.appRoot, '..', '..', `${vscode.env.appName}.exe`);
    }
    return process.execPath;
  }

  private async syncProfileExtensionManifests(
    root: vscode.Uri,
    profileExtensionMap?: ProfileExtensionMap
  ): Promise<void> {
    const installedExtensions = await readJsonContent<Array<ExtensionManifestEntry>>(this.#extensionFolder);
    if (!installedExtensions?.length) {
      return;
    }

    const installedById = new Map(
      installedExtensions
        .map(extension => [extension.identifier?.id, extension] as const)
        .filter((entry): entry is readonly [string, ExtensionManifestEntry] => !!entry[0])
    );
    const profilesRoot = vscode.Uri.joinPath(root, 'profiles');

    let profiles: Array<[string, vscode.FileType]>;
    try {
      profiles = await vscode.workspace.fs.readDirectory(profilesRoot);
    } catch {
      return;
    }

    for (const [profileName, fileType] of profiles) {
      if (fileType !== vscode.FileType.Directory) {
        continue;
      }

      const profileExtensionsPath = vscode.Uri.joinPath(profilesRoot, profileName, 'extensions.json');
      const profileExtensions =
        (await readJsonContent<Array<ExtensionManifestEntry>>(profileExtensionsPath)) ??
        this.createProfileExtensionsFromMap(profileName, profileExtensionMap, installedById);

      if (!profileExtensions?.length) {
        continue;
      }

      const reconciledExtensions = profileExtensions.map(extension => {
        const id = extension.identifier?.id;
        if (!id) {
          return extension;
        }

        const installed = installedById.get(id);
        if (!installed) {
          logger.warn(`profile extension ${id} is not installed locally; keeping existing profile entry`);
          return extension;
        }

        return installed;
      });

      await writeJsonContent(profileExtensionsPath, reconciledExtensions);
    }
  }

  private createProfileExtensionsFromMap(
    profileName: string,
    profileExtensionMap: ProfileExtensionMap | undefined,
    installedById: Map<string, ExtensionManifestEntry>
  ): Array<ExtensionManifestEntry> | undefined {
    const ids = profileExtensionMap?.[profileName];
    if (!ids?.length) {
      return undefined;
    }

    return ids
      .map(id => {
        const installed = installedById.get(id);
        if (!installed) {
          logger.warn(`profile extension ${id} is not installed locally; cannot recreate profile manifest entry`);
        }
        return installed;
      })
      .filter((extension): extension is ExtensionManifestEntry => !!extension);
  }

  private async backupProfileExtensionMap(path: vscode.Uri): Promise<void> {
    const profileExtensionMap = await this.readProfileExtensionMapFromProfiles(this.#userFolder);
    await writeJsonContent(vscode.Uri.joinPath(path, provider.ProfileExtensionsBackupFileName), profileExtensionMap);
  }

  private async readProfileExtensionMap(path: vscode.Uri): Promise<ProfileExtensionMap> {
    const backupFile = vscode.Uri.joinPath(path, provider.ProfileExtensionsBackupFileName);
    const fromBackup = await readJsonContent<ProfileExtensionMap>(backupFile);
    if (fromBackup) {
      return fromBackup;
    }

    return this.readProfileExtensionMapFromProfiles(path);
  }

  private async readProfileExtensionMapFromProfiles(root: vscode.Uri): Promise<ProfileExtensionMap> {
    const profilesRoot = vscode.Uri.joinPath(root, 'profiles');
    const profileExtensionMap: ProfileExtensionMap = {};

    let profiles: Array<[string, vscode.FileType]>;
    try {
      profiles = await vscode.workspace.fs.readDirectory(profilesRoot);
    } catch {
      return profileExtensionMap;
    }

    for (const [profileName, fileType] of profiles) {
      if (fileType !== vscode.FileType.Directory) {
        continue;
      }

      const extensions = await readJsonContent<Array<ExtensionManifestEntry>>(
        vscode.Uri.joinPath(profilesRoot, profileName, 'extensions.json')
      );
      if (!extensions?.length) {
        continue;
      }

      profileExtensionMap[profileName] = extensions
        .map(extension => extension.identifier?.id)
        .filter((id): id is string => !!id);
    }

    return profileExtensionMap;
  }

  private async runWithLock(action: (path: vscode.Uri) => Promise<void>) {
    if (!this.backupPath) {
      logger.warn('no backup path configured');
      return;
    }
    const lockUri = vscode.Uri.joinPath(this.backupPath, 'sync.lock');
    const existingLock = await readJsonContent<LockFile>(lockUri);
    if (await this.pathExists(lockUri)) {
      if (existingLock?.pid && this.isProcessAlive(existingLock.pid)) {
        logger.warn('lock file exists and owner process is alive');
        return;
      }
      try {
        logger.warn('removing stale lock file', lockUri.fsPath);
        await vscode.workspace.fs.delete(lockUri);
      } catch (err) {
        logger.warn('stale lock file could not be removed', err);
        return;
      }
    }

    try {
      await writeJsonContent(lockUri, {
        pid: process.pid,
        createdAt: Date.now(),
      });
    } catch (err) {
      logger.warn('lock file was not created', err);
      return;
    }

    try {
      await action(this.backupPath);
    } finally {
      try {
        // wait for 200ms before releasing lock
        await new Promise<void>(resolve =>
          setTimeout(() => {
            resolve();
          }, 200)
        );
        await vscode.workspace.fs.delete(lockUri);
      } catch (err) {
        logger.error('lock file not deleted', err);
      }
    }
  }

  private async pathExists(pathToCheck: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(pathToCheck);
      return true;
    } catch {
      return false;
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
