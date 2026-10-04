# Setup.exe bootstrapper

```
Rachna AI Studio Setup.exe
     │
     ├── Check WebView2
     │      └── install if missing
     │
     ├── Check VC++ x64
     │      └── install if missing
     │
     └── Install Rachna AI Studio MSI
```

`setup.nsi` is a thin NSIS bootstrapper. It doesn't install anything
itself or appear in Add/Remove Programs - it just runs the shared
prerequisite script (`../prereqs/install-prereqs.ps1`) and then hands off
to `msiexec /i` for the real install. The MSI (built by `tauri build`,
see `../fragments/prereqs.wxs`) owns everything durable: Add/Remove
Programs entry, upgrades, repair, uninstall.

The same `install-prereqs.ps1` also runs a second time inside the MSI's
own WiX custom action, as a fallback for direct-MSI deployments (SCCM/
Intune/etc.) that skip this bootstrapper. That's intentional and safe -
the script checks both prerequisites up front and exits immediately,
without showing UI, if they're already present.

## Building locally (Windows)

1. Build the MSI: `npm run tauri build` (produces
   `src-tauri/target/release/bundle/msi/Rachna AI Studio_<version>_x64_en-US.msi`)
2. Install NSIS: `choco install nsis` (or download from nsis.sourceforge.io)
3. Compile the bootstrapper:

   ```powershell
   & "C:\Program Files (x86)\NSIS\makensis.exe" `
     "/DMSI_PATH=src-tauri\target\release\bundle\msi\Rachna AI Studio_1.0.x_x64_en-US.msi" `
     "/DAPP_VERSION=1.0.0" `
     "/DOUT_FILE=dist\Rachna AI Studio Setup.exe" `
     src-tauri\windows\bootstrapper\setup.nsi
   ```

The CI workflow (`.github/workflows/build.yml`) does this automatically
on every Windows build and uploads the result as the
`rachna-ide-windows-x64-setup` artifact.

## Note on Linux vs Windows makensis flags

Windows' NSIS build uses `/Dname=value`. If you ever run `makensis` on
Linux/macOS to sanity-check the script, use `-Dname=value` instead - the
leading-slash form isn't recognized there.
