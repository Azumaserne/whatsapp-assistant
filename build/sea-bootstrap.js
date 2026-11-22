const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
const sea = require('node:sea');
const { execFileSync } = require('node:child_process');

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CD_SIG = 0x02014b50;
const ZIP_LFH_SIG = 0x04034b50;

function extractZipToDir(buffer, targetDir) {
    const minOffset = Math.max(0, buffer.length - 65557);
    let eocdOffset = -1;
    for (let i = buffer.length - 22; i >= minOffset; i -= 1) {
        if (buffer.readUInt32LE(i) === ZIP_EOCD_SIG) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset === -1) {
        throw new Error('Embedded runtime archive is corrupted (missing EOCD)');
    }

    const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
    const cdSize = buffer.readUInt32LE(eocdOffset + 12);
    const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
    if (cdOffset + cdSize > buffer.length) {
        throw new Error('Embedded runtime archive central directory is out of bounds');
    }

    const resolvedRoot = path.resolve(targetDir);
    const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
    fs.mkdirSync(resolvedRoot, { recursive: true });

    let cursor = cdOffset;
    for (let idx = 0; idx < totalEntries && cursor + 46 <= cdOffset + cdSize; idx += 1) {
        if (buffer.readUInt32LE(cursor) !== ZIP_CD_SIG) {
            throw new Error('Embedded runtime archive central directory entry is corrupted');
        }

        const generalFlag = buffer.readUInt16LE(cursor + 8);
        const method = buffer.readUInt16LE(cursor + 10);
        const compressedSize = buffer.readUInt32LE(cursor + 20);
        const nameLen = buffer.readUInt16LE(cursor + 28);
        const extraLen = buffer.readUInt16LE(cursor + 30);
        const commentLen = buffer.readUInt16LE(cursor + 32);
        const localHeaderOffset = buffer.readUInt32LE(cursor + 42);

        const nameStart = cursor + 46;
        const nameEnd = nameStart + nameLen;
        const entryName = buffer.toString((generalFlag & 0x0800) !== 0 ? 'utf8' : 'latin1', nameStart, nameEnd);
        cursor = nameEnd + extraLen + commentLen;

        if (!entryName || entryName.endsWith('/')) continue;

        const destPath = path.resolve(resolvedRoot, entryName);
        if (!destPath.startsWith(rootWithSep)) {
            throw new Error(`Unsafe zip entry path blocked: ${entryName}`);
        }

        if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== ZIP_LFH_SIG) {
            throw new Error(`Invalid local header for entry: ${entryName}`);
        }

        const lfhNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
        const lfhExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
        const dataEnd = dataStart + compressedSize;
        if (dataEnd > buffer.length) {
            throw new Error(`Truncated data for entry: ${entryName}`);
        }

        const slice = buffer.subarray(dataStart, dataEnd);
        let content;
        if (method === 0) {
            content = slice;
        } else if (method === 8) {
            content = zlib.inflateRawSync(slice);
        } else {
            throw new Error(`Unsupported zip compression method ${method} for ${entryName}`);
        }

        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, content);
    }
}

function cleanupOldRuntimes(appHome, activeRuntimeName) {
    try {
        for (const entry of fs.readdirSync(appHome, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith('runtime-') && entry.name !== activeRuntimeName) {
                fs.rmSync(path.join(appHome, entry.name), { recursive: true, force: true });
            }
        }
    } catch {
        // Best-effort cleanup only
    }
}

async function main() {
    if (!sea.isSea()) {
        throw new Error('sea-bootstrap.js is intended to run inside a Node.js Single Executable Application');
    }

    if (process.platform === 'win32' && process.stdout.isTTY) {
        try {
            execFileSync('cmd.exe', ['/c', 'chcp 65001 >nul'], { stdio: 'ignore' });
        } catch {
            // Ignore console codepage setup failure
        }
    }

    const meta = JSON.parse(sea.getAsset('payload-meta.json', 'utf8'));
    const zipBuffer = Buffer.from(sea.getRawAsset('app-payload.zip'));

    const appHome = path.join(process.env.LOCALAPPDATA || os.homedir(), 'WhatsApp-Assistant');
    const runtimeName = `runtime-${meta.hash}`;
    const runtimeDir = path.join(appHome, runtimeName);
    const readyMarker = path.join(runtimeDir, '.ready');
    const authDir = path.join(appHome, 'wwebjs_auth');

    if (!fs.existsSync(readyMarker)) {
        const tempDir = path.join(appHome, `${runtimeName}.tmp-${process.pid}`);
        fs.rmSync(tempDir, { recursive: true, force: true });
        extractZipToDir(zipBuffer, tempDir);
        fs.writeFileSync(path.join(tempDir, '.ready'), meta.hash, 'utf8');
        fs.rmSync(runtimeDir, { recursive: true, force: true });
        fs.renameSync(tempDir, runtimeDir);
        cleanupOldRuntimes(appHome, runtimeName);
    }

    fs.mkdirSync(authDir, { recursive: true });

    process.env.WA_PACKAGED_EXE = '1';
    process.env.WA_RUNTIME_DIR = runtimeDir;
    process.env.AUTH_DATA_PATH = authDir;

    const runtimeRequire = createRequire(path.join(runtimeDir, 'package.json'));
    const cli = runtimeRequire('./src/cli.js');
    await cli.runCli({
        projectDir: runtimeDir,
        argv: process.argv.slice(2),
        isPackagedExe: true
    });
}

main().catch((error) => {
    console.error('❌ Fatal launcher error:', error);
    if (process.stdin.isTTY) {
        console.log('\nPress Enter to exit...');
        process.stdin.resume();
        process.stdin.once('data', () => process.exit(1));
    } else {
        process.exit(1);
    }
});
