/** Imported first by the CLI: hides Node's ExperimentalWarning for `node:sqlite` (used by the console's admin store). */
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });
