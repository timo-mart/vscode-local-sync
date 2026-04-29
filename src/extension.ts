import * as vscode from 'vscode';
import { initOutputChannel, logger } from './initOutputChannel';
import { SyncService } from './sync-service';
import { watchConfigSettings } from './config';

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

  let isRestored = false;
  context.subscriptions.push(
    ...[
      initOutputChannel(),
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
        await runWithProgress('local-sync: Restoring settings and profiles...', async () => {
          await syncService.restore();
        });
      }),
      vscode.commands.registerCommand('local-sync.restore.dryrun', async () => {
        logger.show(true);
        await runWithProgress('local-sync: Simulating restore...', async () => {
          await syncService.restore({
            dryRun: true,
          });
        });
      }),

      watchConfigSettings(config => {
        const backupPath = config.get<string>('backupPath');
        if (backupPath) {
          syncService.backupPath = vscode.Uri.file(backupPath);
        }
        const result: Array<vscode.Disposable> = [];
        if (config.get('autobackup')) {
          result.push(...syncService.watchForChanges());
        }
        if (config.get('autorestore') && !isRestored) {
          void syncService.restore();
        }
        isRestored = true;
        return result;
      }),
    ]
  );
}
