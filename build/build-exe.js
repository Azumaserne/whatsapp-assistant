const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const STAGING_DIR = path.join(DIST_DIR, 'staging');
const PAYLOAD_ZIP = path.join(DIST_DIR, 'app-payload.zip');
const PAYLOAD_META = path.join(DIST_DIR, 'payload-meta.json');
const SEA_CONFIG = path.join(DIST_DIR, 'sea-config.json');
const SEA_BLOB = path.join(DIST_DIR, 'sea-prep.blob');
const EXE_PATH = path.join(DIST_DIR, 'WhatsApp-Assistant-win-x64.exe');
const SHA_PATH = path.join(DIST_DIR, 'SHA256SUMS.txt');

const PRUNE_DIR_NAMES = new Set(['test', 'tests', '__tests__', 'docs', '.github']);
const PRUNE_FILE_EXTS = ['.d.ts', '.d.mts', '.d.cts', '.map'];

function shouldPruneFile(filename) {
    const lower = filename.toLowerCase();
    if (PRUNE_FILE_EXTS.some((ext) => lower.endsWith(ext))) return true;
    if (lower.endsWith('.md')) return true;
    if (lower.startsWith('license') || lower.startsWith('changelog') || lower.startsWith('history')) return true;
    return false;
}

function pruneNodeModules(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (PRUNE_DIR_NAMES.has(entry.name.toLowerCase())) {
                fs.rmSync(fullPath, { recursive: true, force: true });
            } else {
                pruneNodeModules(fullPath);
            }
        } else if (entry.isFile() && shouldPruneFile(entry.name)) {
            fs.rmSync(fullPath, { force: true });
        }
    }
}

function collectFiles(rootDir, currentDir = rootDir, out = []) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
            collectFiles(rootDir, fullPath, out);
        } else if (entry.isFile()) {
            const relPosix = path.relative(rootDir, fullPath).split(path.sep).join('/');
            out.push({ fullPath, relPosix });
        }
    }
    return out;
}

function buildZipFromDirectory(sourceDir) {
    const files = collectFiles(sourceDir);
    if (files.length >= 65535) {
        throw new Error(`Too many files for non-ZIP64 archive: ${files.length}`);
    }

    const localChunks = [];
    const cdChunks = [];
    let offset = 0;

    for (const file of files) {
        const nameBuf = Buffer.from(file.relPosix, 'utf8');
        const rawBuf = fs.readFileSync(file.fullPath);
        const compressed = zlib.deflateRawSync(rawBuf, { level: 6 });
        const useStored = compressed.length >= rawBuf.length;
        const dataBuf = useStored ? rawBuf : compressed;
        const method = useStored ? 0 : 8;
        const crc = zlib.crc32 ? zlib.crc32(rawBuf) : 0;
        const flag = 0x0800; // UTF-8 filename

        const lfh = Buffer.alloc(30);
        lfh.writeUInt32LE(0x04034b50, 0);
        lfh.writeUInt16LE(20, 4);
        lfh.writeUInt16LE(flag, 6);
        lfh.writeUInt16LE(method, 8);
        lfh.writeUInt32LE(crc >>> 0, 14);
        lfh.writeUInt32LE(dataBuf.length, 18);
        lfh.writeUInt32LE(rawBuf.length, 22);
        lfh.writeUInt16LE(nameBuf.length, 26);

        localChunks.push(lfh, nameBuf, dataBuf);

        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(flag, 8);
        cd.writeUInt16LE(method, 10);
        cd.writeUInt32LE(crc >>> 0, 16);
        cd.writeUInt32LE(dataBuf.length, 20);
        cd.writeUInt32LE(rawBuf.length, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt32LE(offset, 42);

        cdChunks.push(cd, nameBuf);
        offset += lfh.length + nameBuf.length + dataBuf.length;
    }

    const cdBuf = Buffer.concat(cdChunks);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);

    return {
        fileCount: files.length,
        buffer: Buffer.concat([...localChunks, cdBuf, eocd])
    };
}

