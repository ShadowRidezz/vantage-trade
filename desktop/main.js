// VANTAGE TRADE desktop shell: starts the bundled analysis server, then shows the app in its own window.
const { app, BrowserWindow, shell, dialog } = require('electron')
const { spawn } = require('child_process')
const net = require('net')
const path = require('path')
const http = require('http')

let server = null, win = null

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })

const res = (...p) => (app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(__dirname, ...p))
const freePort = () => new Promise((ok, bad) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)) }); s.on('error', bad) })
const ping = (port) => new Promise((ok) => http.get({ host: '127.0.0.1', port, path: '/api/markets', timeout: 2000 }, (r) => { r.resume(); ok(r.statusCode === 200) }).on('error', () => ok(false)))

const LOADING = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<body style="margin:0;height:100vh;display:grid;place-items:center;background:#090B10;color:#F2F4F8;font:13px Segoe UI,sans-serif">
<div style="text-align:center"><div style="font-weight:700;font-size:28px;letter-spacing:.14em">VANTAGE</div>
<div style="font-size:12px;letter-spacing:.62em;color:#9AA4B5;margin-top:4px">TRADE</div>
<div style="margin-top:28px;color:#9AA4B5">Starting the analysis engine…</div></div></body>`)

async function start() {
  win = new BrowserWindow({ width: 1440, height: 900, minWidth: 1000, minHeight: 640, backgroundColor: '#090B10', autoHideMenuBar: true,
    title: 'VANTAGE TRADE', icon: res('build', 'icon.ico'), webPreferences: { contextIsolation: true, sandbox: true } })
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' } })
  win.loadURL(LOADING)

  const port = await freePort()
  const exe = app.isPackaged ? res('backend', 'vantage-backend.exe') : path.join(__dirname, 'backend-build', 'vantage-backend', 'vantage-backend.exe')
  server = spawn(exe, [], { windowsHide: true, env: { ...process.env, VT_PORT: String(port), VT_DATA_DIR: app.getPath('userData'),
    VT_WEB_DIR: app.isPackaged ? res('web') : path.join(__dirname, '..', 'web', 'dist') } })
  let log = ''
  server.stderr.on('data', (d) => { log = (log + d).slice(-2000) })
  server.on('exit', (code) => { if (win && !app.isQuitting) dialog.showErrorBox('VANTAGE TRADE', `The analysis engine stopped (code ${code}).\n\n${log}`) })

  for (let i = 0; i < 120; i++) {
    if (await ping(port)) return win.loadURL(`http://127.0.0.1:${port}/`)
    await new Promise((r) => setTimeout(r, 500))
  }
  dialog.showErrorBox('VANTAGE TRADE', 'The analysis engine did not start within 60 seconds.\n\n' + log)
}

app.whenReady().then(start)
app.on('before-quit', () => { app.isQuitting = true; if (server) server.kill() })
app.on('window-all-closed', () => app.quit())
