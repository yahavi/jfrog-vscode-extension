import * as Collections from 'typescript-collections';
import * as vscode from 'vscode';
import { ComponentDetails } from 'xray-client-js';
import { GeneralInfo } from '../../../types/generalInfo';
import { PypiUtils } from '../../../utils/pypiUtils';
import { ScanUtils } from '../../../utils/scanUtils';
import { TreesManager } from '../../treesManager';
import { DependenciesTreeNode } from '../dependenciesTreeNode';
import { PythonTreeNode } from './pythonTree';

/**
 * Pypi packages can be installed in two different ways:
 * 1. 'pip install [Path to setup.py]' - With this method, the top level in the tree would be the project name.
 * 2. 'pip install -r [Path to requirements.txt]' - With this method, the top level in the tree would be the dependencies of the project.
 */
export class PipTreeNode extends PythonTreeNode {
    constructor(
        workspaceFolder: string,
        private _componentsToScan: Collections.Set<ComponentDetails>,
        treesManager: TreesManager,
        private _pythonPath: string,
        parent?: DependenciesTreeNode
    ) {
        super(workspaceFolder, treesManager, parent);
    }

    /** @override */
    protected executeDepTreeCommand(): any {
        return JSON.parse(
            ScanUtils.executeCmd(this._pythonPath + ' ' + PypiUtils.PIP_DEP_TREE_SCRIPT + ' --json-tree', this.workspaceFolder).toString()
        );
    }

    /** @override */
    protected populateDependenciesTree(dependenciesTreeNode: DependenciesTreeNode, dependencies: any, quickScan: boolean) {
        if (!dependencies) {
            return;
        }
        for (let key in dependencies) {
            let dependency: any = dependencies[key];
            let version: string = dependency.installed_version;
            if (version) {
                let childDependencies: any = dependency.dependencies;
                let generalInfo: GeneralInfo = new GeneralInfo(dependency.key, version, ['None'], '', PypiUtils.PKG_TYPE);
                let treeCollapsibleState: vscode.TreeItemCollapsibleState =
                    childDependencies && childDependencies.length > 0
                        ? vscode.TreeItemCollapsibleState.Collapsed
                        : vscode.TreeItemCollapsibleState.None;
                let child: DependenciesTreeNode = new DependenciesTreeNode(generalInfo, treeCollapsibleState, dependenciesTreeNode);
                let componentId: string = dependency.key + ':' + version;
                if (!quickScan || !this.treesManager.scanCacheManager.validateOrDelete(componentId)) {
                    this._componentsToScan.add(new ComponentDetails(PipTreeNode.COMPONENT_PREFIX + componentId));
                }
                this.populateDependenciesTree(child, childDependencies, quickScan);
            }
        }
    }
}
