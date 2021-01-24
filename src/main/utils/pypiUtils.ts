import * as exec from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as Collections from 'typescript-collections';
import * as vscode from 'vscode';
import { ComponentDetails } from 'xray-client-js';
import { LogManager } from '../log/logManager';
import { CondaTreeNode } from '../treeDataProviders/dependenciesTree/dependenciesRoot/condaTree';
import { PipTreeNode } from '../treeDataProviders/dependenciesTree/dependenciesRoot/pipTree';
import { PythonTreeNode } from '../treeDataProviders/dependenciesTree/dependenciesRoot/pythonTree';
import { DependenciesTreeNode } from '../treeDataProviders/dependenciesTree/dependenciesTreeNode';
import { TreesManager } from '../treeDataProviders/treesManager';
import { Configuration } from './configuration';
import { ScanUtils } from './scanUtils';

export class PypiUtils {
    public static readonly DOCUMENT_SELECTOR: vscode.DocumentSelector = { scheme: 'file', pattern: '**/*requirements*.txt' };
    public static readonly PYTHON_SCRIPTS: string = path.join(__dirname, '..', '..', '..', 'resources', 'python');
    public static readonly PIP_DEP_TREE_SCRIPT: string = path.join(PypiUtils.PYTHON_SCRIPTS, 'pipDepTree.py');
    public static readonly CONDA_DEP_TREE_SCRIPT: string = path.join(PypiUtils.PYTHON_SCRIPTS, 'condaDepTree.py');
    public static readonly CHECK_VENV_SCRIPT: string = path.join(PypiUtils.PYTHON_SCRIPTS, 'checkVenv.py');
    public static readonly PKG_TYPE: string = 'pypi';

    /**
     * Get setup.py file and return the position of 'install_requires' section.
     * @param document - setup.py file
     */
    public static getDependenciesPos(document: vscode.TextDocument): vscode.Position[] {
        let res: vscode.Position[] = [];
        let packageJsonContent: string = document.getText();
        let dependenciesMatch: RegExpMatchArray | null = packageJsonContent.match('install_requires(s*)=');
        if (!dependenciesMatch) {
            return res;
        }
        res.push(document.positionAt(<number>dependenciesMatch.index));
        res.push(new vscode.Position(res[0].line, res[0].character + dependenciesMatch[0].length));
        return res;
    }

    /**
     * Get requirements file and dependencies tree node. return the position of the dependency in the requirements file.
     * @param document             - requirements file
     * @param requirementsContent  - requirements file content - For optimization
     * @param dependenciesTreeNode - dependencies tree node
     */
    public static getDependencyPos(
        document: vscode.TextDocument,
        requirementsContent: string,
        dependenciesTreeNode: DependenciesTreeNode
    ): vscode.Position[] {
        let res: vscode.Position[] = [];
        let dependencyMatch: RegExpMatchArray | null = requirementsContent.match(dependenciesTreeNode.generalInfo.artifactId);
        if (!dependencyMatch) {
            return res;
        }
        res.push(document.positionAt(<number>dependencyMatch.index));
        res.push(new vscode.Position(res[0].line, res[0].character + dependencyMatch[0].length));
        return res;
    }

    /**
     * Find *.py files in workspaces.
     * @param workspaceFolders - Base workspace folders to search
     * @param logManager       - Log manager
     */
    public static async arePythonFilesExist(workspaceFolder: vscode.WorkspaceFolder, logManager: LogManager): Promise<boolean> {
        logManager.logMessage('Locating python files in workspace "' + workspaceFolder.name + '".', 'INFO');

        let wsPythonFiles: vscode.Uri[] = await vscode.workspace.findFiles(
            { base: workspaceFolder.uri.fsPath, pattern: '**/*{setup.py,requirements*.txt}' },
            Configuration.getScanExcludePattern(workspaceFolder)
        );
        if (logManager && wsPythonFiles.length > 0) {
            logManager.logMessage('Detected python files in workspace ' + workspaceFolder.name + ': [' + wsPythonFiles.toString() + ']', 'DEBUG');
        }
        return Promise.resolve(wsPythonFiles.length > 0);
    }

