const { app, BrowserWindow, shell, Menu, MenuItem, session, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');

let mainWindow;
const terminals = new Map();
let nextTerminalId = 1;

const CHROME_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const LANGUAGE_COMMANDS = {
  'bash': { cmd: 'bash', args: ['-c'] },
  'sh': { cmd: 'sh', args: ['-c'] },
  'shell': { cmd: 'bash', args: ['-c'] },
  'zsh': { cmd: 'zsh', args: ['-c'] },
  'python': { cmd: 'python3', args: ['-c'] },
  'python3': { cmd: 'python3', args: ['-c'] },
  'py': { cmd: 'python3', args: ['-c'] },
  'javascript': { cmd: 'node', args: ['-e'] },
  'js': { cmd: 'node', args: ['-e'] },
  'node': { cmd: 'node', args: ['-e'] },
  'powershell': { cmd: 'powershell', args: ['-Command'] },
  'ps1': { cmd: 'powershell', args: ['-Command'] },
  'cmd': { cmd: 'cmd', args: ['/c'] },
  'batch': { cmd: 'cmd', args: ['/c'] }
};

// Helper function to escape HTML
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// Handle code execution with real-time output
ipcMain.handle('execute-code', async (event, code, language, sessionId) => {
  const termData = terminals.get(sessionId);
  if (!termData) return { error: 'Session not found' };

  termData.wasInterrupted = false;
  termData.isExecutionComplete = false;
  termData.lastExecutionResult = null;

  return new Promise((resolve) => {
    const lang = language.toLowerCase();
    let langConfig = LANGUAGE_COMMANDS[lang];

    if (!langConfig) {
      resolve({ error: `Unsupported language: ${language}` });
      return;
    }

    langConfig = { ...langConfig };
    const isWindows = process.platform === 'win32';

    if (isWindows) {
      if (lang === 'python' || lang === 'python3' || lang === 'py') {
        langConfig.cmd = 'python';
      }
    } else {
      if (lang === 'powershell' || lang === 'ps1') {
        langConfig.cmd = 'pwsh';
      }
    }

    let stdout = '';
    let stderr = '';

    try {
      let spawnCmd = langConfig.cmd;
      let spawnArgs = [...langConfig.args, code];

      // On Linux, wrap with 'script' to simulate a TTY and capture prompts like sudo
      if (process.platform === 'linux') {
        const escapedCode = code.replace(/'/g, "'\\''");
        const joinedArgs = langConfig.args.join(' ');
        spawnCmd = 'script';
        spawnArgs = ['-qfec', `${langConfig.cmd} ${joinedArgs} '${escapedCode}'`, '/dev/null'];
      }

      const activeProcess = spawn(spawnCmd, spawnArgs, {
        cwd: os.homedir(),
        shell: isWindows,
        env: { ...process.env, TERM: 'xterm-256color' }
      });

      termData.activeProcess = activeProcess;

      activeProcess.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        termData.buffer += text;
        if (termData.window && !termData.window.isDestroyed()) {
          termData.window.webContents.send('terminal-output', { type: 'stdout', data: text });
        }
      });

      activeProcess.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        termData.buffer += text;
        if (termData.window && !termData.window.isDestroyed()) {
          termData.window.webContents.send('terminal-output', { type: 'stderr', data: text });
        }
      });

      activeProcess.on('error', (err) => {
        resolve({ error: err.message, stdout, stderr });
      });

      activeProcess.on('close', (exitCode) => {
        termData.activeProcess = null;
        termData.isExecutionComplete = true;
        termData.lastExecutionResult = { stdout, stderr, exitCode, wasInterrupted: termData.wasInterrupted };
        resolve(termData.lastExecutionResult);
      });

    } catch (err) {
      resolve({ error: err.message });
    }
  });
});

