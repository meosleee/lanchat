'use strict';

/**
 * electron-builder afterPack kancasi
 * ----------------------------------
 * Apple Developer sertifikasi olmadan paketlerken electron-builder imzalamayi
 * tamamen atlar. Bu durumda uygulama, Electron ikilisinin "linker-signed"
 * imzasini tasimaya devam eder; ama paket adi ve icerigi degistigi icin bu
 * imza gecersizdir. Apple Silicon'da gecersiz imzali ikili calistirilamaz,
 * uygulama aciliste oldurulur.
 *
 * Cozum: paketlemeden sonra uygulamayi kendi kimligiyle "ad-hoc" imzalamak.
 * Bu, uygulamayi Apple tarafindan onaylanmis yapmaz (kullanici yine de
 * sag tik > Ac demeli) ama calistirilabilir kilar.
 */

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const appId = context.packager.appInfo.id;

  console.log(`  • ad-hoc imzalaniyor  app=${appPath}`);

  try {
    execFileSync('codesign', [
      '--force',
      '--deep',
      '--sign', '-',
      '--identifier', appId,
      appPath
    ], { stdio: 'inherit' });

    // Imzanin gecerli oldugunu dogrula; gecersizse derlemeyi durdur
    execFileSync('codesign', ['--verify', '--strict', appPath], { stdio: 'inherit' });
    console.log('  • ad-hoc imza dogrulandi');
  } catch (err) {
    throw new Error(`ad-hoc imzalama basarisiz: ${err.message}`);
  }
};
