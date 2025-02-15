import { exec, execSync } from 'child_process';
import { copyFileSync, existsSync } from 'fs';
import { remove } from 'fs-extra';
import { dirname, join, relative } from 'path';
import { dirSync } from 'tmp';
import { promisify } from 'util';
import { writeJsonFile } from './fileutils';
import { readModulePackageJson } from './package-json';
import { gte, lt } from 'semver';
import { workspaceRoot } from './workspace-root';

const execAsync = promisify(exec);

export type PackageManager = 'yarn' | 'pnpm' | 'npm';

export interface PackageManagerCommands {
  install: string;
  ciInstall: string;
  add: string;
  addDev: string;
  rm: string;
  exec: string;
  list: string;
  run: (script: string, args: string) => string;
}

/**
 * Detects which package manager is used in the workspace based on the lock file.
 */
export function detectPackageManager(dir: string = ''): PackageManager {
  return existsSync(join(dir, 'yarn.lock'))
    ? 'yarn'
    : existsSync(join(dir, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : 'npm';
}

/**
 * Returns commands for the package manager used in the workspace.
 * By default, the package manager is derived based on the lock file,
 * but it can also be passed in explicitly.
 *
 * Example:
 *
 * ```javascript
 * execSync(`${getPackageManagerCommand().addDev} my-dev-package`);
 * ```
 */
export function getPackageManagerCommand(
  packageManager: PackageManager = detectPackageManager()
): PackageManagerCommands {
  const commands: { [pm in PackageManager]: () => PackageManagerCommands } = {
    yarn: () => {
      const yarnVersion = getPackageManagerVersion('yarn');
      const useBerry = gte(yarnVersion, '2.0.0');

      return {
        install: 'yarn',
        ciInstall: useBerry
          ? 'yarn install --immutable'
          : 'yarn install --frozen-lockfile',
        add: useBerry ? 'yarn add' : 'yarn add -W',
        addDev: useBerry ? 'yarn add -D' : 'yarn add -D -W',
        rm: 'yarn remove',
        exec: useBerry ? 'yarn exec' : 'yarn',
        run: (script: string, args: string) => `yarn ${script} ${args}`,
        list: useBerry ? 'yarn info --name-only' : 'yarn list',
      };
    },
    pnpm: () => {
      const pnpmVersion = getPackageManagerVersion('pnpm');
      const useExec = gte(pnpmVersion, '6.13.0');
      const includeDoubleDashBeforeArgs = lt(pnpmVersion, '7.0.0');
      const isPnpmWorkspace = existsSync('pnpm-workspace.yaml');

      return {
        install: 'pnpm install --no-frozen-lockfile', // explicitly disable in case of CI
        ciInstall: 'pnpm install --frozen-lockfile',
        add: isPnpmWorkspace ? 'pnpm add -w' : 'pnpm add',
        addDev: isPnpmWorkspace ? 'pnpm add -Dw' : 'pnpm add -D',
        rm: 'pnpm rm',
        exec: useExec ? 'pnpm exec' : 'pnpx',
        run: (script: string, args: string) =>
          includeDoubleDashBeforeArgs
            ? `pnpm run ${script} -- ${args}`
            : `pnpm run ${script} ${args}`,
        list: 'pnpm ls --depth 100',
      };
    },
    npm: () => {
      return {
        install: 'npm install',
        ciInstall: 'npm ci',
        add: 'npm install',
        addDev: 'npm install -D',
        rm: 'npm rm',
        exec: 'npx',
        run: (script: string, args: string) => `npm run ${script} -- ${args}`,
        list: 'npm ls',
      };
    },
  };

  return commands[packageManager]();
}

/**
 * Returns the version of the package manager used in the workspace.
 * By default, the package manager is derived based on the lock file,
 * but it can also be passed in explicitly.
 */
export function getPackageManagerVersion(
  packageManager: PackageManager = detectPackageManager()
): string {
  return execSync(`${packageManager} --version`).toString('utf-8').trim();
}

/**
 * Checks for a project level npmrc file by crawling up the file tree until
 * hitting a package.json file, as this is how npm finds them as well.
 */
export function findFileInPackageJsonDirectory(
  file: string,
  directory: string = process.cwd()
): string | null {
  while (!existsSync(join(directory, 'package.json'))) {
    directory = dirname(directory);
  }
  const path = join(directory, file);
  return existsSync(path) ? path : null;
}

export function copyPackageManagerConfigurationFiles(
  root: string,
  destination: string
) {
  for (const packageManagerConfigFile of ['.npmrc', '.yarnrc', '.yarnrc.yml']) {
    // f is an absolute path, including the {workspaceRoot}.
    const f = findFileInPackageJsonDirectory(packageManagerConfigFile, root);
    if (f) {
      // Destination should be the same relative path from the {workspaceRoot},
      // but now relative to the destination. `relative` makes `{workspaceRoot}/some/path`
      // look like `./some/path`, and joining that gets us `{destination}/some/path
      const destinationPath = join(destination, relative(root, f));
      // Copy config file if it exists, so that the package manager still follows it.
      copyFileSync(f, destinationPath);
    }
  }
}

/**
 * Creates a temporary directory where you can run package manager commands safely.
 *
 * For cases where you'd want to install packages that require an `.npmrc` set up,
 * this function looks up for the nearest `.npmrc` (if exists) and copies it over to the
 * temp directory.
 */
export function createTempNpmDirectory() {
  const dir = dirSync().name;

  // A package.json is needed for pnpm pack and for .npmrc to resolve
  writeJsonFile(`${dir}/package.json`, {});
  copyPackageManagerConfigurationFiles(workspaceRoot, dir);

  const cleanup = async () => {
    try {
      await remove(dir);
    } catch {
      // It's okay if this fails, the OS will clean it up eventually
    }
  };

  return { dir, cleanup };
}

/**
 * Returns the resolved version for a given package and version tag using the
 * NPM registry (when using Yarn it will fall back to NPM to fetch the info).
 */
export async function resolvePackageVersionUsingRegistry(
  packageName: string,
  version: string
): Promise<string> {
  try {
    const result = await packageRegistryView(packageName, version, 'version');

    if (!result) {
      throw new Error(`Unable to resolve version ${packageName}@${version}.`);
    }

    // get the last line of the output, strip the package version and quotes
    const resolvedVersion = result
      .split('\n')
      .pop()
      .split(' ')
      .pop()
      .replace(/'/g, '');

    return resolvedVersion;
  } catch {
    throw new Error(`Unable to resolve version ${packageName}@${version}.`);
  }
}

/**
 * Return the resolved version for a given package and version tag using by
 * installing it in a temporary directory and fetching the version from the
 * package.json.
 */
export async function resolvePackageVersionUsingInstallation(
  packageName: string,
  version: string
): Promise<string> {
  const { dir, cleanup } = createTempNpmDirectory();

  try {
    const pmc = getPackageManagerCommand();
    await execAsync(`${pmc.add} ${packageName}@${version}`, { cwd: dir });

    const { packageJson } = readModulePackageJson(packageName, [dir]);

    return packageJson.version;
  } finally {
    await cleanup();
  }
}

export async function packageRegistryView(
  pkg: string,
  version: string,
  args: string
): Promise<string> {
  let pm = detectPackageManager();
  if (pm === 'yarn') {
    /**
     * yarn has `yarn info` but it behaves differently than (p)npm,
     * which makes it's usage unreliable
     *
     * @see https://github.com/nrwl/nx/pull/9667#discussion_r842553994
     */
    pm = 'npm';
  }

  const { stdout } = await execAsync(`${pm} view ${pkg}@${version} ${args}`);
  return stdout.toString().trim();
}

export async function packageRegistryPack(
  cwd: string,
  pkg: string,
  version: string
): Promise<{ tarballPath: string }> {
  let pm = detectPackageManager();
  if (pm === 'yarn') {
    /**
     * `(p)npm pack` will download a tarball of the specified version,
     * whereas `yarn` pack creates a tarball of the active workspace, so it
     * does not work for getting the content of a library.
     *
     * @see https://github.com/nrwl/nx/pull/9667#discussion_r842553994
     */
    pm = 'npm';
  }

  const { stdout } = await execAsync(`${pm} pack ${pkg}@${version}`, { cwd });

  const tarballPath = stdout.trim();
  return { tarballPath };
}
