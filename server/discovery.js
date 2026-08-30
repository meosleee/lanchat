'use strict';

/**
 * Ag kesfi (UDP yayin)
 * -------------------
 * Sunucu bir "isaret" (beacon) yayar ve gelen sorgulara cevap verir.
 * Istemci aga sorgu gonderip cevap verenleri listeler.
 *
 * Hamachi sanal bir LAN kurdugu ve yayin (broadcast) trafigini tasidigi icin
 * (oyunlarin LAN uzerinden birbirini bulmasinin sebebi budur) bu yontem
 * Hamachi agi uzerinde de calisir.
 */

const dgram = require('dgram');
const os = require('os');

const DISCOVERY_PORT = 45450;
const MAGIC = 'LANCHAT/1';

/** Her IPv4 arayuzu icin yayin adresini hesapla (adres | ~maske) */
function broadcastTargets() {
  const out = [];
  for (const [nic, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = (a.netmask || '255.255.255.0').split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4) continue;
      const bc = ip.map((o, i) => o | (~mask[i] & 255)).join('.');
      out.push({ nic, address: a.address, broadcast: bc, hamachi: a.address.startsWith('25.') });
    }
  }
  return out;
}

/**
 * Sunucu tarafi: sorgulara cevap ver ve periyodik olarak varligini duyur.
 * @param {object} opts
 * @param {number} opts.port        Socket.io sunucusunun portu
 * @param {function} opts.describe  () => { name, users } bilgisini doner
 */
function startBeacon({ port, describe, log = () => {} }) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let announceTimer = null;
  let closed = false;

  const payload = (type) => {
    const info = describe ? describe() : {};
    return Buffer.from(JSON.stringify({
      magic: MAGIC,
      type,
      port,
      name: info.name || 'LanChat Sunucusu',
      users: info.users || 0,
      locked: !!info.locked,
      host: os.hostname()
    }));
  };

  sock.on('error', (err) => {
    log(`[kesif] soket hatasi: ${err.message}`);
    try { sock.close(); } catch {}
  });

  sock.on('message', (msg, rinfo) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }
    if (data.magic !== MAGIC || data.type !== 'probe') return;
    const reply = payload('server');
    sock.send(reply, rinfo.port, rinfo.address, (err) => {
      if (err) log(`[kesif] cevap gonderilemedi: ${err.message}`);
    });
  });

  sock.bind(DISCOVERY_PORT, () => {
    try {
      sock.setBroadcast(true);
      sock.setTTL(2);
    } catch {}
    log(`[kesif] ${DISCOVERY_PORT} portunda duyuru yapiliyor`);

    // Sorgu beklemeden de duyur: gec acilan istemciler hemen gorsun
    const announce = () => {
      if (closed) return;
      const msg = payload('server');
      for (const t of broadcastTargets()) {
        sock.send(msg, DISCOVERY_PORT, t.broadcast, () => {});
      }
    };
    announce();
    announceTimer = setInterval(announce, 4000);
    if (announceTimer.unref) announceTimer.unref();
  });

  return {
    stop() {
      closed = true;
      clearInterval(announceTimer);
      try { sock.close(); } catch {}
    }
  };
}

/**
 * Istemci tarafi: agdaki sunucularu ara.
 * @param {object} opts
 * @param {number} opts.timeout  Cevap bekleme suresi (ms)
 * @returns {Promise<Array>} bulunan sunucular
 */
function scan({ timeout = 1200 } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map();
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      try { sock.close(); } catch {}
      const list = [...found.values()];
      // Hamachi adresleri once, sonra kullanici sayisina gore
      list.sort((a, b) => Number(b.hamachi) - Number(a.hamachi) || b.users - a.users);
      resolve(list);
    };

    sock.on('error', finish);

    sock.on('message', (msg, rinfo) => {
      let d;
      try { d = JSON.parse(msg.toString()); } catch { return; }
      if (d.magic !== MAGIC || d.type !== 'server') return;
      const key = `${rinfo.address}:${d.port}`;
      found.set(key, {
        address: rinfo.address,
        port: d.port,
        name: d.name,
        users: d.users || 0,
        locked: !!d.locked,
        host: d.host,
        hamachi: rinfo.address.startsWith('25.'),
        local: rinfo.address === '127.0.0.1'
      });
    });

    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch {}
      const probe = Buffer.from(JSON.stringify({ magic: MAGIC, type: 'probe' }));
      const targets = new Set(['255.255.255.255', '127.0.0.1']);
      for (const t of broadcastTargets()) targets.add(t.broadcast);

      for (const t of targets) sock.send(probe, DISCOVERY_PORT, t, () => {});
      // Paket kaybina karsi bir kez daha sor
      setTimeout(() => {
        if (!done) for (const t of targets) sock.send(probe, DISCOVERY_PORT, t, () => {});
      }, Math.min(400, timeout / 2));

      setTimeout(finish, timeout);
    });
  });
}

module.exports = { startBeacon, scan, broadcastTargets, DISCOVERY_PORT };
