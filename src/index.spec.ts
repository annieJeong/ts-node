import { expect } from 'chai'
import { ChildProcess, exec as childProcessExec, ExecException, ExecOptions } from 'child_process'
import { join } from 'path'
import semver = require('semver')
import ts = require('typescript')
import proxyquire = require('proxyquire')
import type * as tsNodeTypes from './index'
import { unlinkSync, existsSync, lstatSync } from 'fs'
import * as promisify from 'util.promisify'
import { sync as rimrafSync } from 'rimraf'
import type _createRequire from 'create-require'
const createRequire: typeof _createRequire = require('create-require')
import { pathToFileURL } from 'url'
import Module = require('module')
import { PassThrough } from 'stream'
import * as getStream from 'get-stream'

type TestExecReturn = { stdout: string, stderr: string, err: null | ExecException }
function exec (cmd: string, opts: ExecOptions = {}): Promise<TestExecReturn> & { child: ChildProcess } {
  let childProcess!: ChildProcess
  return Object.assign(
    new Promise<TestExecReturn>((resolve, reject) => {
      childProcess = childProcessExec(cmd, {
        cwd: TEST_DIR,
        ...opts
      }, (error, stdout, stderr) => {
        resolve({ err: error, stdout, stderr })
      })
    }),
    {
      child: childProcess
    }
  )
}

const TEST_DIR = join(__dirname, '../tests')
const PROJECT = join(TEST_DIR, 'tsconfig.json')
const BIN_PATH = join(TEST_DIR, 'node_modules/.bin/ts-node')
const BIN_SCRIPT_PATH = join(TEST_DIR, 'node_modules/.bin/ts-node-script')
const BIN_CWD_PATH = join(TEST_DIR, 'node_modules/.bin/ts-node-cwd')

const SOURCE_MAP_REGEXP = /\/\/# sourceMappingURL=data:application\/json;charset=utf\-8;base64,[\w\+]+=*$/

// `createRequire` does not exist on older node versions
const testsDirRequire = createRequire(join(TEST_DIR, 'index.js')) // tslint:disable-line

// Set after ts-node is installed locally
let { register, create, VERSION, createRepl }: typeof tsNodeTypes = {} as any

// Pack and install ts-node locally, necessary to test package "exports"
before(async function () {
  this.timeout(5 * 60e3)
  rimrafSync(join(TEST_DIR, 'node_modules'))
  await promisify(childProcessExec)(`npm install`, { cwd: TEST_DIR })
  const packageLockPath = join(TEST_DIR, 'package-lock.json')
  existsSync(packageLockPath) && unlinkSync(packageLockPath)
    ; ({ register, create, VERSION, createRepl } = testsDirRequire('ts-node'))
})

