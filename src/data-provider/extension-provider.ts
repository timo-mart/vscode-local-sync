import * as vscode from 'vscode';
import { logger } from '../initOutputChannel';
import { DataOptions, DataProvider } from './data-provider';
import { readJsonContent, writeJsonContent } from '../file.utils';
import { getConfigSetting } from '../config';
import {
  ProfileExtensionsBackupFileName,
} from './profiles-provider';

interface Extension extends vscode.Extension<unknown> {
  packageJSON: {
    isBuiltin: boolean;
    publisher: string;
    name: string;
    version: string;
  };
}

export const ExtensionProviderId = 'extensions';

type InstallExtensionCommandOptions = {
  isApplicationScoped?: boolean;
  profileLocation?: vscode.Uri;
};

type ProfileExtensionMap = Record<string, Array<string>>;

export class ExtensionProvider implements DataProvider {
  readonly id = ExtensionProviderId;
  #extensionFolder: vscode.Uri;

  constructor(extensionFolder: vscode.Uri) {
    this.#extensionFolder = extensionFolder;
  }

  public async backup({ path, userFolder, dryRun }: DataOptions): Promise<void> {
    const installedExtensions = this.filterIgnoredExtensions(
      Array.from(new Set([...(await this.getInstalledExtensions()), ...(await this.getProfileExtensionIds(userFolder, path))]))
    ).sort();

    logger.info('extensions backup', installedExtensions);
    if (!dryRun) {
      const filename = this.getFilepath(path);
      await writeJsonContent(filename, installedExtensions);
    }
  }

