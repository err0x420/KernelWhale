const { app, BrowserWindow, shell, Menu, MenuItem, session, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');

let mainWindow;
const terminals = new Map();
let nextTerminalId = 1;

const isWindows = process.platform === 'win32';
const CHROME_USER_AGENT = isWindows 
  ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

ipcMain.handle('execute-code', async (event, code, language, sessionId) => {
  console.log(`[Backend] Executing ${language} in session ${sessionId}`);
  const termData = terminals.get(sessionId);
  if (!termData) return { error: 'Session not found' };
  
  termData.wasInterrupted = false;
  termData.isExecutionComplete = false;
  termData.lastExecutionResult = null;

  return new Promise((resolve) => {
    let lang = language.toLowerCase();
    let langConfig = LANGUAGE_COMMANDS[lang];
    if (!langConfig) { resolve({ error: `Unsupported language: ${language}` }); return; }

    // Removed the automatic stripping of <script> tags to allow testing raw payloads
    let finalCode = code;

    langConfig = { ...langConfig };
    if (process.platform === 'win32') {
      if (lang === 'python' || lang === 'python3' || lang === 'py') langConfig.cmd = 'python';
      else if (['shell', 'bash', 'sh', 'zsh', 'powershell', 'ps1'].includes(lang)) {
        langConfig = { cmd: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command'] };
      }
    } else {
      if (lang === 'powershell' || lang === 'ps1') langConfig.cmd = 'pwsh';
    }

    let stdout = '';
    let stderr = '';
    let tempFilePath = null;

    try {
      let spawnCmd = langConfig.cmd;
      let spawnArgs = [...langConfig.args];
      const tempDir = os.tmpdir();
      let extension = '.sh';
      if (['python', 'python3', 'py'].includes(lang)) extension = '.py';
      else if (['javascript', 'js', 'node'].includes(lang)) extension = '.js';
      else if (['powershell', 'ps1'].includes(lang)) extension = '.ps1';
      else if (['cmd', 'batch', 'bat'].includes(lang)) extension = '.bat';
      
      // Crucial: If we are using powershell (either explicitly or as fallback for shell on Win), use .ps1
      if (langConfig.cmd.includes('powershell') || langConfig.cmd === 'pwsh') {
        extension = '.ps1';
      }
      
      tempFilePath = path.join(tempDir, `whale_exec_${Date.now()}_${Math.floor(Math.random() * 1000)}${extension}`);
      fs.writeFileSync(tempFilePath, finalCode);

      if (langConfig.cmd === 'node' && langConfig.args.includes('-e')) { 
        spawnArgs = spawnArgs.filter(a => a !== '-e'); 
        spawnArgs.push(tempFilePath); 
      }
      else if (langConfig.cmd.includes('python') && langConfig.args.includes('-c')) { 
        spawnArgs = spawnArgs.filter(a => a !== '-c'); 
        spawnArgs.push(tempFilePath); 
      }
      else if (langConfig.cmd.includes('powershell') || langConfig.cmd === 'pwsh') {
        // For PowerShell, we use -File to execute the script properly
        spawnArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tempFilePath];
      }
      else if (langConfig.cmd === 'bash' || langConfig.cmd === 'sh' || langConfig.cmd === 'zsh') { 
        spawnArgs = [tempFilePath]; 
      }
      else {
        spawnArgs.push(tempFilePath);
      }

      if (process.platform === 'linux') {
        const joinedArgs = spawnArgs.join(' ');
        spawnCmd = 'script';
        spawnArgs = ['-qfec', `${langConfig.cmd} ${joinedArgs}`, '/dev/null'];
      }

      const activeProcess = spawn(spawnCmd, spawnArgs, {
        cwd: os.homedir(),
        shell: process.platform === 'win32',
        env: { ...process.env, TERM: 'xterm-256color' },
        windowsHide: true
      });

      termData.activeProcess = activeProcess;
      activeProcess.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        termData.buffer += text;
        if (termData.window && !termData.window.isDestroyed()) termData.window.webContents.send('terminal-output', { type: 'stdout', data: text });
      });

      activeProcess.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        termData.buffer += text;
        if (termData.window && !termData.window.isDestroyed()) termData.window.webContents.send('terminal-output', { type: 'stderr', data: text });
      });

      activeProcess.on('error', (err) => {
        if (tempFilePath && fs.existsSync(tempFilePath)) { try { fs.unlinkSync(tempFilePath); } catch (e) {} }
        resolve({ error: err.message, stdout, stderr });
      });

      activeProcess.on('close', (exitCode) => {
        if (tempFilePath && fs.existsSync(tempFilePath)) { try { fs.unlinkSync(tempFilePath); } catch (e) {} }
        termData.activeProcess = null;
        termData.isExecutionComplete = true;
        termData.lastExecutionResult = { stdout, stderr, exitCode, wasInterrupted: termData.wasInterrupted };
        resolve(termData.lastExecutionResult);
      });
    } catch (err) {
      if (tempFilePath && fs.existsSync(tempFilePath)) { try { fs.unlinkSync(tempFilePath); } catch (e) {} }
      resolve({ error: err.message });
    }
  });
});

