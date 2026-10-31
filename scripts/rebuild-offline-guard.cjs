'use strict';
/**
 * Guard offline do rebuild nativo do pipeline (LANE, 2026-10-24).
 *
 * O `node-gyp` tem caminhos de download (headers, `prebuild-install`). Quando o
 * nodedir é passado explicitamente não precisa deles, mas um fallback silencioso
 * transformaria um build reprodutível num build dependente de rede. Este módulo
 * é carregado com `node --require` no processo do node-gyp: qualquer tentativa
 * de abrir socket/HTTP falha alto, em vez de descarregar algo.
 */
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

const deny = () => {
  throw new Error('OFFLINE_NATIVE_REBUILD_NETWORK_FORBIDDEN');
};
net.Socket.prototype.connect = deny;
for (const api of [http, https]) {
  api.request = deny;
  api.get = deny;
}
