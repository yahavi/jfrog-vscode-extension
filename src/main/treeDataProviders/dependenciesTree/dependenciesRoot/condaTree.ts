import * as Collections from 'typescript-collections';
import * as vscode from 'vscode';
import { ComponentDetails } from 'xray-client-js';
import { GeneralInfo } from '../../../types/generalInfo';
import { PypiUtils, PythonPaths } from '../../../utils/pypiUtils';
import { ScanUtils } from '../../../utils/scanUtils';
import { TreesManager } from '../../treesManager';
import { DependenciesTreeNode } from '../dependenciesTreeNode';
import { PythonTreeNode } from './pythonTree';

export class CondaTreeNode extends PythonTreeNode {
    constructor(
        workspaceFolder: string,
        private _componentsToScan: Collections.Set<ComponentDetails>,
        treesManager: TreesManager,
        private _pythonPath: PythonPaths,
        parent?: DependenciesTreeNode
    ) {
        super(workspaceFolder, treesManager, parent);
    }

    /** @override */
    protected executeDepTreeCommand(): any {
        return JSON.parse(
            ScanUtils.executeCmd(
                'conda run -p ' + this._pythonPath.condaPrefix + ' python ' + PypiUtils.CONDA_DEP_TREE_SCRIPT,
                this.workspaceFolder
            ).toString()
        );
    }

    /** @override */
    protected populateDependenciesTree(dependenciesTreeNode: DependenciesTreeNode, dependencies: any, quickScan: boolean) {
        let dependencyMap: Collections.Dictionary<string, CondaDependencyInfo> = new Collections.Dictionary();

        // Create dependency map
        for (let dependency of dependencies) {
            dependencyMap.setValue(dependency['name'], new CondaDependencyInfo(dependency['version'], dependency['dependencies']));
        }

        // Get direct dependencies
        let allDependencies: string[] = dependencyMap.values().flatMap(entry => entry.dependencies);
        dependencyMap.forEach((name: string, value: CondaDependencyInfo) => {
            // Skip dependency included by other dependency
            if (!allDependencies.includes(name)) {
                let generalInfo: GeneralInfo = new GeneralInfo(name, value.version, [], this.workspaceFolder, PypiUtils.PKG_TYPE);
                let dependencyInfo: any = dependencyMap.getValue(name)?.dependencies;
                let treeCollapsibleState: vscode.TreeItemCollapsibleState =
                    dependencyInfo?.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
                dependenciesTreeNode.addChild(new DependenciesTreeNode(generalInfo, treeCollapsibleState));
                let componentId: string = name + ':' + value.version;
                if (!quickScan || !this.treesManager.scanCacheManager.validateOrDelete(componentId)) {
                    this._componentsToScan.add(new ComponentDetails(PythonTreeNode.COMPONENT_PREFIX + componentId));
                }
            }
        });

        // Populate subtree
        this.populateChildren(dependencyMap, dependenciesTreeNode, quickScan);
    }

    private populateChildren(
        dependencyMap: Collections.Dictionary<string, CondaDependencyInfo>,
        dependenciesTreeNode: DependenciesTreeNode,
        quickScan: boolean
    ) {
        if (ScanUtils.hasLoop(dependenciesTreeNode, this.treesManager.logManager)) {
            return;
        }

        for (let node of dependenciesTreeNode.children) {
            let nodeInfo: CondaDependencyInfo | undefined = dependencyMap.getValue(node.generalInfo.artifactId);
            if (!nodeInfo || nodeInfo.dependencies.length === 0) {
                continue;
            }
            dependenciesTreeNode.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
            for (let childStr of nodeInfo.dependencies) {
                let childInfo: CondaDependencyInfo | undefined = dependencyMap.getValue(childStr);
                if (!childInfo) {
                    continue;
                }

                let generalInfo: GeneralInfo = new GeneralInfo(childStr, childInfo.version, [], '', PypiUtils.PKG_TYPE);
                let child: DependenciesTreeNode = new DependenciesTreeNode(generalInfo, vscode.TreeItemCollapsibleState.None);
                node.addChild(child);
                let componentId: string = childStr + ':' + childInfo.version;
                if (!quickScan || !this.treesManager.scanCacheManager.validateOrDelete(componentId)) {
                    this._componentsToScan.add(new ComponentDetails(PythonTreeNode.COMPONENT_PREFIX + componentId));
                }
            }
            this.populateChildren(dependencyMap, node, quickScan);
        }
    }
}

class CondaDependencyInfo {
    constructor(public version: string, public dependencies: string[]) {}
}