describe('ts-node', function () {
  const cmd = `"${BIN_PATH}" --project "${PROJECT}"`
  const cmdNoProject = `"${BIN_PATH}"`

  this.timeout(10000)

  it('should export the correct version', () => {
    expect(VERSION).to.equal(require('../package.json').version)
  })
  it('should export all CJS entrypoints', () => {
    // Ensure our package.json "exports" declaration allows `require()`ing all our entrypoints
    // https://github.com/TypeStrong/ts-node/pull/1026

    testsDirRequire.resolve('ts-node')

    // only reliably way to ask node for the root path of a dependency is Path.resolve(require.resolve('ts-node/package'), '..')
    testsDirRequire.resolve('ts-node/package')
    testsDirRequire.resolve('ts-node/package.json')

    // All bin entrypoints for people who need to augment our CLI: `node -r otherstuff ./node_modules/ts-node/dist/bin`
    testsDirRequire.resolve('ts-node/dist/bin')
    testsDirRequire.resolve('ts-node/dist/bin.js')
    testsDirRequire.resolve('ts-node/dist/bin-transpile')
    testsDirRequire.resolve('ts-node/dist/bin-transpile.js')
    testsDirRequire.resolve('ts-node/dist/bin-script')
    testsDirRequire.resolve('ts-node/dist/bin-script.js')
    testsDirRequire.resolve('ts-node/dist/bin-cwd')
    testsDirRequire.resolve('ts-node/dist/bin-cwd.js')

    // Must be `require()`able obviously
    testsDirRequire.resolve('ts-node/register')
    testsDirRequire.resolve('ts-node/register/files')
    testsDirRequire.resolve('ts-node/register/transpile-only')
    testsDirRequire.resolve('ts-node/register/type-check')

    // `node --loader ts-node/esm`
    testsDirRequire.resolve('ts-node/esm')
    testsDirRequire.resolve('ts-node/esm.mjs')
    testsDirRequire.resolve('ts-node/esm/transpile-only')
    testsDirRequire.resolve('ts-node/esm/transpile-only.mjs')
  })

  describe('cli', () => {
    this.slow(1000)

    it('should execute cli', async () => {
      const { err, stdout } = await exec(`${cmd} hello-world`)
      expect(err).to.equal(null)
      expect(stdout).to.equal('Hello, world!\n')
    })

    it('shows usage via --help', async () => {
      const { err, stdout } = await exec(`${cmdNoProject} --help`)
      expect(err).to.equal(null)
      expect(stdout).to.match(/Usage: ts-node /)
    })
    it('shows version via -v', async () => {
      const { err, stdout } = await exec(`${cmdNoProject} -v`)
      expect(err).to.equal(null)
      expect(stdout.trim()).to.equal('v' + testsDirRequire('ts-node/package').version)
    })
    it('shows version of compiler via -vv', async () => {
      const { err, stdout } = await exec(`${cmdNoProject} -vv`)
      expect(err).to.equal(null)
      expect(stdout.trim()).to.equal(
        `ts-node v${testsDirRequire('ts-node/package').version}\n` +
        `node ${process.version}\n` +
        `compiler v${testsDirRequire('typescript/package').version}`
      )
    })

    it('should register via cli', async () => {
      const { err, stdout } = await exec(`node -r ts-node/register hello-world.ts`, {
        cwd: TEST_DIR
      })
      expect(err).to.equal(null)
      expect(stdout).to.equal('Hello, world!\n')
    })

    it('should execute cli with absolute path', async () => {
      const { err, stdout } = await exec(`${cmd} "${join(TEST_DIR, 'hello-world')}"`)
      expect(err).to.equal(null)
      expect(stdout).to.equal('Hello, world!\n')
    })

    it('should print scripts', async () => {
      const { err, stdout } = await exec(`${cmd} -pe "import { example } from './complex/index';example()"`)
      expect(err).to.equal(null)
      expect(stdout).to.equal('example\n')
    })

    it('should provide registered information globally', async () => {
      const { err, stdout } = await exec(`${cmd} env`)
      expect(err).to.equal(null)
      expect(stdout).to.equal('object\n')
    })

    it('should provide registered information on register', async () => {
      const { err, stdout } = await exec(`node -r ts-node/register env.ts`, {
        cwd: TEST_DIR
      })
      expect(err).to.equal(null)
      expect(stdout).to.equal('object\n')
    })

    if (semver.gte(ts.version, '1.8.0')) {
      it('should allow js', async () => {
        const { err, stdout } = await exec(
          [
            cmd,
            '-O "{\\\"allowJs\\\":true}"',
            '-pe "import { main } from \'./allow-js/run\';main()"'
          ].join(' '))
        expect(err).to.equal(null)
        expect(stdout).to.equal('hello world\n')
      }
      )

      it('should include jsx when `allow-js` true', async () => {
        const { err, stdout } = await exec(
          [
            cmd,
            '-O "{\\\"allowJs\\\":true}"',
            '-pe "import { Foo2 } from \'./allow-js/with-jsx\'; Foo2.sayHi()"'
          ].join(' '))
        expect(err).to.equal(null)
        expect(stdout).to.equal('hello world\n')
      })
    }

    it('should eval code', async () => {
      const { err, stdout } = await exec(
        `${cmd} -e "import * as m from './module';console.log(m.example('test'))"`)
      expect(err).to.equal(null)
      expect(stdout).to.equal('TEST\n')
    })

    it('should import empty files', async () => {
      const { err, stdout } = await exec(`${cmd} -e "import './empty'"`)
      expect(err).to.equal(null)
      expect(stdout).to.equal('')
    })

    it('should throw errors', async () => {
      const { err } = await exec(`${cmd} -e "import * as m from './module';console.log(m.example(123))"`)
      if (err === null) {
        throw new Error('Command was expected to fail, but it succeeded.')
      }

      expect(err.message).to.match(new RegExp(
        'TS2345: Argument of type \'(?:number|123)\' ' +
        'is not assignable to parameter of type \'string\'\\.'
      ))
    })

    it('should be able to ignore diagnostic', async () => {
      const { err } = await exec(
        `${cmd} --ignore-diagnostics 2345 -e "import * as m from './module';console.log(m.example(123))"`)
      if (err === null) {
        throw new Error('Command was expected to fail, but it succeeded.')
      }

      expect(err.message).to.match(
        /TypeError: (?:(?:undefined|foo\.toUpperCase) is not a function|.*has no method \'toUpperCase\')/
      )
    })

    it('should work with source maps', async () => {
      const { err } = await exec(`${cmd} throw`)
      if (err === null) {
        throw new Error('Command was expected to fail, but it succeeded.')
      }

      expect(err.message).to.contain([
        `${join(TEST_DIR, 'throw.ts')}:100`,
        '  bar () { throw new Error(\'this is a demo\') }',
        '                 ^',
        'Error: this is a demo'
      ].join('\n'))
    })

    it('eval should work with source maps', async () => {
      const { err } = await exec(`${cmd} -pe "import './throw'"`)
      if (err === null) {
        throw new Error('Command was expected to fail, but it succeeded.')
      }

      expect(err.message).to.contain([
        `${join(TEST_DIR, 'throw.ts')}:100`,
        '  bar () { throw new Error(\'this is a demo\') }',
        '                 ^'
      ].join('\n'))
    })

    it('should support transpile only mode', async () => {
      const { err } = await exec(`${cmd} --transpile-only -pe "x"`)
      if (err === null) {
        throw new Error('Command was expected to fail, but it succeeded.')
      }

      expect(err.message).to.contain('ReferenceError: x is not defined')
    })

    it('should throw error even in transpileOnly mode', async () => {
      const { err } = await exec(`${cmd} --transpile-only -pe "console."`)
      if (err === null) {
        throw new Error('Command was expected to fail, but it succeeded.')
      }

      expect(err.message).to.contain('error TS1003: Identifier expected')
    })

    it('should pipe into `ts-node` and evaluate', async () => {
      const execPromise = exec(cmd)
      execPromise.child.stdin!.end("console.log('hello')")
      const { err, stdout } = await execPromise
      expect(err).to.equal(null)
      expect(stdout).to.equal('hello\n')
    })

    it('should pipe into `ts-node`', async () => {
      const execPromise = exec(`${cmd} -p`)
      execPromise.child.stdin!.end('true')
      const { err, stdout } = await execPromise
      expect(err).to.equal(null)
      expect(stdout).to.equal('true\n')

    })

    it('should pipe into an eval script', async () => {
      const execPromise = exec(`${cmd} --transpile-only -pe "process.stdin.isTTY"`)
      execPromise.child.stdin!.end('true')
      const { err, stdout } = await execPromise
      expect(err).to.equal(null)
      expect(stdout).to.equal('undefined\n')

    })

    it('should run REPL when --interactive passed and stdin is not a TTY', async () => {
      const execPromise = exec(`${cmd} --interactive`)
      execPromise.child.stdin!.end('console.log("123")\n')
      const { err, stdout } = await execPromise
      expect(err).to.equal(null)
      expect(stdout).to.equal(
        '> 123\n' +
        'undefined\n' +
        '> '
      )

    })

    it('REPL has command to get type information', async () => {
      const execPromise = exec(`${cmd} --interactive`)
      execPromise.child.stdin!.end('\nconst a = 123\n.type a')
      const { err, stdout } = await execPromise
      expect(err).to.equal(null)
      expect(stdout).to.equal(
        '> undefined\n' +
        '> undefined\n' +
        '> const a: 123\n' +
        '> '
      )
    })

    it('REPL can be created via API', async () => {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const replService = createRepl({
        stdin,
        stdout,
        stderr
      })
      const service = create(replService.evalAwarePartialHost)
      replService.setService(service)
      replService.start()
      stdin.write('\nconst a = 123\n.type a\n')
      stdin.end()
      await promisify(setTimeout)(1e3)
      stdout.end()
      stderr.end()
      expect(await getStream(stderr)).to.equal('')
      expect(await getStream(stdout)).to.equal(
        '> \'use strict\'\n' +
        '> undefined\n' +
        '> const a: 123\n' +
        '> '
      )
    })

    it('should support require flags', async () => {
      const { err, stdout } = await exec(`${cmd} -r ./hello-world -pe "console.log('success')"`)
      expect(err).to.equal(null)
      expect(stdout).to.equal('Hello, world!\nsuccess\nundefined\n')
    })

    it('should support require from node modules', async () => {
      const { err, stdout } = await exec(`${cmd} -r typescript -e "console.log('success')"`)
      expect(err).to.equal(null)
      expect(stdout).to.equal('success\n')
    })

    it('should use source maps with react tsx', async () => {
      const { err, stdout } = await exec(`${cmd} throw-react-tsx.tsx`)
      expect(err).not.to.equal(null)
      expect(err!.message).to.contain([
        `${join(TEST_DIR, './throw-react-tsx.tsx')}:100`,
        '  bar () { throw new Error(\'this is a demo\') }',
        '                 ^',
        'Error: this is a demo'
      ].join('\n'))
    })

    it('should allow custom typings', async () => {
      const { err, stdout } = await exec(`${cmd} custom-types`)
      expect(err).to.match(/Error: Cannot find module 'does-not-exist'/)
    })

    it('should preserve `ts-node` context with child process', async () => {
      const { err, stdout } = await exec(`${cmd} child-process`)
      expect(err).to.equal(null)
      expect(stdout).to.equal('Hello, world!\n')
    })

    it('should import js before ts by default', async () => {
      const { err, stdout } = await exec(`${cmd} import-order/compiled`)
      expect(err).to.equal(null)
      expect(stdout).to.equal('Hello, JavaScript!\n')
    })

    const preferTsExtsEntrypoint = semver.gte(process.version, '12.0.0') ? 'import-order/compiled' : 'import-order/require-compiled'
    it('should import ts before js when --prefer-ts-exts flag is present', async () => {

      const { err, stdout } = await exec(`${cmd} --prefer-ts-exts ${preferTsExtsEntrypoint}`)
      expect(err).to.equal(null)
      expect(stdout).to.equal('Hello, TypeScript!\n')
    })

    it('should import ts before js when TS_NODE_PREFER_TS_EXTS env is present', async () => {
      const { err, stdout } = await exec(`${cmd} ${preferTsExtsEntrypoint}`, { env: { ...process.env, TS_NODE_PREFER_TS_EXTS: 'true' } })
      expect(err).to.equal(null)
      expect(stdout).to.equal('Hello, TypeScript!\n')
    })

    it('should ignore .d.ts files', async () => {
      const { err, stdout } = await exec(`${cmd} import-order/importer`)
      expect(err).to.equal(null)
      expect(stdout).to.equal('Hello, World!\n')
    })

    describe('issue #884', () => {
      it('should compile', async function () {
        // TODO disabled because it consistently fails on Windows on TS 2.7
        if (process.platform === 'win32' && semver.satisfies(ts.version, '2.7')) {
          this.skip()
        } else {
          const { err, stdout } = await exec(`"${BIN_PATH}" --project issue-884/tsconfig.json issue-884`)
          expect(err).to.equal(null)
          expect(stdout).to.equal('')
        }
      })
    })

    describe('issue #986', () => {
      it('should not compile', async () => {
        const { err, stdout, stderr } = await exec(`"${BIN_PATH}" --project issue-986/tsconfig.json issue-986`)
        expect(err).not.to.equal(null)
        expect(stderr).to.contain('Cannot find name \'TEST\'') // TypeScript error.
        expect(stdout).to.equal('')
      })

      it('should compile with `--files`', async () => {
        const { err, stdout, stderr } = await exec(`"${BIN_PATH}" --files --project issue-986/tsconfig.json issue-986`)
        expect(err).not.to.equal(null)
        expect(stderr).to.contain('ReferenceError: TEST is not defined') // Runtime error.
        expect(stdout).to.equal('')
      })
    })

    if (semver.gte(ts.version, '2.7.0')) {
      it('should locate tsconfig relative to entry-point by default', async () => {
        const { err, stdout } = await exec(`${BIN_PATH} ../a/index`, { cwd: join(TEST_DIR, 'cwd-and-script-mode/b') })
        expect(err).to.equal(null)
        expect(stdout).to.match(/plugin-a/)
      })
      it('should locate tsconfig relative to entry-point via ts-node-script', async () => {
        const { err, stdout } = await exec(`${BIN_SCRIPT_PATH} ../a/index`, { cwd: join(TEST_DIR, 'cwd-and-script-mode/b') })
        expect(err).to.equal(null)
        expect(stdout).to.match(/plugin-a/)
      })
      it('should locate tsconfig relative to entry-point with --script-mode', async () => {
        const { err, stdout } = await exec(`${BIN_PATH} --script-mode ../a/index`, { cwd: join(TEST_DIR, 'cwd-and-script-mode/b') })
        expect(err).to.equal(null)
        expect(stdout).to.match(/plugin-a/)
      })
      it('should locate tsconfig relative to cwd via ts-node-cwd', async () => {
        const { err, stdout } = await exec(`${BIN_CWD_PATH} ../a/index`, { cwd: join(TEST_DIR, 'cwd-and-script-mode/b') })
        expect(err).to.equal(null)
        expect(stdout).to.match(/plugin-b/)
      })
      it('should locate tsconfig relative to cwd in --cwd-mode', async () => {
        const { err, stdout } = await exec(`${BIN_PATH} --cwd-mode ../a/index`, { cwd: join(TEST_DIR, 'cwd-and-script-mode/b') })
        expect(err).to.equal(null)
        expect(stdout).to.match(/plugin-b/)
      })
      it('should locate tsconfig relative to realpath, not symlink, when entrypoint is a symlink', async function () {
        if (lstatSync(join(TEST_DIR, 'main-realpath/symlink/symlink.tsx')).isSymbolicLink()) {
          const { err, stdout } = await exec(`${BIN_PATH} main-realpath/symlink/symlink.tsx`)
          expect(err).to.equal(null)
          expect(stdout).to.equal('')
        } else {
          this.skip()
        }
      })
    }

    describe('should read ts-node options from tsconfig.json', () => {
      const BIN_EXEC = `"${BIN_PATH}" --project tsconfig-options/tsconfig.json`

      it('should override compiler options from env', async () => {
        const { err, stdout } = await exec(`${BIN_EXEC} tsconfig-options/log-options1.js`, {
          env: {
            ...process.env,
            TS_NODE_COMPILER_OPTIONS: '{"typeRoots": ["env-typeroots"]}'
          }
        })
        expect(err).to.equal(null)
        const { config } = JSON.parse(stdout)
        expect(config.options.typeRoots).to.deep.equal([join(TEST_DIR, './tsconfig-options/env-typeroots').replace(/\\/g, '/')])
      })

      it('should use options from `tsconfig.json`', async () => {
        const { err, stdout } = await exec(`${BIN_EXEC} tsconfig-options/log-options1.js`)
        expect(err).to.equal(null)
        const { options, config } = JSON.parse(stdout)
        expect(config.options.typeRoots).to.deep.equal([join(TEST_DIR, './tsconfig-options/tsconfig-typeroots').replace(/\\/g, '/')])
        expect(config.options.types).to.deep.equal(['tsconfig-tsnode-types'])
        expect(options.pretty).to.equal(undefined)
        expect(options.skipIgnore).to.equal(false)
        expect(options.transpileOnly).to.equal(true)
        expect(options.require).to.deep.equal([join(TEST_DIR, './tsconfig-options/required1.js')])
      })

      it('should have flags override / merge with `tsconfig.json`', async () => {
        const { err, stdout } = await exec(`${BIN_EXEC} --skip-ignore --compiler-options "{\\"types\\":[\\"flags-types\\"]}" --require ./tsconfig-options/required2.js tsconfig-options/log-options2.js`)
        expect(err).to.equal(null)
        const { options, config } = JSON.parse(stdout)
        expect(config.options.typeRoots).to.deep.equal([join(TEST_DIR, './tsconfig-options/tsconfig-typeroots').replace(/\\/g, '/')])
        expect(config.options.types).to.deep.equal(['flags-types'])
        expect(options.pretty).to.equal(undefined)
        expect(options.skipIgnore).to.equal(true)
        expect(options.transpileOnly).to.equal(true)
        expect(options.require).to.deep.equal([
          join(TEST_DIR, './tsconfig-options/required1.js'),
          './tsconfig-options/required2.js'
        ])
      })

      it('should have `tsconfig.json` override environment', async () => {
        const { err, stdout } = await exec(`${BIN_EXEC} tsconfig-options/log-options1.js`, {
          env: {
            ...process.env,
            TS_NODE_PRETTY: 'true',
            TS_NODE_SKIP_IGNORE: 'true'
          }
        })
        expect(err).to.equal(null)
        const { options, config } = JSON.parse(stdout)
        expect(config.options.typeRoots).to.deep.equal([join(TEST_DIR, './tsconfig-options/tsconfig-typeroots').replace(/\\/g, '/')])
        expect(config.options.types).to.deep.equal(['tsconfig-tsnode-types'])
        expect(options.pretty).to.equal(true)
        expect(options.skipIgnore).to.equal(false)
        expect(options.transpileOnly).to.equal(true)
        expect(options.require).to.deep.equal([join(TEST_DIR, './tsconfig-options/required1.js')])
      })
    })

    describe('compiler host', () => {
      it('should execute cli', async () => {
        const { err, stdout } = await exec(`${cmd} --compiler-host hello-world`)
        expect(err).to.equal(null)
        expect(stdout).to.equal('Hello, world!\n')
      })
    })

    it('should transpile files inside a node_modules directory when not ignored', async () => {
      const { err, stdout, stderr } = await exec(`${cmdNoProject} from-node-modules/from-node-modules`)
      if (err) throw new Error(`Unexpected error: ${err}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
      expect(JSON.parse(stdout)).to.deep.equal({
        external: {
          tsmri: { name: 'typescript-module-required-internally' },
          jsmri: { name: 'javascript-module-required-internally' },
          tsmii: { name: 'typescript-module-imported-internally' },
          jsmii: { name: 'javascript-module-imported-internally' }
        },
        tsmie: { name: 'typescript-module-imported-externally' },
        jsmie: { name: 'javascript-module-imported-externally' },
        tsmre: { name: 'typescript-module-required-externally' },
        jsmre: { name: 'javascript-module-required-externally' }
      })
    })

    describe('should respect maxNodeModulesJsDepth', () => {
      it('for unscoped modules', async () => {
        const { err, stdout, stderr } = await exec(`${cmdNoProject} maxnodemodulesjsdepth`)
        expect(err).to.not.equal(null)
        expect(stderr.replace(/\r\n/g, '\n')).to.contain(
          'TSError: ⨯ Unable to compile TypeScript:\n' +
          "maxnodemodulesjsdepth/other.ts(4,7): error TS2322: Type 'string' is not assignable to type 'boolean'.\n" +
          '\n'
        )
      })

      it('for @scoped modules', async () => {
        const { err, stdout, stderr } = await exec(`${cmdNoProject} maxnodemodulesjsdepth-scoped`)
        expect(err).to.not.equal(null)
        expect(stderr.replace(/\r\n/g, '\n')).to.contain(
          'TSError: ⨯ Unable to compile TypeScript:\n' +
          "maxnodemodulesjsdepth-scoped/other.ts(7,7): error TS2322: Type 'string' is not assignable to type 'boolean'.\n" +
          '\n'
        )
      })
    })
  })

  describe('register', () => {
    let registered: tsNodeTypes.Service
    let moduleTestPath: string
    before(() => {
      registered = register({
        project: PROJECT,
        compilerOptions: {
          jsx: 'preserve'
        }
      })
      moduleTestPath = require.resolve('../tests/module')
    })

    afterEach(() => {
      // Re-enable project after every test.
      registered.enabled(true)
    })

    it('should be able to require typescript', () => {
      const m = require(moduleTestPath)

      expect(m.example('foo')).to.equal('FOO')
    })

    it('should support dynamically disabling', () => {
      delete require.cache[moduleTestPath]

      expect(registered.enabled(false)).to.equal(false)
      expect(() => require(moduleTestPath)).to.throw(/Unexpected token/)

      delete require.cache[moduleTestPath]

      expect(registered.enabled()).to.equal(false)
      expect(() => require(moduleTestPath)).to.throw(/Unexpected token/)

      delete require.cache[moduleTestPath]

      expect(registered.enabled(true)).to.equal(true)
      expect(() => require(moduleTestPath)).to.not.throw()

      delete require.cache[moduleTestPath]

      expect(registered.enabled()).to.equal(true)
      expect(() => require(moduleTestPath)).to.not.throw()
    })

    if (semver.gte(ts.version, '2.7.0')) {
      it('should support compiler scopes', () => {
        const calls: string[] = []

        registered.enabled(false)

        const compilers = [
          register({ projectSearchDir: join(TEST_DIR, 'scope/a'), scopeDir: join(TEST_DIR, 'scope/a'), scope: true }),
          register({ projectSearchDir: join(TEST_DIR, 'scope/a'), scopeDir: join(TEST_DIR, 'scope/b'), scope: true })
        ]

        compilers.forEach(c => {
          const old = c.compile
          c.compile = (code, fileName, lineOffset) => {
            calls.push(fileName)

            return old(code, fileName, lineOffset)
          }
        })

        try {
          expect(require('../tests/scope/a').ext).to.equal('.ts')
          expect(require('../tests/scope/b').ext).to.equal('.ts')
        } finally {
          compilers.forEach(c => c.enabled(false))
        }

        expect(calls).to.deep.equal([
          join(TEST_DIR, 'scope/a/index.ts'),
          join(TEST_DIR, 'scope/b/index.ts')
        ])

        delete require.cache[moduleTestPath]

        expect(() => require(moduleTestPath)).to.throw()
      })
    }

    it('should compile through js and ts', () => {
      const m = require('../tests/complex')

      expect(m.example()).to.equal('example')
    })

    it('should work with proxyquire', () => {
      const m = proxyquire('../tests/complex', {
        './example': 'hello'
      })

      expect(m.example()).to.equal('hello')
    })

    it('should work with `require.cache`', () => {
      const { example1, example2 } = require('../tests/require-cache')

      expect(example1).to.not.equal(example2)
    })

    it('should use source maps', async () => {
      try {
        require('../tests/throw')
      } catch (error) {
        expect(error.stack).to.contain([
          'Error: this is a demo',
          `    at Foo.bar (${join(TEST_DIR, './throw.ts')}:100:18)`
        ].join('\n'))
      }
    })

    describe('JSX preserve', () => {
      let old: (m: Module, filename: string) => any
      let compiled: string

      before(() => {
        old = require.extensions['.tsx']! // tslint:disable-line
        require.extensions['.tsx'] = (m: any, fileName) => { // tslint:disable-line
          const _compile = m._compile

          m._compile = (code: string, fileName: string) => {
            compiled = code
            return _compile.call(this, code, fileName)
          }

          return old(m, fileName)
        }
      })

      after(() => {
        require.extensions['.tsx'] = old // tslint:disable-line
      })

      it('should use source maps', async () => {
        try {
          require('../tests/with-jsx.tsx')
        } catch (error) {
          expect(error.stack).to.contain('SyntaxError: Unexpected token')
        }

        expect(compiled).to.match(SOURCE_MAP_REGEXP)
      })
    })
  })

  describe('create', () => {
    let service: tsNodeTypes.Service
    before(() => {
      service = create({ compilerOptions: { target: 'es5' }, skipProject: true })
    })

    it('should create generic compiler instances', () => {
      const output = service.compile('const x = 10', 'test.ts')
      expect(output).to.contain('var x = 10;')
    })

    describe('should get type information', () => {
      it('given position of identifier', () => {
        expect(service.getTypeInfo('/**jsdoc here*/const x = 10', 'test.ts', 21)).to.deep.equal({
          comment: 'jsdoc here',
          name: 'const x: 10'
        })
      })
      it('given position that does not point to an identifier', () => {
        expect(service.getTypeInfo('/**jsdoc here*/const x = 10', 'test.ts', 0)).to.deep.equal({
          comment: '',
          name: ''
        })
      })
    })
  })

  describe('issue #1098', () => {
    function testIgnored (ignored: tsNodeTypes.Service['ignored'], allowed: string[], disallowed: string[]) {
      for (const ext of allowed) {
        expect(ignored(join(__dirname, `index${ext}`))).equal(false, `should accept ${ext} files`)
      }
      for (const ext of disallowed) {
        expect(ignored(join(__dirname, `index${ext}`))).equal(true, `should ignore ${ext} files`)
      }
    }

    it('correctly filters file extensions from the compiler when allowJs=false and jsx=false', () => {
      const { ignored } = create({ compilerOptions: {}, skipProject: true })
      testIgnored(ignored, ['.ts', '.d.ts'], ['.js', '.tsx', '.jsx', '.mjs', '.cjs', '.xyz', ''])
    })
    it('correctly filters file extensions from the compiler when allowJs=true and jsx=false', () => {
      const { ignored } = create({ compilerOptions: { allowJs: true }, skipProject: true })
      testIgnored(ignored, ['.ts', '.js', '.d.ts'], ['.tsx', '.jsx', '.mjs', '.cjs', '.xyz', ''])
    })
    it('correctly filters file extensions from the compiler when allowJs=false and jsx=true', () => {
      const { ignored } = create({ compilerOptions: { allowJs: false, jsx: 'preserve' }, skipProject: true })
      testIgnored(ignored, ['.ts', '.tsx', '.d.ts'], ['.js', '.jsx', '.mjs', '.cjs', '.xyz', ''])
    })
    it('correctly filters file extensions from the compiler when allowJs=true and jsx=true', () => {
      const { ignored } = create({ compilerOptions: { allowJs: true, jsx: 'preserve' }, skipProject: true })
      testIgnored(ignored, ['.ts', '.tsx', '.js', '.jsx', '.d.ts'], ['.mjs', '.cjs', '.xyz', ''])
    })
  })

  describe('esm', () => {
    this.slow(1000)

    const cmd = `node --loader ts-node/esm`

    if (semver.gte(process.version, '13.0.0')) {
      it('should compile and execute as ESM', async () => {
        const { err, stdout } = await exec(`${cmd} index.ts`, { cwd: join(TEST_DIR, './esm') })
        expect(err).to.equal(null)
        expect(stdout).to.equal('foo bar baz biff libfoo\n')
      })
      it('should use source maps', async () => {
        const { err, stdout } = await exec(`${cmd} throw.ts`, { cwd: join(TEST_DIR, './esm') })
        expect(err).not.to.equal(null)
        expect(err!.message).to.contain([
          `${pathToFileURL(join(TEST_DIR, './esm/throw.ts'))}:100`,
          '  bar () { throw new Error(\'this is a demo\') }',
          '                 ^',
          'Error: this is a demo'
        ].join('\n'))
      })

      describe('supports experimental-specifier-resolution=node', () => {
        it('via --experimental-specifier-resolution', async () => {
          const { err, stdout } = await exec(`${cmd} --experimental-specifier-resolution=node index.ts`, { cwd: join(TEST_DIR, './esm-node-resolver') })
          expect(err).to.equal(null)
          expect(stdout).to.equal('foo bar baz biff libfoo\n')
        })
        it('via --es-module-specifier-resolution alias', async () => {
          const { err, stdout } = await exec(`${cmd} --experimental-modules --es-module-specifier-resolution=node index.ts`, { cwd: join(TEST_DIR, './esm-node-resolver') })
          expect(err).to.equal(null)
          expect(stdout).to.equal('foo bar baz biff libfoo\n')
        })
        it('via NODE_OPTIONS', async () => {
          const { err, stdout } = await exec(`${cmd} index.ts`, {
            cwd: join(TEST_DIR, './esm-node-resolver'),
            env: {
              ...process.env,
              NODE_OPTIONS: '--experimental-specifier-resolution=node'
            }
          })
          expect(err).to.equal(null)
          expect(stdout).to.equal('foo bar baz biff libfoo\n')
        })
      })

      it('throws ERR_REQUIRE_ESM when attempting to require() an ESM script while ESM loader is enabled', async () => {
        const { err, stdout, stderr } = await exec(`${cmd} ./index.js`, { cwd: join(TEST_DIR, './esm-err-require-esm') })
        expect(err).to.not.equal(null)
        expect(stderr).to.contain('Error [ERR_REQUIRE_ESM]: Must use import to load ES Module:')
      })

      it('defers to fallback loaders when URL should not be handled by ts-node', async () => {
        const { err, stdout, stderr } = await exec(`${cmd} index.mjs`, {
          cwd: join(TEST_DIR, './esm-import-http-url')
        })
        expect(err).to.not.equal(null)
        // expect error from node's default resolver
        expect(stderr).to.match(/Error \[ERR_UNSUPPORTED_ESM_URL_SCHEME\]:.*(?:\n.*){0,1}\n *at defaultResolve/)
      })

      it('should bypass import cache when changing search params', async () => {
        const { err, stdout } = await exec(`${cmd} index.ts`, { cwd: join(TEST_DIR, './esm-import-cache') })
        expect(err).to.equal(null)
        expect(stdout).to.equal('log1\nlog2\nlog2\n')
      })

      it('should support transpile only mode via dedicated loader entrypoint', async () => {
        const { err, stdout } = await exec(`${cmd}/transpile-only index.ts`, { cwd: join(TEST_DIR, './esm-transpile-only') })
        expect(err).to.equal(null)
        expect(stdout).to.equal('')
      })
      it('should throw type errors without transpile-only enabled', async () => {
        const { err, stdout } = await exec(`${cmd} index.ts`, { cwd: join(TEST_DIR, './esm-transpile-only') })
        if (err === null) {
          throw new Error('Command was expected to fail, but it succeeded.')
        }

        expect(err.message).to.contain('Unable to compile TypeScript')
        expect(err.message).to.match(new RegExp('TS2345: Argument of type \'(?:number|1101)\' is not assignable to parameter of type \'string\'\\.'))
        expect(err.message).to.match(new RegExp('TS2322: Type \'(?:"hello world"|string)\' is not assignable to type \'number\'\\.'))
        expect(stdout).to.equal('')
      })
    }

    it('executes ESM as CJS, ignoring package.json "types" field (for backwards compatibility; should be changed in next major release to throw ERR_REQUIRE_ESM)', async () => {
      const { err, stdout } = await exec(`${BIN_PATH} ./esm-err-require-esm/index.js`)
      expect(err).to.equal(null)
      expect(stdout).to.equal('CommonJS\n')
    })
  })
})