ipcMain.handle('show-execution-modal', async (event, result, language, code) => {
  const sessionId = nextTerminalId++;
  const terminalWindow = new BrowserWindow({
    width: 800, height: 600, minWidth: 400, minHeight: 300,
    title: `Terminal Output - ${language}`,
    icon: path.join(__dirname, 'assets', isWindows ? 'icon.ico' : 'icon.png'),
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, webSecurity: false },
    autoHideMenuBar: true, show: false, backgroundColor: '#1e1e1e'
  });

  const promptText = isWindows ? 'PS> ' : '└─$ ';
  terminals.set(sessionId, {
    window: terminalWindow, activeProcess: null,
    command: code, // Store the command separately to avoid passing it in the URL
    buffer: `\x1B[1;36m${promptText}${code}\x1B[0m\r\n`,
    isExecutionComplete: false, lastExecutionResult: null, wasInterrupted: false
  });

  // We now pass ONLY the session ID in the URL. Everything else is fetched via IPC.
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
        button:hover { opacity: 0.9; }
        #sendToChatBtn { background: #22c55e; display: none; margin-right: auto; }
        #killBtn { background: #d83b01; }
        #copyAllBtn { background: #515c6b; display: none; }
        .xterm-viewport::-webkit-scrollbar { width: 10px; }
      </style>
    </head>
    <body>
      <div class="drag-region"></div><div id="terminal-container"></div>
      <div class="terminal-footer">
        <button id="sendToChatBtn">Send to Chat</button>
        <button id="killBtn">Stop Execution</button>
        <button id="copyAllBtn">Copy</button>
        <button id="closeFooterBtn">Close</button>
      </div>
      <script>
        const { ipcRenderer } = require('electron');
        const sessionId = ${sessionId};
        let currentCommand = "";
        const term = new Terminal({ theme: { background: '#1e1e1e', foreground: '#d4d4d4' }, fontSize: 13, fontFamily: 'monospace', cursorBlink: true, convertEol: true });
        const fitAddon = new FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        term.open(document.getElementById('terminal-container'));
        fitAddon.fit();
        let fullOutput = '';
        function handleCompletion(result) {
          if (document.body.getAttribute('data-completed')) return;
          document.body.setAttribute('data-completed', 'true');
          const isSuccess = result.exitCode === 0 && !result.wasInterrupted;
          const color = isSuccess ? "\\x1B[1;32m" : "\\x1B[1;31m";
          const reset = "\\x1B[0m";
          const exitValue = result.wasInterrupted ? "null" : result.exitCode;
          term.write("\\r\\n" + color + "Exit code: " + exitValue + reset);
          term.options.cursorBlink = false; term.write('\\x1b[?25l');
          document.getElementById('killBtn').style.display = 'none';
          document.getElementById('copyAllBtn').style.display = 'block';
        }
        ipcRenderer.invoke('get-terminal-buffer', sessionId).then(data => {
          if (data) { 
            currentCommand = data.command || "";
            if (data.buffer) { term.write(data.buffer); fullOutput = data.buffer; if (fullOutput.trim()) document.getElementById('sendToChatBtn').style.display = 'block'; }
            if (data.isComplete) handleCompletion(data.result);
          }
        });
        term.onData(data => ipcRenderer.send('terminal-input', sessionId, data));
        ipcRenderer.on('terminal-output', (event, output) => { term.write(output.data); fullOutput += output.data; if (fullOutput.trim()) document.getElementById('sendToChatBtn').style.display = 'block'; });
        ipcRenderer.on('terminal-complete', (event, result) => handleCompletion(result));
        document.getElementById('closeFooterBtn').addEventListener('click', () => ipcRenderer.send('close-terminal', sessionId));
        document.getElementById('killBtn').addEventListener('click', () =>  ipcRenderer.send('kill-execution', sessionId));
        document.getElementById('sendToChatBtn').addEventListener('click', () => {
          let clean = fullOutput.replace(/[\\u001b\\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
          const lines = clean.split(/\\r?\\n/);
          const processedLines = lines.map(line => {
            if (line.includes('\\r')) { const parts = line.split('\\r'); return parts.filter(p => p.trim()).pop() || ''; }
            return line;
          }).filter(line => {
            const trimmed = line.trim();
            return trimmed && !trimmed.startsWith('└─$') && !trimmed.startsWith('PS> ') && !/^(Script done|Session terminated)/i.test(trimmed);
          });
          ipcRenderer.send('forward-to-chat', { command: currentCommand, output: processedLines.join('\\n').trim() });
          document.getElementById('sendToChatBtn').textContent = '✅ Sent!';
        });
        document.getElementById('copyAllBtn').addEventListener('click', () => {
          try {
            const { clipboard } = require('electron');
            const cleanText = fullOutput.replace(/[\\u001b\\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '').split(/\\r?\\n/).map(line => {
              if (line.includes('\\r')) { const parts = line.split('\\r'); return parts.filter(p => p.trim()).pop() || ''; }
              return line;
            }).filter(line => !/^(Script done|Session terminated)/i.test(line.trim())).join('\\n').trim();
            clipboard.writeText(cleanText);
            document.getElementById('copyAllBtn').textContent = '✅ Copied!';
            setTimeout(() => { document.getElementById('copyAllBtn').textContent = 'Copy'; }, 2000);
          } catch (err) { console.error('Copy failed:', err); }
        });
        window.addEventListener('resize', () => fitAddon.fit());
        document.addEventListener('keydown', e => { if (e.key === 'Escape') ipcRenderer.send('close-terminal', sessionId); });
      </script>
    </body>
    </html>
  `)}`);

  terminalWindow.webContents.on('context-menu', (event, params) => {
    const { Menu, MenuItem } = require('electron');
    const menu = new Menu();
    menu.append(new MenuItem({ label: 'Copy', role: 'copy' }));
    menu.popup();
  });

  terminalWindow.once('ready-to-show', () => terminalWindow.show());
  terminalWindow.on('closed', () => {
    const termData = terminals.get(sessionId);
    if (termData && termData.activeProcess) {
      if (process.platform === 'win32') require('child_process').exec(`taskkill /F /T /PID ${termData.activeProcess.pid}`);
      else termData.activeProcess.kill('SIGTERM');
    }
    terminals.delete(sessionId);
  });
  return sessionId;
});

ipcMain.on('close-terminal', (event, sessionId) => {
  const termData = terminals.get(sessionId);
  if (termData && termData.window && !termData.window.isDestroyed()) termData.window.close();
});

ipcMain.on('kill-execution', (event, sessionId) => {
  const termData = terminals.get(sessionId);
  if (termData && termData.activeProcess) {
    termData.wasInterrupted = true;
    const p = termData.activeProcess;
    if (process.platform === 'win32') require('child_process').exec(`taskkill /F /T /PID ${p.pid}`);
    else {
      if (p.stdin && p.stdin.writable) p.stdin.write('\x03');
      else p.kill('SIGINT');
      setTimeout(() => { try { if (p && !p.killed) p.kill('SIGKILL'); } catch (e) { } }, 3000);
    }
  }
});

ipcMain.on('terminal-complete', (event, sessionId, result) => {
  const termData = terminals.get(sessionId);
  if (termData && termData.window && !termData.window.isDestroyed()) termData.window.webContents.send('terminal-complete', result);
});

ipcMain.handle('get-terminal-buffer', (event, sessionId) => {
  const termData = terminals.get(sessionId);
  if (termData) return { 
    buffer: termData.buffer, 
    command: termData.command, 
    isComplete: termData.isExecutionComplete, 
    result: termData.lastExecutionResult 
  };
  return null;
});

ipcMain.on('update-window-title', (event, title) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (title) mainWindow.setTitle(`KernelWhale - ${title}`);
    else mainWindow.setTitle('KernelWhale');
  }
});

