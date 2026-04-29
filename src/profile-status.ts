import * as path from 'node:path';
import * as vscode from 'vscode';
import { readJsonContent } from './file.utils';

type ProfileAssociationMap = Record<string, unknown>;

type StorageJson = {
  profileAssociations?: {
    workspaces?: ProfileAssociationMap;
    emptyWindows?: unknown;
  };
  userDataProfiles?: Array<{
    location?: unknown;
    name?: unknown;
    shortName?: unknown;
    icon?: unknown;
  }>;
};

type ResolvedProfileStatus = {
  name: string;
  icon: string;
  detail: string;
};

type ProfileEntry = {
  location?: unknown;
  name?: unknown;
  shortName?: unknown;
  icon?: unknown;
};

const DefaultProfileLocation = '__default__profile__';
const DefaultProfileName = 'Default';
const DefaultProfileIcon = 'account';
const OpenProfileSelectorCommands = [
  'workbench.profiles.actions.switchProfile',
  'workbench.profiles.actions.manageProfiles',
  'workbench.action.openCommands',
] as const;
const ProfileIconMap: Record<string, string> = {
  snake: 'symbol-misc',
  'terminal-linux': 'terminal',
  coffee: 'symbol-class',
  chip: 'extensions',
  verified: 'verified',
  server: 'server',
};

export class ProfileStatusService implements vscode.Disposable {
  #item: vscode.StatusBarItem;
  #userFolder: vscode.Uri;
  #enabled = true;
  #refreshTimer?: NodeJS.Timeout;
  #disposables: Array<vscode.Disposable> = [];

  constructor(context: vscode.ExtensionContext) {
    this.#item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.#item.name = 'local-sync profile status';
    this.#item.command = 'local-sync.openProfileSelector';
    this.#userFolder = this.getUserFolder(context);

    const storageWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.#userFolder, 'globalStorage/storage.json'),
      false,
      false,
      false
    );

