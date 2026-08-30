#!/usr/bin/env node
'use strict';

/**
 * Sunucuyu Electron olmadan calistirmak icin:  npm run server
 * Ornek:  PORT=4545 node server/standalone.js
 */

const path = require('path');
const os = require('os');
const { createServer } = require('./index.js');

const port = Number(process.env.PORT || process.argv[2] || 4545);
const dataDir = process.env.LANCHAT_DATA || path.join(os.homedir(), '.lanchat');

const server = createServer({ port, dataDir });

server
  .start()
  .then(({ addresses }) => {
    console.log('\n  LanChat sunucusu hazir.');
    console.log('  Arkadaslarin su adresle baglansin:\n');
    const pick = addresses.find((a) => a.hamachi) || addresses[0];
    if (pick) console.log(`      ${pick.address}:${port}\n`);
    else console.log(`      localhost:${port}\n`);
  })
  .catch((err) => {
    console.error('Sunucu baslatilamadi:', err.message);
    process.exit(1);
  });

const shutdown = () => {
  console.log('\nKapatiliyor...');
  server.stop().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
