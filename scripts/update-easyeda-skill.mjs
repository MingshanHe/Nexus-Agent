// 把上游的 EasyEDA API Skill 更新到 vendor/easyeda-api-skill。
// 用法：npm run update:skill            （拉取上游最新版）
//       npm run update:skill -- <目录>   （从本地已有的克隆复制）
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const UPSTREAM = 'https://github.com/easyeda/easyeda-api-skill.git'
const root = path.resolve(import.meta.dirname, '..')
const target = path.join(root, 'vendor', 'easyeda-api-skill')

let source = process.argv[2] ? path.resolve(process.argv[2]) : null
let temp = null
if (!source) {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'easyeda-skill-'))
  source = path.join(temp, 'repo')
  execFileSync('git', ['clone', '--depth', '1', UPSTREAM, source], { stdio: 'inherit' })
}

const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim()
const commit = git('rev-parse', 'HEAD')
const date = git('log', '-1', '--format=%cI')
const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version

fs.rmSync(target, { recursive: true, force: true })
fs.cpSync(source, target, {
  recursive: true,
  filter: (file) => !['.git', 'node_modules'].includes(path.basename(file)),
})
fs.writeFileSync(
  path.join(root, 'vendor', 'easyeda-api-skill.source.json'),
  `${JSON.stringify({ upstream: UPSTREAM, commit, date, version, license: 'MIT' }, null, 2)}\n`,
)
if (temp) fs.rmSync(temp, { recursive: true, force: true })
console.log(`easyeda-api-skill ${version} (${commit.slice(0, 7)}) -> vendor/easyeda-api-skill`)
