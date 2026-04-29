import * as vscode from 'vscode';

const OpenProfileSelectorCommands = [
  'workbench.profiles.actions.switchProfile',
  'workbench.profiles.actions.manageProfiles',
  'workbench.action.openCommands',
] as const;

export class ProfileStatusService implements vscode.Disposable {
  #item: vscode.StatusBarItem;
  #enabled = true;
  #disposables: Array<vscode.Disposable> = [];

  constructor() {
    this.#item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.#item.name = 'local-sync profile launcher';
    this.#item.command = 'local-sync.openProfileSelector';
    this.#disposables.push(this.#item);
  }

  public setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (enabled) {
      this.refresh();
    } else {
      this.#item.hide();
    }
  }

  public refresh(): void {
    if (!this.#enabled) {
      this.#item.hide();
      return;
    }

    this.#item.text = '$(account) Profiles';
    this.#item.tooltip = new vscode.MarkdownString(
      [
        '**local-sync profiles**',
        '',
        'Open the native VSCodium profile selector.',
        '',
        'The active profile for the current window is not exposed through the public extension API, so this button stays neutral instead of showing incorrect profile names or icons.',
      ].join('\n')
    );
    this.#item.show();
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

  public dispose(): void {
    for (const disposable of this.#disposables) {
      disposable.dispose();
    }
  }
}