    this.#disposables.push(
      this.#item,
      storageWatcher,
      storageWatcher.onDidCreate(() => {
        this.scheduleRefresh();
      }),
      storageWatcher.onDidChange(() => {
        this.scheduleRefresh();
      }),
      storageWatcher.onDidDelete(() => {
        this.scheduleRefresh();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.scheduleRefresh();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.scheduleRefresh();
      }),
      vscode.window.onDidChangeWindowState(() => {
        this.scheduleRefresh();
      })
    );
  }

  public setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (!enabled) {
      this.#item.hide();
      return;
    }
    this.scheduleRefresh();
  }

  public async refresh(): Promise<void> {
    clearTimeout(this.#refreshTimer);
    if (!this.#enabled) {
      this.#item.hide();
      return;
    }

    const profileStatus = await this.resolveProfileStatus();
    this.#item.text = `$(${profileStatus.icon}) Profile: ${profileStatus.name}`;
    this.#item.tooltip = new vscode.MarkdownString(
      [
        `**local-sync profile**`,
        '',
        profileStatus.detail,
        '',
        'Click to open the native profile selector.',
      ].join('\n')
    );
    this.#item.show();
  }

  public dispose(): void {
    clearTimeout(this.#refreshTimer);
    for (const disposable of this.#disposables) {
      disposable.dispose();
    }
  }

  private scheduleRefresh(): void {
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => {
      void this.refresh();
    }, 150);
  }

  private async resolveProfileStatus(): Promise<ResolvedProfileStatus> {
    const storage = await readJsonContent<StorageJson>(vscode.Uri.joinPath(this.#userFolder, 'globalStorage', 'storage.json'));
    const profiles = Array.isArray(storage?.userDataProfiles) ? storage.userDataProfiles : [];
    const workspaceAssociations = this.asRecord(storage?.profileAssociations?.workspaces);
    const candidates = this.getWorkspaceCandidates();

    if (!workspaceAssociations || candidates.length === 0) {
      return this.getDefaultStatus();
    }

    for (const candidate of candidates) {
      const matchedKey = this.findMatchingAssociationKey(candidate.uri, workspaceAssociations);
      if (!matchedKey) {
        continue;
      }

      const location = this.getAssociationLocation(workspaceAssociations[matchedKey]);
      const profile = profiles.find(entry => typeof entry.location === 'string' && entry.location === location);
      const name = this.getProfileName(profile, location);
      const icon = this.getProfileIcon(profile, location);

      return {
        name,
        icon,
        detail: `Matched ${candidate.label} to \`${matchedKey}\`.`,
      };
    }

    return this.getDefaultStatus();
  }

  private getWorkspaceCandidates(): Array<{ label: string; uri: vscode.Uri }> {
    const candidates: Array<{ label: string; uri: vscode.Uri }> = [];

    if (vscode.workspace.workspaceFile) {
      candidates.push({
        label: 'workspace file',
        uri: vscode.workspace.workspaceFile,
      });
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      candidates.push({
        label: `workspace folder "${folder.name}"`,
        uri: folder.uri,
      });
    }

    return candidates;
  }

  private findMatchingAssociationKey(uri: vscode.Uri, associations: ProfileAssociationMap): string | undefined {
    const exactCandidates = new Set([uri.toString(), uri.toString(true)]);
    for (const candidate of exactCandidates) {
      if (Object.prototype.hasOwnProperty.call(associations, candidate)) {
        return candidate;
      }
    }

    const normalizedUri = this.normalizeUriForComparison(uri);
    for (const key of Object.keys(associations)) {
      if (this.normalizeUriStringForComparison(key) === normalizedUri) {
        return key;
      }
    }

    return undefined;
  }

  private getAssociationLocation(value: unknown): string | undefined {
    if (typeof value === 'string') {
      return value;
    }

    const record = this.asRecord(value);
    const location = record?.location;
    return typeof location === 'string' ? location : undefined;
  }

  public async openProfileSelector(): Promise<void> {
    for (const command of OpenProfileSelectorCommands) {
      try {
        if (command === 'workbench.action.openCommands') {
          await vscode.commands.executeCommand(command, '>Profiles: Switch Profile');
        } else {
          await vscode.commands.executeCommand(command);
        }
        return;
      } catch {
        // Try the next known profile command id.
      }
    }

    void vscode.window.showWarningMessage('Could not open the native profile selector on this VSCodium build.');
  }

  private getProfileName(profile: ProfileEntry | undefined, location: string | undefined): string {
    if (location === DefaultProfileLocation) {
      return DefaultProfileName;
    }
    if (typeof profile?.name === 'string' && profile.name.length > 0 && profile.name !== DefaultProfileLocation) {
      return profile.name;
    }
    if (typeof profile?.shortName === 'string' && profile.shortName.length > 0 && profile.shortName !== DefaultProfileLocation) {
      return profile.shortName;
    }
    return this.getFallbackProfileName(location);
  }

  private getProfileIcon(profile: ProfileEntry | undefined, location: string | undefined): string {
    if (location === DefaultProfileLocation) {
      return DefaultProfileIcon;
    }
    if (typeof profile?.icon === 'string' && profile.icon.length > 0) {
      return ProfileIconMap[profile.icon] ?? 'account';
    }
    return 'account';
  }

  private getFallbackProfileName(location: string | undefined): string {
    if (!location || location === DefaultProfileLocation) {
      return DefaultProfileName;
    }
    return path.posix.basename(location) || DefaultProfileName;
  }

  private getDefaultStatus(): ResolvedProfileStatus {
    return {
      name: DefaultProfileName,
      icon: DefaultProfileIcon,
      detail: 'No matching workspace profile association was found. The built-in Profiles picker remains the source of truth.',
    };
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  }

  private normalizeUriForComparison(uri: vscode.Uri): string {
    if (uri.scheme === 'file') {
      return this.normalizeFilePath(uri.fsPath);
    }
    return uri.toString(true);
  }

  private normalizeUriStringForComparison(value: string): string {
    try {
      return this.normalizeUriForComparison(vscode.Uri.parse(value, true));
    } catch {
      return value;
    }
  }

  private normalizeFilePath(value: string): string {
    const normalized = path.normalize(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  private getUserFolder(context: vscode.ExtensionContext): vscode.Uri {
    if (process.env.VSCODE_PORTABLE) {
      return vscode.Uri.joinPath(vscode.Uri.file(process.env.VSCODE_PORTABLE), 'user-data', 'User');
    }
    return vscode.Uri.joinPath(context.globalStorageUri, '..', '..', '..', 'User');
  }
}
