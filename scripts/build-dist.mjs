#!/usr/bin/env node
/**
 * Builds the distribution folder and archives for this plugin:
 *
 *   dist/<name>-<version>/          installable folder (README + installers + package/)
 *   dist/<name>-<version>.zip       what people download
 *   <name>-<version>.tgz            the official dsh plugin pack format
 *
 * Packing tries `npm pack`, then `pnpm pack`, and finally a built-in writer, so a
 * machine without either package manager can still cut a release. Zipping needs a
 * system `zip` (POSIX) or `tar` (Windows 10+); without one the zip step is skipped.
 */
import { execSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const base = pkg.name + '-' + pkg.version
const distDir = join(root, 'dist')
const stage = join(distDir, base)
const tgzPath = join(root, base + '.tgz')
const zipPath = join(distDir, base + '.zip')
const INSTALLERS = ['install.sh', 'install.ps1', 'uninstall.sh', 'uninstall.ps1']

const run = (command, options) => {
  try {
    execSync(command, { cwd: root, stdio: 'pipe', ...options })
    return true
  } catch {
    return false
  }
}

const walk = (path) =>
  statSync(path).isDirectory()
    ? readdirSync(path).flatMap((name) => walk(join(path, name)))
    : [path]

/** The files the published package carries, mirroring package.json#files. */
function packedFiles() {
  const entries = pkg.files ?? ['lib', 'README.md', 'package.json']
  const found = entries.flatMap((entry) => {
    const path = join(root, entry)
    try {
      return walk(path)
    } catch {
      return []
    }
  })
  return [...new Set([...found, join(root, 'package.json')])]
}

/** A minimal ustar + gzip writer, used when no package manager is available. */
function writeTarball() {
  const chunks = []
  const now = Math.floor(Date.now() / 1000)
  for (const file of packedFiles()) {
    const name = 'package/' + relative(root, file).split(sep).join('/')
    const body = readFileSync(file)
    const header = Buffer.alloc(512)
    header.write(name.slice(0, 100), 0, 'utf8')
    header.write('0000644\0', 100, 'ascii')
    header.write('0000000\0', 108, 'ascii')
    header.write('0000000\0', 116, 'ascii')
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
    header.write(now.toString(8).padStart(11, '0') + '\0', 136, 'ascii')
    header.write('        ', 148, 'ascii')
    header.write('0', 156, 'ascii')
    header.write('ustar\0', 257, 'ascii')
    header.write('00', 263, 'ascii')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  chunks.push(Buffer.alloc(1024))
  writeFileSync(tgzPath, gzipSync(Buffer.concat(chunks)))
}

function pack() {
  rmSync(tgzPath, { force: true })
  if (run('npm pack --silent')) return 'npm pack'
  if (run('pnpm pack')) return 'pnpm pack'
  writeTarball()
  return 'built-in writer'
}

function unzipTarball() {
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar'
  if (!run('"' + tar + '" -xzf "' + tgzPath + '" -C "' + stage + '"')) {
    throw new Error('could not extract ' + base + '.tgz into ' + stage)
  }
}

function zip() {
  rmSync(zipPath, { force: true })
  if (process.platform === 'win32') {
    const tar = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe')
    if (run('"' + tar + '" -a -c -f "' + zipPath + '" -C "' + distDir + '" "' + base + '"')) return true
  }
  return run('zip -qr "' + zipPath + '" "' + base + '"', { cwd: distDir })
}

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
const packer = pack()
unzipTarball()
cpSync(join(root, 'DIST-README.md'), join(stage, 'README.md'))
for (const file of INSTALLERS) cpSync(join(root, file), join(stage, file))
cpSync(tgzPath, join(stage, base + '.tgz'))
const zipped = zip()

console.log('packed with ' + packer)
console.log('  ' + relative(root, tgzPath))
console.log('  ' + relative(root, stage) + '/')
console.log('  ' + (zipped ? relative(root, zipPath) : 'zip skipped (no system zip/tar)'))
