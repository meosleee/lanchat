'use strict';

/**
 * Izin politikasi tek yerde.
 *
 * Testler de bunu kullanir; aksi halde testler "her seye izin ver" diyip
 * gercek politikadaki eksikleri gormez. (Nitekim 'fullscreen' listede
 * olmadigi icin ekran paylasimi tam ekrana alinamiyordu ve test bunu
 * yakalayamamisti.)
 */

const ALLOWED_REQUEST = [
  'media',
  'audioCapture',
  'videoCapture',
  'display-capture',
  'clipboard-read',
  'notifications',
  'fullscreen'
];

const ALLOWED_CHECK = [
  'media',
  'audioCapture',
  'videoCapture',
  'display-capture',
  'notifications',
  'fullscreen'
];

const isRequestAllowed = (permission) => ALLOWED_REQUEST.includes(permission);
const isCheckAllowed = (permission) => ALLOWED_CHECK.includes(permission);

/** Bir Electron session'ina politikayi uygula */
function applyTo(session) {
  session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(isRequestAllowed(permission));
  });
  session.setPermissionCheckHandler((_wc, permission) => isCheckAllowed(permission));
}

module.exports = { ALLOWED_REQUEST, ALLOWED_CHECK, isRequestAllowed, isCheckAllowed, applyTo };
