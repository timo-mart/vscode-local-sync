import * as vscode from 'vscode';
import { initOutputChannel, logger } from './initOutputChannel';
import { SyncService } from './sync-service';
import { watchConfigSettings } from './config';
import { ProfileStatusService } from './profile-status';

async function runWithProgress(title: string, action: () => Promise<void>): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false,
    },
    async () => {
      await action();
    }
  );
}

export function activate(context: vscode.ExtensionContext): void {
  const syncService = new SyncService(context);
  const profileStatusService = new ProfileStatusService(context);

  let isRestored = false;
  context.subscriptions.push(
    ...[
      initOutputChannel(),
      profileStatusService,
      vscode.commands.registerCommand('local-sync.backup', async () => {
        await runWithProgress('local-sync: Backing up settings and profiles...', async () => {
          await syncService.backup();
        });
      }),
      vscode.commands.registerCommand('local-sync.backup.dryrun', async () => {
        logger.show(true);
        await runWithProgress('local-sync: Simulating backup...', async () => {
          await syncService.backup({
            dryRun: true,
          });
        });
      }),
      vscode.commands.registerCommand('local-sync.restore', async () => {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'local-sync: Restoring settings and profiles...',
            cancellable: false,
          },
          async () => {
            return syncService.restore();
          }
        );
        if (result.restartRequired) {
          await syncService.promptForRestartAfterRestore();
        }
      }),
      vscode.commands.registerCommand('local-sync.restore.dryrun', async () => {
        logger.show(true);
        await runWithProgress('local-sync: Simulating restore...', async () => {
          await syncService.restore({
            dryRun: true,
          });
        });
      }),
      vscode.commands.registerCommand('local-sync.openProfileSelector', async () => {
        await profileStatusService.openProfileSelector();
      }),
      vscode.commands.registerCommand('local-sync.refreshProfileStatus', async () => {
        await profileStatusService.refresh();
      }),

      watchConfigSettings(config => {
        const backupPath = config.get<string>('backupPath');
        if (backupPath) {
          syncService.backupPath = vscode.Uri.file(backupPath);
        }
        profileStatusService.setEnabled(config.get<boolean>('showProfileStatus', true));
        const result: Array<vscode.Disposable> = [];
        if (config.get('autobackup')) {
          result.push(...syncService.watchForChanges());
        }
        if (config.get('autorestore') && !isRestored) {
          void syncService.restore();
        }
        isRestored = true;
        void profileStatusService.refresh();
        return result;
      }),
    ]
  );
}
