#!/usr/bin/env node
/**
 * ServerBrowser Live Session Manager Launcher
 * Starts the control panel with 0.0.0.0 binding and displays
 * the UI URL and authentication token in a nice colored format using chalk.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const chalk = require('chalk');

console.log(chalk.cyan('╔' + '═'.repeat(60)));
console.log(chalk.cyan('║' + ' '.repeat(20) + 'SERVERBROWSER LIVE SESSION MANAGER' + ' '.repeat(20) + '║'));
console.log(chalk.cyan('║' + ' '.repeat(20) + 'Live VNC + Chrome Browser Access' + ' '.repeat(20) + '║'));
console.log(chalk.cyan('╠' + '═'.repeat(60)));

process.env.PANEL_ADDR = '0.0.0.0';
const { fork } = require('child_process');
const p = fork(path.join(__dirname, '..', 'control', 'panel-server.js'), [], {
  env: { ...process.env, PANEL_NO_AUTH: '1' },
  silent: true,
});

p.on('exit', (code) => {
  console.log(chalk.yellow('
[panel] Panel process exited with code ' + code));
});

p.on('error', (err) => {
  console.log(chalk.red('[panel] Failed to start panel: ' + err.message));
  process.exit(1);
});

console.log(chalk.cyan('
[panel] Waiting for panel server to start...'));

const waitForServer = (url, maxAttempts = 30) => {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      attempts++;
      http.get(url, (res) => {
        if (res.statusCode === 200) {
          clearInterval(interval);
          resolve(true);
        }
      })
        .on('error', () => {
          if (attempts >= maxAttempts) {
            clearInterval(interval);
            reject(new Error('Server not ready after max attempts'));
          }
        });
    };
    const interval = setInterval(check, 500);
  });
};

waitForServer('http://127.0.0.1:6180/api/health', 20)
  .then((ready) => {
    if (ready) {
      console.log(chalk.green('✓ Panel server is ready!'));
    }
  })
  .catch((e) => {
    console.log(chalk.red('✗ Panel server failed to start'));
    console.log(e.message);
    process.exit(1);
  });

const statePath = path.join(__dirname, '..', 'datastore', 'panel-state.json');
let token = '';
try {
  const stateData = fs.readFileSync(statePath, 'utf8');
  const state = JSON.parse(stateData);
  token = state.token || '';
} catch (e) {
  console.log(chalk.yellow('[panel] Could not read panel state, generating new token...'));
  token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(statePath, JSON.stringify({ token }), { mode: 0o600 });
}

console.log('
' + chalk.cyan('╔' + '═'.repeat(60)));
console.log(chalk.cyan('║' + chalk.white.bold(' ') + chalk.magenta(' LIVE SESSION ACCESS ') + chalk.white.bold(' ') + chalk.cyan('║')));
console.log(chalk.cyan('╠' + '═'.repeat(60)));

const panelUrl = chalk.blue('http://127.0.0.1:6180/');
console.log(chalk.cyan('║') + ' '.repeat(5) + chalk.green('↳') + ' '.repeat(2) + panelUrl + chalk.cyan(' '.repeat(5)) + chalk.cyan('║'));

const tokenPrefix = chalk.gray('Token: ');
const tokenValue = chalk.bold.cyan(token);
const tokenDisplay = tokenPrefix + tokenValue;
console.log(chalk.cyan('║') + ' '.repeat(5) + tokenDisplay + ' '.repeat(30) + chalk.cyan('║'));

console.log(chalk.cyan('║') + ' '.repeat(5) + chalk.yellow('▶') + ' '.repeat(2) + chalk.green('Open the URL in your browser') + chalk.yellow(' (' + panelUrl + ')') + chalk.cyan(' ║'));
console.log(chalk.cyan('║') + ' '.repeat(5) + chalk.yellow('▶') + ' '.repeat(2) + chalk.blue('OR use HTTP Basic Auth') + chalk.cyan(' ║'));
console.log(chalk.cyan('║') + ' '.repeat(5) + chalk.gray('   Username: any') + ' '.repeat(25) + chalk.cyan('║'));
console.log(chalk.cyan('║') + ' '.repeat(5) + chalk.gray('   Password: ') + token + chalk.cyan(' '.repeat(20)) + chalk.cyan('║'));

console.log(chalk.cyan('╠' + '═'.repeat(60)));
console.log(chalk.cyan('║') + ' '.repeat(5) + chalk.green('↳') + ' '.repeat(2) + chalk.magenta('Viewer URLs with built-in auth') + chalk.cyan(' ║'));
console.log(chalk.cyan('╠' + '═'.repeat(60)));

const viewerUrl1 = chalk.gray('http://127.0.0.1:6080/novnc/vnc.html?pw=') + chalk.bold.cyan(token);
const viewerUrl2 = chalk.gray('http://127.0.0.1:6080/?pw=') + chalk.bold.cyan(token);

console.log(chalk.cyan('║') + ' '.repeat(5) + chalk.gray('▶') + ' '.repeat(2) + viewerUrl1 + chalk.cyan(' ║'));
console.log(chalk.cyan('║') + ' '.repeat(5) + chalk.gray('▶') + ' '.repeat(2) + viewerUrl2 + chalk.cyan(' ║'));

console.log(chalk.cyan('╠' + '═'.repeat(60)));
console.log(chalk.cyan('║') + ' '.repeat(5) + chalk.green('↳') + ' '.repeat(2) + chalk.blue('API Endpoints') + chalk.cyan(' ║'));
console.log(chalk.cyan('║') + ' '.repeat(5) + chalk.gray('  Health:') + chalk.cyan(' http://127.0.0.1:6180/api/health') + chalk.cyan(' '.repeat(5)) + chalk.cyan('║'));
console.log(chalk.cyan('║') + ' '.repeat(5) + chalk.gray('  Sessions:') + chalk.cyan(' http://127.0.0.1:6180/api/sessions') + chalk.cyan(' '.repeat(5)) + chalk.cyan('║'));
console.log(chalk.cyan('║') + ' '.repeat(5) + chalk.gray('  Viewer URL:') + chalk.cyan(' http://127.0.0.1:6180/api/sessions/:name/viewer-url') + chalk.cyan(' ║'));
console.log(chalk.cyan('╚' + '═'.repeat(60)));

console.log('
' + chalk.cyan('ℹ') + ' ' + chalk.gray('Share the viewer URL above with end-users.'));
console.log(chalk.cyan('ℹ') + ' ' + chalk.gray('The ?pw= token is already embedded in the URL for automatic auth.'));
console.log(chalk.cyan('ℹ') + ' ' + chalk.gray('PANEL_NO_AUTH=1 disables auth for local development only.'));
console.log();

console.log(chalk.gray('Panel is running in the background. Press Ctrl-C to stop.'));
