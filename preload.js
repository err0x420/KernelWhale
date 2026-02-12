const { contextBridge, ipcRenderer } = require('electron');

// Expose the execute code function to the window object
// This will be called by the injected script
contextBridge.exposeInMainWorld('__executeCode', async (code, language) => {
  return await ipcRenderer.invoke('execute-code', code, language);
});

// Expose function to execute code and show modal with real-time output
contextBridge.exposeInMainWorld('__executeCodeAndShowModal', async (code, language) => {
  // First, show the terminal window and get the session ID
  const sessionId = await ipcRenderer.invoke('show-execution-modal', { stdout: '', stderr: '', exitCode: undefined }, language, code);

  // Then execute the code (output will be streamed to terminal window)
  const result = await ipcRenderer.invoke('execute-code', code, language, sessionId);

  // Send completion signal to terminal window (via main process)
  ipcRenderer.send('terminal-complete', sessionId, result);

  return result;
});

// Also expose electronAPI for compatibility
contextBridge.exposeInMainWorld('electronAPI', {
  executeCode: (code, language, sessionId) => ipcRenderer.invoke('execute-code', code, language, sessionId),
  showExecutionModal: (result, language) => ipcRenderer.invoke('show-execution-modal', result, language),
  onInsertChatText: (callback) => {
    ipcRenderer.removeAllListeners('insert-chat-text');
    ipcRenderer.on('insert-chat-text', (event, text) => callback(text));
  }
});

console.log('DeepSeek PWA: Preload script loaded');
