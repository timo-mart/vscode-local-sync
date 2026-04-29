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
  }>;
};

type ResolvedProfileStatus = {
  name: string;
  detail: string;
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
    this.#item.command = 'local-sync.refreshProfileStatus';
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
    this.#item.text = `$(account) ${profileStatus.name}`;
    this.#item.tooltip = new vscode.MarkdownString(
      [
        `**local-sync profile**`,
        '',
        profileStatus.detail,
        '',
        'Click to refresh this indicator.',
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
      const name = this.getProfileName(profile) ?? this.getFallbackProfileName(location);

      return {
        name,
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

  private getProfileName(profile: { name?: unknown; shortName?: unknown } | undefined): string | undefined {
    if (typeof profile?.name === 'string' && profile.name.length > 0) {
      return profile.name;
    }
    if (typeof profile?.shortName === 'string' && profile.shortName.length > 0) {
      return profile.shortName;
    }
    return undefined;
  }

  private getFallbackProfileName(location: string | undefined): string {
    if (!location) {
      return 'Default';
    }
    return path.posix.basename(location) || 'Default';
  }

  private getDefaultStatus(): ResolvedProfileStatus {
    return {
      name: 'Default',
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