// Handle showing execution result in modal with real-time output
ipcMain.handle('show-execution-modal', async (event, result, language, code) => {
  const sessionId = nextTerminalId++;

  // Create a new window for the terminal
  const terminalWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 400,
    minHeight: 300,
    title: `Terminal Output - ${language}`,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false // Necessary for CDN loading in some environments
    },
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#1e1e1e'
  });

  terminals.set(sessionId, {
    window: terminalWindow,
    activeProcess: null,
    buffer: `\x1B[1;36m└─$ ${code}\x1B[0m\r\n`,
    isExecutionComplete: false,
    lastExecutionResult: null,
    wasInterrupted: false
  });

  // Load the terminal HTML with xterm.js
  terminalWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Terminal Output</title>
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css" />
      <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
      <style>
        body { margin: 0; background: #1e1e1e; height: 100vh; display: flex; flex-direction: column; border-top: 1px solid #333; overflow: hidden; }
        .drag-region { height: 12px; width: 100%; -webkit-app-region: drag; background: transparent; flex-shrink: 0; }
        #terminal-container { flex: 1; margin: 0 4px; background: #1e1e1e; overflow: hidden; position: relative; }
        .terminal-footer { background: #2d2d2d; padding: 10px 16px; border-top: 1px solid #3d3d3d; display: flex; justify-content: flex-end; gap: 10px; flex-shrink: 0; }
        button { background: #0e639c; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px; font-family: sans-serif; }
        button:hover { background: #1177bb; }
        #killBtn { background: #d83b01; }
        #killBtn:hover { background: #ef4444; }
        #sendToChatBtn { background: #007acc; display: none; margin-right: auto; }
        #copyAllBtn { background: #515c6b; display: none; }
        #copyAllBtn:hover { background: #5c697a; }
        
        /* Stylize xterm scrollbar */
        .xterm-viewport::-webkit-scrollbar { width: 10px; }
        .xterm-viewport::-webkit-scrollbar-track { background: #1e1e1e; }
        .xterm-viewport::-webkit-scrollbar-thumb { background: #333; border-radius: 5px; border: 2px solid #1e1e1e; }
        .xterm-viewport::-webkit-scrollbar-thumb:hover { background: #444; }
      </style>
    </head>
    <body>
      <div class="drag-region"></div>
      <div id="terminal-container"></div>
      <div class="terminal-footer">
        <button id="sendToChatBtn">Send to Chat</button>
        <button id="killBtn">Stop Execution</button>
        <button id="copyAllBtn">Copy</button>
        <button id="closeFooterBtn">Close</button>
      </div>
      <script>
        const { ipcRenderer } = require('electron');
        const sessionId = ${sessionId};
        const term = new Terminal({
          theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
          fontSize: 13,
          fontFamily: 'monospace',
          cursorBlink: true,
          convertEol: true
        });
        const fitAddon = new FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        term.open(document.getElementById('terminal-container'));
        fitAddon.fit();

        let fullOutput = '';
        const sendBtn = document.getElementById('sendToChatBtn');
        const copyBtn = document.getElementById('copyAllBtn');

        function handleCompletion(result) {
          if (document.body.getAttribute('data-completed')) return;
          document.body.setAttribute('data-completed', 'true');
          
          const isSuccess = result.exitCode === 0 && !result.wasInterrupted;
          const color = isSuccess ? "\\x1B[1;32m" : "\\x1B[1;31m";
          const reset = "\\x1B[0m";
          const exitValue = result.wasInterrupted ? "null" : result.exitCode;
          const exitMsg = "\\r\\n" + color + "Exit code: " + exitValue + reset;
          
          term.write(exitMsg);
          // Hide cursor and stop blinking
          term.options.cursorBlink = false;
          term.write('\\x1b[?25l');
          
          document.getElementById('killBtn').style.display = 'none';
          copyBtn.style.display = 'block';
        }

        // Initial load: get existing buffer and status
        ipcRenderer.invoke('get-terminal-buffer', sessionId).then(data => {
          if (data && data.buffer) {
            term.write(data.buffer);
            fullOutput = data.buffer;
            if (fullOutput.trim()) sendBtn.style.display = 'block';
          }
          if (data && data.isComplete) {
            handleCompletion(data.result);
          }
        });

        // Handle outgoing data (typing)
        term.onData(data => ipcRenderer.send('terminal-input', sessionId, data));

        // Receive output from process
        ipcRenderer.on('terminal-output', (event, output) => {
          term.write(output.data);
          fullOutput += output.data;
          if (fullOutput.trim()) sendBtn.style.display = 'block';
        });

        ipcRenderer.on('terminal-complete', (event, result) => {
          handleCompletion(result);
        });

        document.getElementById('closeFooterBtn').addEventListener('click', () => ipcRenderer.send('close-terminal', sessionId));
        document.getElementById('killBtn').addEventListener('click', () =>  ipcRenderer.send('kill-execution', sessionId));
        
        document.getElementById('sendToChatBtn').addEventListener('click', () => {
          // 1. Remove ALL ANSI escape codes (more robust regex)
          let clean = fullOutput.replace(/[\\u001b\\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
          
          // 2. Handle carriage returns and line endings correctly
          const lines = clean.split(/\\r?\\n/);
          const processedLines = lines.map(line => {
            if (line.includes('\\r')) {
              const parts = line.split('\\r');
              // Return the last non-empty part to handle progress bar overwrites
              return parts.filter(p => p.trim()).pop() || '';
            }
            return line;
          }).filter(line => {
            const trimmed = line.trim();
            // Filter out the prompt to avoid duplication (chat injection adds it back),
            // empty lines, or system/noisy messages.
            return trimmed && 
                   !trimmed.startsWith('└─$') && 
                   !/^(Script done|Session terminated)/i.test(trimmed);
          });

          ipcRenderer.send('forward-to-chat', { 
            command: ${JSON.stringify(code)}, 
            output: processedLines.join('\\n').trim()
          });
          sendBtn.textContent = '✅ Sent!';
        });

        document.getElementById('copyAllBtn').addEventListener('click', () => {
          try {
            const { clipboard } = require('electron');
            // Clean the output: remove ANSI and correctly handle \r
            const cleanText = fullOutput
              .replace(/[\\u001b\\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
              .split(/\\r?\\n/)
              .map(line => {
                if (line.includes('\\r')) {
                  const parts = line.split('\\r');
                  return parts.filter(p => p.trim()).pop() || '';
                }
                return line;
              })
              .filter(line => !/^(Script done|Session terminated)/i.test(line.trim()))
              .join('\\n')
              .trim();

            clipboard.writeText(cleanText);
            const btn = document.getElementById('copyAllBtn');
            btn.textContent = '✅ Copied!';
            setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
          } catch (err) {
            console.error('Copy failed:', err);
          }
        });

        window.addEventListener('resize', () => fitAddon.fit());
        document.addEventListener('keydown', e => { if (e.key === 'Escape') ipcRenderer.send('close-terminal', sessionId); });
      </script>
    </body>
    </html>
  `)}`);


  // Context menu for terminal (Copy/Paste/Select All)
  terminalWindow.webContents.on('context-menu', (event, params) => {
    const { Menu, MenuItem } = require('electron');
    const menu = new Menu();
    menu.append(new MenuItem({ label: 'Copy', role: 'copy' }));
    menu.popup();
  });

  // Show window when ready
  terminalWindow.once('ready-to-show', () => {
    terminalWindow.show();
  });

  // Handle window close
  terminalWindow.on('closed', () => {
    const termData = terminals.get(sessionId);
    if (termData && termData.activeProcess) {
      termData.activeProcess.kill('SIGTERM');
    }
    terminals.delete(sessionId);
  });

  return sessionId;
});

// Final terminal IPC listeners (Registered ONCE at top level/outside handler)
ipcMain.on('close-terminal', (event, sessionId) => {
  const termData = terminals.get(sessionId);
  if (termData && termData.window && !termData.window.isDestroyed()) {
    termData.window.close();
  }
});

ipcMain.on('kill-execution', (event, sessionId) => {
  const termData = terminals.get(sessionId);
  if (termData && termData.activeProcess) {
    termData.wasInterrupted = true;
    if (termData.activeProcess.stdin && termData.activeProcess.stdin.writable) {
      termData.activeProcess.stdin.write('\x03');
    } else {
      termData.activeProcess.kill('SIGINT');
    }
    const p = termData.activeProcess;
    setTimeout(() => {
      try { if (p && !p.killed) p.kill('SIGKILL'); } catch (e) { }
    }, 3000);
  }
});

// Forward completion signal from main window to terminal window
ipcMain.on('terminal-complete', (event, sessionId, result) => {
  const termData = terminals.get(sessionId);
  if (termData && termData.window && !termData.window.isDestroyed()) {
    termData.window.webContents.send('terminal-complete', result);
  }
});

ipcMain.handle('get-terminal-buffer', (event, sessionId) => {
  const termData = terminals.get(sessionId);
  if (termData) {
    return {
      buffer: termData.buffer,
      isComplete: termData.isExecutionComplete,
      result: termData.lastExecutionResult
    };
  }
  return null;
});

ipcMain.on('update-window-title', (event, title) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (title) {
      mainWindow.setTitle(`KernelWhale - ${title}`);
    } else {
      mainWindow.setTitle('KernelWhale');
    }
  }
});

ipcMain.on('forward-to-chat', (event, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('insert-chat-text', data);
  }
});

ipcMain.on('terminal-input', (event, sessionId, text) => {
  const termData = terminals.get(sessionId);
  if (termData && termData.activeProcess && termData.activeProcess.stdin) {
    // Normalize \r (from xterm.js) to \n (standard Unix newline)
    // so that Enter works correctly for sudo and other prompts.
    const normalizedText = text.replace(/\r/g, '\n');
    termData.activeProcess.stdin.write(normalizedText);
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'KernelWhale',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      partition: 'persist:deepseek',
      spellcheck: true
    },
    autoHideMenuBar: true,
    show: false
  });

  // Force the title to stay as 'KernelWhale'
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
  });

  // Context menu for copy/paste
  mainWindow.webContents.on('context-menu', (event, params) => {
    const { Menu, MenuItem } = require('electron');
    const menu = new Menu();

    if (params.isEditable) {
      menu.append(new MenuItem({ label: 'Cut', role: 'cut', enabled: params.editFlags.canCut }));
      menu.append(new MenuItem({ label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy }));
      menu.append(new MenuItem({ label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: 'Select All', role: 'selectAll' }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({ label: 'Copy', role: 'copy' }));
    }

    if (menu.items.length > 0) {
      menu.popup();
    }
  });

  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow.reload() },
        {
          label: 'Clear Cache & Reload', accelerator: 'CmdOrCtrl+Shift+R', click: async () => {
            await mainWindow.webContents.session.clearCache();
            mainWindow.reload();
          }
        },
        {
          label: 'Clear All Data & Reload', click: async () => {
            await mainWindow.webContents.session.clearStorageData();
            mainWindow.reload();
          }
        },
        { type: 'separator' },
        { label: 'Exit', accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4', click: () => app.quit() }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);

  mainWindow.loadURL('https://chat.deepseek.com');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Inject code execution script after page loads
  mainWindow.webContents.on('did-finish-load', () => {
    injectCodeExecutionUI(mainWindow.webContents);
  });

  mainWindow.webContents.on('did-navigate-in-page', () => {
    setTimeout(() => injectCodeExecutionUI(mainWindow.webContents), 1000);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('accounts.google.com') ||
      url.includes('deepseek.com') ||
      url.includes('google.com/o/oauth')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 500,
          height: 700,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            partition: 'persist:deepseek'
          }
        }
      };
    }

    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Inject the code execution UI into the page
function injectCodeExecutionUI(webContents) {
  const injectionScript = `
    (function() {
      if (window.__dsCodeExecInjected) return;
      window.__dsCodeExecInjected = true;
      
      const EXECUTABLE_LANGUAGES = ['bash', 'sh', 'shell', 'zsh', 'python', 'python3', 'py', 'javascript', 'js', 'node', 'powershell', 'ps1', 'cmd', 'batch'];
      
      // Inject styles
      if (!document.getElementById('ds-run-styles')) {
        const style = document.createElement('style');
        style.id = 'ds-run-styles';
        style.textContent = \`
          .ds-run-btn {
            background: #22c55e !important;
            color: white !important;
            border: none !important;
            border-radius: 4px !important;
            padding: 4px 10px !important;
            font-size: 12px !important;
            cursor: pointer !important;
            display: inline-flex !important;
            align-items: center !important;
            gap: 4px !important;
            transition: background 0.2s !important;
            margin-left: 8px !important;
            margin-right: 8px !important;
            font-family: system-ui, -apple-system, sans-serif !important;
            position: relative !important;
            z-index: 100 !important;
            vertical-align: middle !important;
          }
          .ds-run-btn:hover { background: #16a34a !important; }
          .ds-run-btn:disabled { background: #6b7280 !important; cursor: not-allowed !important; }
          
          /* Estilos para el campo de entrada y su contenedor */
          textarea._27c9245, 
          textarea[placeholder*="DeepSeek"] {
            resize: none !important; 
            height: 100% !important; /* Que ocupe todo el contenedor que redimensionamos */
            max-height: none !important;
            min-height: 48px !important;
            overflow-y: auto !important;
            z-index: 10 !important;
            border: none !important;
            background: transparent !important;
          }
          
          /* El contenedor es el que ahora tiene el 'cuadro visible' */
          /* El contenedor es el que ahora tiene el 'cuadro visible' */
          .ds-resizer-container {
            position: relative !important;
            padding-top: 4px !important; 
            height: 52px !important; /* Altura inicial FIJA */
            min-height: 48px !important;
            max-height: none !important;
            display: flex !important;
            flex-direction: column !important;
            transition: none !important;
            overflow: visible !important;
            /* Variables CSS para que funcionen los gutters de DeepSeek */
            --container-height: 52px; 
          }

          /* Forzamos que el contenedor exterior no limite el crecimiento */
          ._020ab5b {
            height: auto !important;
            max-height: none !important;
          }

          /* El resizer (línea azul) - Más fino ahora */
          .ds-top-resizer {
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            right: 0 !important;
            height: 3px !important;
            background: #5686fe !important;
            cursor: ns-resize !important;
            z-index: 9999 !important;
            border-radius: 2px 2px 0 0 !important;
            opacity: 0.8 !important;
          }

          .ds-top-resizer:hover {
            height: 6px !important;
            opacity: 1 !important;
            box-shadow: 0 0 8px rgba(86, 134, 254, 0.6) !important;
          }

          /* ESTRATEGIA FINAL: Respetar scrollbars nativos de la web */
          /* No aplicamos ningún estilo a los scrolls, dejamos que DeepSeek los gestione */
        \`;
        document.head.appendChild(style);
      }
      
      function getLanguage(pre) {
        const code = pre.querySelector('code');
        const el = code || pre;
        const classes = el.className || '';
        const match = classes.match(/language-(\\w+)|hljs\\s+(\\w+)/);
        if (match) return match[1] || match[2];
        return 'bash';
      }
      
      function processCodeBlocks() {
        document.querySelectorAll('pre').forEach(pre => {
          if (pre.getAttribute('data-ds-processed')) return;
          
          const language = getLanguage(pre);
          if (!EXECUTABLE_LANGUAGES.includes(language.toLowerCase())) return;
          
          const code = (pre.querySelector('code') || pre).textContent || '';
          if (!code.trim()) return;
          
          // Check if code block is still being written (streaming)
          // We'll mark it as pending and monitor for changes
          if (!pre.getAttribute('data-ds-pending')) {
            pre.setAttribute('data-ds-pending', 'true');
            pre.setAttribute('data-ds-last-content', code);
            
            // Monitor this code block for content changes
            const checkInterval = setInterval(() => {
              const currentCode = (pre.querySelector('code') || pre).textContent || '';
              const lastCode = pre.getAttribute('data-ds-last-content') || '';
              
              if (currentCode === lastCode) {
                // Content has stabilized, add the Run button
                clearInterval(checkInterval);
                pre.removeAttribute('data-ds-pending');
                pre.removeAttribute('data-ds-last-content');
                addRunButton(pre, language, currentCode);
              } else {
                // Content is still changing, update and continue monitoring
                pre.setAttribute('data-ds-last-content', currentCode);
              }
            }, 500); // Check every 500ms
            
            // Stop monitoring after 10 seconds (timeout)
            setTimeout(() => {
              clearInterval(checkInterval);
              if (pre.getAttribute('data-ds-pending')) {
                pre.removeAttribute('data-ds-pending');
                pre.removeAttribute('data-ds-last-content');
                const finalCode = (pre.querySelector('code') || pre).textContent || '';
                addRunButton(pre, language, finalCode);
              }
            }, 10000);
          }
        });
      }
      
      function addRunButton(pre, language, code) {
        if (pre.getAttribute('data-ds-processed')) return;
        pre.setAttribute('data-ds-processed', 'true');
        
        // Create button
        const btn = document.createElement('button');
        btn.className = 'ds-run-btn';
        btn.innerHTML = '▶ Run';
        btn.title = 'Execute ' + language;
        
        btn.onclick = async function(e) {
          e.preventDefault();
          e.stopPropagation();
          
          btn.innerHTML = '⏳ Running...';
          btn.disabled = true;
          
          try {
            // Use IPC to execute code and show modal
            await window.__executeCodeAndShowModal(code, language);
          } catch (err) {
            console.error('Execution failed:', err);
          }
          
          btn.innerHTML = '▶ Run';
          btn.disabled = false;
        };
        
        // Find toolbar or create one
        let toolbar = null;
        const parent = pre.parentElement;
        if (parent) {
          for (const child of parent.children) {
            if (child !== pre && child.querySelector && child.querySelector('button')) {
              toolbar = child;
              break;
            }
          }
        }
        
        if (toolbar) {
          // Find the language container (first d2a24f03 div) and insert Run button after the language span
          const langContainer = toolbar.querySelector('.d2a24f03');
          if (langContainer) {
            const langSpan = langContainer.querySelector('.d813de27');
            if (langSpan) {
              // Insert button after the language span
              if (langSpan.nextSibling) {
                langContainer.insertBefore(btn, langSpan.nextSibling);
              } else {
                langContainer.appendChild(btn);
              }
            } else {
              // No language span found, append to container
              langContainer.appendChild(btn);
            }
          } else {
            // Fallback: append to toolbar
            toolbar.appendChild(btn);
          }
        } else {
          // Create inline toolbar with language and Run button
          const wrapper = document.createElement('div');
          wrapper.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 8px;background:rgba(0,0,0,0.3);border-radius:6px 6px 0 0;margin-bottom:-1px;';
          
          // Add language label
          const langLabel = document.createElement('span');
          langLabel.className = 'ds-lang-label';
          langLabel.textContent = language;
          langLabel.style.cssText = 'font-size:12px;font-weight:600;color:#9ca3af;text-transform:uppercase;';
          
          wrapper.appendChild(langLabel);
          wrapper.appendChild(btn);
          pre.parentElement.insertBefore(wrapper, pre);
        }
      }
      
      // Initial processing
      setTimeout(processCodeBlocks, 500);
      setTimeout(processCodeBlocks, 1500);
      setTimeout(processCodeBlocks, 3000);
      
      // Debounced processing for MutationObserver
      let debounceTimer = null;
      const debouncedProcess = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          processCodeBlocks();
          debounceTimer = null;
        }, 300);
      };
      
      // Window Title Management
      let lastSentTitle = null;
      function updateWindowTitle() {
        const currentPath = window.location.pathname;
        let title = null;
        
        // Strategy: Match current URL with sidebar links
        if (currentPath.includes('/chat/s/')) {
          // Try to find the link that matches the current URL
          const links = document.querySelectorAll('a._546d736');
          for (const link of links) {
            const href = link.getAttribute('href');
            if (href && currentPath.endsWith(href)) {
              const titleEl = link.querySelector('.c08e6e93');
              if (titleEl) {
                title = titleEl.textContent.trim();
                break;
              }
            }
          }
          
          // Fallback: look for the "active" class b64fb9ae mentioned by user
          if (!title) {
            const activeLink = document.querySelector('a._546d736.b64fb9ae');
            if (activeLink) {
              const titleEl = activeLink.querySelector('.c08e6e93');
              if (titleEl) title = titleEl.textContent.trim();
            }
          }
        }
        
        if (title !== lastSentTitle) {
          lastSentTitle = title;
          if (window.__updateTitle) window.__updateTitle(title);
        }
      }

      // Initial check
      setTimeout(updateWindowTitle, 2000);

      // Watch for changes (sidebar updates, navigation, etc)
      const observer = new MutationObserver((mutations) => {
        // Update title if needed
        updateWindowTitle();

        // Check for code blocks
        const hasRelevantMutations = mutations.some(mutation => {
          if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            return Array.from(mutation.addedNodes).some(node => {
              // Check if the added node or its descendants contain pre elements
              if (node.nodeType === Node.ELEMENT_NODE) {
                return node.tagName === 'PRE' || node.querySelector && node.querySelector('pre');
              }
              return false;
            });
          }
          return false;
        });
        
        if (hasRelevantMutations) {
          debouncedProcess();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      
      // Handle text injection from terminal
      if (window.electronAPI && window.electronAPI.onInsertChatText && !window.__dsChatListenerInjected) {
        window.__dsChatListenerInjected = true;
        window.electronAPI.onInsertChatText((data) => {
          const selectors = [
            'textarea#chat-input',
            'textarea[placeholder*="Message"]',
            'textarea[placeholder*="DeepSeek"]',
            'div[contenteditable="true"]',
            'textarea'
          ];
          
          let input = null;
          for (const selector of selectors) {
            input = document.querySelector(selector);
            if (input) break;
          }
          
          if (input) {
            const commandText = "└─$ " + (data.command || "").trim();
            const outputText = (data.output || "").trim();
            const formattedText = "\\n" + commandText + "\\n" + outputText + "\\n";
            
            // Focus the window and the input
            window.focus();
            input.focus();

            // Try using execCommand first - this is the most compatible way with React
            // as it simulates a real user typing/pasting action
            const isExecuted = document.execCommand('insertText', false, formattedText);

            if (!isExecuted) {
              // Fallback for React-controlled inputs if execCommand fails
              if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                  window.HTMLTextAreaElement.prototype,
                  'value'
                ).set;
                nativeInputValueSetter.call(input, input.value + formattedText);
                
                // Trigger events to let React know the value changed
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
              } else {
                // Last resort for contenteditable
                input.textContent += formattedText;
                input.dispatchEvent(new Event('input', { bubbles: true }));
              }
            }
            
            // Ensure the input is visible
            input.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        });
      }
      
      // Custom Resizer Logic
      function setupResizer() {
        const textarea = document.querySelector('textarea._27c9245') || 
                         document.querySelector('textarea[placeholder*="DeepSeek"]');
        
        if (!textarea) return;

        // El contenedor 'padre' que suele ser ._24fad49
        const container = textarea.parentElement;
        if (!container || container.querySelector('.ds-top-resizer')) return;

        container.classList.add('ds-resizer-container');

        const resizer = document.createElement('div');
        resizer.className = 'ds-top-resizer';
        container.prepend(resizer);

        let startY, startHeight;

        resizer.addEventListener('mousedown', (e) => {
          startY = e.clientY;
          // Medimos el CONTAINER porque es lo que queremos que crezca visualmente
          startHeight = container.offsetHeight;
          
          document.body.style.userSelect = 'none';
          document.body.style.cursor = 'ns-resize';
          
          const onMouseMove = (moveEvent) => {
            const dy = startY - moveEvent.clientY;
            let newHeight = startHeight + dy;
            
            if (newHeight >= 50 && newHeight <= 600) {
              // Aplicamos la altura al CONTENEDOR
              container.style.setProperty('height', newHeight + 'px', 'important');
              
              // CRUCIAL: Actualizar variable CSS para que los scrolls de DeepSeek se ajusten
              container.style.setProperty('--container-height', newHeight + 'px');
            }
          };

          const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
          };

          document.addEventListener('mousemove', onMouseMove);
          document.addEventListener('mouseup', onMouseUp);
          
          e.preventDefault();
          e.stopPropagation();
        });

        console.log('DeepSeek PWA: Resizer attached to textarea');
      }

      // Periodically check for resizer setup (DeepSeek loads chats dynamically)
      setInterval(setupResizer, 1000);
      setInterval(processCodeBlocks, 2000);
      
      console.log('DeepSeek PWA: Logic injected and running');
    })();
  `;

  webContents.executeJavaScript(injectionScript).catch(err => {
    console.error('Failed to inject code execution UI:', err);
  });
}

app.on('ready', () => {
  const ses = session.fromPartition('persist:deepseek');
  ses.setUserAgent(CHROME_USER_AGENT);

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = CHROME_USER_AGENT;
    delete details.requestHeaders['sec-ch-ua'];
    delete details.requestHeaders['sec-ch-ua-mobile'];
    delete details.requestHeaders['sec-ch-ua-platform'];
    callback({ requestHeaders: details.requestHeaders });
  });

  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('web-contents-created', (event, contents) => {
  contents.setUserAgent(CHROME_USER_AGENT);
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
});
