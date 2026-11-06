#!/usr/bin/env python3
"""Собирает расширение Clodex в .vsix и (с флагом --install) ставит в VS Code.

python3 build.py            — только сборка в ./dist/
python3 build.py --install  — сборка и установка
"""
import json, os, subprocess, sys, zipfile
from pathlib import Path

SRC = Path(__file__).resolve().parent / "extension"
OUT = Path(__file__).resolve().parent / "dist"
CODE = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"

pkg = json.loads((SRC / "package.json").read_text())
ver = pkg["version"]
OUT.mkdir(parents=True, exist_ok=True)
vsix = OUT / f"clodex-{ver}.vsix"

manifest = f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{pkg['name']}" Version="{ver}" Publisher="{pkg['publisher']}" />
    <DisplayName>{pkg['displayName']}</DisplayName>
    <Description xml:space="preserve">{pkg['description']}</Description>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{pkg['engines']['vscode']}" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
"""
types = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/>
<Default Extension=".css" ContentType="text/css"/><Default Extension=".svg" ContentType="image/svg+xml"/>
<Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>
"""

with zipfile.ZipFile(vsix, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("extension.vsixmanifest", manifest)
    z.writestr("[Content_Types].xml", types)
    for f in sorted(SRC.rglob("*")):
        if f.is_file() and not f.name.startswith("."):
            z.write(f, "extension/" + f.relative_to(SRC).as_posix())
print("собрано:", vsix)

if "--install" in sys.argv:
    subprocess.run([CODE, "--install-extension", str(vsix), "--force"], check=True)
    print("installed; reload the VS Code window (Developer: Reload Window)")
