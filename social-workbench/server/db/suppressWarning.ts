// node:sqlite 在 Node 22 會印出 ExperimentalWarning，這裡只過濾掉這一則，其餘警告照常顯示。
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message;
  const type = typeof args[0] === 'string' ? args[0] : (args[0] as { type?: string } | undefined)?.type;
  if (type === 'ExperimentalWarning' && typeof text === 'string' && text.includes('SQLite')) return;
  return (originalEmitWarning as (...a: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;

export {};