function stripWindowsAuthenticodeSignature(exePath) {
    if (process.platform !== 'win32') return;
    const escapedPath = exePath.replace(/'/g, "''");
    const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class PeSigStripper {
    [DllImport("imagehlp.dll", SetLastError = true)]
    static extern bool ImageEnumerateCertificates(IntPtr FileHandle, ushort TypeFilter, out uint CertificateCount, IntPtr Indices, uint IndexCount);
    [DllImport("imagehlp.dll", SetLastError = true)]
    static extern bool ImageRemoveCertificate(IntPtr FileHandle, uint Index);
    public static void Strip(string path) {
        using (var fs = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) {
            uint count = 0;
            while (ImageEnumerateCertificates(fs.SafeFileHandle.DangerousGetHandle(), 0x00FF, out count, IntPtr.Zero, 0) && count > 0) {
                if (!ImageRemoveCertificate(fs.SafeFileHandle.DangerousGetHandle(), 0)) {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }
            }
        }
    }
}
"@
[PeSigStripper]::Strip('${escapedPath}')
$sig = Get-AuthenticodeSignature -LiteralPath '${escapedPath}'
if ($sig.Status -ne 'NotSigned') {
    throw "Failed to strip Authenticode signature; status is $($sig.Status)"
}
`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        stdio: 'inherit'
    });
}

function runCmd(cmd, args, cwd, extraEnv = {}) {
    execFileSync(cmd, args, {
        cwd,
        stdio: 'inherit',
        shell: process.platform === 'win32' && cmd.toLowerCase().endsWith('.cmd') === false && !cmd.includes('.exe'),
        env: { ...process.env, ...extraEnv }
    });
}

function main() {
    if (process.platform !== 'win32') {
        throw new Error('build-exe.js currently targets Windows x64 (.exe)');
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));

    console.log('1/7 Preparing staging directory...');
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
    fs.mkdirSync(STAGING_DIR, { recursive: true });

    fs.copyFileSync(path.join(ROOT_DIR, 'package.json'), path.join(STAGING_DIR, 'package.json'));
    fs.copyFileSync(path.join(ROOT_DIR, 'index.js'), path.join(STAGING_DIR, 'index.js'));
    fs.copyFileSync(path.join(ROOT_DIR, 'prompt.txt'), path.join(STAGING_DIR, 'prompt.txt'));
    fs.cpSync(path.join(ROOT_DIR, 'src'), path.join(STAGING_DIR, 'src'), { recursive: true });

    console.log('2/7 Installing production dependencies (skipping Chromium download)...');
    runCmd('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], STAGING_DIR, {
        PUPPETEER_SKIP_DOWNLOAD: 'true',
        PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'true'
    });

    console.log('3/7 Pruning non-runtime files from node_modules...');
    pruneNodeModules(path.join(STAGING_DIR, 'node_modules'));

    console.log('4/7 Packing runtime payload ZIP...');
    const zipResult = buildZipFromDirectory(STAGING_DIR);
    fs.writeFileSync(PAYLOAD_ZIP, zipResult.buffer);
    const payloadHash = crypto.createHash('sha256').update(zipResult.buffer).digest('hex').slice(0, 12);
    console.log(`    Packed ${zipResult.fileCount} files -> ${(zipResult.buffer.length / (1024 * 1024)).toFixed(2)} MB (hash: ${payloadHash})`);

    fs.writeFileSync(
        PAYLOAD_META,
        JSON.stringify({ version: pkg.version, hash: payloadHash, builtAt: new Date().toISOString() }, null, 2),
        'utf8'
    );

    console.log('5/7 Generating Node.js SEA blob...');
    fs.writeFileSync(
        SEA_CONFIG,
        JSON.stringify({
            main: path.join(ROOT_DIR, 'build', 'sea-bootstrap.js'),
            output: SEA_BLOB,
            disableExperimentalSEAWarning: true,
            useCodeCache: false,
            assets: {
                'app-payload.zip': PAYLOAD_ZIP,
                'payload-meta.json': PAYLOAD_META
            }
        }, null, 2),
        'utf8'
    );

    execFileSync(process.execPath, ['--experimental-sea-config', SEA_CONFIG], {
        cwd: ROOT_DIR,
        stdio: 'inherit'
    });

    console.log('6/7 Copying Node binary and stripping Windows signature...');
    fs.copyFileSync(process.execPath, EXE_PATH);
    stripWindowsAuthenticodeSignature(EXE_PATH);

    console.log('7/7 Injecting SEA blob with postject...');
    runCmd(
        'npx',
        [
            '--yes',
            'postject',
            EXE_PATH,
            'NODE_SEA_BLOB',
            SEA_BLOB,
            '--sentinel-fuse',
            'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
        ],
        ROOT_DIR
    );

    const exeBuf = fs.readFileSync(EXE_PATH);
    const exeSha = crypto.createHash('sha256').update(exeBuf).digest('hex');
    fs.writeFileSync(SHA_PATH, `${exeSha}  ${path.basename(EXE_PATH)}\n`, 'utf8');

    console.log(`\n✅ Build complete: ${EXE_PATH} (${(exeBuf.length / (1024 * 1024)).toFixed(2)} MB)`);
    console.log(`🔐 SHA-256: ${exeSha}`);
}

if (require.main === module) {
    main();
}

module.exports = {
    buildZipFromDirectory,
    pruneNodeModules
};
