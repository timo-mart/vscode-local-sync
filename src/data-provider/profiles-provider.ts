import * as vscode from 'vscode';
import { DataOptions, DataProvider } from './data-provider';
import { logger } from '../initOutputChannel';
import { readJsonContent, writeJsonContent } from '../file.utils';

const ProfileMetadataKeys = [
  'profileAssociations',
  'profileAssociationsMigration',
  'userDataProfiles',
  'userDataProfilesMigration',
] as const;

type StorageJson = {
  profileAssociations?: unknown;
  profileAssociationsMigration?: unknown;
  userDataProfiles?: unknown;
  userDataProfilesMigration?: unknown;
  [key: string]: unknown;
};

export const ProfilesProviderId = 'profiles';
export const PendingProfilesRestoreFileName = 'local-sync-profiles-restore.json';
export const ProfileExtensionsBackupFileName = 'profile-extensions.json';

export class ProfilesProvider implements DataProvider {
  readonly id = ProfilesProviderId;
  #userFolder: vscode.Uri;

  constructor(userFolder: vscode.Uri) {
    this.#userFolder = userFolder;
  }

  public async backup({ path, dryRun }: DataOptions): Promise<void> {
    const storageJson = await readJsonContent<StorageJson>(this.getStorageJsonPath());
    const profileMetadata = this.getProfileMetadata(storageJson);
    const source = this.getProfilesPath(this.#userFolder);
    const target = this.getProfilesPath(path);

    logger.info('profiles backup', source.fsPath);
    if (dryRun) {
      logger.info('profiles backup metadata', profileMetadata);
      return;
    }

    await writeJsonContent(this.getMetadataPath(path), profileMetadata);
    await this.syncProfilesDirectory(source, target, 'backup', this.getProfileLocations(profileMetadata));
  }

  public async restore({ path, dryRun }: DataOptions): Promise<void> {
    const source = this.getProfilesPath(path);
    const target = this.getProfilesPath(this.#userFolder);
    const profileMetadata = await readJsonContent<StorageJson>(this.getMetadataPath(path));

    logger.info('profiles restore', source.fsPath);
    if (dryRun) {
      logger.info('profiles restore metadata', profileMetadata);
      return;
    }

    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.#userFolder, 'globalStorage'));
    await writeJsonContent(this.getPendingRestorePath(), profileMetadata ?? {});
    await this.syncProfilesDirectory(source, target, 'restore', this.getProfileLocations(profileMetadata));
  }

  private getMetadataPath(path: vscode.Uri) {
    return vscode.Uri.joinPath(path, 'profiles.json');
  }

  private getProfilesPath(path: vscode.Uri) {
    return vscode.Uri.joinPath(path, 'profiles');
  }

  private getStorageJsonPath() {
    return vscode.Uri.joinPath(this.#userFolder, 'globalStorage', 'storage.json');
  }

  private getPendingRestorePath() {
    return vscode.Uri.joinPath(this.#userFolder, 'globalStorage', PendingProfilesRestoreFileName);
  }

  private getProfileMetadata(storageJson: StorageJson | undefined): StorageJson {
    const metadata: StorageJson = {};

    if (!storageJson) {
      return metadata;
    }

    for (const key of ProfileMetadataKeys) {
      if (storageJson[key] !== undefined) {
        metadata[key] = storageJson[key];
      }
    }

    return metadata;
  }

  private getProfileLocations(storageJson: StorageJson | undefined): Set<string> | undefined {
    const profiles = storageJson?.userDataProfiles;
    if (!Array.isArray(profiles)) {
      return undefined;
    }

    return new Set(
      profiles
        .map(profile => {
          if (!profile || typeof profile !== 'object') {
            return undefined;
          }
          const location = (profile as { location?: unknown }).location;
          return typeof location === 'string' ? location : undefined;
        })
        .filter((location): location is string => !!location)
    );
  }

  private async syncProfilesDirectory(
    source: vscode.Uri,
    target: vscode.Uri,
    action: 'backup' | 'restore',
    activeProfileLocations?: Set<string>
  ): Promise<void> {
    try {
      if (await this.pathExists(target)) {
        await vscode.workspace.fs.delete(target, {
          recursive: true,
          useTrash: false,
        });
      }

      if (await this.pathExists(source)) {
        await vscode.workspace.fs.createDirectory(target);
        for (const [name, fileType] of await vscode.workspace.fs.readDirectory(source)) {
          if (fileType === vscode.FileType.Directory && activeProfileLocations && !activeProfileLocations.has(name)) {
            continue;
          }
          await vscode.workspace.fs.copy(vscode.Uri.joinPath(source, name), vscode.Uri.joinPath(target, name), {
            overwrite: true,
          });
        }
      }
    } catch (err) {
      logger.error(`profiles ${action} failed`, err);
    }
  }

  private async pathExists(path: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }
}
