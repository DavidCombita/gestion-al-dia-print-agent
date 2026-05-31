import { app } from 'electron';

export function enableAutoStart(): void {
  if (process.platform !== 'win32') {
    return;
  }

  app.setLoginItemSettings({
    openAtLogin: true,
    args: ['--hidden'],
  });
}
