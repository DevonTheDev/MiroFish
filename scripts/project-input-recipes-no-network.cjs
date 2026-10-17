// Supplementary test-host tripwires, not an OS sandbox or production code.
const { syncBuiltinESMExports } = require('node:module')
const deny = name => () => { throw new Error('Qualification forbids ' + name) }
const net = require('node:net'), http = require('node:http'), https = require('node:https')
net.connect = net.createConnection = deny('network connection')
net.Socket.prototype.connect = deny('socket connection')
net.Server.prototype.listen = deny('network listener')
http.request = http.get = https.request = https.get = deny('HTTP request')
const dns = require('node:dns')
dns.lookup = dns.resolve = deny('DNS request')
require('node:dgram').createSocket = deny('datagram socket')
globalThis.fetch = deny('unmocked Fetch')
globalThis.WebSocket = deny('WebSocket')
// Node's own test coordinator may spawn its one selected file child. Fixture
// child processes must not spawn anything further.
if (process.env.NODE_TEST_CONTEXT) {
  const child = require('node:child_process')
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) child[key] = deny('fixture subprocess')
}
syncBuiltinESMExports()