  private async getInstalledExtensions(userFolder?: vscode.Uri): Promise<Array<string>> {
    const extensions = await readJsonContent<Array<VSCodeExtensionsJSON>>(this.#extensionFolder);
    const installedExtensions = new Set<string>();

    if (extensions?.length) {
      for (const ext of extensions) {
        installedExtensions.add(ext.identifier.id);
      }
    } else {
      for (const ext of vscode.extensions.all.filter(
        (candidate: vscode.Extension<unknown>): candidate is Extension => !(candidate as Extension).packageJSON.isBuiltin
      )) {
        installedExtensions.add(`${ext.packageJSON.publisher}.${ext.packageJSON.name}`);
      }
    }

    if (userFolder) {
      for (const extensionId of await this.getProfileExtensionIds(userFolder, userFolder)) {
        installedExtensions.add(extensionId);
      }
    }

    return Array.from(installedExtensions);
  }

  private getFilepath(path: vscode.Uri) {
    return vscode.Uri.joinPath(path, 'extension.json');
  }

  private get shouldRemoveExtensions(): boolean {
    return !!getConfigSetting().get<boolean>('removeExtensions');
  }

  private filterIgnoredExtensions(extensions: Array<string> | undefined): Array<string> {
    const ignoredExtensios = getConfigSetting().get<Array<string>>('ignoreExtensions') || [];
    return (extensions || []).filter(ext => !ignoredExtensios.includes(ext));
  }

  public async restore({ path, userFolder, dryRun }: DataOptions): Promise<void> {
    const extensions = this.filterIgnoredExtensions(await readJsonContent<Array<string>>(this.getFilepath(path)));
    const installedExtensions = this.filterIgnoredExtensions(await this.getInstalledExtensions(userFolder));
    const profileExtensionMap = await this.getProfileExtensionMap(path);
    const profileSpecificExtensions = new Set(Object.values(profileExtensionMap).flat());
    const profileInstallTargets = await this.getProfileInstallTargets(profileExtensionMap, userFolder);

    const missingExtensions = extensions.filter(ext => !installedExtensions.includes(ext));
    const missingDefaultProfileExtensions = missingExtensions.filter(ext => !profileSpecificExtensions.has(ext));
    const missingProfileExtensions = missingExtensions.filter(ext => profileSpecificExtensions.has(ext));
    const deletedExtensions = this.shouldRemoveExtensions
      ? installedExtensions.filter(ext => !extensions.includes(ext))
      : [];
    logger.info(
      'extensions restore',
      {
        missingDefaultProfileExtensions,
        missingProfileExtensions,
        deletedExtensions,
      }
    );
    if (!dryRun) {
      await Promise.all(missingDefaultProfileExtensions.map(ext => this.installExtension(ext, this.#extensionFolder)));
      await Promise.all(missingProfileExtensions.map(ext => this.installExtension(ext, profileInstallTargets.get(ext))));
      await Promise.all(deletedExtensions.map(ext => this.deleteExtension(ext)));
    }
  }

  private async installExtension(ext: string, profileLocation?: vscode.Uri) {
    try {
      const options: InstallExtensionCommandOptions = {
        isApplicationScoped: false,
      };
      if (profileLocation) {
        options.profileLocation = profileLocation;
      }
      await vscode.commands.executeCommand('workbench.extensions.installExtension', ext, options);
      logger.info(`extension ${ext} installed`);
    } catch (err) {
      logger.warn(`extension ${ext} install with explicit profileLocation failed; retrying default install`, err);
      try {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', ext);
        logger.info(`extension ${ext} installed`);
      } catch (fallbackErr) {
        logger.error(`extension ${ext} failed to install`, fallbackErr);
      }
    }
  }

  private async deleteExtension(ext: string) {
    try {
      await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', ext);
      logger.info(`extension ${ext} deleted`);
    } catch (err) {
      logger.error(`extension ${ext} failed to delete`, err);
    }
  }

  private async getProfileExtensionIds(userFolder: vscode.Uri, backupPath: vscode.Uri): Promise<Array<string>> {
    const profileExtensionMap = await this.getProfileExtensionMap(backupPath, userFolder);

    return Array.from(new Set(Object.values(profileExtensionMap).flat()));
  }

  private async getProfileExtensionMap(backupPath: vscode.Uri, userFolder?: vscode.Uri): Promise<ProfileExtensionMap> {
    const fromBackup = await readJsonContent<ProfileExtensionMap>(vscode.Uri.joinPath(backupPath, ProfileExtensionsBackupFileName));
    if (fromBackup) {
      return fromBackup;
    }

    if (userFolder) {
      return this.readProfileExtensionMapFromProfiles(userFolder);
    }

    return {};
  }

  private async getProfileInstallTargets(
    profileExtensionMap: ProfileExtensionMap,
    userFolder: vscode.Uri
  ): Promise<Map<string, vscode.Uri>> {
    const installTargets = new Map<string, vscode.Uri>();

    for (const [profileLocation, extensionIds] of Object.entries(profileExtensionMap)) {
      const profileDirectory = vscode.Uri.joinPath(userFolder, 'profiles', profileLocation);
      await vscode.workspace.fs.createDirectory(profileDirectory);
      const installTarget = vscode.Uri.joinPath(profileDirectory, 'extensions.json');

      for (const extensionId of extensionIds) {
        installTargets.set(extensionId, installTarget);
      }
    }

    return installTargets;
  }

  private async readProfileExtensionMapFromProfiles(root: vscode.Uri): Promise<Record<string, Array<string>>> {
    const profilesRoot = vscode.Uri.joinPath(root, 'profiles');
    const profileExtensionMap: Record<string, Array<string>> = {};

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

      const extensions = await readJsonContent<Array<VSCodeExtensionsJSON>>(
        vscode.Uri.joinPath(profilesRoot, profileName, 'extensions.json')
      );
      if (!extensions?.length) {
        continue;
      }

      profileExtensionMap[profileName] = extensions
        .map(extension => extension.identifier.id)
        .filter((id): id is string => !!id);
    }

    return profileExtensionMap;
  }
}

export interface VSCodeExtensionsJSON {
  identifier: {
    id: string;
    uuid: string;
  };
  version: string;
}
