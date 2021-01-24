import { GeneralInfo } from '../../../types/generalInfo';
import { PypiUtils } from '../../../utils/pypiUtils';
import { TreesManager } from '../../treesManager';
import { DependenciesTreeNode } from '../dependenciesTreeNode';
import { RootNode } from './rootTree';

export abstract class PythonTreeNode extends RootNode {
    protected static readonly COMPONENT_PREFIX: string = 'pypi://';

    constructor(
        workspaceFolder: string,
        private _treesManager: TreesManager,
        parent?: DependenciesTreeNode
    ) {
        super(workspaceFolder, parent);
    }

    public async refreshDependencies(quickScan: boolean) {
        let pypiList: any;
        try {
            pypiList = this.executeDepTreeCommand();
            this.generalInfo = new GeneralInfo(this.workspaceFolder.replace(/^.*[\\\/]/, ''), '', ['None'], this.workspaceFolder, PypiUtils.PKG_TYPE);
        } catch (error) {
            this._treesManager.logManager.logError(error, !quickScan);
        }
        this.label = this.generalInfo.artifactId;
        this.populateDependenciesTree(this, pypiList, quickScan);
    }

    protected abstract executeDepTreeCommand(): any;

    protected abstract populateDependenciesTree(dependenciesTreeNode: DependenciesTreeNode, dependencies: any, quickScan: boolean): void;

    protected get treesManager() {
        return this._treesManager;
    }
}
