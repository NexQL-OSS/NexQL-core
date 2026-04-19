import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { getDatabaseConnection, NotebookBuilder, MarkdownUtils } from './helper';
import { validateCategoryItem } from './connection';
import { PgCronSQL } from './sql/pgCron';

function assertCronJob(item: DatabaseTreeItem): asserts item is DatabaseTreeItem & { cronJobId: number } {
  if (item.cronJobId === undefined || item.cronJobId === null) {
    throw new Error('Select a scheduled job');
  }
}

export async function cmdListCronJobs(item: DatabaseTreeItem, _context: vscode.ExtensionContext) {
  const { metadata, release } = await getDatabaseConnection(item, validateCategoryItem);
  try {
    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header('pg_cron jobs') +
          MarkdownUtils.infoBox(
            'Jobs are stored in cron.job. Requires the pg_cron extension. Some hosts need pg_cron in shared_preload_libraries and a PostgreSQL restart.',
          ),
      )
      .addSql(PgCronSQL.listJobs())
      .show();
  } finally {
    release();
  }
}

export async function cmdInstallPgCron(item: DatabaseTreeItem, _context: vscode.ExtensionContext) {
  const { metadata, release } = await getDatabaseConnection(item, validateCategoryItem);
  try {
    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header('Install pg_cron') +
          MarkdownUtils.warningBox(
            'Creating the extension may require superuser. The database cluster may need shared_preload_libraries = \'pg_cron\' and a restart before CREATE EXTENSION succeeds.',
          ),
      )
      .addSql(PgCronSQL.installExtension())
      .show();
  } finally {
    release();
  }
}

export async function cmdScheduleCronJob(item: DatabaseTreeItem, _context: vscode.ExtensionContext) {
  const { metadata, release } = await getDatabaseConnection(item, validateCategoryItem);
  try {
    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header('Schedule a new pg_cron job') +
          MarkdownUtils.infoBox('Edit the cron expression and SQL body, then execute the cell.'),
      )
      .addSql(PgCronSQL.scheduleNewJob())
      .show();
  } finally {
    release();
  }
}

export async function cmdShowCronJobProperties(item: DatabaseTreeItem, _context: vscode.ExtensionContext) {
  assertCronJob(item);
  const { metadata, release } = await getDatabaseConnection(item, validateCategoryItem);
  try {
    const label = item.label;
    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`Cron job: ${label}`) +
          MarkdownUtils.infoBox('Job definition from cron.job. Use Unschedule to remove the schedule.'),
      )
      .addSql(PgCronSQL.jobDetail(item.cronJobId))
      .addMarkdown('##### Recent runs (if job_run_details exists)')
      .addSql(PgCronSQL.jobRunHistory(item.cronJobId))
      .addMarkdown('##### Alter / advanced')
      .addSql(PgCronSQL.alterJobNote())
      .show();
  } finally {
    release();
  }
}

export async function cmdUnscheduleCronJob(item: DatabaseTreeItem, _context: vscode.ExtensionContext) {
  assertCronJob(item);
  const confirm = await vscode.window.showWarningMessage(
    `Unschedule cron job "${item.label}" (job id ${item.cronJobId})?`,
    { modal: true },
    'Unschedule',
  );
  if (confirm !== 'Unschedule') {
    return;
  }
  const { metadata, release } = await getDatabaseConnection(item, validateCategoryItem);
  try {
    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`Unschedule job ${item.cronJobId}`) +
          MarkdownUtils.dangerBox('This removes the job from the schedule. It cannot be undone except by creating a new job.'),
      )
      .addSql(PgCronSQL.unschedule(item.cronJobId))
      .show();
  } finally {
    release();
  }
}
