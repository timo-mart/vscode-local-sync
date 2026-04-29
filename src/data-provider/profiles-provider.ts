import * as vscode from 'vscode';
import { DataOptions, DataProvider } from './data-provider';
import { logger } from '../initOutputChannel';
import { readJsonContent, writeJsonContent } from '../file.utils';

type StorageJson = {
  profileAssociations?: unknown;
  userDataProfiles?: unknown;
  [key: string]: unknown;
};

export const ProfilesProviderId = 'profiles';

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

    if (profileMetadata) {
      await writeJsonContent(this.getMetadataPath(path), profileMetadata);
    }

    if (await this.pathExists(source)) {
      try {
        await vscode.workspace.fs.copy(source, target, {
          overwrite: true,
        });
      } catch (err) {
        logger.error('profiles backup failed', err);
      }
    }
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

    if (profileMetadata) {
      const storagePath = this.getStorageJsonPath();
      const currentStorage = (await readJsonContent<StorageJson>(storagePath)) || {};

      if (profileMetadata.profileAssociations !== undefined) {
        currentStorage.profileAssociations = profileMetadata.profileAssociations;
      }
      if (profileMetadata.userDataProfiles !== undefined) {
        currentStorage.userDataProfiles = profileMetadata.userDataProfiles;
      }

      await writeJsonContent(storagePath, currentStorage);
    }

    if (await this.pathExists(source)) {
      try {
        await vscode.workspace.fs.copy(source, target, {
          overwrite: true,
        });
      } catch (err) {
        logger.error('profiles restore failed', err);
      }
    }
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

  private getProfileMetadata(storageJson: StorageJson | undefined): StorageJson | undefined {
    if (!storageJson) {
      return undefined;
    }

    const metadata: StorageJson = {};
    if (storageJson.profileAssociations !== undefined) {
      metadata.profileAssociations = storageJson.profileAssociations;
    }
    if (storageJson.userDataProfiles !== undefined) {
      metadata.userDataProfiles = storageJson.userDataProfiles;
    }

    return Object.keys(metadata).length > 0 ? metadata : undefined;
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
