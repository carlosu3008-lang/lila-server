# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['escuchador_lila.py'],
    pathex=[],
    binaries=[('C:\\Users\\carlo\\AppData\\Local\\Programs\\Python\\Python314\\Lib\\site-packages\\vosk', 'vosk')],
    datas=[('vosk-model', 'vosk-model')],
    hiddenimports=['vosk', 'sounddevice', 'docx', 'numpy', 'selenium', 'webdriver_manager'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='lila_python',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='lila_python',
)