ipcMain.on('forward-to-chat', (event, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('insert-chat-text', data);
});

ipcMain.on('terminal-input', (event, sessionId, text) => {
  const termData = terminals.get(sessionId);
  if (termData && termData.activeProcess && termData.activeProcess.stdin) {
    const normalizedText = text.replace(/\r/g, '\n');
    termData.activeProcess.stdin.write(normalizedText);
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 800, minHeight: 600,
    title: 'KernelWhale', icon: path.join(__dirname, 'assets', isWindows ? 'icon.ico' : 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: false, webSecurity: true, allowRunningInsecureContent: false, partition: 'persist:deepseek', spellcheck: true },
    autoHideMenuBar: true, show: false
  });

  mainWindow.on('page-title-updated', (e) => e.preventDefault());
  mainWindow.webContents.on('context-menu', (event, params) => {
    const { Menu, MenuItem } = require('electron');
    const menu = new Menu();
    if (params.isEditable) {
      menu.append(new MenuItem({ label: 'Cut', role: 'cut', enabled: params.editFlags.canCut }));
      menu.append(new MenuItem({ label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy }));
      menu.append(new MenuItem({ label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: 'Select All', role: 'selectAll' }));
    } else if (params.selectionText) menu.append(new MenuItem({ label: 'Copy', role: 'copy' }));
    if (menu.items.length > 0) menu.popup();
  });

  const menu = Menu.buildFromTemplate([
    { label: 'File', submenu: [{ label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow.reload() }, { label: 'Clear Cache & Reload', accelerator: 'CmdOrCtrl+Shift+R', click: async () => { await mainWindow.webContents.session.clearCache(); mainWindow.reload(); } }, { label: 'Clear All Data & Reload', click: async () => { await mainWindow.webContents.session.clearStorageData(); mainWindow.reload(); } }, { type: 'separator' }, { label: 'Exit', accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4', click: () => app.quit() }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'toggleDevTools' }] }
  ]);
  Menu.setApplicationMenu(menu);

  mainWindow.loadURL('https://chat.deepseek.com');
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.on('did-finish-load', () => injectCodeExecutionUI(mainWindow.webContents));
  mainWindow.webContents.on('did-navigate-in-page', () => setTimeout(() => injectCodeExecutionUI(mainWindow.webContents), 1000));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('accounts.google.com') || url.includes('deepseek.com') || url.includes('google.com/o/oauth')) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 500, height: 700, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, partition: 'persist:deepseek' } } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function injectCodeExecutionUI(webContents) {
  const p = isWindows ? "PS> " : "└─$ ";
  let s = "(function(){if(window.__dsCodeExecInjected)return;window.__dsCodeExecInjected=true;";
  s += "const EXECUTABLE_LANGUAGES=['bash','sh','shell','zsh','python','python3','py','javascript','js','node','powershell','ps1','cmd','batch','html'];";
  s += "if(!document.getElementById('ds-run-styles')){const st=document.createElement('style');st.id='ds-run-styles';st.textContent='.ds-run-btn{background:#22c55e!important;color:white!important;border:none!important;border-radius:4px!important;padding:4px 10px!important;font-size:12px!important;cursor:pointer!important;display:inline-flex!important;align-items:center!important;gap:4px!important;transition:background 0.2s!important;margin-left:8px!important;margin-right:4px!important;font-family:system-ui,-apple-system,sans-serif!important;position:relative!important;z-index:100!important;vertical-align:middle!important}.ds-run-btn:hover{background:#16a34a!important}.ds-run-btn:disabled{background:#6b7280!important;cursor:not-allowed!important}.ds-edit-btn{background:#3b82f6!important;color:white!important;border:none!important;border-radius:4px!important;padding:4px 10px!important;font-size:12px!important;cursor:pointer!important;display:inline-flex!important;align-items:center!important;gap:4px!important;transition:background 0.2s!important;margin-right:8px!important;font-family:system-ui,-apple-system,sans-serif!important;position:relative!important;z-index:100!important;vertical-align:middle!important}.ds-edit-btn:hover{background:#2563eb!important}.ds-code-edit-area{width:100%!important;background:#1e1e1e!important;color:#d4d4d4!important;border:1px solid #333!important;border-radius:4px!important;font-family:monospace!important;font-size:13px!important;padding:10px!important;outline:none!important;resize:vertical!important;min-height:60px!important;box-sizing:border-box!important;display:block!important}textarea._27c9245,textarea[placeholder*=\"DeepSeek\"]{resize:none!important;height:100%!important;max-height:none!important;min-height:48px!important;overflow-y:auto!important;z-index:10!important;border:none!important;background:transparent!important}.ds-resizer-container{position:relative!important;padding-top:4px!important;height:52px!important;min-height:48px!important;max-height:none!important;display:flex!important;flex-direction:column!important;transition:none!important;overflow:visible!important;--container-height:52px}.ds-top-resizer{position:absolute!important;top:0!important;left:0!important;right:0!important;height:3px!important;background:#5686fe!important;cursor:ns-resize!important;z-index:9999!important;border-radius:2px 2px 0 0!important;opacity:0.8!important}.ds-top-resizer:hover{height:6px!important;opacity:1!important;box-shadow:0 0 8px rgba(86,134,254,0.6)!important}';document.head.appendChild(st);}";
  s += "function getLanguage(pre){const code=pre.querySelector('code');const el=code||pre;const classes=el.className||'';const match=classes.match(/language-(\\\\w+)|hljs\\\\s+(\\\\w+)/);if(match)return match[1]||match[2];if(el.textContent.trim().startsWith('<'))return 'html';return 'bash';}";
  s += "function processCodeBlocks(){document.querySelectorAll('pre').forEach(pre=>{if(pre.getAttribute('data-ds-processed'))return;const language=getLanguage(pre);if(!EXECUTABLE_LANGUAGES.includes(language.toLowerCase()))return;const code=(pre.querySelector('code')||pre).textContent||'';if(!code.trim())return;if(!pre.getAttribute('data-ds-pending')){pre.setAttribute('data-ds-pending','true');pre.setAttribute('data-ds-last-content',code);const checkInterval=setInterval(()=>{const currentCode=(pre.querySelector('code')||pre).textContent||'';const lastCode=pre.getAttribute('data-ds-last-content')||'';if(currentCode===lastCode){clearInterval(checkInterval);pre.removeAttribute('data-ds-pending');pre.removeAttribute('data-ds-last-content');addRunButton(pre,language,currentCode);}else pre.setAttribute('data-ds-last-content',currentCode);},500);setTimeout(()=>{clearInterval(checkInterval);if(pre.getAttribute('data-ds-pending')){pre.removeAttribute('data-ds-pending');pre.removeAttribute('data-ds-last-content');const finalCode=(pre.querySelector('code')||pre).textContent||'';addRunButton(pre,language,finalCode);}},10000);}});}";
  s += "function addRunButton(pre,language,code){if(pre.getAttribute('data-ds-processed'))return;pre.setAttribute('data-ds-processed','true');const btnContainer=document.createElement('div');btnContainer.style.display='inline-flex';btnContainer.style.alignItems='center';btnContainer.style.verticalAlign='middle';const runBtn=document.createElement('button');runBtn.className='ds-run-btn';runBtn.innerHTML='▶ Run';runBtn.title='Execute '+language;const editBtn=document.createElement('button');editBtn.className='ds-edit-btn';editBtn.innerHTML='✎ Edit';editBtn.title='Edit code';let isEditing=false;let editor=null;editBtn.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();isEditing=!isEditing;if(isEditing){editBtn.innerHTML='✔ Done';editBtn.style.setProperty('background','#10b981','important');const codeEl=pre.querySelector('code')||pre;editor=document.createElement('textarea');editor.className='ds-code-edit-area';editor.value=codeEl.textContent;editor.style.height=(pre.offsetHeight+20)+'px';pre.style.display='none';pre.parentNode.insertBefore(editor,pre.nextSibling);}else{editBtn.innerHTML='✎ Edit';editBtn.style.setProperty('background','#3b82f6','important');if(editor){const codeEl=pre.querySelector('code')||pre;codeEl.textContent=editor.value;editor.remove();editor=null;}pre.style.display='block';}},true);runBtn.addEventListener('click',async function(e){e.preventDefault();e.stopPropagation();let codeToRun=(pre.querySelector('code')||pre).textContent;if(isEditing&&editor)codeToRun=editor.value;runBtn.innerHTML='⏳ Running...';runBtn.disabled=true;try{const execLang=language.toLowerCase()==='html'?'javascript':language;await window.__executeCodeAndShowModal(codeToRun,execLang);}catch(err){console.error('Execution failed:',err);}runBtn.innerHTML='▶ Run';runBtn.disabled=false;},true);btnContainer.appendChild(runBtn);btnContainer.appendChild(editBtn);let toolbar=null;const parent=pre.parentElement;if(parent){for(const child of parent.children){if(child!==pre&&child.querySelector&&child.querySelector('button')){toolbar=child;break;}}}";
  s += "if(toolbar){const langContainer=toolbar.querySelector('.d2a24f03');if(langContainer){const langSpan=langContainer.querySelector('.d813de27');if(langSpan){if(langSpan.nextSibling)langContainer.insertBefore(btnContainer,langSpan.nextSibling);else langContainer.appendChild(btnContainer);}else langContainer.appendChild(btnContainer);}else toolbar.appendChild(btnContainer);}";
  s += "else{const wrapper=document.createElement('div');wrapper.style.cssText='display:flex;align-items:center;gap:8px;padding:4px 8px;background:rgba(0,0,0,0.3);border-radius:6px 6px 0 0;margin-bottom:-1px;';const langLabel=document.createElement('span');langLabel.className='ds-lang-label';langLabel.textContent=language;langLabel.style.cssText='font-size:12px;font-weight:600;color:#9ca3af;text-transform:uppercase;';wrapper.appendChild(langLabel);wrapper.appendChild(btnContainer);pre.parentElement.insertBefore(wrapper,pre);}}";
  s += "setTimeout(processCodeBlocks,500);setTimeout(processCodeBlocks,1500);setTimeout(processCodeBlocks,3000);";
  s += "let debounceTimer=null;const debouncedProcess=()=>{if(debounceTimer)clearTimeout(debounceTimer);debounceTimer=setTimeout(()=>{processCodeBlocks();debounceTimer=null;},300);};";
  s += "let lastSentTitle=null;function updateWindowTitle(){const currentPath=window.location.pathname;let title=null;if(currentPath.includes('/chat/s/')){const links=document.querySelectorAll('a._546d736');for(const link of links){const href=link.getAttribute('href');if(href&&currentPath.endsWith(href)){const titleEl=link.querySelector('.c08e6e93');if(titleEl){title=titleEl.textContent.trim();break;}}}}if(title!==lastSentTitle){lastSentTitle=title;if(window.__updateTitle)window.__updateTitle(title);}}";
  s += "setTimeout(updateWindowTitle,2000);const observer=new MutationObserver((mutations)=>{updateWindowTitle();const hasRelevantMutations=mutations.some(mutation=>{if(mutation.type==='childList'&&mutation.addedNodes.length>0){return Array.from(mutation.addedNodes).some(node=>{if(node.nodeType===Node.ELEMENT_NODE)return node.tagName==='PRE'||node.querySelector&&node.querySelector('pre');return false;});}return false;});if(hasRelevantMutations)debouncedProcess();});observer.observe(document.body,{childList:true,subtree:true});";
  s += "if(window.electronAPI&&window.electronAPI.onInsertChatText&&!window.__dsChatListenerInjected){window.__dsChatListenerInjected=true;window.electronAPI.onInsertChatText((data)=>{const selectors=['textarea#chat-input','textarea[placeholder*=\"Message\"]','textarea[placeholder*=\"DeepSeek\"]','div[contenteditable=\"true\"]','textarea'];let input=null;for(const selector of selectors){input=document.querySelector(selector);if(input)break;}";
  s += "if(input){const prompt=\"" + p + "\";const commandText=prompt+(data.command||\"\").trim();const outputText=(data.output||\"\").trim();const formattedText=\"\\n\"+commandText+\"\\n\"+outputText+\"\\n\";window.focus();input.focus();const isExecuted=document.execCommand('insertText',false,formattedText);";
  s += "if(!isExecuted){if(input.tagName==='TEXTAREA'||input.tagName==='INPUT'){const nativeSetter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;nativeSetter.call(input,input.value+formattedText);input.dispatchEvent(new Event('input',{bubbles:true}));}else{const textNode=document.createTextNode(formattedText);input.appendChild(textNode);input.dispatchEvent(new Event('input',{bubbles:true}));}}input.scrollIntoView({behavior:'smooth',block:'center'});}});}";
  s += "function setupResizer(){const textarea=document.querySelector('textarea._27c9245')||document.querySelector('textarea[placeholder*=\"DeepSeek\"]');if(!textarea)return;const rTarget=textarea.parentElement;const rParent=document.querySelector('._020ab5b')||rTarget;if(!rTarget||rParent.querySelector('.ds-top-resizer'))return;rTarget.classList.add('ds-resizer-container');const resizer=document.createElement('div');resizer.className='ds-top-resizer';rParent.prepend(resizer);let startY,startHeight;resizer.addEventListener('mousedown',(e)=>{startY=e.clientY;startHeight=rTarget.offsetHeight;document.body.style.userSelect='none';document.body.style.cursor='ns-resize';const onMouseMove=(moveEvent)=>{const dy=startY-moveEvent.clientY;let newHeight=startHeight+dy;if(newHeight>=50&&newHeight<=600){rTarget.style.setProperty('height',newHeight+'px','important');rTarget.style.setProperty('--container-height',newHeight+'px');}};const onMouseUp=()=>{document.removeEventListener('mousemove',onMouseMove);document.removeEventListener('mouseup',onMouseUp);document.body.style.userSelect='';document.body.style.cursor='';};document.addEventListener('mousemove',onMouseMove);document.addEventListener('mouseup',onMouseUp);e.preventDefault();e.stopPropagation();});}setInterval(setupResizer,1000);setInterval(processCodeBlocks,2000);})();";
  webContents.executeJavaScript(s).catch(err => console.error('Failed to inject code execution UI:', err));
}

app.on('ready', () => {
  const ses = session.fromPartition('persist:deepseek'); ses.setUserAgent(CHROME_USER_AGENT);
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = CHROME_USER_AGENT;
    delete details.requestHeaders['sec-ch-ua']; delete details.requestHeaders['sec-ch-ua-mobile']; delete details.requestHeaders['sec-ch-ua-platform'];
    callback({ requestHeaders: details.requestHeaders });
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (mainWindow === null) createWindow(); });
app.on('web-contents-created', (event, contents) => {
  contents.setUserAgent(CHROME_USER_AGENT);
  contents.on('will-attach-webview', (event) => event.preventDefault());
});