    /**
     * @param workspaceFolders - Base workspace folders
     * @param componentsToScan - Set of setup.py components to populate during the tree building. We'll use this set later on, while scanning the packages with Xray.
     * @param scanCacheManager - Scan cache manager
     * @param parent           - The base tree node
     * @param quickScan        - True to allow using the scan cache
     */
    public static async createDependenciesTrees(
        workspaceFolders: vscode.WorkspaceFolder[],
        componentsToScan: Collections.Set<ComponentDetails>,
        treesManager: TreesManager,
        parent: DependenciesTreeNode,
        quickScan: boolean
    ): Promise<PythonTreeNode[]> {
        treesManager.logManager.logMessage(process.env.CONDA_DEFAULT_ENV || '', 'INFO', false);
        let pythonExtensionActivated: boolean = false;
        let pythonTreeNodes: PythonTreeNode[] = [];
        for (let workspaceFolder of workspaceFolders) {
            let pythonFilesExist: boolean = await PypiUtils.arePythonFilesExist(workspaceFolder, treesManager.logManager);
            if (!pythonFilesExist) {
                treesManager.logManager.logMessage('No setup.py and requirements files found in workspace ' + workspaceFolder.name + '.', 'DEBUG');
                continue;
            }
            if (!pythonExtensionActivated) {
                if (!(await PypiUtils.verifyAndActivatePythonExtension())) {
                    vscode.window.showErrorMessage(
                        'Could not scan Pypi project dependencies, because python extension is not installed. ' +
                            'Please install Python extension: https://marketplace.visualstudio.com/items?itemName=ms-python.python'
                    );
                    return [];
                }
                pythonExtensionActivated = true;
            }

            let pythonPath: string | undefined = PypiUtils.getPythonPath(workspaceFolder);
            if (!pythonPath) {
                vscode.window.showErrorMessage('Could not scan Pypi project dependencies, because python interpreter is not set.');
                return [];
            }
            let pythonPaths: PythonPaths = new PythonPaths(pythonPath);
            pythonPaths.condaPrefix = PypiUtils.getCondaPath(workspaceFolder);
            if (!PypiUtils.isInVirtualEnv(pythonPaths, workspaceFolder.uri.fsPath, treesManager.logManager)) {
                vscode.window.showErrorMessage(
                    'Please install and activate a virtual environment before running Xray scan. Then, install your Python project in that environment.'
                );
                return [];
            }

            treesManager.logManager.logMessage('Analyzing setup.py and requirements files of ' + workspaceFolder.name, 'INFO');

            let dependenciesTreeNode: PythonTreeNode;
            if (pythonPaths.condaPrefix) {
                dependenciesTreeNode = new CondaTreeNode(workspaceFolder.uri.fsPath, componentsToScan, treesManager, pythonPaths, parent);
            } else {
                dependenciesTreeNode = new PipTreeNode(workspaceFolder.uri.fsPath, componentsToScan, treesManager, pythonPath, parent);
            }
            dependenciesTreeNode.refreshDependencies(quickScan);
            pythonTreeNodes.push(dependenciesTreeNode);
        }
        return pythonTreeNodes;
    }

    /**
     * Return true iff VS-Code Python extension is installed.
     * Activate it to allow tracking on environmental changes -
     *   If virtual env is not installed, we want that the Python extension will detect new virtualenv environments and suggest activation.
     */
    public static async verifyAndActivatePythonExtension(): Promise<boolean> {
        let pythonExtension: vscode.Extension<any> | undefined = vscode.extensions.getExtension('ms-python.python');
        if (!pythonExtension) {
            return false;
        }
        await pythonExtension.activate();
        return true;
    }

    /**
     * Return Python path as configured in Python extension.
     * @param workspaceFolder - Base workspace folder
     */
    private static getPythonPath(workspaceFolder: vscode.WorkspaceFolder): string | undefined {
        return vscode.workspace.getConfiguration('python', workspaceFolder.uri).get('pythonPath');
    }

    /**
     * Return Conda path as configured in Python extension.
     * @param workspaceFolder - Base workspace folder
     */
    private static getCondaPath(workspaceFolder: vscode.WorkspaceFolder): string | undefined {
        return vscode.workspace.getConfiguration('python', workspaceFolder.uri).get('condaPath');
    }

    /**
     * Return true iff the input Python interpreter is inside virtual environment.
     * @param pythonPath      - Path to python interpreter
     * @param workspaceFolder - Base workspace folder
     */
    public static isInVirtualEnv(pythonPaths: PythonPaths, workspaceFolder: string, logManager: LogManager): boolean {
        if (pythonPaths.condaPrefix) {
            if (fs.existsSync(pythonPaths.condaPrefix)) {
                logManager.logMessage("Using conda path '" + pythonPaths.condaPrefix + "'", 'INFO');
                return true;
            }
            logManager.logError(new Error("Couldn't find Conda in '" + pythonPaths.condaPrefix + "'"), true);
            return false;
        }

        try {
            exec.execSync(pythonPaths.pythonPath + ' ' + PypiUtils.CHECK_VENV_SCRIPT, {
                cwd: workspaceFolder
            } as exec.ExecSyncOptionsWithStringEncoding);
            return true;
        } catch (error) {
            logManager.logMessage('Virtual environment is not set, checking for Conda executable...', 'DEBUG');
            pythonPaths.condaPrefix = PypiUtils.getCondaEnv(pythonPaths, logManager);
            if (pythonPaths.condaPrefix) {
                logManager.logMessage("Using conda prefix '" + pythonPaths.condaPrefix + "'", 'INFO');
                return true;
            }
            logManager.logError(error, false);
            return false;
        }
    }

    private static getCondaEnv(pythonPaths: PythonPaths, logManager: LogManager): string | undefined {
        try {
            let envsRes: any = JSON.parse(ScanUtils.executeCmd('conda env list --json').toString());
            let envs: string[] = envsRes.envs;
            if (!envs) {
                logManager.logMessage('Conda environments not found.', 'DEBUG');
                return undefined;
            }
            let baseDir: string = path.dirname(path.dirname(pythonPaths.pythonPath));
            for (let env of envs) {
                if (baseDir === env) {
                    return env;
                }
            }
            logManager.logMessage('Python interpreter is not under Conda environment', 'DEBUG');
        } catch (error) {
            logManager.logMessage('Conda is not in Path', 'DEBUG');
        }
        return undefined;
    }

    /**
     * Search for requirements files in the input path.
     * @param fsPath - The base path to search
     */
    public static async getRequirementsFiles(fsPath: string): Promise<vscode.Uri[]> {
        return await vscode.workspace.findFiles({ base: fsPath, pattern: '**/*requirements*.txt' }, Configuration.getScanExcludePattern());
    }
}

export class PythonPaths {
    condaPrefix: string | undefined;
    constructor(private _pythonPath: string) {}

    public get pythonPath() {
        return this._pythonPath;
    }
}
